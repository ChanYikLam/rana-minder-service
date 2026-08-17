/**
 * 组织工作空间 HTTP 契约类型
 *
 * 端点事实基线：docs/specification/接口清单-HTTP端点-v1.0.md §5
 * 逻辑契约：IFC-GEN-004（普通社团单目标作用域）、IFC-QRY-003（管理工作台）
 */

import type { WorkspaceRole } from './auth.contracts';

/** GET /api/org/:clubId/context 响应 data */
export interface OrgContext {
  clubId: string;
  clubName: string;
  role: WorkspaceRole;
  permissions: string[];
  memberId: string | null;
}

/** GET /api/org/:clubId/dashboard 响应 data */
export interface OrgDashboard {
  club: { id: string; name: string };
  role: string;
  permissions: string[];
  metrics: {
    pendingReviews: number;
    pendingInterviews: number;
    pendingResults: number;
    syncErrors: number;
  };
  todos: Array<{
    id: string;
    type: 'application_review' | 'interview_schedule' | 'invitation_pending';
    title: string;
    count: number;
  }>;
  recentActivities: unknown[];
}
