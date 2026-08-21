/**
 * 会话失效端口（IDN-008 依赖边界）。
 *
 * 禁用/删除的可信确认到达后，本地必须立即终止该主体全部会话并撤销当前权限
 * （IDN-008、GOV-009、CAS-FAIL-002）。真实会话由认证链路（3.3）创建；
 * 本端口以撤销版本标记全部现存会话，会话服务据此拒绝继续使用。
 * 与账号状态转换同事务提交（IFC-TX-001）。
 */

export interface SessionRevocationPort {
  /** 立即失效该主体全部未失效会话（按会话撤销版本推进） */
  invalidateSessions(subjectId: string, revokeVersion: number): Promise<void>;
}
