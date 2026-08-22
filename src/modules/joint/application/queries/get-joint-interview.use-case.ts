/**
 * 获取联合面试用例（JNT-004）。
 */

import type { JointInterviewSnapshot } from '../../domain/models/joint-interview';
import type { JointRepository } from '../ports/joint-repository.port';
import { jointErrors } from '../errors';

export interface GetJointInterviewInput {
  readonly interviewId: string;
}

export interface GetJointInterviewUseCase {
  execute(input: GetJointInterviewInput): Promise<JointInterviewSnapshot>;
}

export class DefaultGetJointInterviewUseCase implements GetJointInterviewUseCase {
  constructor(private readonly repository: JointRepository) {}

  async execute(input: GetJointInterviewInput): Promise<JointInterviewSnapshot> {
    const snap = await this.repository.loadInterview(input.interviewId);
    if (snap === null) {
      throw jointErrors.notFound('联合面试');
    }
    return snap;
  }
}
