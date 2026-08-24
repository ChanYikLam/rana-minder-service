/**
 * 普通招新域 HTTP 契约类型
 *
 * 端点事实基线：docs/specification/接口清单-HTTP端点-v1.0.md §11
 * 逻辑契约：IFC-SM-008~012、IFC-SM-019、SRS-SM-REC-001~005、SRS-SM-INV-001
 *
 * 错误语义：状态机守卫失败与业务校验一律 422 IFC-ERR-006（不用 409）；
 * 乐观锁以资源 version 字段承载（API-GEN-007）。
 */

import type { ApiListResponse } from './api-envelope';

/* ============ 领域枚举（传输层对外契约） ============ */

export type RecruitmentActivityStatus =
  'draft' | 'in_progress' | 'paused' | 'completed' | 'cancelled' | 'force_completed' | 'archived';

export type RecruitmentChannelStatus = 'not_open' | 'open' | 'paused' | 'closed';

export type ApplicationStatus =
  | 'draft'
  | 'submitted'
  | 'revision_requested'
  | 'revised'
  | 'exited'
  | 'adjustment_overdue'
  | 'identity_anomaly'
  | 'not_qualified'
  | 'accepted';

export type InterviewStatus =
  | 'pending_selection'
  | 'scheduled'
  | 'leave'
  | 'late'
  | 'absent'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'invalidated';

export type RecruitmentInvitationStatus =
  'pending_acceptance' | 'accepted' | 'rejected' | 'withdrawn' | 'expired';

export type InterviewAttendance = 'none' | 'leave' | 'late' | 'absent' | 'present';

export type CasdoorSyncStatus = 'none' | 'processing' | 'confirmed' | 'failed';

/* ============ 报名侧 ============ */

export interface ApplicationPreference {
  departmentId: string;
  departmentName?: string;
}

/** 招新申请完整对象（RecApplication） */
export interface RecApplication {
  id: string;
  activityId: string;
  status: ApplicationStatus;
  preferences: ApplicationPreference[];
  allowAdjustment: boolean;
  answers: Record<string, unknown>;
  formVersion: number | null;
  submittedAt: string | null;
  withdrawnAt: string | null;
  identityAnomalyAt: string | null;
  recoveryWindowDeadline: string | null;
  adjustmentDeadline: string | null;
  adjustmentReason: string | null;
  notQualifiedReason: string | null;
  paths: ApplicationPathMap;
  version: number;
}

/** 部门选拔路径（申请详情内嵌） */
export interface ApplicationPath {
  departmentId: string;
  departmentName: string;
  order: number;
  source: 'volunteer' | 'adjustment';
  status: 'pending' | 'evaluating' | 'hold' | 'decided' | 'waitlist' | 'published';
  decided: 'admit' | 'not_admit' | null;
  labelSetBy: string | null;
  waitlist: boolean;
  holdDeadline: string | null;
  publishedAt: string | null;
  version: number;
}

export type ApplicationPathMap = Record<string, ApplicationPath>;

/** POST /api/activity/recruitment/:activityId/apply 请求 input */
export interface SubmitRecruitmentApplicationInput {
  preferences: Array<{ departmentId: string }>;
  allowAdjustment: boolean;
  answers?: Record<string, unknown>;
}

/** POST /api/activity/recruitment/:activityId/draft 请求 input */
export interface SaveRecruitmentDraftInput {
  answers?: Record<string, unknown>;
}

/** POST /api/activity/recruitment/:activityId/draft 响应 data */
export interface RecApplicationDraftSaved extends RecApplication {
  savedAt: string;
}

/** POST /api/activity/recruitment/:activityId/withdraw 请求 input */
export interface WithdrawRecruitmentInput {
  confirm?: boolean;
}

/* ============ 活动管理 ============ */

export interface RecActivityDepartment {
  id: string;
  name: string;
}

export interface RecruitEligibility {
  colleges: string[];
  grades: string[];
}

export interface VolunteerRules {
  min: number;
  max: number;
}

export interface RecruitWindow {
  seq: number;
  deadline: string;
}

