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

/** DI 令牌（Symbol；与仓库约定一致） */
export const MEMBERSHIP_ACCESS_PORT = Symbol('MEMBERSHIP_ACCESS_PORT');
export const MEMBERSHIP_NOTIFICATION_PORT = Symbol('MEMBERSHIP_NOTIFICATION_PORT');
