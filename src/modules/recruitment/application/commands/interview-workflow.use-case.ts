/**
 * 面试记录工作流用例（REC-005、REC-011/012/013/040/041）。
 *
 * 调度/开始/完成/作废/取消/跳轮/暂缓/恢复由负责人/人事操作（fail-closed 授权桩）；
 * 评价允许面试官本人或负责人/人事，追加版本。
 */

import { randomUUID } from 'node:crypto';

import { InterviewRecord } from '../../domain/models/interview-record';
import { DefaultInterviewRecordStateMachine } from '../../domain/state-machines/interview-record.state-machine';
import type { RecruitmentRepository } from '../ports/recruitment-repository.port';
import type { RecruitmentAuthorizationPort } from '../ports/recruitment-authorization.port';
import { recruitmentErrors } from '../errors';

export interface ScheduleInterviewInput {
  readonly applicationId: string;
  readonly roundId: string;
  readonly interviewerId: string;
  readonly scheduledAt: Date;
  readonly location: string | null;
  readonly actor: string;
  readonly now: Date;
  readonly id?: string;
}
export interface InterviewRefInput {
  readonly interviewId: string;
  readonly actor: string;
  readonly now: Date;
}
export interface SkipInterviewInput {
  readonly interviewId: string;
  readonly reason: string;
  readonly actor: string;
  readonly now: Date;
}
export interface HoldInterviewInput {
  readonly interviewId: string;
  readonly until: Date;
  readonly actor: string;
  readonly now: Date;
}
export interface RecordEvaluationInput {
  readonly interviewId: string;
  readonly values: Record<string, unknown>;
  readonly actor: string;
  readonly now: Date;
}

export interface InterviewWorkflowResult {
  readonly interviewId: string;
  readonly status: string;
}

