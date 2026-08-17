/**
 * 个人中心（me）HTTP 契约类型
 *
 * 端点事实基线：docs/specification/接口清单-HTTP端点-v1.0.md §8
 * 逻辑契约：IFC-QRY-003（个人中心集合只读）、IFC-SM-010/016/019/023
 *
 * 约束：个人中心为派生读模型集合，详情和执行逐项重验；列表均为集合只读。
 */

import type { ApiListResponse } from './api-envelope';
import type { CasdoorSyncStatus, InterviewAttendance, RecInterview } from './recruitment.contracts';
import type { JointInterview } from './joint.contracts';

/** GET /api/me/todo 响应 item */
export interface MeTodoItem {
  id: string;
  type: 'invitation' | 'interview';
  title: string;
  description: string;
  deadline: string;
  /** 前端路由，不是授权依据 */
  link: string;
}

/** GET /api/me/ongoing 响应 item */
export interface MeOngoingItem {
  id: string;
  type: 'application' | 'joint';
  title: string;
  description: string;
  submittedAt: string;
  link: string;
  activityId: string;
  status: string;
}

/** GET /api/me/history 响应 item */
export interface MeHistoryItem {
  id: string;
  type: 'application';
  title: string;
  result: '未通过' | '已退出';
  completedAt: string;
}

/** GET /api/me/schedule 响应 item（申请人 + 面试官合并） */
export interface MeScheduleItem {
  id: string;
  title: string;
  activityTitle: string;
  time: string;
  location: string;
  interviewerName: string;
  status: string;
  role: 'applicant' | 'interviewer';
  applicantName: string;
}

/** GET /api/me/interviews/tasks 响应 item */
export interface MeInterviewerTaskItem {
  id: string;
  type: 'recruitment' | 'joint';
  activityId: string;
  activityTitle: string;
  clubId: string;
  clubName: string;
  applicantId: string;
  applicantName: string;
  roundId: string;
  roundName: string;
  status: string;
  startAt: string;
  endAt: string;
  attendance: InterviewAttendance;
  conflict: { conflict: boolean; detail?: string };
}

/** 可选面试时段（本人视角） */
export interface MeAvailableSlot {
  id: string;
  time: string;
  endAt: string;
  capacity: number;
  booked: number;
}

/** GET /api/me/interviews/recruitment/:interviewId 响应 data */
export interface MeRecInterview extends RecInterview {
  interviewers: Array<{ id: string; name: string }>;
  availableSlots: MeAvailableSlot[];
}

/** GET /api/me/interviews/joint/:jointId 响应 data */
export interface MeJointInterview extends JointInterview {
  jointTitle: string;
  availableSlots: Array<MeAvailableSlot & { available: number }>;
}

export interface BookMeInterviewInput {
  slotId: string;
}

/** 本人普通招新录取邀请详情 */
export interface MeRecruitmentInvitation {
  id: string;
  activityId: string;
  activityTitle: string;
  clubName: string;
  applicantName: string;
  status: string;
  sentAt: string;
  acceptedAt: string | null;
  expiredAt: string;
  departmentName: string;
  casdoorSync: CasdoorSyncStatus;
}

/** 本人联合录取邀请详情 */
export interface MeJointInvitation {
  id: string;
  jointId: string;
  jointTitle: string;
  clubName: string;
  applicantName: string;
  type: 'admit' | 'join';
  status: string;
  sentAt: string;
  acceptedAt: string | null;
  expiredAt: string;
  reviewFlag: boolean;
  casdoorSync: CasdoorSyncStatus;
}

export interface RespondInvitationInput {
  action: 'accept' | 'reject';
}

/** GET /api/me/invitations/membership 响应 item */
export interface MembershipInvitationItem {
  id: string;
  clubId: string;
  clubName: string;
  candidateName: string;
  departmentId: string;
  departmentName: string;
  status: string;
  sentAt: string;
  expiredAt: string;
  acceptedAt: string | null;
}

/** GET /api/me/invitations/membership/:invitationId 响应 data */
export interface MembershipInvitationDetail {
  id: string;
  clubId: string;
  clubName: string;
  candidateId: string;
  candidateName: string;
  departmentId: string;
  departmentName: string;
  status: string;
  sentAt: string;
  expiredAt: string;
  acceptedAt: string | null;
}

export interface MembershipInvitationRespondResult {
  id: string;
  status: string;
  acceptedAt?: string;
}

export interface MembershipInvitationSyncConfirmResult {
  id: string;
  status: 'effective';
}

/* ============ 列表结果类型 ============ */

export type MeTodoResult = ApiListResponse<MeTodoItem>;
export type MeOngoingResult = ApiListResponse<MeOngoingItem>;
export type MeHistoryResult = ApiListResponse<MeHistoryItem>;
export type MeScheduleResult = ApiListResponse<MeScheduleItem>;
export type MeInterviewerTasksResult = ApiListResponse<MeInterviewerTaskItem>;
export type MembershipInvitationListResult = ApiListResponse<MembershipInvitationItem>;
