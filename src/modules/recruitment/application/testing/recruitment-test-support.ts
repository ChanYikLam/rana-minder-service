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
import type { RemedyWindowSnapshot } from '../../domain/models/remedy-window';
import type { RecruitmentAuthorizationPort } from '../ports/recruitment-authorization.port';
import { StubRecruitmentForm } from '../ports/recruitment-form.port';
import { RecruitmentDomainError } from '../../domain/errors';

export class InMemoryRecruitmentRepository implements RecruitmentRepository {
  private readonly activities = new Map<string, RecruitmentActivitySnapshot>();
  private readonly channels = new Map<string, ApplicationChannelSnapshot>();
  private readonly applications = new Map<string, ApplicationSnapshot>();
  private readonly paths = new Map<string, DepartmentPathSnapshot>();
  private readonly interviews = new Map<string, InterviewRecordSnapshot>();
  private readonly remedyWindows = new Map<string, RemedyWindowSnapshot>();

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
  async saveApplication(snapshot: ApplicationSnapshot, expectedRevision: number): Promise<void> {
    if (expectedRevision === -1) {
      if (this.applications.has(snapshot.id)) {
        throw new RecruitmentDomainError('REC_CONFLICT', '申请并发冲突，请刷新后重试');
      }
      this.applications.set(snapshot.id, snapshot);
      return;
    }
    const existing = this.applications.get(snapshot.id);
    if (existing === undefined || existing.revisionNumber !== expectedRevision) {
      throw new RecruitmentDomainError(
        'REC_CONFLICT',
        '申请并发冲突（修订号守卫未命中），请刷新后重试',
      );
    }
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
  async saveDepartmentPath(
    snapshot: DepartmentPathSnapshot,
    expectedRevision: number,
  ): Promise<void> {
    if (expectedRevision === -1) {
      if (this.paths.has(snapshot.id)) {
        throw new RecruitmentDomainError('REC_CONFLICT', '部门路径并发冲突，请刷新后重试');
      }
      this.paths.set(snapshot.id, snapshot);
      return;
    }
    const existing = this.paths.get(snapshot.id);
    if (existing === undefined || existing.revisionNumber !== expectedRevision) {
      throw new RecruitmentDomainError(
        'REC_CONFLICT',
        '部门路径并发冲突（修订号守卫未命中），请刷新后重试',
      );
    }
    this.paths.set(snapshot.id, snapshot);
  }
  async loadDepartmentPathsByApplication(applicationId: string): Promise<DepartmentPathSnapshot[]> {
    return [...this.paths.values()].filter((p) => p.applicationId === applicationId);
  }

  async loadInterview(id: string): Promise<InterviewRecordSnapshot | null> {
    return this.interviews.get(id) ?? null;
  }
  async saveInterview(snapshot: InterviewRecordSnapshot, expectedRevision: number): Promise<void> {
    if (expectedRevision === -1) {
      if (this.interviews.has(snapshot.id)) {
        throw new RecruitmentDomainError('REC_CONFLICT', '面试记录并发冲突，请刷新后重试');
      }
      this.interviews.set(snapshot.id, snapshot);
      return;
    }
    const existing = this.interviews.get(snapshot.id);
    if (existing === undefined || existing.revisionNumber !== expectedRevision) {
      throw new RecruitmentDomainError(
        'REC_CONFLICT',
        '面试记录并发冲突（修订号守卫未命中），请刷新后重试',
      );
    }
    this.interviews.set(snapshot.id, snapshot);
  }
  async loadInterviewsByRound(roundId: string): Promise<InterviewRecordSnapshot[]> {
    return [...this.interviews.values()].filter((i) => i.roundId === roundId);
  }
  async loadInterviewsByApplication(applicationId: string): Promise<InterviewRecordSnapshot[]> {
    return [...this.interviews.values()].filter((i) => i.applicationId === applicationId);
  }

  async saveRemedyWindow(snapshot: RemedyWindowSnapshot): Promise<void> {
    this.remedyWindows.set(snapshot.windowId, snapshot);
  }
  async loadRemedyWindow(windowId: string): Promise<RemedyWindowSnapshot | null> {
    return this.remedyWindows.get(windowId) ?? null;
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
