/**
 * 部门/职位关系用例端口（MEM-002/MEM-003；依赖倒置边界）。
 *
 * - RelationDirectoryPort：部门/职位目录与成员当前关系的领域投影，生产实现绑定
 *   organization 模块 Group 映射注册表 + Casdoor 回读（GOV-007：服务端重算，
 *   不信任前端或入参携带的角色/关系）；
 * - 审批人解析（MEM-017/ORG-036）与通知事实复用 membership 既有
 *   MembershipNotificationPort（IFC-TX-002 同事务留痕）。
 */

/** 关系目录端口（Casdoor 当前关系的服务端投影；ORG-013 稳定标识定位） */
export interface RelationDirectoryPort {
  /** 成员当前所属部门 id 集合（按 Casdoor 部门 Group 成员回读派生） */
  currentDepartmentIds(clubId: string, subjectId: string): Promise<readonly string[]>;
  /** 成员当前职位 id 集合 */
  currentPositionIds(clubId: string, subjectId: string): Promise<readonly string[]>;
  /** 部门是否存在且当前有效 */
  departmentActive(clubId: string, deptId: string): Promise<boolean>;
  /** 职位是否存在且当前有效 */
  positionActive(clubId: string, posId: string): Promise<boolean>;
  /** 部门的现任负责人主体 id（无则空数组——审批回退负责人/人事的依据 ORG-036） */
  departmentLeaderIds(clubId: string, deptId: string): Promise<readonly string[]>;
  /** 职位层级：普通职位 / 负责人（会长团）职位（ORG-021 任免层级依据） */
  positionScope(clubId: string, posId: string): Promise<'NORMAL' | 'LEADER'>;
  /** 操作者是否为指定部门的部门负责人 */
  operatorLeadsDepartment(clubId: string, deptId: string, operatorId: string): Promise<boolean>;
}

export const RELATION_DIRECTORY_PORT = Symbol('RELATION_DIRECTORY_PORT');
