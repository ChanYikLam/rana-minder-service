/**
 * 联合活动域 HTTP 契约类型
 *
 * 端点事实基线：docs/specification/接口清单-HTTP端点-v1.0.md §12
 * 逻辑契约：IFC-SM-013~018、IFC-SM-019、SRS-SM-JNT-001~006、SRS-SM-INV-001
 */

import type { ApiListResponse } from './api-envelope';
import type { CasdoorSyncStatus, InterviewerTask } from './recruitment.contracts';

/* ============ 领域枚举 ============ */

export type JointActivityStatus =
  | 'draft'
  | 'confirmed'
  | 'published'
  | 'invite_phase'
  | 'closing_confirm'
  | 'closed'
  | 'cancelled'
  | 'force_closed';

export type JointClubStatus =
  'invited' | 'accepted' | 'confirm_pending' | 'locked' | 'force_suspended' | 'removed';

export type JointChannelStatus = 'not_open' | 'open' | 'paused' | 'closed';

export type JointApplicationStatus = 'draft' | 'submitted' | 'archived';

export type JointConclusionStatus =
  'pending' | 'evaluating' | 'invite_pending' | 'accepted_locked' | 'archived';

export type JointInterviewStatus =
  | 'pending_selection'
  | 'scheduled'
  | 'leave'
  | 'late'
  | 'absent'
  | 'in_progress'
  | 'completed'
  | 'invalidated'
  | 'cancelled_archived'
  | 'completed_archived';

export type JointInvitationStatus =
  'pending_acceptance' | 'accepted' | 'rejected' | 'withdrawn' | 'expired';

export type JointInvitationType = 'admit' | 'join';

/* ============ 活动管理 ============ */

export interface JointParticipantClub {
  clubId: string;
  clubName: string;
  status: JointClubStatus;
  confirmedAt: string | null;
  confirmedBy: string | null;
}

export interface JointActivityRow {
  id: string;
  title: string;
  status: JointActivityStatus;
  channelStatus: JointChannelStatus;
  deadline: string;
  participantClubs: string[];
  applicantCount: number;
  confirmRound: number;
  confirmDeadline: string;
  createdAt: string;
  version: number;
  myClubStatus: JointClubStatus | null;
}

/** 完整 JointActivity（详情） */
export interface JointActivity extends JointActivityRow {
  description: string;
  sharedAgreement: { version: number; text: string };
  participants: JointParticipantClub[];
  cancelConfirmRound: number;
  cancelConfirmDeadline: string | null;
  endConfirmRound: number;
  endConfirmDeadline: string | null;
  publishedAt: string | null;
  firstInviteAt: string | null;
  closedAt: string | null;
  forceClosedAt: string | null;
}

export interface CreateJointActivityInput {
  title?: string;
  description?: string;
  clubIds?: string[];
  confirmDeadline?: string;
  sharedAgreement?: string;
}

export interface JointCancelInput {
  confirm?: boolean;
  reason?: string;
}

export interface JointClubsInput {
  clubIds: string[];
  newDeadline?: string;
}

export interface JointChannelActionInput {
  action: 'open' | 'pause' | 'resume' | 'extend' | 'close' | 'reopen';
  deadline?: string;
  reason?: string;
}

export interface JointClosePanel {
  id: string;
  title: string;
  status: JointActivityStatus;
  participants: Array<{
    clubId: string;
    clubName: string;
    status: JointClubStatus;
    concludedCount: number;
    invitationSent: number;
    endConfirmed: boolean;
  }>;
  totalApplicants: number;
  endConfirmRound: number;
  endConfirmDeadline: string | null;
  canClose: boolean;
}

/* ============ 联合申请 ============ */

export interface JointApplication {
  id: string;
  jointId: string;
  applicantId: string;
  applicantName: string;
  applicantStudentId: string;
  status: JointApplicationStatus;
  consented: boolean;
  consentAt: string | null;
  agreementVersion: number | null;
  allowJointAdjustment: boolean;
  volunteerClubIds: string[];
  volunteerClubSnapshot: string[] | null;
  agreementClubSnapshot: string[] | null;
  submittedAt: string | null;
  version: number;
}

export interface JointApplicationDetail extends JointApplication {
  answers: Record<string, unknown>;
  formVersion: number | null;
}

export interface SubmitJointApplicationInput {
  consented: boolean;
  allowJointAdjustment: boolean;
  volunteerClubIds?: string[];
  answers?: Record<string, unknown>;
  preferences?: Array<{ departmentId: string; departmentName: string }>;
}

