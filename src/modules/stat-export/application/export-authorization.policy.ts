/**
 * 导出权限收敛策略（5.4.2，EXP-003：授权边界）。
 *
 * 5 类导出者各自可覆盖的作用域：
 * - 社团负责人/人事（club_leader_hr）：本社团全范围（含联合活动参与方边界）；
 * - 部门负责人（department_leader）：本部门，外加进入本部门招新路径的申请人；
 * - 普通面试官（interviewer）：禁止批量导出；
 * - 普通成员/申请人（member_applicant）：仅个人副本；
 * - 平台超管（platform_super_admin）：全平台或指定社团，须用途 + 特权审计。
 *
 * 越权/作用域不匹配分别拒绝（IFC-ERR-003 / IFC-ERR-004）；不涉及停用/联合失效判定
 * （该判定依赖事实回源，由 command 层配合上下文完成，见 export-apply.command.ts）。
 */

import type {
  ExportPrincipal,
  ExportClubScope,
  ExportReauthPort,
} from './ports/export-authorization.port';
import type { ExportFactSourcePort } from './ports/export-fact-source.port';
import { ExportError, exportErrors } from './errors';

// ---------------------------------------------------------------------------
// 请求与解析结果
// ---------------------------------------------------------------------------

export type RequestedExportKind = 'club' | 'department' | 'platform' | 'joint';

export interface RequestedExportScope {
  readonly kind: RequestedExportKind;
  readonly clubId?: string;
  readonly departmentId?: string;
  readonly jointActivityId?: string;
}

export type ResolvedExportKind = 'club' | 'department' | 'platform' | 'joint';

export interface ResolvedExportScope {
  readonly kind: ResolvedExportKind;
  readonly clubId: string | null;
  readonly departmentIds: readonly string[];
  readonly jointActivityId: string | null;
  readonly participantClubIds: readonly string[];
  /** true → 超管特权访问，应标记特权审计并校验用途 */
  readonly privileged: boolean;
}

// ---------------------------------------------------------------------------
// 帮助：在 principal 的 clubScopes 内查找某社团作用域
// ---------------------------------------------------------------------------

function findClubScope(principal: ExportPrincipal, clubId: string): ExportClubScope | undefined {
  return principal.clubScopes.find((s) => s.clubId === clubId);
}

// ---------------------------------------------------------------------------
// 批量导出收敛
// ---------------------------------------------------------------------------

/**
 * 收敛批量导出请求到已授权作用域。
 * 联合活动（joint）的角色边界在 convergeJointExportScope 中单独处理，
 * 因为需要参与方清单的事实回源；本函数拒绝非授权组合。
 */
