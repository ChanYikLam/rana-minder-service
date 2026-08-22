/**
 * 安排联合面试用例（JNT-004）。复用首条面试记录，须处于待选择态。
 */

import { randomUUID } from 'node:crypto';
import { JointInterview } from '../../domain/models/joint-interview';
import { JointInterviewStateMachine } from '../../domain/state-machines/joint-interview.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';
import { assertOrgScope } from '../require-org-scope';

export interface ScheduleJointInterviewInput {
  readonly jointActivityId: string;
  readonly jointApplicationId: string;
  readonly scheduledAt: Date;
  readonly location: string;
  readonly method: string;
  readonly actingClubId: string;
  readonly actor: string;
  readonly now: Date;
  readonly id?: string;
}

export interface ScheduleJointInterviewResult {
  readonly interviewId: string;
}

export interface ScheduleJointInterviewUseCase {
  execute(input: ScheduleJointInterviewInput): Promise<ScheduleJointInterviewResult>;
}

export class DefaultScheduleJointInterviewUseCase implements ScheduleJointInterviewUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: ScheduleJointInterviewInput): Promise<ScheduleJointInterviewResult> {
    if (
      !(await this.authorization.canManageInvitation({
        activityId: input.jointActivityId,
        subjectId: input.actor,
        clubId: input.actingClubId,
        action: 'INVITE',
      }))
    ) {
      throw jointErrors.forbidden('仅授权用户可安排联合面试');
    }

    await assertOrgScope(this.repository, input.jointActivityId, input.actingClubId);

    const applicationSnap = await this.repository.loadApplication(input.jointApplicationId);
    if (applicationSnap === null) {
      throw jointErrors.notFound('联合申请');
    }
    if (applicationSnap.status !== 'SUBMITTED') {
      throw jointErrors.preconditionFailed('仅已提交的联合申请可安排面试');
    }

    let interviewId: string;
    let expectedRevision: number;

    const existing = await this.repository.loadInterviewByApplication(input.jointApplicationId);
    let interviewSnap;
    if (existing === null) {
      interviewId = input.id ?? randomUUID();
      const interview = JointInterview.createPending({
        id: interviewId,
        jointActivityId: input.jointActivityId,
        jointApplicationId: input.jointApplicationId,
        now: input.now,
      });
      await this.repository.saveInterview(interview.toSnapshot(), -1);
      const saved = await this.repository.loadInterview(interviewId);
      if (saved === null) {
        throw jointErrors.preconditionFailed('联合面试创建失败');
      }
      interviewSnap = saved;
      expectedRevision = saved.revisionNumber;
    } else {
      if (existing.status !== 'PENDING_CHOICE') {
        throw jointErrors.preconditionFailed('仅待选择态的联合面试可安排');
      }
      interviewSnap = existing;
      interviewId = existing.id;
      expectedRevision = existing.revisionNumber;
    }

    const interview = JointInterview.fromSnapshot(interviewSnap);
    if (
      !interview.schedule(new JointInterviewStateMachine(), {
        scheduledAt: input.scheduledAt,
        location: input.location,
        method: input.method,
        now: input.now,
      })
    ) {
      throw jointErrors.preconditionFailed('联合面试安排失败');
    }
    await this.repository.saveInterview(interview.toSnapshot(), expectedRevision);
    return { interviewId };
  }
}
