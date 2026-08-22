/**
 * 完成联合面试用例（JNT-004）。
 */

import { JointInterview } from '../../domain/models/joint-interview';
import { JointInterviewStateMachine } from '../../domain/state-machines/joint-interview.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';

export interface CompleteJointInterviewInput {
  readonly interviewId: string;
  readonly actor: string;
  readonly now: Date;
}

export interface CompleteJointInterviewUseCase {
  execute(input: CompleteJointInterviewInput): Promise<void>;
}

export class DefaultCompleteJointInterviewUseCase implements CompleteJointInterviewUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: CompleteJointInterviewInput): Promise<void> {
    if (
      !(await this.authorization.canManageInvitation({
        subjectId: input.actor,
        action: 'INVITE',
      }))
    ) {
      throw jointErrors.forbidden('仅授权用户可操作联合面试');
    }
    const interviewSnap = await this.repository.loadInterview(input.interviewId);
    if (interviewSnap === null) {
      throw jointErrors.notFound('联合面试');
    }
    const interview = JointInterview.fromSnapshot(interviewSnap);
    if (!interview.complete(new JointInterviewStateMachine(), input.now)) {
      throw jointErrors.preconditionFailed('联合面试完成失败');
    }
    await this.repository.saveInterview(interview.toSnapshot(), interviewSnap.revisionNumber);
  }
}