export function authorizeBatchExportScope(
  principal: ExportPrincipal,
  requested: RequestedExportScope & { kind: 'club' | 'department' | 'platform' },
): ResolvedExportScope {
  const kind = principal.kind;

  // 普通成员/申请人、普通面试官：任何批量导出一律拒绝（EXP-003）
  if (kind === 'member_applicant' || kind === 'interviewer') {
    throw exportErrors.forbidden(`导出者分类 ${kind} 禁止批量导出，仅允许个人副本（EXP-003）`);
  }

  // 部门负责人：仅本部门（含进入本部门招新路径的申请人，事实层统一纳入）
  if (kind === 'department_leader') {
    if (requested.kind === 'platform') {
      throw exportErrors.forbidden('部门负责人无权导出全平台数据（EXP-003）');
    }
    if (requested.kind === 'club') {
      throw exportErrors.scopeMismatch('部门负责人仅可导出本部门数据，不可导出整个社团（EXP-003）');
    }
    // requested.kind === 'department'
    if (requested.clubId === undefined || requested.departmentId === undefined) {
      throw exportErrors.validation('部门负责人导出须指定 clubId 与 departmentId');
    }
    const scope = findClubScope(principal, requested.clubId);
    if (scope === undefined || scope.level !== 'department') {
      throw exportErrors.forbidden(
        `用户 ${principal.userId} 无权导出社团 ${requested.clubId} 数据（EXP-003）`,
      );
    }
    if (!scope.departmentIds.includes(requested.departmentId)) {
      throw exportErrors.scopeMismatch(
        `部门 ${requested.departmentId} 不在用户可导出部门集合内（EXP-003）`,
      );
    }
    return {
      kind: 'department',
      clubId: requested.clubId,
      departmentIds: [requested.departmentId],
      jointActivityId: null,
      participantClubIds: [],
      privileged: false,
    };
  }

  // 社团负责人/人事：本社团（club level），或本社团内部门子集
  if (kind === 'club_leader_hr') {
    if (requested.kind === 'platform') {
      throw exportErrors.forbidden('社团负责人/人事无权导出全平台数据（EXP-003）');
    }
    if (requested.clubId === undefined) {
      throw exportErrors.validation('社团导出须指定 clubId');
    }
    const scope = findClubScope(principal, requested.clubId);
    if (scope === undefined) {
      throw exportErrors.forbidden(
        `用户 ${principal.userId} 无权导出社团 ${requested.clubId} 数据（EXP-003）`,
      );
    }
    if (scope.level !== 'club') {
      throw exportErrors.scopeMismatch(
        `用户对社团 ${requested.clubId} 仅具备部门作用域，不可导出全社团（EXP-003）`,
      );
    }
    if (requested.kind === 'department') {
      if (requested.departmentId === undefined) {
        throw exportErrors.validation('部门导出须指定 departmentId');
      }
      return {
        kind: 'department',
        clubId: requested.clubId,
        departmentIds: [requested.departmentId],
        jointActivityId: null,
        participantClubIds: [],
        privileged: false,
      };
    }
    return {
      kind: 'club',
      clubId: requested.clubId,
      departmentIds: [],
      jointActivityId: null,
      participantClubIds: [],
      privileged: false,
    };
  }

  // 平台超管：全平台或指定社团（特权）
  if (kind === 'platform_super_admin') {
    if (requested.kind === 'platform') {
      return {
        kind: 'platform',
        clubId: null,
        departmentIds: [],
        jointActivityId: null,
        participantClubIds: [],
        privileged: true,
      };
    }
    // club / department 指定 → 特权导出指定社团
    if (requested.clubId === undefined) {
      throw exportErrors.validation('超管指定社团导出须提供 clubId');
    }
    return {
      kind: requested.kind,
      clubId: requested.clubId,
      departmentIds:
        requested.kind === 'department' && requested.departmentId ? [requested.departmentId] : [],
      jointActivityId: null,
      participantClubIds: [],
      privileged: true,
    };
  }

  // 类型穷尽保护
  const exhaustive: never = kind;
  void exhaustive;
  throw exportErrors.forbidden('未知导出者分类（EXP-003）');
}

/**
 * 收敛联合活动批量导出：仅参与活动社团的负责人/人事可导出（JNT-023），
 * 且仅用参与方社团清单（participantClubIds）内该用户具备 club 级作用域者。
 * 部门负责人对联合活动导出一律拒绝（导出边界为参与社团负责人/人事）。
 */
export function convergeJointExportScope(
  principal: ExportPrincipal,
  participantClubIds: readonly string[],
  requestedClubId: string | undefined,
): ResolvedExportScope {
  if (principal.kind === 'platform_super_admin') {
    return {
      kind: 'joint',
      clubId: null,
      departmentIds: [],
      jointActivityId: null,
      participantClubIds,
      privileged: true,
    };
  }
  if (principal.kind !== 'club_leader_hr') {
    throw exportErrors.forbidden(
      `联合活动批量导出仅限参与社团负责人/人事（JNT-023），` + `当前分类 ${principal.kind} 无权`,
    );
  }
  // 找到 principal 具备 club 级作用域且属参与方的社团
  const match = principal.clubScopes.find(
    (s) => s.level === 'club' && participantClubIds.includes(s.clubId),
  );
  if (match === undefined) {
    throw exportErrors.forbidden(
      `用户 ${principal.userId} 并非该联合活动参与社团负责人/人事（JNT-023）`,
    );
  }
  // 若调用方显式指定了其参与社团，须与其授权社团一致（防止用别的社团占位）
  if (requestedClubId !== undefined && requestedClubId !== match.clubId) {
    throw exportErrors.scopeMismatch(
      `请求社团 ${requestedClubId} 与用户参与社团 ${match.clubId} 不一致（JNT-023）`,
    );
  }
  return {
    kind: 'joint',
    clubId: match.clubId,
    departmentIds: [],
    jointActivityId: null,
    participantClubIds,
    privileged: false,
  };
}

// ---------------------------------------------------------------------------
// 个人副本收敛
// ---------------------------------------------------------------------------

/**
 * 收敛"个人副本"导出（普通成员/申请人本人；负责人/人事/超管可代其作用域内成员申请）。
 * targetUserId 缺省表示本人导出。
 */
