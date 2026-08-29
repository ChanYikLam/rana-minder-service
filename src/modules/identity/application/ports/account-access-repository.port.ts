/**
 * 账号访问聚合根存储端口（IDN-001 持久化边界）。
 *
 * 账号禁用/删除/降级/恢复与审计同事务提交（ENG-004/AUD-003）；
 * 会话撤销版本由聚合根推进，基础设施据此失效会话。
 */

import type {
  AccountAccessSnapshot,
  AccountAccessDomainEvent,
} from '../../domain/models/account-access';

export interface AccountAccessRepository {
  /** 载入账号访问聚合根（不存在返回 null） */
  load(subjectId: string): Promise<AccountAccessSnapshot | null>;
  /**
   * 原子保存：新快照 + 本次变更领域事件。
   * expectedStateVersion：调用方期望的当前版本（用于 SQL 层乐观锁守卫）。
   *   - 新建主体：传 -1，INSERT 路径生效；
   *   - 更新：传读取时的旧 state_version；DB 行不匹配 → 0 行更新 → 抛 CAS 冲突。
   * 账号状态机高敏感（CAS-FAIL-002/CAS-SEC-001），禁止 last-write-wins 覆盖。
   */
  save(
    snapshot: AccountAccessSnapshot,
    expectedStateVersion: number,
    events: readonly AccountAccessDomainEvent[],
  ): Promise<void>;
}
