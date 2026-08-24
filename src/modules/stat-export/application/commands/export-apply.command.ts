/**
 * 导出申请命令（5.4.2，P2，SRS-SM-EXP-001 转换 1 / EXP-001/002/003）。
 *
 * 职责：
 * - 安全开关校验（GOV-004，IFC-ERR-011）、越权/作用域拒绝（IFC-ERR-003/004）；
 * - 停用（社团强制停用 / 参与社团紧急停用，JNT-023）拒绝（IFC-ERR-006）；
 * - 申请幂等（IFC-ERR-009：同 key 语义一致回放、不一致冲突）；
 * - 快照冻结（复用 STATISTICS_SPECIFICATION 字段基线 clamp，越权字段剔除）；
 * - 超管全局/指定社团导出须用途 + 实时重新认证 + 特权审计（IFC-ERR-002）。
 * - 任务与快照同事务落库（IFC-TX-001 由仓储一次 save 保证）。
 */

import { randomUUID } from 'node:crypto';

import { Inject } from '@nestjs/common';

import {
  EXPORT_AUDIT_PORT,
  EXPORT_AUTHORIZATION_PORT,
  EXPORT_REAUTH_PORT,
  EXPORT_SAFETY_SWITCH_PORT,
  type ExportAuditPort,
  type ExportAuthorizationPort,
  type ExportPrincipal,
  type ExportReauthPort,
  type ExportSafetySwitchPort,
} from '../ports/export-authorization.port';
import { EXPORT_TASK_REPOSITORY, type ExportTaskRepository } from '../ports/export-repository.port';
import { EXPORT_FACT_SOURCE, type ExportFactSourcePort } from '../ports/export-fact-source.port';
import {
  EXPORT_APPLY_IDEMPOTENCY,
  type ExportApplyIdempotencyPort,
  APPLY_CONFLICT,
} from '../ports/export-idempotency.port';
import {
  StatisticsSpecification,
  EXPORT_DATASET_TYPES,
  type ExportDatasetType,
} from '../../domain/models/statistics-specification';
import { ExportSnapshot } from '../../domain/models/export-snapshot';
import { ExportTaskAggregate } from '../../domain/models/export-task';
import { ExportTaskStateMachine } from '../../domain/state-machines/export-task.state-machine';
import {
  assertPersonalCopyTargetInScope,
  assertFreshReauth,
  authorizeBatchExportScope,
  authorizePersonalCopy,
  convergeJointExportScope,
  SUPER_ADMIN_REAUTH_TTL_MS,
} from '../export-authorization.policy';
import { exportErrors, ExportError } from '../errors';
import { deniedAuditEntry } from '../export-denied-audit';

/**
 * 超管高风险导出的重新认证有效期（10 分钟窗口，IFC-ERR-002）。
 * 复用 export-authorization.policy 的公共常量，与 retry 共用同一口径。
 */
export { SUPER_ADMIN_REAUTH_TTL_MS };

export interface ExportApplyRequest {
  readonly kind: 'club' | 'department' | 'platform' | 'joint' | 'personal';
  readonly clubId?: string;
  readonly departmentId?: string;
  readonly jointActivityId?: string;
  readonly targetUserId?: string; // personal 副本目标
  readonly datasets?: readonly string[];
  readonly fields?: Readonly<Record<string, readonly string[]>>;
  readonly academicYear?: string;
  readonly timeRange?: { from: string; to: string };
  readonly includeFiles?: boolean;
  /** 超管特权导出用途（必填） */
  readonly purpose?: string;
  /** 超管高风险重新认证凭证时间戳 */
  readonly reauthProofAt?: string;
}

export interface ExportApplyInput {
  readonly principal: ExportPrincipal;
  readonly idempotencyKey?: string;
  readonly request: ExportApplyRequest;
  readonly now?: Date;
}

export interface ExportApplyResult {
  readonly task: ExportTaskAggregate;
  readonly replayed: boolean;
  readonly rejectedFields: readonly string[];
  readonly request: ExportApplyRequest;
}