export function authorizePersonalCopy(
  principal: ExportPrincipal,
  targetUserId: string | undefined,
  scope: { clubId?: string; departmentId?: string },
): { targetUserId: string; clubId: string | null; departmentId: string | null } {
  const target = targetUserId ?? principal.userId;

  // 普通成员/申请人：仅本人
  if (principal.kind === 'member_applicant') {
    if (target !== principal.userId) {
      throw exportErrors.forbidden('普通成员/申请人仅可导出本人个人副本（EXP-003）');
    }
    return { targetUserId: target, clubId: null, departmentId: null };
  }

  if (principal.kind === 'interviewer') {
    throw exportErrors.forbidden('普通面试官不可导出个人副本（EXP-003）');
  }

  // 部门负责人：仅本部门内个人副本
  if (principal.kind === 'department_leader') {
    if (scope.clubId === undefined || scope.departmentId === undefined) {
      throw exportErrors.validation('部门负责人代申请个人副本须提供 clubId 与 departmentId');
    }
    const clubScope = findClubScope(principal, scope.clubId);
    if (clubScope === undefined || clubScope.level !== 'department') {
      throw exportErrors.forbidden(
        `用户 ${principal.userId} 无权访问社团 ${scope.clubId} 个人副本（EXP-003）`,
      );
    }
    if (!clubScope.departmentIds.includes(scope.departmentId)) {
      throw exportErrors.scopeMismatch(
        `部门 ${scope.departmentId} 不在用户可导出部门集合内（EXP-003）`,
      );
    }
    return { targetUserId: target, clubId: scope.clubId, departmentId: scope.departmentId };
  }

  // 社团负责人/人事：本社团内个人副本
  if (principal.kind === 'club_leader_hr') {
    const clubId = scope.clubId;
    if (clubId === undefined) {
      throw exportErrors.validation('社团负责人/人事代申请个人副本须提供 clubId');
    }
    const clubScope = findClubScope(principal, clubId);
    if (clubScope === undefined || clubScope.level !== 'club') {
      throw exportErrors.forbidden(
        `用户 ${principal.userId} 无权访问社团 ${clubId} 个人副本（EXP-003）`,
      );
    }
    return { targetUserId: target, clubId, departmentId: scope.departmentId ?? null };
  }

  // 平台超管：任意个人副本（特权）
  return {
    targetUserId: target,
    clubId: scope.clubId ?? null,
    departmentId: scope.departmentId ?? null,
  };
}

// ---------------------------------------------------------------------------
// 快照作用域重验（供重试命令 / 下载控制器共用，避免逻辑重复漂移）
// ---------------------------------------------------------------------------

/** 作用域重验所需的快照形状（scope + personalTargetUserId） */
export interface ExportScopeRevalidateInput {
  readonly scope: {
    readonly kind: string;
    readonly clubId: string | null;
    readonly departmentId: string | null;
    readonly jointActivityId: string | null;
    readonly participantClubIds: readonly string[];
  };
  readonly personalTargetUserId: string | null;
}

/**
 * 实时重验操作者当前对冻结作用域仍具备导出权限（失权即拒绝，EXP-003）。
 *
 * 供 export-retry.command 与 export.controller 下载路径共用，统一授权口径：
 * 任意一处调整授权逻辑，两处自动同步，避免重复实现导致漂移。
 */
export function revalidateExportScope(
  principal: ExportPrincipal,
  snap: ExportScopeRevalidateInput,
): void {
  const scope = snap.scope;
  switch (scope.kind) {
    case 'personal':
      authorizePersonalCopy(principal, snap.personalTargetUserId ?? principal.userId, {
        clubId: scope.clubId ?? undefined,
        departmentId: scope.departmentId ?? undefined,
      });
      return;
    case 'joint':
      convergeJointExportScope(principal, scope.participantClubIds, scope.clubId ?? undefined);
      return;
    default: {
      const requested: RequestedExportScope =
        scope.kind === 'platform'
          ? { kind: 'platform' }
          : scope.kind === 'department'
            ? {
                kind: 'department',
                clubId: scope.clubId ?? undefined,
                departmentId: scope.departmentId ?? undefined,
              }
            : { kind: 'club', clubId: scope.clubId ?? undefined };
      authorizeBatchExportScope(
        principal,
        requested as RequestedExportScope & { kind: 'club' | 'department' | 'platform' },
      );
    }
  }
}

/**
 * 个人副本被代申请目标归属回源复核（EXP-003，申请/重试/下载三处统一口径）。
 *
 * 在静态策略（authorizePersonalCopy）之上，对"代申请他人个人副本"的 target
 * 回源确认其仍在操作者自身作用域内，防止对任意 userId 代申请导出越权：
 * - 部门负责人：target 须为本部门成员 或 进入本部门招新路径的申请人；
 * - 社团负责人/人事：target 须为本社团当前成员；
 * - 本人导出（target = 操作者本人）天然在自身作用域内，无需回源；
 * - 平台超管特权：不设归属限制（任意个人副本）。
 *
 * 供 export-apply.command（申请）、export-retry.command（重试）与
 * export.controller（下载）共用，保证申请/重试/下载三处授权口径一致。
 */
