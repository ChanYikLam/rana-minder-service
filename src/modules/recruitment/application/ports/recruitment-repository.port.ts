// no-spec-required 纯接口端口（无实现逻辑），由基础设施实现（postgres-recruitment.repository.spec.ts）与内存实现（recruitment-test-support）实际覆盖验证
/**
 * 招新仓储端口（recruitment 应用层；聚合持久化边界）。
 *
 * 涵盖 REC-001~005 全部聚合读写；内存实现用于测试，PostgreSQL 实现在基础设施层。
 */

import type { RecruitmentActivitySnapshot } from '../../domain/models/recruitment-activity';
import type { ApplicationChannelSnapshot } from '../../domain/models/application-channel';
import type { ApplicationSnapshot } from '../../domain/models/application';
import type { DepartmentPathSnapshot } from '../../domain/models/department-path';
import type { InterviewRecordSnapshot } from '../../domain/models/interview-record';
import type { RemedyWindowSnapshot } from '../../domain/models/remedy-window';

export interface RecruitmentRepository {
  loadActivity(id: string): Promise<RecruitmentActivitySnapshot | null>;
  saveActivity(snapshot: RecruitmentActivitySnapshot): Promise<void>;
  loadActivitiesByClub(clubId: string): Promise<RecruitmentActivitySnapshot[]>;

  loadChannel(id: string): Promise<ApplicationChannelSnapshot | null>;
  saveChannel(snapshot: ApplicationChannelSnapshot): Promise<void>;

  loadApplication(id: string): Promise<ApplicationSnapshot | null>;
  saveApplication(snapshot: ApplicationSnapshot, expectedRevision: number): Promise<void>;
  loadApplicationByApplicantAndChannel(
    applicantId: string,
    channelId: string,
  ): Promise<ApplicationSnapshot | null>;
  loadApplicationsByActivity(activityId: string): Promise<ApplicationSnapshot[]>;

  loadDepartmentPath(id: string): Promise<DepartmentPathSnapshot | null>;
  saveDepartmentPath(snapshot: DepartmentPathSnapshot, expectedRevision: number): Promise<void>;
  loadDepartmentPathsByApplication(applicationId: string): Promise<DepartmentPathSnapshot[]>;

  loadInterview(id: string): Promise<InterviewRecordSnapshot | null>;
  saveInterview(snapshot: InterviewRecordSnapshot, expectedRevision: number): Promise<void>;
  loadInterviewsByRound(roundId: string): Promise<InterviewRecordSnapshot[]>;
  /** 按申请查面试记录（A2 撤销守卫：未排期/无结论才可撤回草稿） */
  loadInterviewsByApplication(applicationId: string): Promise<InterviewRecordSnapshot[]>;

  saveRemedyWindow(snapshot: RemedyWindowSnapshot): Promise<void>;
  loadRemedyWindow(windowId: string): Promise<RemedyWindowSnapshot | null>;
}
