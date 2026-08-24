/**
 * 导出生成命令（5.4.4，P5，SRS-SM-EXP-001 转换 2/3/4，EXP-001/EXP-002/EXP-003）。
 *
 * 由后台任务 worker 驱动（platform/tasks ExportGenerationHandler），职责：
 * - 幂等（EXP-003：生成成功按任务版本/文件哈希幂等）：任务已 DOWNLOADABLE 且已有
 *   文件哈希时直接回放结果，不重复写文件/发通知/审计；
 * - 安全开关复核（GOV-004，IFC-ERR-011）；
 * - 租约领取（转换 2）：PENDING_GENERATION → GENERATING，乐观保存版本冲突
 *   （IFC-ERR-008）重读一次——同持有者租约重入继续，异持有者 IFC-ERR-007；
 * - 按冻结快照渲染（EXP-003 快照口径）：逐数据集经 EXPORT_DATASET_SOURCE 回源，
 *   字段投影严格取 snapshot.fields(dataset)（纵深防御二次裁剪；includeContact=false
 *   时联系方式键绝不放行），附件仅在快照 attachmentRefs 显式冻结时打包（EXP-002
 *   「附件默认不打包」）；
 * - 成功落库（转换 3）：sha256 哈希 + 字节长度 → 对象存储写出 → 
 *   markGenerationSucceeded(validityMs=有效期配置) → 乐观保存（一次冲突容忍）；
 *   落库成功后才审计 export_generate(allowed) 与站内信通知（EXP-001，尽力而为副作用，
 *   失败不回滚业务结果）；
 * - 失败收敛（转换 4）：仍持租约时 markGenerationFailed（可披露原因）+ 审计
 *   export_generate(denied)，并重抛原错误供任务管道按失败重试处理。
 */

import { createHash } from 'node:crypto';

import { Inject, Logger } from '@nestjs/common';

import {
  EXPORT_AUDIT_PORT,
  EXPORT_SAFETY_SWITCH_PORT,
  type ExportAuditPort,
  type ExportSafetySwitchPort,
} from '../ports/export-authorization.port';
import { EXPORT_TASK_REPOSITORY, type ExportTaskRepository } from '../ports/export-repository.port';
import { EXPORT_FACT_SOURCE, type ExportFactSourcePort } from '../ports/export-fact-source.port';
import {
  EXPORT_DATASET_SOURCE,
  type ExportDatasetSourcePort,
} from '../ports/export-dataset-source.port';
import {
  EXPORT_FILE_RENDERER_PORT,
  type ExportFileRendererPort,
} from '../ports/export-file-renderer.port';
import {
  EXPORT_FILE_WRITER_PORT,
  type ExportFileWriterPort,
} from '../ports/export-file-writer.port';
import {
  EXPORT_RETENTION_CONFIG_PORT,
  type ExportRetentionConfigPort,
} from '../ports/export-retention-config.port';
import {
  EXPORT_NOTIFICATION_PORT,
  type ExportNotificationPort,
} from '../ports/export-notification.port';
import { CONTACT_FIELDS } from '../../domain/models/statistics-specification';
import { buildExportWatermarkMetadata } from '../../domain/services/export-watermark.policy';
import { ExportTaskAggregate } from '../../domain/models/export-task';
import { ExportTaskStatus } from '../../domain/state-machines/export-task.state-machine';
import { exportErrors, ExportError } from '../errors';

/** 默认生成租约时长（毫秒）；调用方可注入覆盖 */
export const DEFAULT_GENERATION_LEASE_MS = 60 * 1000;

export interface ExportGenerationInput {
  readonly exportId: string;
  /** 后台 worker 标识（租约持有者；用于租约重入与冲突判定） */
  readonly workerId: string;
  readonly now?: Date;
  readonly leaseMs?: number;
}

export interface ExportGenerationResult {
  readonly status: ExportTaskStatus;
  /** 仅本次或幂等回放命中"已成功"时返回 */
  readonly fileHash?: string;
  readonly fileSize?: number;
  readonly expiresAt?: string;
}

/**
 * 判定是否为乐观并发版本冲突（IFC-ERR-008）。
 * 与 export-delete.command 的同名私有逻辑同口径：优先比对稳定错误码，
 * 兼容仅携带消息的场景。
 */
