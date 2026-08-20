/**
 * 平台公共资料存储端口（IDN-002 聚合根持久化边界）。
 *
 * 业务事实与同步意图/审计同事务提交（IFC-TX-001/003）；事务边界由基础设施实现，
 * 本端口只声明快照读写（禁止携带明文令牌、附件正文或完整外部响应）。
 */

import type { ProfileSnapshot, ProfileDomainEvent } from '../../domain/models/profile';

export interface ProfileRepository {
  /** 载入本人平台公共资料（不存在返回 null） */
  load(subjectId: string): Promise<ProfileSnapshot | null>;
  /** 原子保存：新快照 + 本次变更领域事件 */
  save(snapshot: ProfileSnapshot, events: readonly ProfileDomainEvent[]): Promise<void>;
}