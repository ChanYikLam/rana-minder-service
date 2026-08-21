/**
 * recruitment 应用层测试桩（spec 共用；不用于生产）。
 *
 * - InMemoryRecruitmentRepository：全部聚合内存存储，状态守卫同 PostgreSQL 仓储；
 * - 桩端口：授权（可编程）、表单（可编程 seed）。
 */

import { randomUUID } from 'node:crypto';

import type { RecruitmentRepository } from '../ports/recruitment-repository.port';
import type { RecruitmentActivitySnapshot } from '../../domain/models/recruitment-activity';
import type { ApplicationChannelSnapshot } from '../../domain/models/application-channel';
import type { ApplicationSnapshot } from '../../domain/models/application';
import type { DepartmentPathSnapshot } from '../../domain/models/department-path';
import type { InterviewRecordSnapshot } from '../../domain/models/interview-record';
import type { RecruitmentAuthorizationPort } from '../ports/recruitment-authorization.port';
import { StubRecruitmentForm } from '../ports/recruitment-form.port';

export class InMemoryRecruitmentRepository implements RecruitmentRepository {
  private readonly activities = new Map<string, RecruitmentActivitySnapshot>();
  private readonly channels = new Map<string, ApplicationChannelSnapshot>();
  private readonly applications = new Map<string, ApplicationSnapshot>();
  private readonly paths = new Map<string, DepartmentPathSnapshot>();
  private readonly interviews = new Map<string, InterviewRecordSnapshot>();

  async loadActivity(id: string): Promise<RecruitmentActivitySnapshot | null> {
    return this.activities.get(id) ?? null;
  }
  async saveActivity(snapshot: RecruitmentActivitySnapshot): Promise<void> {
    this.activities.set(snapshot.id, snapshot);
  }
  async loadActivitiesByClub(clubId: string): Promise<RecruitmentActivitySnapshot[]> {
    return [...this.activities.values()].filter((a) => a.clubId === clubId);
  }

  async loadChannel(id: string): Promise<ApplicationChannelSnapshot | null> {
    return this.channels.get(id) ?? null;
  }
  async saveChannel(snapshot: ApplicationChannelSnapshot): Promise<void> {
    this.channels.set(snapshot.id, snapshot);
  }

  async loadApplication(id: string): Promise<ApplicationSnapshot | null> {
    return this.applications.get(id) ?? null;
  }
  async saveApplication(snapshot: ApplicationSnapshot): Promise<void> {
    this.applications.set(snapshot.id, snapshot);
  }
  async loadApplicationByApplicantAndChannel(
    applicantId: string,
    channelId: string,
  ): Promise<ApplicationSnapshot | null> {
    return (
      [...this.applications.values()].find(
        (a) => a.applicantId === applicantId && a.channelId === channelId,
      ) ?? null
    );
  }
  async loadApplicationsByActivity(activityId: string): Promise<ApplicationSnapshot[]> {
    return [...this.applications.values()].filter((a) => a.activityId === activityId);
  }

  async loadDepartmentPath(id: string): Promise<DepartmentPathSnapshot | null> {
    return this.paths.get(id) ?? null;
  }
  async saveDepartmentPath(snapshot: DepartmentPathSnapshot): Promise<void> {
    this.paths.set(snapshot.id, snapshot);
  }
  async loadDepartmentPathsByApplication(applicationId: string): Promise<DepartmentPathSnapshot[]> {
    return [...this.paths.values()].filter((p) => p.applicationId === applicationId);
  }

  async loadInterview(id: string): Promise<InterviewRecordSnapshot | null> {
    return this.interviews.get(id) ?? null;
  }
  async saveInterview(snapshot: InterviewRecordSnapshot): Promise<void> {
    this.interviews.set(snapshot.id, snapshot);
  }
  async loadInterviewsByRound(roundId: string): Promise<InterviewRecordSnapshot[]> {
    return [...this.interviews.values()].filter((i) => i.roundId === roundId);
  }
}

export class StubRecruitmentAuthorization implements RecruitmentAuthorizationPort {
  manageAllowed = false;
  submitAllowed = false;

  async canManageRecruitment(): Promise<boolean> {
    return this.manageAllowed;
  }
  async canSubmitApplication(): Promise<boolean> {
    return this.submitAllowed;
  }
}

export { StubRecruitmentForm, randomUUID };