function isVersionConflict(err: unknown): boolean {
  return (
    err instanceof Error &&
    ((err as Error & { code?: string }).code === 'IFC-ERR-008' || err.message.includes('IFC-ERR-008'))
  );
}

/**
 * 可披露的失败原因（落任务 failureReason / 审计 reason）：
 * - ExportError：稳定错误码 + 面向用户的可披露消息（与 deniedAuditEntry 同口径）；
 * - 其他异常：固定兜底文案（不透出堆栈/内部细节），原始错误另行重抛给管道留痕。
 */
function disposableFailureReason(err: ExportError): string {
  return `${err.code}: ${err.message}`;
}

/**
 * 字段投影收口（纯函数，EXP-003「字段不越权」纵深防御）：
 * 以冻结 fields 为唯一列白名单重建行对象——列序跟随 fields、fields 之外的任何键
 * （含数据源意外多返回的越权/秘密列）一律不进入产物。缺省值补 null 保持列位对齐。
 */
export function projectExportRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  fields: readonly string[],
): Array<Record<string, unknown>> {
  const fieldList = [...fields];
  return rows.map((row) => {
    const projected: Record<string, unknown> = {};
    for (const f of fieldList) {
      projected[f] = row[f] ?? null;
    }
    return projected;
  });
}

/**
 * 联系方式勾选投影闸门（纯函数，EXP-002/EXP-003）：
 * includeContact !== true 时从有效列中剔除 phone/email（正常管线中快照 clamp 已保证
 * fields 不含联系方式；此处为纵深防御——若因快照损坏/端口契约破坏导致 fields 仍含
 * 联系方式键，则以 IFC-ERR-005 硬失败拒绝生成，绝不静默导出）。
 * 返回实际允许进入产物的列清单。
 */
export function assertContactOptInProjection(
  fields: readonly string[],
  includeContact: boolean,
): readonly string[] {
  if (includeContact === true) return [...fields];
  const leaked = fields.filter((f) => CONTACT_FIELDS.has(f));
  if (leaked.length > 0) {
    // 快照口径被破坏（clamp 应已剔除联系方式）：宁可失败也不越权导出
    throw exportErrors.validation(
      `快照未勾选联系方式却包含联系方式字段 ${leaked.join('/')}，拒绝生成（EXP-002/EXP-003，IFC-ERR-005）`,
    );
  }
  return [...fields];
}

export class ExportGenerationCommand {
  private readonly logger = new Logger(ExportGenerationCommand.name);

  constructor(
    @Inject(EXPORT_TASK_REPOSITORY) private readonly repo: ExportTaskRepository,
    @Inject(EXPORT_SAFETY_SWITCH_PORT) private readonly safety: ExportSafetySwitchPort,
    @Inject(EXPORT_DATASET_SOURCE) private readonly datasets: ExportDatasetSourcePort,
    @Inject(EXPORT_FILE_RENDERER_PORT) private readonly renderer: ExportFileRendererPort,
    @Inject(EXPORT_FILE_WRITER_PORT) private readonly fileWriter: ExportFileWriterPort,
    @Inject(EXPORT_RETENTION_CONFIG_PORT) private readonly retention: ExportRetentionConfigPort,
    @Inject(EXPORT_FACT_SOURCE) private readonly facts: ExportFactSourcePort,
    @Inject(EXPORT_AUDIT_PORT) private readonly audit: ExportAuditPort,
    @Inject(EXPORT_NOTIFICATION_PORT) private readonly notifications: ExportNotificationPort,
  ) {}

