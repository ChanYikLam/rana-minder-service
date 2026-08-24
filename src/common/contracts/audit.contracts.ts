/**
 * 事实纠错与审计域 HTTP 契约类型
 *
 * 端点事实基线：docs/specification/接口清单-HTTP端点-v1.0.md §16
 * 逻辑契约：IFC-SM-028、SRS-SM-AUD-001、DATA-AUD-*、XCC-AUD-001
 *
 * 纠错状态机 SM-AUD-001：submitted → approved|rejected|withdrawn；
 * 逾期末处置视为 overdue；仅 submitted/overdue 可批/可撤，否则 409 IFC-ERR-007。
 */

import type { ApiListResponse } from './api-envelope';

export type CorrectionStatus = 'submitted' | 'overdue' | 'approved' | 'rejected' | 'withdrawn';

export interface CorrectionAuditTrailItem {
  action: 'submit' | 'approve' | 'reject' | 'withdraw';
  actorName: string;
  at: string;
  note?: string;
}

/** CorrectionRecord（me/org/admin 三域共用结构） */
export interface CorrectionRecord {
  id: string;
  targetType: string;
  targetId: string;
  reason: string;
  evidence: string;
  status: CorrectionStatus;
  submittedAt: string;
  submitterName: string;
  decidedBy?: string;
  decidedAt?: string;
  withdrawnBy?: string;
  withdrawnAt?: string;
  auditTrail: CorrectionAuditTrailItem[];
}

export interface CreateCorrectionInput {
  targetType: string;
  targetId: string;
  reason: string;
  evidence: string;
}

export interface DecideCorrectionInput {
  decision: 'approve' | 'reject';
}

/** GET /api/org/:clubId/audit/logs、GET /api/admin/audit/logs 响应 item */
export interface AuditLogItem {
  id: string;
  actorName: string;
  action: string;
  targetType: string;
  targetId: string;
  detail: string;
  createdAt: string;
  scope: 'org' | 'platform';
}

export type CorrectionListResult = ApiListResponse<CorrectionRecord>;
export type AuditLogListResult = ApiListResponse<AuditLogItem>;
