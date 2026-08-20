/**
 * 姓名更正申请存储端口（IDN-016 聚合根持久化边界）。
 *
 * 业务事实（申请/裁决/同步落点）与审计同事务提交（IFC-TX-001/003）；
 * 证明只存引用，不存附件正文（IDN-016、AUD-003）。
 */

import type {
  NameCorrectionRequestSnapshot,
  NameCorrectionDomainEvent,
} from '../../domain/models/name-correction-request';

export interface NameCorrectionRequestRepository {
  /** 载入申请（不存在返回 null） */
  load(id: string): Promise<NameCorrectionRequestSnapshot | null>;
  /** 查本人待裁决申请（同一主体同时最多一条，IDN-016） */
  findPendingBySubject(subjectId: string): Promise<NameCorrectionRequestSnapshot | null>;
  /** 原子保存：新快照 + 本次领域事件 */
  save(snapshot: NameCorrectionRequestSnapshot, events: readonly NameCorrectionDomainEvent[]): Promise<void>;
}