/** 招新活动完整对象（RecActivity） */
export interface RecActivity {
  id: string;
  clubId: string;
  clubName?: string;
  title: string;
  description: string;
  status: RecruitmentActivityStatus;
  channelStatus: RecruitmentChannelStatus;
  deadline: string;
  deadlineVersion: number;
  window: RecruitWindow;
  formId: string | null;
  formVersion: number | null;
  departments: RecActivityDepartment[];
  eligibility: RecruitEligibility;
  volunteerRules: VolunteerRules;
  allowAdjustmentDefault: boolean;
  conclusionMode: string;
  applicantCount: number;
  interviewCount: number;
  invitationCount: number;
  publishedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  version: number;
}

/** 活动列表 item（GET /api/org/:clubId/recruitment、/recruitment/list） */
export interface RecruitmentActivityListItem {
  id: string;
  clubId?: string;
  title: string;
  status: RecruitmentActivityStatus | 'published';
  channelStatus: RecruitmentChannelStatus | 'closed';
  deadline: string;
  applicantCount: number;
  createdAt: string;
}

/** POST /api/org/:clubId/recruitment 请求 input */
export interface CreateRecruitmentInput {
  title: string;
  description?: string;
  deadline?: string;
  departments?: RecActivityDepartment[];
  formId?: string;
}

/** PUT /api/org/:clubId/recruitment/:activityId 请求 input */
export interface UpdateRecruitmentInput {
  title?: string;
  description?: string;
  departments?: RecActivityDepartment[];
  eligibility?: RecruitEligibility;
  volunteerRules?: VolunteerRules;
  formId?: string;
  formVersion?: number;
  conclusionMode?: string;
}

/** POST /api/org/:clubId/recruitment/:activityId/pause 请求 input */
export interface PauseRecruitmentInput {
  reason?: string;
}

/** POST /api/org/:clubId/recruitment/:activityId/cancel 请求 input */
export interface CancelRecruitmentInput {
  reason?: string;
  confirmAcceptedSync?: boolean;
}

/** POST /api/org/:clubId/recruitment/:activityId/channel 请求 input */
export interface RecruitmentChannelActionInput {
  action: 'open' | 'close' | 'pause' | 'resume' | 'reopen';
  reason?: string;
  newDeadline?: string;
}

/* ============ 轮次 ============ */

export interface RecruitmentSlot {
  id: string;
  roundId: string;
  startAt: string;
  endAt: string;
  capacity: number;
  taken: number;
  available: number;
}

export interface RecRound {
  id: string;
  name: string;
  status: 'open' | 'closed' | 'cancelled';
  mode: 'club_unified' | 'dept_separate';
  selectDeadline: string;
  slots: RecruitmentSlot[];
  bookedCount: number;
}

export interface CreateRecruitmentRoundInput {
  name: string;
  mode: 'club_unified' | 'dept_separate';
  selectDeadline: string;
  slots: Array<{ startAt: string; endAt: string; capacity: number }>;
}

export interface UpdateRecruitmentRoundInput {
  name?: string;
  selectDeadline?: string;
}

export interface CancelRecruitmentRoundInput {
  reason?: string;
}

export interface SkipRecruitmentRoundInput {
  applicantId?: string;
  reason?: string;
}

/** POST /api/org/:clubId/recruitment/:activityId/rules/tighten 响应 data */
export interface TightenRulesResult {
  affectedCount: number;
  affected: Array<{
    applicantId: string;
    applicantName: string;
    adjustmentDeadline: string;
  }>;
}

/* ============ 申请管理 ============ */

/** 报名申请列表行（RecApplicationRow） */
export interface RecApplicationRow {
  id: string;
  applicantId: string;
  applicantName: string;
  studentId: string;
  status: ApplicationStatus;
  preferences: ApplicationPreference[];
  submittedAt: string | null;
  version: number;
}

export interface AdjustmentActionInput {
  action: 'extend' | 'not_qualified';
  reason?: string;
  newDeadline?: string;
}

export interface SupplementApplicationInput {
  requirement?: string;
  deadline?: string;
}

export interface NotQualifiedInput {
  reason?: string;
}

export interface RecoveryWindowInput {
  deadline?: string;
}

export interface PathDecisionInput {
  decision: 'admit' | 'not_admit' | 'hold';
  holdDeadline?: string;
}

