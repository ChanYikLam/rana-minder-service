/**
 * 会话失效端口（IDN-008 依赖边界）。
 *
 * 禁用/删除的可信确认到达后，本地必须立即终止该主体全部会话并撤销当前权限
 * （IDN-008、GOV-009、CAS-FAIL-002）。真实会话由认证链路（3.3）创建；
 * 本端口以撤销版本标记全部现存会话，会话服务据此拒绝继续使用。
 * 与账号状态转换同事务提交（IFC-TX-001）。
 */

/** 主体当前会话吊销状态（用于会话解析/审计查询） */
export interface SessionRevocation {
  /** 当前撤销版本（auth_sessions 中该主体的最大 revoke_version） */
  readonly revokeVersion: number;
  /** 最近一次吊销时间；主体从未被吊销时为 null */
  readonly revokedAt: string | null;
}

export interface SessionRevocationPort {
  /** 立即失效该主体全部未失效会话（按会话撤销版本推进） */
  invalidateSessions(subjectId: string, revokeVersion: number): Promise<void>;

  /**
   * 读取主体当前会话吊销状态（BUG-003 修复）。
   * 供会话解析/审计查询使用，独立于账号状态用例事务，自身管理只读事务。
   */
  getRevocation(subjectId: string): Promise<SessionRevocation | null>;

  /**
   * 失效主体全部未失效会话并将撤销版本自增（BUG-007 修复）。
   * 用于登出/主动吊销：不依赖调用方传入版本，自身计算下一版本号。
   * 须在身份域工作单元事务内调用（this.uow.active）。
   */
  invalidateAllSessions(subjectId: string): Promise<number>;
}