  async execute(input: ExportGenerationInput): Promise<ExportGenerationResult> {
    const now = input.now ?? new Date();

    // ---------------------------------------------------------------------
    // 步骤 1~3：加载/幂等/开关/领取 —— 此段失败不置 FAILED（任务尚未被本 worker 认领）
    // ---------------------------------------------------------------------

    // 1. 任务不可见 → IFC-ERR-015
    let task = await this.repo.load(input.exportId);
    if (task === null) {
      throw exportErrors.notVisible('导出任务不存在（IFC-ERR-015）');
    }

    // 1. 幂等回放（EXP-003：生成成功按任务版本/文件哈希幂等）：不重复写文件/
    //    发通知/审计——重复投递同一生成任务时直接返回既有结果。
    if (
      task.status === ExportTaskStatus.DOWNLOADABLE &&
      task.toData().fileHash !== null
    ) {
      return this.idempotentResult(task);
    }

    // 2. 安全开关（GOV-004，IFC-ERR-011）
    const safetyState = await this.safety.checkAllowed();
    if (!safetyState.allowed) {
      throw exportErrors.safety('导出安全开关已关闭，暂停生成（GOV-004，IFC-ERR-011）');
    }

    // 3. 租约领取（转换 2）
    task = await this.claimOrThrow(task, input, now);

    // ---------------------------------------------------------------------
    // 步骤 4~7：渲染/写出/成功落库 —— 失败须 markGenerationFailed 并重抛
    // ---------------------------------------------------------------------
    try {
      const result = await this.generateAndPersist(task, input, now);
      return result;
    } catch (err) {
      const failure =
        err instanceof ExportError
          ? err
          : exportErrors.precondition('导出内容生成失败，请稍后重试');
      await this.markFailedIfStillOwned(task, input, now, failure, err);
      throw failure;
    }
  }

  // -------------------------------------------------------------------------
  // 内部：租约领取（转换 2）
  // -------------------------------------------------------------------------

  /**
   * 领取租约并返回可推进的聚合：
   * - PENDING_GENERATION：claimGeneration 后以 expectedRevision 乐观保存；版本冲突
   *   （IFC-ERR-008）重读一次——已是本 worker 名下 GENERATING 视为租约重入继续；
   *   是其他 worker 的 GENERATING → IFC-ERR-007；其余情形重抛原冲突。
   * - GENERATING：仅本 worker 租约内可重入（worker 崩溃恢复后的续跑）；
   *   他者持有 → IFC-ERR-007。
   * - 其余状态（FAILED/终态/NEW 等）→ IFC-ERR-007（FAILED 经 retry 命令回队列）。
   */
  private async claimOrThrow(
    initial: ExportTaskAggregate,
    input: ExportGenerationInput,
    now: Date,
  ): Promise<ExportTaskAggregate> {
    if (initial.status === ExportTaskStatus.PENDING_GENERATION) {
      const expectedRevision = initial.revisionNumber;
      initial.claimGeneration(input.workerId, input.leaseMs ?? DEFAULT_GENERATION_LEASE_MS, now);
      try {
        await this.repo.save(initial, { expectedRevision });
        return initial;
      } catch (err) {
        if (!isVersionConflict(err)) throw err;
        const fresh = await this.repo.load(initial.id);
        if (
          fresh !== null &&
          fresh.status === ExportTaskStatus.GENERATING &&
          fresh.toData().lease?.holderId === input.workerId
        ) {
          // 租约重入：并发写者以同 worker 身份完成领取（如管道重复投递），继续生成
          return fresh;
        }
        if (fresh !== null && fresh.status === ExportTaskStatus.GENERATING) {
          throw exportErrors.stateConflict(
            `导出任务正被其他 worker 生成中，本 worker 不得接管（IFC-ERR-007）`,
          );
        }
        throw err;
      }
    }

    if (initial.status === ExportTaskStatus.GENERATING) {
      if (initial.toData().lease?.holderId !== input.workerId) {
        throw exportErrors.stateConflict(
          `导出任务生成中且租约非本 worker 所有，拒绝并发生成（IFC-ERR-007）`,
        );
      }
      return initial; // 租约重入
    }

    throw exportErrors.stateConflict(
      `仅待生成任务可执行生成，当前状态 ${initial.status}（IFC-ERR-007）`,
    );
  }

  // -------------------------------------------------------------------------
  // 内部：渲染 + 写出 + 成功落库（步骤 4~7）
  // -------------------------------------------------------------------------