/**
 * 计算申请语义摘要（幂等键语义归一化；作用域/字段/数据集任一变化摘要即变）。
 *
 * 并入申请者身份（principalUserId）以避免"本人个人副本"（targetUserId 缺省）场景下
 * 不同用户以同 key + 相同申请内容产生相同摘要：若摘要不含身份，第二个用户会命中下方
 * 跨用户回放守卫抛 IFC-ERR-003（误导性强，且限制了同名 key 的合理复用）。并入后不同
 * 用户摘要不同，回放前冲突预检直接以 IFC-ERR-009 语义拒绝，语义更清晰；同用户同 key
 * 相同请求摘要仍一致，幂等回放不受影响。
 *
 * hashVersion 固化幂等语义摘要的版本（评审⑤跨分支耦合：摘要依赖
 * STATISTICS_SPECIFICATION 的 EXPORT_DATASET_TYPES / clampExportFields 基线）。
 * 基线跨版本漂移时，同 key 回放的 rejectedFields / 冲突语义可能漂移，导致幂等
 * 回放与历史快照失配。通过显式版本号，当字段/数据集基线发生不兼容变更时须同步
 * 递增本常量，使摘要变化显式化（旧 key 语义归为不同申请内容 → IFC-ERR-009），
 * 而非静默复用错误基线。
 *
 * hashVersion 作为可选入参（缺省用常量），便于测试真正驱动版本递增验证摘要变化，
 * 而非仅靠手动构造差异断言（避免测试自证）。生产调用不传，恒用常量，语义不变。
 */
export const APPLY_IDEMPOTENCY_HASH_VERSION = 1;

export function applyIdempotencyHash(
  request: ExportApplyRequest,
  principalUserId?: string,
  hashVersion: number = APPLY_IDEMPOTENCY_HASH_VERSION,
): string {
  return JSON.stringify({
    hashVersion,
    kind: request.kind,
    principalUserId: principalUserId ?? null,
    clubId: request.clubId ?? null,
    departmentId: request.departmentId ?? null,
    jointActivityId: request.jointActivityId ?? null,
    targetUserId: request.targetUserId ?? null,
    academicYear: request.academicYear ?? null,
    timeRange: request.timeRange ?? null,
    includeFiles: request.includeFiles ?? false,
    purpose: request.purpose ?? null,
    datasets: [...(request.datasets ?? [])].sort().map((d) => d.toLowerCase()),
    fields:
      request.fields === undefined
        ? null
        : Object.fromEntries(
            Object.entries(request.fields)
              // 字段 key 用与 datasets 一致的确定性排序（UTF-16 码元序，不依赖 locale），
              // 避免 localeCompare 在不同环境/region 下产生不同顺序导致幂等哈希漂移。
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, v]) => [k, [...v].sort()]),
          ),
  });
}

export class ExportApplyCommand {
  private readonly machine = new ExportTaskStateMachine();

  constructor(
    private readonly spec: StatisticsSpecification,
    @Inject(EXPORT_AUTHORIZATION_PORT) private readonly authz: ExportAuthorizationPort,
    @Inject(EXPORT_AUDIT_PORT) private readonly audit: ExportAuditPort,
    @Inject(EXPORT_SAFETY_SWITCH_PORT) private readonly safety: ExportSafetySwitchPort,
    @Inject(EXPORT_REAUTH_PORT) private readonly reauth: ExportReauthPort,
    @Inject(EXPORT_FACT_SOURCE) private readonly facts: ExportFactSourcePort,
    @Inject(EXPORT_TASK_REPOSITORY) private readonly repo: ExportTaskRepository,
    @Inject(EXPORT_APPLY_IDEMPOTENCY) private readonly idem: ExportApplyIdempotencyPort,
  ) {}

