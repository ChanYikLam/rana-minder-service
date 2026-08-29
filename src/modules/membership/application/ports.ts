/**
 * 成员生命周期模块 · 应用端口（依赖倒置边界）。
 *
 * - MembershipAccessPort：角色/主角色/现任负责人一律由用例内经本端口**服务端重算**
 *   （ORG-038：不信任前端或入参携带的角色），生产绑定组织模块
 *   CurrentPermissionsPort / Group 映射（Casdoor Group 为权威，GOV-007）；
 * - MembershipNotificationPort：涉及权益的转换在收口点同事务保存通知事实
 *   （IFC-TX-002；与 organization 模块 NotificationPort 同构，投递由 NTF 模块承接）。
 */

/** 访问与关系重算端口（ORG-023/038、GOV-007） */
export interface MembershipAccessPort {
  /** 操作者在该社团的当前有效角色集合（空数组=无管理角色） */
  operatorRolesAt(clubId: string, userId: string): Promise<readonly string[]>;
  /** 成员在该社团的主角色（职位 Group 名派生；无职位返回空串） */
  subjectPrimaryRoleAt(clubId: string, userId: string): Promise<string>;
  /** 社团当前全部负责人主体 id（按负责人 Group 当前成员回读） */
  currentOwnerIds(clubId: string): Promise<readonly string[]>;
  /** 是否平台超级管理员（紧急处置豁免通道校验，ORG-024/029） */
  isPlatformSuperAdmin(userId: string): Promise<boolean>;
}

/** 通知事实（IFC-TX-002：失败不阻断主事务，但必须留痕） */
export interface MembershipNotificationFact {
  readonly kind: string;
  readonly toUserIds: readonly string[];
  readonly clubId: string;
  /** 去重键：经历段＋事件类型（重试类附尝试序号），保证通知不重复泛滥 */
  readonly dedupKey: string;
  readonly title: string;
  readonly body: string;
}

export interface MembershipNotificationPort {
  save(fact: MembershipNotificationFact): Promise<void>;
  /** 测试/查询辅助：读取已保存事实（生产适配可不实现为只写） */
  list(): Promise<MembershipNotificationFact[]>;
}

/**
 * 同事务保存通知事实的兜底封装（IFC-TX-002）：投递事实保存失败不得阻断主事务，
 * 由生产适配器自行重试/留痕。所有用例统一经此调用。
 */
export async function saveNotificationFact(
  port: MembershipNotificationPort,
  fact: MembershipNotificationFact,
): Promise<void> {
  try {
    await port.save(fact);
  } catch {
    // 失败不阻断主事务；生产适配器负责落告警
  }
}

/**
 * 成员当前 Group 关系观测同步端口（A4 Group 写链路收口；CAS-MAP-004）。
 *
 * membership 域在"写后回读确认"收口点调用本端口，把已确认的 Casdoor Group 关系
 * 同步到组织域观测表（org_member_group_current），供权限解析
 * （PostgresCurrentPermissionsPort）使用。数据权威仍是 Casdoor；本端口只同步观测。
 *
 * 实现侧约定（组织模块适配器）：按 (club, purpose, refId) 查 Group 映射得到
 * (group_owner, group_name)，upsert 观测行；失败不阻断主事务（saveObservation 落痕）。
 */
export interface MembershipRelationRef {
  readonly kind: 'CLUB' | 'DEPARTMENT' | 'POSITION';
  readonly refId: string;
}

export interface MembershipGroupObservationPort {
  /** 成员生效（激活回读全部确认）后同步观测 */
  syncOnActivationConfirmed(
    clubId: string,
    subjectId: string,
    targets: readonly MembershipRelationRef[],
  ): Promise<void>;
  /** 退出/移除（级联回读确认清空）后清除该主体在该社团的观测 */
  clearOnDepartureConfirmed(clubId: string, subjectId: string): Promise<void>;
}

/** DI 令牌（Symbol；与仓库约定一致） */
export const MEMBERSHIP_GROUP_OBSERVATION_PORT = Symbol('MEMBERSHIP_GROUP_OBSERVATION_PORT');

/** 安全调用：观测同步失败不阻断主事务（与 saveNotificationFact 同立场），仅留痕 */
export async function safeSyncObservation(
  port: MembershipGroupObservationPort | undefined,
  run: () => Promise<void>,
): Promise<void> {
  if (!port) return;
  try {
    await run();
  } catch {
    // 失败不阻断主事务；组织域对账任务会周期性修正观测表（ADR-009 对账兜底）
  }
}

/** DI 令牌（Symbol；与仓库约定一致） */
export const MEMBERSHIP_ACCESS_PORT = Symbol('MEMBERSHIP_ACCESS_PORT');
export const MEMBERSHIP_NOTIFICATION_PORT = Symbol('MEMBERSHIP_NOTIFICATION_PORT');