  private async generateAndPersist(
    task: ExportTaskAggregate,
    input: ExportGenerationInput,
    now: Date,
  ): Promise<ExportGenerationResult> {
    const snap = task.snapshot.data;

    // 4. 渲染计划：逐数据集按冻结快照回源（字段投影 EXACTLY snapshot.fields）
    const sheets: Array<{ name: string; rows: ReadonlyArray<readonly unknown[]> }> = [];
    const manifestDatasets: Array<{ dataset: string; fieldCount: number }> = [];
    for (const dataset of snap.datasets) {
      const frozenFields = task.snapshot.fields(dataset);
      // 联系方式勾选闸门（纵深防御第一道）：includeContact=false 时 fields 含
      // phone/email 直接硬失败；否则得到实际允许列
      const effectiveFields = assertContactOptInProjection(frozenFields, snap.includeContact);

      const rows = await this.datasets.loadDatasetRows({
        dataset,
        scope: snap.scope,
        fields: frozenFields, // 回源查询仍传冻结基线（实现侧同样强制投影）
        includeContact: snap.includeContact,
        academicYear: snap.academicYear,
        timeRange: snap.timeRange,
      });

      // 纵深防御第二道（EXP-003 字段不越权）：以有效列为唯一白名单重建行，
      // 数据源多返回的任何键一律剥离
      const projectedRows = projectExportRows(rows, effectiveFields);

      // 首行为字段名表头（可用性 + 列序自描述），其后每行按列序取值
      sheets.push({
        name: dataset,
        rows: [effectiveFields, ...projectedRows.map((r) => effectiveFields.map((f) => r[f]))],
      });
      manifestDatasets.push({ dataset, fieldCount: effectiveFields.length });
    }

    // 5. 水印元数据（EXP-002：导出编号/导出人/社团/生成时间固化进文件）
    const watermark = buildExportWatermarkMetadata({
      exportId: task.id,
      revisionNumber: task.revisionNumber,
      exporterUserId: task.requestedByUserId,
      clubId: snap.scope.clubId,
      generatedAt: now,
    });

    // 6. 附件（EXP-002：默认不打包，仅显式冻结进快照的 refs 才回源打包）
    const attachments =
      snap.attachmentRefs.length > 0 ? await this.facts.loadAttachmentContents(snap.attachmentRefs) : [];

    const rendered = await this.renderer.render({
      sheets,
      watermark,
      attachments: attachments.map((a) => ({
        ref: a.ref,
        filename: a.filename,
        contentType: a.contentType,
        bytes: a.bytes,
      })),
      datasets: manifestDatasets,
      now,
    });

    // 7. 哈希 + 写对象存储 + 成功落库（转换 3）
    const fileHash = createHash('sha256').update(rendered.bytes).digest('hex');
    const written = await this.fileWriter.write({
      exportId: task.id,
      exportNo: watermark.exportNo,
      kind: rendered.kind,
      bytes: rendered.bytes,
      watermark,
    });
    const validityMs = await this.retention.resolveValidityMs();

    const expectedRevision = task.revisionNumber;
    task.markGenerationSucceeded({
      fileRef: written.fileRef,
      fileHash,
      fileSize: written.fileSize,
      now,
      validityMs,
    });
    try {
      await this.repo.save(task, { expectedRevision });
    } catch (err) {
      if (!isVersionConflict(err)) throw err;
      // 一次冲突容忍（与 invalidateCandidate 口径一致）：重读后分类处置
      const fresh = await this.repo.load(task.id);
      if (fresh === null || fresh.isTerminal || fresh.toData().lease?.holderId !== input.workerId) {
        // 已被并发写者推进到终态（失权/过期/提前删除）或租约易主：
        // 本轮生成结果作废（superseded），静默放弃——不覆盖他人写入、不审计 allowed、不通知
        this.logger.warn(
          `导出生成完成前任务已被并发推进（exportId=${task.id}, status=${fresh?.status ?? 'unknown'}），本轮结果作废`,
        );
        return { status: fresh ? fresh.status : task.status };
      }
      const reExpected = fresh.revisionNumber;
      fresh.markGenerationSucceeded({
        fileRef: written.fileRef,
        fileHash,
        fileSize: written.fileSize,
        now,
        validityMs,
      });
      await this.repo.save(fresh, { expectedRevision: reExpected });
      task = fresh;
    }

    // 8. 成功审计（业务结果持久化之后才记录 allowed；privileged 仅平台级作用域为 true）
    await this.audit.record({
      at: now.toISOString(),
      action: 'export_generate',
      principalId: task.requestedByUserId, // 生成行为归属导出发起方（worker 触发，见 JSDoc）
      privileged: snap.scope.kind === 'platform',
      clubId: snap.scope.clubId,
      jointActivityId: snap.scope.jointActivityId,
      datasetType: snap.datasets.length > 0 ? snap.datasets.join(',') : null,
      exportId: task.id,
      purpose: null,
      outcome: 'allowed',
    });

    // 站内信通知（EXP-001：完成后站内信，不用邮件附件交付）。尽力而为副作用：
    // 业务结果已持久化，通知失败仅告警不使命令失败（生产适配器负责重试/落告警）。
    try {
      await this.notifications.notifyExportCompleted({
        recipientUserId: task.ownerUserId,
        exportId: task.id,
        exportNo: watermark.exportNo,
      });
    } catch (err) {
      this.logger.warn(
        `导出完成站内信通知失败（不影响业务结果，exportId=${task.id}）：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return {
      status: task.status,
      fileHash,
      fileSize: written.fileSize,
      expiresAt: task.toData().expiresAt ?? undefined,
    };
  }

  // -------------------------------------------------------------------------
  // 内部：失败收敛（转换 4）
  // -------------------------------------------------------------------------

  /**
   * 生成失败收敛：仅当任务仍为本 worker 名下 GENERATING 时 markGenerationFailed
   * （可重试、沿用原快照）+ 审计 export_generate(denied)；已被并发推进/租约易主则
   * 不再改写（避免覆盖他者状态）。无论收敛与否都由调用方重抛原错误。
   *
   * 失败保存同样做一次版本冲突容忍：重读后仍符合条件则以最新版本重存；二次冲突
   * 放弃改写（状态机语义上该任务终将由其持有者自行收敛）。
   */
  private async markFailedIfStillOwned(
    task: ExportTaskAggregate,
    input: ExportGenerationInput,
    now: Date,
    failure: ExportError,
    original: unknown,
  ): Promise<void> {
    let current: ExportTaskAggregate | null = null;
    try {
      current = await this.repo.load(task.id);
    } catch {
      current = null; // 重读失败不影响后续以内存态兜底尝试
    }
    const target =
      current !== null &&
      current.status === ExportTaskStatus.GENERATING &&
      current.toData().lease?.holderId === input.workerId
        ? current
        : null;
    if (target === null) {
      this.logger.warn(
        `导出生成失败但任务已不在本 worker 名下（exportId=${task.id}），跳过失败标记：${
          original instanceof Error ? original.message : String(original)
        }`,
      );
      return;
    }

    const expectedRevision = target.revisionNumber;
    target.markGenerationFailed(disposableFailureReason(failure), now);
    try {
      await this.repo.save(target, { expectedRevision });
    } catch (saveErr) {
      if (!isVersionConflict(saveErr)) {
        // 真实仓储异常不吞掉：保留原生成错误为主抛出，仓储问题仅告警
        this.logger.error(`导出失败状态保存异常（exportId=${task.id}）：${String(saveErr)}`);
        return;
      }
      const fresh = await this.repo.load(task.id);
      if (
        fresh === null ||
        fresh.status !== ExportTaskStatus.GENERATING ||
        fresh.toData().lease?.holderId !== input.workerId
      ) {
        return; // 并发写者已接管/收敛，不再改写
      }
      const reExpected = fresh.revisionNumber;
      fresh.markGenerationFailed(disposableFailureReason(failure), now);
      try {
        await this.repo.save(fresh, { expectedRevision: reExpected });
      } catch {
        // 二次冲突放弃改写
      }
    }

    await this.audit.record({
      at: now.toISOString(),
      action: 'export_generate',
      principalId: task.requestedByUserId,
      privileged: task.snapshot.data.scope.kind === 'platform',
      clubId: task.snapshot.data.scope.clubId,
      jointActivityId: task.snapshot.data.scope.jointActivityId,
      datasetType:
        task.snapshot.data.datasets.length > 0 ? task.snapshot.data.datasets.join(',') : null,
      exportId: task.id,
      purpose: null,
      outcome: 'denied',
      reason: disposableFailureReason(failure),
    });
  }

  /** 幂等回放结果（DOWNLOADABLE 且已有文件哈希） */
  private idempotentResult(task: ExportTaskAggregate): ExportGenerationResult {
    const data = task.toData();
    return {
      status: task.status,
      fileHash: data.fileHash ?? undefined,
      fileSize: data.fileSize,
      expiresAt: data.expiresAt ?? undefined,
    };
  }
}
