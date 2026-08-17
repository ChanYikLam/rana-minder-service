/**
 * 成员生命周期域 HTTP 契约类型
 *
 * 端点事实基线：docs/specification/接口清单-HTTP端点-v1.0.md §10
 * 逻辑契约：IFC-SM-020~023、SRS-SM-MEM-001~004、SRS-SM-ORG-003/004
 */

import type { ApiListResponse } from './api-envelope';

export type MemberStatus = 'non_member' | 'pending_effective' | 'active' | 'exiting' | 'exited' | 'sync_anomaly';

export type PositionStatus = 'active' | 'pending_confirmation' | 'transferring' | 'suspended' | 'ended';

export type AppointmentCommandAction = 'appoint' | 'transfer' | 'dismiss';

export type AppointmentCommandStatus =
  | 'pending_exec'
  | 'initiator_lost_rights'
  | 'precondition_failed'
  | 'reconfirmed'
  | 'cancelled'
  | 'executing'
  | 'executed'
  | 'exec_failed';

export type DepartmentApplyType = 'join' | 'leave' | 'transfer';

export type DepartmentApplyStatus =
  | 'under_review'
  | 'approved_pending_exec'
  | 'executing'
  | 'effective'
  | 'exec_failed'
  | 'rejected'
  | 'withdrawn';

export type ResignationStatus = 'under_review' | 'approved' | 'rejected' | 'withdrawn';

export type MembershipInvitationStatus =
  | 'sent'
  | 'pending_acceptance'
  | 'accepted_pending_sync'
  | 'effective'
  | 'sync_failed'
  | 'sync_anomaly'
  | 'withdrawn'
  | 'rejected'
  | 'expired'
  | 'target_already_member';

/* ============ 成员列表与详情 ============ */

/** GET /api/org/:clubId/members 响应 item */
export interface MemberListItem {
  id: string;
  name: string;
  studentId: string;
  email: string;
  phone: string;
  positions: Array<{ departmentId: string; departmentName: string; title: string; status: PositionStatus }>;
  department: string;
  title: string;
  status: MemberStatus;
  joinedAt: string;
  exitedAt: string | null;
}

export interface MemberListStats {
  total: number;
  active: number;
  exited: number;
  byDepartment: Array<{ id: string; name: string; count: number }>;
  zeroDepartment: number;
}

export interface MemberListPendingCounts {
  departmentApply: number;
  appointments: number;
  transition: number;
}

/** GET /api/org/:clubId/members 响应 data */
export interface MemberListResult {
  items: MemberListItem[];
  stats: MemberListStats;
  pendingCounts: MemberListPendingCounts;
  nextCursor: string | null;
}

/** GET /api/org/:clubId/members/:memberId 响应 data */
export interface MemberDetail {
  id: string;
  clubId: string;
  studentId: string;
  name: string;
  email: string;
  phone: string;
  status: MemberStatus;
  joinedAt: string;
  exitedAt: string | null;
  positions: Array<{
    id: string;
    departmentId: string;
    departmentName: string;
    title: string;
    startDate: string;
    endDate: string | null;
    status: PositionStatus;
  }>;
  tenures: Array<{
    id: string;
    departmentName: string;
    title: string;
    startDate: string;
    endDate: string | null;
    endReason: string | null;
  }>;
  departmentHistory: Array<{
    id: string;
    action: 'join' | 'leave' | 'transfer';
    departmentName: string;
    at: string;
  }>;
  anomalies: Array<{
    id: string;
    kind: 'casdoor_mismatch' | 'external_change';
    message: string;
    createdAt: string;
  }>;
}

/* ============ 任命/调岗/免职（预约命令） ============ */

export interface AppointmentCommandListItem {
  id: string;
  action: AppointmentCommandAction;
  memberId: string;
  memberName: string;
  departmentId: string | null;
  departmentName: string | null;
  title: string | null;
  scheduledAt: string | null;
  status: AppointmentCommandStatus;
  createdAt: string;
  createdBy: string;
  executedAt: string | null;
  failReason: string | null;
}

/** GET /api/org/:clubId/members/appointments 响应 data */
export interface AppointmentsView {
  items: Array<{
    id: string;
    name: string;
    studentId: string;
    department: string;
    title: string;
    status: MemberStatus;
  }>;
  departments: string[];
  titles: string[];
  commands: AppointmentCommandListItem[];
}

export interface CreateAppointmentInput {
  action: AppointmentCommandAction;
  memberId: string;
  departmentId: string | null;
  title: string | null;
  scheduledAt: string | null;
}

export interface AppointmentCommandResult {
  id: string;
  status: AppointmentCommandStatus;
}

export interface ExecuteAppointmentResult extends AppointmentCommandResult {
  failed: boolean;
  message?: string;
}

export interface ReconfirmAppointmentInput {
  scheduledAt?: string;
}

/* ============ 部门关系申请 ============ */

export interface DepartmentApplyItem {
  id: string;
  applicantId: string;
  applicantName: string;
  type: DepartmentApplyType;
  currentDept: string | null;
  targetDeptId: string;
  targetDeptName: string;
  reason: string;
  status: DepartmentApplyStatus;
  submittedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  rejectReason: string | null;
}