export interface PathLabelInput {
  label?: boolean;
}

export interface PathWaitlistInput {
  on?: boolean;
}

/* ============ 面试管理 ============ */

export interface RecInterview {
  id: string;
  activityId: string;
  activityTitle: string;
  roundId: string;
  roundName: string;
  applicantId: string;
  applicantName: string;
  studentId: string;
  status: InterviewStatus;
  slotId: string | null;
  scheduledTime: string | null;
  endTime: string | null;
  attendance: InterviewAttendance;
  invalidReason: string | null;
  skipReason: string | null;
  version: number;
}

/** GET /api/org/:clubId/recruitment/:activityId/interviews/:interviewId 响应 data */
export interface RecInterviewDetail extends RecInterview {
  interviewers: Array<{ id: string; name: string }>;
  cancelReason: string | null;
}

/** POST /api/org/:clubId/recruitment/:activityId/interviews/book 请求 input */
export interface BookRecInterviewInput {
  applicantId?: string;
  roundId?: string;
  slotId?: string;
}

/** POST /api/org/:clubId/recruitment/:activityId/interviews/:interviewId/attendance 请求 input */
export interface InterviewAttendanceInput {
  event: 'leave' | 'late' | 'absent';
}

/** POST /api/org/:clubId/recruitment/:activityId/interviews/:interviewId/invalidate 请求 input */
export interface InvalidateInterviewInput {
  reason?: string;
}

/* ============ 面试官任务 ============ */

export interface DefaultReviewer {
  id: string;
  name: string;
  source: 'default';
}

export interface InterviewerTask {
  id: string;
  clubId: string;
  activityId: string;
  kind: 'recruitment' | 'joint';
  scope: 'activity' | 'round';
  roundId: string | null;
  roundName: string | null;
  userId: string;
  userName: string;
  status: 'active' | 'revoked' | 'expired';
  createdAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
}

export interface InterviewersResult {
  defaultReviewers: DefaultReviewer[];
  tasks: InterviewerTask[];
}

export interface AssignInterviewerInput {
  userId?: string;
  userName?: string;
  scope?: 'activity' | 'round';
  roundId?: string;
}

/* ============ 评价与结论 ============ */

export interface ReviewEntry {
  authorName: string;
  authorRole: string;
  comment: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewItem {
  id: string;
  applicantId: string;
  applicantName: string;
  departmentName: string;
  status: 'pending' | 'published' | 'concluded' | 'evaluating';
  rating: number | null;
  comment: string;
  concludedAt: string | null;
  concludedBy: string | null;
  peerViewLocked: boolean;
  reviews: ReviewEntry[];
  myRating: number | null;
  myComment: string;
}

export interface ConcludeReviewInput {
  rating?: number;
  comment?: string;
}

export interface ConcludeReviewResult {
  id: string;
  status: 'concluded';
  rating: number | null;
  comment: string;
  concludedAt: string;
}

export interface PublishReviewsResult {
  publishedCount: number;
}

/* ============ 录取邀请 ============ */

export interface RecInvitation {
  id: string;
  activityId: string;
  applicantId: string;
  applicantName: string;
  departmentId: string;
  departmentName: string;
  status: RecruitmentInvitationStatus;
  sentAt: string;
  acceptedAt: string | null;
  expiredAt: string;
  casdoorSync: CasdoorSyncStatus;
  version: number;
}

export interface CreateRecruitmentInvitationInput {
  applicantId?: string;
  departmentId?: string;
  expireDays?: number;
}

export interface ReissueInvitationInput {
  expireDays?: number;
}

/* ============ 列表结果类型 ============ */

export type RecruitmentActivityListResult = ApiListResponse<RecruitmentActivityListItem>;
export type RecruitmentApplicationListResult = ApiListResponse<RecApplicationRow>;
export type RecruitmentRoundListResult = ApiListResponse<RecRound>;
export type RecInterviewListResult = ApiListResponse<RecInterview>;
export type RecInvitationListResult = ApiListResponse<RecInvitation>;
export type ReviewListResult = ApiListResponse<ReviewItem>;
export type InterviewerCandidateListResult = ApiListResponse<{
  id: string;
  name: string;
  role: string;
}>;