  async execute(input: ExportApplyInput): Promise<ExportApplyResult> {
    const now = input.now ?? new Date();
    try {
      return await this.doExecute(input);
    } catch (err) {
      if (err instanceof ExportError) {
        // 拒绝路径审计：越权尝试（IFC-ERR-003/004）、停用封锁（IFC-ERR-006）、
        // 重认证不足（IFC-ERR-002）、幂等冲突（IFC-ERR-009）等安全相关拒绝须留痕可追踪。
        await this.audit.record(
          deniedAuditEntry(
            now.toISOString(),
            'export_apply',
            {
              principal: input.principal,
              clubId: input.request.clubId ?? null,
              jointActivityId: input.request.jointActivityId ?? null,
              datasetType:
                (input.request.datasets?.length ?? 0) > 0
                  ? (input.request.datasets ?? []).join(',')
                  : 'default',
              exportId: null,
              purpose: input.request.purpose ?? null,
            },
            err,
          ),
        );
      }
      throw err;
    }
  }

  private async doExecute(input: ExportApplyInput): Promise<ExportApplyResult> {
    const now = input.now ?? new Date();
    const principal = input.principal;
    const request = input.request;

    // 安全开关（GOV-004）：关闭 → IFC-ERR-011
    const safetyState = await this.safety.checkAllowed();
    if (!safetyState.allowed) {
      throw exportErrors.safety('导出安全开关已关闭，拒绝申请（GOV-004）');
    }

    // 幂等冲突预检（IFC-ERR-009）：同 key 已登记且语义不一致 → 立即冲突。
    // 仅做"冲突检测"不做"回放早退"——回放仍须走下方 resolveScope / 超管特权
    // 用途重认证等关键校验，避免回放路径绕过校验；真正原子判定由 claim() 完成。
    if (input.idempotencyKey) {
      const priorHash = await this.idem.hashForKey(input.idempotencyKey);
      if (priorHash !== null && priorHash !== applyIdempotencyHash(request, principal.userId)) {
        throw exportErrors.conflict('同一幂等键对应不同申请内容，请更换幂等键（IFC-ERR-009）');
      }
    }

    // 解析作用域 + 冻结场景上下文
    const resolution = await this.resolveScope(principal, request);

    // 超管特权导出：用途 + 重新认证（IFC-ERR-002）+ 特权审计
    if (resolution.privileged) {
      await assertFreshReauth(this.reauth, principal.userId, request.reauthProofAt, now);
      if (!request.purpose || request.purpose.trim().length === 0) {
        throw exportErrors.validation('超管特权导出必须填写用途（EXP-003）');
      }
    } else if (request.purpose) {
      // 非超管提交用途为冗余输入 → 输入无效，防误导
      throw exportErrors.validation('仅平台超管特权导出需要该用途字段');
    }

    // 快照冻结（字段 clamp 由 STATISTICS_SPECIFICATION 完成，越权/秘密字段剔除；
    // rejectedFields 一并固化进快照，供幂等回放时原样返回，与实时基线解耦）
    const { snapshot, rejectedFields } = ExportSnapshot.freeze({
      spec: this.spec,
      scope: resolution.snapshotScope,
      datasets: this.normalizeDatasets(request.datasets),
      requestedFields: this.normalizeFields(request.fields),
      academicYear: request.academicYear,
      timeRange: request.timeRange,
      includesPersonalCopy: request.kind === 'personal',
      personalTargetUserId: resolution.personalTargetUserId,
      jointAnnotations: resolution.jointAnnotations,
      attachmentRefs: resolution.attachmentRefs,
      now,
    });

    // 创建任务并推进 apply → PENDING_GENERATION
    const id = randomUUID();
    const task = ExportTaskAggregate.create({
      machine: this.machine,
      id,
      snapshot,
      ownerUserId: resolution.ownerUserId,
      authorizerUserId: resolution.authorizerUserId,
      requestedByUserId: principal.userId,
      now,
    });
    task.markApplied(now);

    // 幂等槽位原子领取（created / replayed / conflict）：并发下唯一原子判定点（IFC-ERR-009）。
    // 回放分支返回前已通过 resolveScope 与超管特权用途/重认证等关键校验，
    // 与首次创建语义一致（冲突预检已在上方完成，此处不做早退）。
    // idemCreated 记录本调用是否新领槽（created），用于落库失败时回滚槽位防毒化。
    let idemCreated = false;
    if (input.idempotencyKey) {
      const claim = await this.idem.claim({
        key: input.idempotencyKey,
        semanticHash: applyIdempotencyHash(request, principal.userId),
        taskId: id,
        now,
      });
      if (claim.status === APPLY_CONFLICT) {
        throw exportErrors.conflict('同一幂等键对应不同申请内容，请更换幂等键（IFC-ERR-009）');
      }
      idemCreated = claim.status === 'created';
      if (claim.status === 'replayed') {
        const existing = await this.repo.load(claim.taskId);
        if (existing === null) {
          throw exportErrors.stateConflict('幂等命中但任务不存在，请重试');
        }
        // 跨用户回放防护（纵深防御）：幂等摘要已并入申请者身份，正常情况下不同用户
        // 以同 key 申请会在冲突预检处以 IFC-ERR-009 拒绝；此处仍保留归属复核，防止
        // 摘要碰撞或服务端复用 key 等极端场景下拿到他人任务标识（IFC-ERR-003）。
        if (existing.requestedByUserId !== principal.userId) {
          throw exportErrors.forbidden('该幂等键已被其他用户申请，不能复用（IFC-ERR-003）');
        }
        // 回放审计：合法回放同样是一次导出申请行为，需留 export_apply 审计，
        // 否则回放请求在审计日志无痕迹，无法对账。
        await this.audit.record({
          at: now.toISOString(),
          action: 'export_apply',
          principalId: principal.userId,
          privileged: resolution.privileged,
          clubId: resolution.auditClubId,
          jointActivityId: request.jointActivityId ?? null,
          datasetType:
            (request.datasets?.length ?? 0) > 0 ? (request.datasets ?? []).join(',') : 'default',
          exportId: existing.id,
          purpose: request.purpose ?? null,
          outcome: 'allowed',
        });
        // 回放展示的 rejectedFields 读取首次冻结时固化进快照的历史值（评审②幂等回放纵深：
        // 与实时 STATISTICS_SPECIFICATION 基线彻底解耦，保证回放展示与首次创建永远一致，
        // 即便基线在 hashVersion 递增滞后/被意外修改时也不漂移）。
        // 兼容历史/反序列化的旧快照（#138 固化前创建、可能不含 rejectedFields 字段）：
        // 用 ?? [] 兜底，避免回放返回 undefined 破坏 ExportApplyResult.rejectedFields 数组契约。
        return {
          task: existing,
          replayed: true,
          rejectedFields: existing.snapshot.data.rejectedFields ?? [],
          request,
        };
      }
    }

    // 落库（带幂等槽位回滚）：槽位领取与任务保存非同一事务，若保存失败而槽位仍指向
    // 本任务，后续同 key 重试会命中 replayed 但任务不存在 → 永久毒化。故保存失败时
    // 回滚本调用新建的槽位（仅本调用 created 的才回滚，避免并发误删他人抢占的槽位）。
    try {
      await this.repo.save(task);
    } catch (err) {
      if (idemCreated && input.idempotencyKey) {
        await this.idem.release(input.idempotencyKey, id);
      }
      throw err;
    }

    await this.audit.record({
      at: now.toISOString(),
      action: 'export_apply',
      principalId: principal.userId,
      privileged: resolution.privileged,
      clubId: resolution.auditClubId,
      jointActivityId: request.jointActivityId ?? null,
      datasetType:
        (request.datasets?.length ?? 0) > 0 ? (request.datasets ?? []).join(',') : 'default',
      exportId: id,
      purpose: request.purpose ?? null,
      outcome: 'allowed',
    });

    return { task, replayed: false, rejectedFields, request };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private async resolveScope(
    principal: ExportPrincipal,
    request: ExportApplyRequest,
  ): Promise<{
    snapshotScope: ExportSnapshot['data']['scope'];
    ownerUserId: string;
    authorizerUserId: string | null;
    privileged: boolean;
    personalTargetUserId: string | null;
    jointAnnotations: ExportSnapshot['data']['jointAnnotations'];
    attachmentRefs: readonly string[];
    auditClubId: string | null;
  }> {
    // 个人副本
    if (request.kind === 'personal') {
      const pc = authorizePersonalCopy(principal, request.targetUserId, {
        clubId: request.clubId,
        departmentId: request.departmentId,
      });
      // 对象存储未接入前，includeFiles=true 一律显式拒绝，避免附件开关语义在个人副本
      // 下被静默忽略。
      // 顺序说明：越权静态校验（authorizePersonalCopy）先于业务/能力校验（includeFiles），
      // 与普通批量/联合分支的错误码优先级口径统一——越权（IFC-ERR-003）优先于能力不支持
      // （IFC-ERR-005），避免越权者以 includeFiles 探测附件功能状态（信息泄露）。
      if (request.includeFiles) {
        throw exportErrors.validation(
          '当前版本暂不支持导出包含附件（includeFiles=true），请去除附件后重试（IFC-ERR-005）',
        );
      }
      // 回源校验被代申请人归属（EXP-003 越权边界）：
      // 部门负责人/社团负责人代申请个人副本时，须确认 target 确实在自身作用域内
      // （部门成员 + 进入本部门招新路径的申请人 / 本社团当前成员），否则可为任意
      // 用户代申请导出越权。与 retry/download 共用同一归属复核函数，三处口径统一。
      await assertPersonalCopyTargetInScope(
        principal,
        pc.targetUserId,
        {
          clubId: pc.clubId,
          departmentId: pc.departmentId,
        },
        this.facts,
      );
      // 个人副本材料引用：仅当能同时定位社团与部门时回源；否则（本人副本无部门/社团
      // 边界）视为无附件引用。
      const refs =
        pc.clubId && pc.departmentId
          ? await this.facts.resolvePersonalCopyRefs(pc.clubId, pc.targetUserId)
          : [];
      return {
        snapshotScope: {
          kind: 'personal',
          clubId: pc.clubId,
          departmentId: pc.departmentId,
          departmentIds: pc.departmentId ? [pc.departmentId] : [],
          jointActivityId: null,
          participantClubIds: [],
        },
        ownerUserId: pc.targetUserId,
        authorizerUserId: pc.targetUserId === principal.userId ? null : principal.userId,
        privileged: principal.kind === 'platform_super_admin',
        personalTargetUserId: pc.targetUserId,
        jointAnnotations: [],
        attachmentRefs: refs,
        auditClubId: pc.clubId ?? null,
      };
    }

    // 联合活动批量导出（JNT-023）
    if (request.kind === 'joint') {
      if (!request.jointActivityId) {
        throw exportErrors.validation('联合导出须提供 jointActivityId');
      }
      const participantClubIds = await this.facts.loadParticipantClubIds(request.jointActivityId);
      if (participantClubIds.length === 0) {
        throw exportErrors.notVisible('联合活动不存在或尚未公示参与方（IFC-ERR-015）');
      }
      const scope = convergeJointExportScope(principal, participantClubIds, request.clubId);
      // 参与社团紧急停用 → 不能新建相关导出（JNT-023）
      const matchedClubId = scope.clubId;
      for (const clubId of participantClubIds) {
        const suspended = await this.facts.isParticipantClubSuspended(
          request.jointActivityId,
          clubId,
        );
        if (suspended) {
          throw exportErrors.precondition(
            `参与社团 ${clubId} 处于紧急停用，不能新建相关联合导出（JNT-023）`,
          );
        }
      }
      const annotations = await this.facts.loadJointAnnotations(request.jointActivityId);
      return {
        snapshotScope: {
          kind: 'joint',
          clubId: matchedClubId,
          departmentId: null,
          departmentIds: [],
          jointActivityId: request.jointActivityId,
          participantClubIds,
        },
        ownerUserId: principal.userId,
        authorizerUserId: null,
        privileged: principal.kind === 'platform_super_admin',
        personalTargetUserId: null,
        jointAnnotations: annotations,
        attachmentRefs: request.includeFiles
          ? this.requireBatchFileRefs('联合导出', request.jointActivityId)
          : [],
        auditClubId: matchedClubId ?? null,
      };
    }

    // 普通批量导出（club / department / platform）
    const resolved = authorizeBatchExportScope(principal, {
      kind: request.kind as 'club' | 'department' | 'platform',
      clubId: request.clubId,
      departmentId: request.departmentId,
    });

    // 社团强制停用 → 不能新建相关导出（JNT-023）
    if ((resolved.kind === 'club' || resolved.kind === 'department') && resolved.clubId) {
      const ctx = await this.facts.loadClubContext(resolved.clubId);
      if (ctx === null) {
        throw exportErrors.notVisible('社团不存在或不可见（IFC-ERR-015）');
      }
      if (ctx.forcedSuspension) {
        throw exportErrors.precondition(
          `社团 ${resolved.clubId} 已紧急停用，不能新建导出（JNT-023）`,
        );
      }
    }

    return {
      snapshotScope: {
        kind: resolved.kind,
        clubId: resolved.clubId,
        departmentId: request.departmentId ?? null,
        departmentIds: resolved.departmentIds,
        jointActivityId: null,
        participantClubIds: [],
      },
      ownerUserId: principal.userId,
      authorizerUserId: null,
      privileged: resolved.privileged,
      personalTargetUserId: null,
      jointAnnotations: [],
      attachmentRefs: request.includeFiles ? this.requireBatchFileRefs(resolved.kind, null) : [],
      auditClubId: resolved.clubId ?? null,
    };
  }

  /** 重新认证新鲜度校验（IFC-ERR-002）已抽为公共函数 assertFreshReauth，与 retry 共用。 */

  private normalizeDatasets(datasets?: readonly string[]): ExportSnapshot['data']['datasets'] {
    const normalized = datasets ?? [];
    // 以 EXPORT_DATASET_TYPES 为单一数据源构造白名单，避免硬编码
    // 清单与统计口径基线重复、后续新增数据集类型时漂移。
    const known = new Set<string>(EXPORT_DATASET_TYPES);
    for (const d of normalized) {
      if (!known.has(d)) {
        throw exportErrors.validation(`未知导出数据集类型：${d}（IFC-ERR-005）`);
      }
    }
    return normalized as ExportSnapshot['data']['datasets'];
  }

  private normalizeFields(
    fields?: Readonly<Record<string, readonly string[]>>,
  ): Partial<Readonly<Record<ExportDatasetType, readonly string[]>>> | undefined {
    if (fields === undefined) return undefined;
    // 校验字段 key 必须属于合法数据集类型；未知类型既不 clamp 也不应被静默忽略。
    const known = new Set<string>(EXPORT_DATASET_TYPES);
    const out: Partial<Record<ExportDatasetType, readonly string[]>> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (!known.has(k)) {
        throw exportErrors.validation(`未知导出数据集类型：${k}（IFC-ERR-005）`);
      }
      out[k as ExportDatasetType] = [...new Set(v)];
    }
    return out;
  }

  /**
   * 批量/联合导出的附件快照引用（5.4.3 接对象存储后支持）。
   * 当前对象存储未接入，显式拒绝 includeFiles 以避免附件静默缺失。
   */
  private requireBatchFileRefs(_kind: string, _jointActivityId: string | null): readonly string[] {
    throw exportErrors.validation(
      `当前版本暂不支持批量导出包含附件（includeFiles=true），请去除附件后重试（IFC-ERR-005）`,
    );
  }
}
