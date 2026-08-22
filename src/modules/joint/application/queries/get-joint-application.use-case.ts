/**
 * 获取联合申请用例（JNT-003）。
 */

import type { JointApplicationSnapshot } from '../../domain/models/joint-application';
import type { JointRepository } from '../ports/joint-repository.port';
import { jointErrors } from '../errors';

export interface GetJointApplicationInput {
  readonly applicationId: string;
}

export interface GetJointApplicationUseCase {
  execute(input: GetJointApplicationInput): Promise<JointApplicationSnapshot>;
}

export class DefaultGetJointApplicationUseCase implements GetJointApplicationUseCase {
  constructor(private readonly repository: JointRepository) {}

  async execute(input: GetJointApplicationInput): Promise<JointApplicationSnapshot> {
    const snap = await this.repository.loadApplication(input.applicationId);
    if (snap === null) {
      throw jointErrors.notFound('联合申请');
    }
    return snap;
  }
}