/** GET /api/org/:clubId/members/department-apply 响应 data */
export interface DepartmentApplyListResult {
  items: DepartmentApplyItem[];
  departments: Array<{ id: string; name: string }>;
  nextCursor: string | null;
}

export interface CreateDepartmentApplyInput {
  type: DepartmentApplyType;
  targetDeptId: string;
  reason: string;
}

export interface DepartmentApplyCreated {
  id: string;
  status: 'under_review';
  submittedAt: string;
}

export interface DecideDepartmentApplyInput {
  decision: 'approve' | 'reject';
  rejectReason?: string;
}

export interface DepartmentApplyDecideResult {
  id: string;
  status: 'approved_pending_exec' | 'rejected';
}

export interface DepartmentApplyExecuteResult {
  id: string;
  status: 'effective' | 'exec_failed';
  failed: boolean;
  message?: string;
}

export interface DepartmentApplyWithdrawResult {
  id: string;
  status: 'withdrawn';
}

/* ============ 辞职 ============ */

export interface ResignationItem {
  id: string;
  clubId: string;
  memberId: string;
  memberName: string;
  departmentName: string;
  title: string;
  reason: string;
  status: ResignationStatus;
  submittedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  syncWarning?: boolean;
}

export interface CreateResignationInput {
  reason: string;
}

export interface ResignationCreated {
  id: string;
  status: 'under_review';
  submittedAt: string;
}

export interface DecideResignationInput {
  decision: 'approve' | 'reject';
}

export interface ResignationDecideResult {
  id: string;
  status: 'approved' | 'rejected';
}

/* ============ 成员退出（管理员移除） ============ */

export interface MemberExitListResult {
  items: MemberListItem[];
  resignations: ResignationItem[];
  nextCursor: string | null;
}

export interface RemoveMemberInput {
  memberId: string;
  reason?: string;
}

export interface RemoveMemberResult {
  memberId: string;
  status: 'removed';
}

/* ============ 常规入社邀请 ============ */

export interface MembershipInvitationRow {
  id: string;
  candidateId: string;
  candidateName: string;
  candidateStudentId: string;
  departmentId: string;
  departmentName: string;
  status: MembershipInvitationStatus;
  sentAt: string;
  expiredAt: string;
  acceptedAt: string | null;
  withdrawnAt: string | null;
}

export interface CreateMembershipInvitationInput {
  candidateId: string;
  departmentId: string | null;
  /** 默认 7 天 */
  expireDays?: number;
}

export interface MembershipInvitationCreated {
  id: string;
  status: 'sent';
  sentAt: string;
}

export interface MembershipInvitationCandidate {
  id: string;
  studentId: string;
  name: string;
  email: string;
  phone: string;
  isMember: false;
}

export interface MembershipInvitationWithdrawResult {
  id: string;
  status: 'withdrawn';
  withdrawnAt: string;
}

/* ============ 换届 ============ */

export interface TransitionView {
  currentLeader: { id: string; name: string; title: string } | null;
  candidates: Array<{
    memberId: string;
    name: string;
    currentTitle: string;
    proposedTitle: string;
    department: string;
  }>;
  appointments: unknown[];
  canExecute: boolean;
  executedAt: string | null;
  results: Array<{
    memberId: string;
    name: string;
    action: string;
    targetTitle: string;
    success: boolean;
    message: string;
  }>;
  syncFailures: Array<{
    memberId: string;
    memberName: string;
    title: string;
    active: boolean;
    error: string;
  }>;
  failOn: 'none' | 'partial';
}

export interface SaveTransitionPlanInput {
  candidates?: unknown[];
  appointments?: unknown[];
}

export interface SaveTransitionPlanResult {
  saved: true;
}

export interface ExecuteTransitionResult {
  executedAt: string;
  results: TransitionView['results'];
  finishedAt: null;
  syncFailures: TransitionView['syncFailures'];
}

/* ============ 受控批量 ============ */

export interface BatchCandidateItem {
  id: string;
  name: string;
  studentId: string;
  department: string;
  status: 'submitted' | 'revision_requested';
}

export interface BatchExecuteInput {
  memberIds: string[];
  action: string;
  interviewerId?: string;
}

export interface BatchExecuteResult {
  results: Array<{ memberId: string; success: boolean; message: string }>;
  completedAt: string;
  auditRef: string;
}

/* ============ 列表结果类型 ============ */

export type MemberListApiResult = ApiListResponse<MemberListItem>;
export type DepartmentApplyApiListResult = ApiListResponse<DepartmentApplyItem>;
export type ResignationApiListResult = ApiListResponse<ResignationItem>;
export type MembershipInvitationApiListResult = ApiListResponse<MembershipInvitationRow>;
export type BatchCandidateListResult = ApiListResponse<BatchCandidateItem>;
export type MembershipInvitationCandidateListResult = ApiListResponse<MembershipInvitationCandidate>;