export async function assertPersonalCopyTargetInScope(
  principal: ExportPrincipal,
  targetUserId: string,
  scope: { clubId: string | null; departmentId: string | null },
  facts: Pick<
    ExportFactSourcePort,
    'resolveDepartmentMemberIds' | 'resolveDepartmentApplicantIds' | 'resolveClubMemberIds'
  >,
): Promise<void> {
  // 本人导出：无需回源
  if (targetUserId === principal.userId) return;

  if (principal.kind === 'department_leader') {
    if (scope.clubId === null || scope.departmentId === null) return; // 静态层已要求提供
    const [members, applicants] = await Promise.all([
      facts.resolveDepartmentMemberIds(scope.clubId, scope.departmentId),
      facts.resolveDepartmentApplicantIds(scope.clubId, scope.departmentId),
    ]);
    if (!members.includes(targetUserId) && !applicants.includes(targetUserId)) {
      throw exportErrors.forbidden(`目标用户 ${targetUserId} 不在本部门可导出范围内（EXP-003）`);
    }
    return;
  }

  if (principal.kind === 'club_leader_hr') {
    if (scope.clubId === null) return; // 静态层已要求提供
    const members = await facts.resolveClubMemberIds(scope.clubId);
    if (!members.includes(targetUserId)) {
      throw exportErrors.forbidden(`目标用户 ${targetUserId} 不在本社团可导出范围内（EXP-003）`);
    }
    return;
  }

  // member_applicant：静态层已拒绝代申请；interviewer：静态层已拒绝个人副本；
  // platform_super_admin：特权不设归属限制。均无需回源。
}

/**
 * 作用域实时重验（含个人副本归属回源）。
 *
 * 在 `revalidateExportScope` 的静态策略校验之上，补充个人副本被代申请目标用户的
 * **归属回源校验**：部门负责人代申请的个人副本，须确认 target 当前仍属本部门
 * （部门成员 + 进入本部门招新路径的申请人）；社团负责人/人事代申请的个人副本，
 * 须确认 target 当前仍属本社团成员。否则目标成员已离部/离社后，原负责人仍可凭
 * 冻结快照下载/重试其副本，存在授权时效性缺口（EXP-003）。
 *
 * 与 export-apply.command.ts `resolveScope` 中个人副本的口径一致，供 retry 命令与
 * 下载控制器共用，保证申请/重试/下载三处授权口径统一。
 */
export async function revalidateExportScopeWithFacts(
  principal: ExportPrincipal,
  snap: ExportScopeRevalidateInput,
  facts: Pick<
    ExportFactSourcePort,
    'resolveDepartmentMemberIds' | 'resolveDepartmentApplicantIds' | 'resolveClubMemberIds'
  >,
): Promise<void> {
  // 静态作用域校验（含操作者自身作用域）始终执行
  revalidateExportScope(principal, snap);

  // 个人副本：代申请他人时回源复核 target 归属（部门负责人→部门成员/申请人；
  // 社团负责人/人事→社团成员）。本人导出（target 即操作者本人）天然在自身作用域内。
  if (snap.scope.kind !== 'personal') return;
  const target = snap.personalTargetUserId ?? principal.userId;
  await assertPersonalCopyTargetInScope(
    principal,
    target,
    {
      clubId: snap.scope.clubId,
      departmentId: snap.scope.departmentId,
    },
    facts,
  );
}

/**
 * 停用封锁复核（JNT-023）——抽公共函数供 retry 命令与下载控制器共用。
 *
 * 社团强制停用或联合参与社团紧急停用后，拒绝在该作用域上继续释放数据（重试生成/下载）。
 * 与申请（resolveScope）同一口径，保证重试/下载不绕过停用封锁。
 *
 * - joint：任一参与方社团紧急停用 → 拒绝；
 * - club / department：社团强制停用 → 拒绝；
 * - personal：按目标用户所在社团（clubId）复核强制停用；无社团边界（本人副本）不拦截；
 * - platform：不涉及停用拦截（超管平台级导出）。
 */