export interface SaveJointDraftInput {
  answers?: Record<string, unknown>;
  volunteerClubIds?: string[];
  allowJointAdjustment?: boolean;
  consented?: boolean;
  preferences?: Array<{ departmentId: string; departmentName: string }>;
}

/* ============ 联合面试 ============ */

export interface JointSlot {
  id: string;
  startAt: string;
  endAt: string;
  capacity: number;
  available: number;
}

export interface JointInterviewReview {
  clubId: string;
  clubName: string;
  rating: number | null;
  comment: string;
  concludedAt: string | null;
  author: string;
  authorRole: string;
  version: number;
}

export interface JointInterview {
  id: string;
  jointId: string;
  applicantId: string;
  applicantName: string;
  status: JointInterviewStatus;
  slotId: string | null;
  scheduledTime: string | null;
  endTime: string | null;
  attendance: string;
  invalidReason: string | null;
  attempt: number;
  version: number;
  reviews: JointInterviewReview[];
}

export interface BookJointInterviewInput {
  applicantId?: string;
  slotId?: string;
}

export interface JointAttendanceInput {
  event: 'leave' | 'late' | 'absent';
}

export interface InvalidateJointInterviewInput {
  reason?: string;
}

/* ============ 联合结论 ============ */

export interface JointConclusionVersion {
  id: string;
  conclusion: 'admit' | 'not_admit' | null;
  rating: number | null;
  comment: string;
  authorName: string;
  authorRole: string;
  createdAt: string;
}

export interface JointConclusion {
  id: string;
  applicantId: string;
  applicantName: string;
  clubId: string;
  clubName: string;
  status: JointConclusionStatus;
  conclusion: 'admit' | 'not_admit' | null;
  reviewFlag: boolean;
  rating: number | null;
  comment: string;
  concludedAt: string | null;
  version: number;
  authorName: string;
  authorRole: string;
  history: string[];
  versions: JointConclusionVersion[];
  myClub: boolean;
}

export interface SetJointConclusionInput {
  conclusion: 'admit' | 'not_admit';
}

export interface ReviewJointConclusionInput {
  action: 'keep' | 'modify';
  newConclusion?: 'admit' | 'not_admit';
}

export interface EvaluateJointConclusionInput {
  rating?: number;
  comment?: string;
}

export interface EvaluateJointConclusionResult {
  id: string;
  status: 'concluded';
  rating: number | null;
  comment: string;
  concludedAt: string;
  author: string;
  authorRole: string;
  version: number;
  history: string[];
}

/* ============ 联合邀请 ============ */

export interface JointInvitation {
  id: string;
  jointId: string;
  applicantId: string;
  applicantName: string;
  clubId: string;
  clubName: string;
  type: JointInvitationType;
  status: JointInvitationStatus;
  sentAt: string;
  acceptedAt: string | null;
  expiredAt: string;
  reviewFlag: boolean;
  casdoorSync: CasdoorSyncStatus;
  version: number;
}

export interface CreateJointInvitationInput {
  applicantId?: string;
  clubId?: string;
  expireDays?: number;
}

/* ============ 面试官任务（联合） ============ */

export interface AssignJointInterviewerInput {
  userId?: string;
  userName?: string;
}

/* ============ 平台管理（joint） ============ */

export interface AdminJointListItem {
  id: string;
  title: string;
  status: JointActivityStatus;
  participants: string[];
  applicantCount: number;
  canForceClose: boolean;
  clubs: Array<{ clubId: string; clubName: string; suspended: boolean }>;
}

export interface ForceCloseJointInput {
  reason?: string;
}

/* ============ 列表结果类型 ============ */

export type JointActivityListResult = ApiListResponse<JointActivityRow>;
export type JointApplicationListResult = ApiListResponse<JointApplication>;
export type JointSlotListResult = ApiListResponse<JointSlot>;
export type JointInterviewListResult = ApiListResponse<JointInterview>;
export type JointConclusionListResult = ApiListResponse<JointConclusion>;
export type JointInvitationListResult = ApiListResponse<JointInvitation>;
export type AdminJointListResult = ApiListResponse<AdminJointListItem>;
export type JointInterviewersResult = {
  defaultReviewers: Array<{ id: string; name: string; source: 'default' }>;
  tasks: InterviewerTask[];
};
