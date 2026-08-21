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

export interface RecruitmentRepository {
  loadActivity(id: string): Promise<RecruitmentActivitySnapshot | null>;
  saveActivity(snapshot: RecruitmentActivitySnapshot): Promise<void>;
  loadActivitiesByClub(clubId: string): Promise<RecruitmentActivitySnapshot[]>;

  loadChannel(id: string): Promise<ApplicationChannelSnapshot | null>;
  saveChannel(snapshot: ApplicationChannelSnapshot): Promise<void>;

  loadApplication(id: string): Promise<ApplicationSnapshot | null>;
  saveApplication(snapshot: ApplicationSnapshot): Promise<void>;
  loadApplicationByApplicantAndChannel(
    applicantId: string,
    channelId: string,
  ): Promise<ApplicationSnapshot | null>;
  loadApplicationsByActivity(activityId: string): Promise<ApplicationSnapshot[]>;

  loadDepartmentPath(id: string): Promise<DepartmentPathSnapshot | null>;
  saveDepartmentPath(snapshot: DepartmentPathSnapshot): Promise<void>;
  loadDepartmentPathsByApplication(applicationId: string): Promise<DepartmentPathSnapshot[]>;

  loadInterview(id: string): Promise<InterviewRecordSnapshot | null>;
  saveInterview(snapshot: InterviewRecordSnapshot): Promise<void>;
  loadInterviewsByRound(roundId: string): Promise<InterviewRecordSnapshot[]>;
}