export async function assertNotSuspended(
  snap: ExportScopeRevalidateInput,
  facts: Pick<
    ExportFactSourcePort,
    'loadClubContext' | 'loadParticipantClubIds' | 'isParticipantClubSuspended'
  >,
): Promise<void> {
  const scope = snap.scope;
  if (scope.kind === 'joint') {
    if (scope.jointActivityId) {
      const participantClubIds =
        scope.participantClubIds.length > 0
          ? scope.participantClubIds
          : await facts.loadParticipantClubIds(scope.jointActivityId);
      for (const clubId of participantClubIds) {
        const suspended = await facts.isParticipantClubSuspended(scope.jointActivityId, clubId);
        if (suspended) {
          throw exportErrors.precondition(
            `参与社团 ${clubId} 处于紧急停用，不能释放相关导出（JNT-023）`,
          );
        }
      }
    }
    return;
  }
  // club / department / personal：按冻结快照的 clubId 复核社团强制停用。
  // personal 的 clubId 可能为空（本人副本无社团边界），为空则不拦截。
  const clubId = scope.clubId;
  if (
    (scope.kind === 'club' || scope.kind === 'department' || scope.kind === 'personal') &&
    clubId
  ) {
    const ctx = await facts.loadClubContext(clubId);
    if (ctx === null) {
      throw exportErrors.notVisible('社团不存在或不可见（IFC-ERR-015）');
    }
    if (ctx.forcedSuspension) {
      throw exportErrors.precondition(`社团 ${clubId} 已紧急停用，不能释放相关导出（JNT-023）`);
    }
  }
}

/** 便捷：构造可注入测试的超管主体 */
export function platformSuperAdminPrincipal(userId: string): ExportPrincipal {
  return { userId, kind: 'platform_super_admin', clubScopes: [] };
}

/** 便捷：构造社团负责人主体 */
export function clubLeaderPrincipal(
  userId: string,
  clubId: string,
  extra: readonly {
    clubId: string;
    level: 'club' | 'department';
    departmentIds?: readonly string[];
  }[] = [],
): ExportPrincipal {
  return {
    userId,
    kind: 'club_leader_hr',
    clubScopes: [
      { clubId, level: 'club', departmentIds: [] },
      ...extra.map((e) => ({
        clubId: e.clubId,
        level: e.level,
        departmentIds: e.departmentIds ?? [],
      })),
    ],
  };
}

/** 便捷：拒绝错误类型守卫 */
export function isExportError(err: unknown): err is ExportError {
  return err instanceof ExportError;
}

/** 超管高风险导出的重新认证有效期（10 分钟窗口，IFC-ERR-002）。
 * 由 apply（新建）与 retry（重试）共用，保证特权导出的新建与重试口径统一；
 * export-apply.command 亦 re-export 该常量以保持对外引用兼容。 */
export const SUPER_ADMIN_REAUTH_TTL_MS = 10 * 60 * 1000;

/**
 * 校验高风险（超管特权）导出的重新认证新鲜度（IFC-ERR-002）。
 *
 * 与 apply 侧同一校验逻辑抽为公共函数，供申请（新建）与重试（沿用原快照重新生成）共用：
 * 超管特权导出重试时同样可能重新生成特权数据，若重认证已过期仍放行会产生对账缺口，
 * 故重试前须以与申请同口径复核重认证新鲜度。
 *
 * @param reauth 重新认证事实源端口
 * @param userId  操作者用户 id
 * @param proofAt 客户端声明的重新认证凭证时间戳（可缺省；缺省时仅依赖服务端最近重认证时间）
 * @param now     当前时间
 */
export async function assertFreshReauth(
  reauth: ExportReauthPort,
  userId: string,
  proofAt: string | undefined,
  now: Date,
): Promise<void> {
  const latest = await reauth.latestReauthAt(userId);
  if (latest === null) {
    throw exportErrors.reauth('高风险导出前需重新认证（IFC-ERR-002）');
  }
  if (proofAt !== undefined) {
    // 客户端声明的时间戳不得晚于服务端最近重认证时间（防捏造）；
    // 无效时间戳 getTime() 为 NaN，NaN 比较恒为 false 会静默绕过校验，须显式拒绝。
    const proofTs = new Date(proofAt).getTime();
    if (Number.isNaN(proofTs)) {
      throw exportErrors.reauth('重新认证凭证时间戳无效（IFC-ERR-002）');
    }
    if (proofTs > latest.getTime()) {
      throw exportErrors.reauth('重新认证凭证无效（IFC-ERR-002）');
    }
  }
  if (now.getTime() - latest.getTime() > SUPER_ADMIN_REAUTH_TTL_MS) {
    throw exportErrors.reauth('重新认证已过期，请重新认证后再导出（IFC-ERR-002）');
  }
}