export class InterviewWorkflowUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async schedule(input: ScheduleInterviewInput): Promise<InterviewWorkflowResult> {
    if (input.scheduledAt < input.now) {
      throw recruitmentErrors.validation('面试时间不可早于当前时间');
    }
    const application = await this.repository.loadApplication(input.applicationId);
    if (application === null) {
      throw recruitmentErrors.notFound('招新申请');
    }
    if (
      !(await this.authorization.canManageRecruitment({
        clubId: application.clubId,
        subjectId: input.actor,
        activityId: application.activityId,
      }))
    ) {
      throw recruitmentErrors.forbidden('仅负责人/人事可调度面试');
    }
    const existing = (await this.repository.loadInterviewsByRound(input.roundId)).find(
      (r) => r.applicationId === input.applicationId,
    );
    if (existing !== undefined) {
      if (existing.status === 'VOIDED' || existing.status === 'PENDING_SELECTION') {
        // 作废后重排或暂停恢复后的待排记录：复用同一记录编排到 SCHEDULED
        const record = InterviewRecord.fromSnapshot(existing);
        if (existing.status === 'VOIDED') {
          if (!record.reschedule(new DefaultInterviewRecordStateMachine(), input.now)) {
            throw recruitmentErrors.preconditionFailed('面试重排失败');
          }
        } else {
          if (
            !record.schedule(
              new DefaultInterviewRecordStateMachine(),
              input.interviewerId,
              input.scheduledAt,
              input.location,
              input.now,
            )
          ) {
            throw recruitmentErrors.preconditionFailed('面试调度失败');
          }
        }
        // 重排/调度均回到 SCHEDULED 后统一重新分配面试官/时间/地点
        record.reassign(input.interviewerId, input.scheduledAt, input.location, input.now);
        await this.repository.saveInterview(record.toSnapshot(), existing.revisionNumber);
        return { interviewId: record.id, status: record.status };
      }
      if (existing.status === 'CANCELLED') {
        throw recruitmentErrors.conflict('该申请在此轮次已有取消的面试记录');
      }
      throw recruitmentErrors.conflict('该申请在此轮次已有有效面试记录');
    }
    const id = input.id ?? randomUUID();
    const record = InterviewRecord.createPending({
      id,
      applicationId: application.id,
      activityId: application.activityId,
      clubId: application.clubId,
      roundId: input.roundId,
      applicantId: application.applicantId,
      now: input.now,
    });
    if (
      !record.schedule(
        new DefaultInterviewRecordStateMachine(),
        input.interviewerId,
        input.scheduledAt,
        input.location,
        input.now,
      )
    ) {
      throw recruitmentErrors.preconditionFailed('面试记录调度失败');
    }
    await this.repository.saveInterview(record.toSnapshot(), -1);
    return { interviewId: id, status: record.status };
  }

  async start(input: InterviewRefInput): Promise<InterviewWorkflowResult> {
    return this.managedTransition(
      input,
      (record, machine, now) => record.start(machine, now),
      '面试开始失败',
    );
  }
  async complete(input: InterviewRefInput): Promise<InterviewWorkflowResult> {
    return this.managedTransition(
      input,
      (record, machine, now) => record.complete(machine, now),
      '面试完成失败',
    );
  }
  async void(input: InterviewRefInput): Promise<InterviewWorkflowResult> {
    return this.managedTransition(
      input,
      (record, machine, now) => record.void(machine, now),
      '面试作废失败',
    );
  }
  async cancel(input: InterviewRefInput): Promise<InterviewWorkflowResult> {
    return this.managedTransition(
      input,
      (record, machine, now) => record.cancel(machine, now),
      '面试取消失败',
    );
  }
  async skip(input: SkipInterviewInput): Promise<InterviewWorkflowResult> {
    if (typeof input.reason !== 'string' || input.reason.trim() === '') {
      throw recruitmentErrors.validation('跳轮/免试须填写原因');
    }
    const { record, expectedRevision } = await this.loadManaged(input.interviewId, input.actor);
    if (!record.skip(new DefaultInterviewRecordStateMachine(), input.reason, input.now)) {
      throw recruitmentErrors.preconditionFailed('面试跳轮/免试失败');
    }
    await this.repository.saveInterview(record.toSnapshot(), expectedRevision);
    return { interviewId: record.id, status: record.status };
  }
  async hold(input: HoldInterviewInput): Promise<InterviewWorkflowResult> {
    const snapshot = await this.repository.loadInterview(input.interviewId);
    if (snapshot === null) {
      throw recruitmentErrors.notFound('面试记录');
    }
    if (
      !(await this.authorization.canManageRecruitment({
        clubId: snapshot.clubId,
        subjectId: input.actor,
        activityId: snapshot.activityId,
      }))
    ) {
      throw recruitmentErrors.forbidden('仅负责人/人事可操作面试记录');
    }
    const activity = await this.repository.loadActivity(snapshot.activityId);
    if (activity !== null && activity.endDate !== null && input.until > activity.endDate) {
      throw recruitmentErrors.validation('暂缓期限不得晚于招新活动结束时间', {
        activityEndDate: activity.endDate,
      });
    }
    if (input.until <= input.now) {
      throw recruitmentErrors.validation('暂缓期限须晚于当前时间');
    }
    const record = InterviewRecord.fromSnapshot(snapshot);
    if (!record.hold(new DefaultInterviewRecordStateMachine(), input.until, input.now)) {
      throw recruitmentErrors.preconditionFailed('面试暂缓失败');
    }
    await this.repository.saveInterview(record.toSnapshot(), snapshot.revisionNumber);
    return { interviewId: record.id, status: record.status };
  }
  async resume(input: InterviewRefInput): Promise<InterviewWorkflowResult> {
    const { record, expectedRevision } = await this.loadManaged(input.interviewId, input.actor);
    if (!record.resume(input.now)) {
      throw recruitmentErrors.preconditionFailed('面试恢复失败');
    }
    await this.repository.saveInterview(record.toSnapshot(), expectedRevision);
    return { interviewId: record.id, status: record.status };
  }

  async recordEvaluation(input: RecordEvaluationInput): Promise<InterviewWorkflowResult> {
    const snapshot = await this.repository.loadInterview(input.interviewId);
    if (snapshot === null) {
      throw recruitmentErrors.notFound('面试记录');
    }
    const isInterviewer = snapshot.interviewerId === input.actor;
    if (
      !isInterviewer &&
      !(await this.authorization.canManageRecruitment({
        clubId: snapshot.clubId,
        subjectId: input.actor,
        activityId: snapshot.activityId,
      }))
    ) {
      throw recruitmentErrors.forbidden('仅面试官本人或负责人/人事可记录评价');
    }
    if (snapshot.status !== 'IN_PROGRESS' && snapshot.status !== 'COMPLETED') {
      throw recruitmentErrors.preconditionFailed('仅进行中或已完成面试可记录评价');
    }
    const record = InterviewRecord.fromSnapshot(snapshot);
    record.recordEvaluation(input.actor, input.values, input.now);
    await this.repository.saveInterview(record.toSnapshot(), snapshot.revisionNumber);
    return { interviewId: record.id, status: record.status };
  }

  private async loadManaged(
    interviewId: string,
    actor: string,
  ): Promise<{ record: InterviewRecord; expectedRevision: number }> {
    const snapshot = await this.repository.loadInterview(interviewId);
    if (snapshot === null) {
      throw recruitmentErrors.notFound('面试记录');
    }
    if (
      !(await this.authorization.canManageRecruitment({
        clubId: snapshot.clubId,
        subjectId: actor,
        activityId: snapshot.activityId,
      }))
    ) {
      throw recruitmentErrors.forbidden('仅负责人/人事可操作面试记录');
    }
    return {
      record: InterviewRecord.fromSnapshot(snapshot),
      expectedRevision: snapshot.revisionNumber,
    };
  }

  private async managedTransition(
    input: InterviewRefInput,
    fn: (
      record: InterviewRecord,
      machine: DefaultInterviewRecordStateMachine,
      now: Date,
    ) => boolean,
    message: string,
  ): Promise<InterviewWorkflowResult> {
    const { record, expectedRevision } = await this.loadManaged(input.interviewId, input.actor);
    if (!fn(record, new DefaultInterviewRecordStateMachine(), input.now)) {
      throw recruitmentErrors.preconditionFailed(message);
    }
    await this.repository.saveInterview(record.toSnapshot(), expectedRevision);
    return { interviewId: record.id, status: record.status };
  }
}
