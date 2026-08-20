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
  /** 原子保存：新快照 + 本次变更领域事件 */
  save(snapshot: AccountAccessSnapshot, events: readonly AccountAccessDomainEvent[]): Promise<void>;
}