/**
 * 列出社团结论用例（JNT-005）。
 */

import type { JointConclusionSnapshot } from '../../domain/models/joint-conclusion';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';

export interface ListClubConclusionsInput {
  readonly jointApplicationId: string;
  readonly subjectId: string;
}

export interface ListClubConclusionsUseCase {
  execute(input: ListClubConclusionsInput): Promise<JointConclusionSnapshot[]>;
}

export class DefaultListClubConclusionsUseCase implements ListClubConclusionsUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: ListClubConclusionsInput): Promise<JointConclusionSnapshot[]> {
    const applicationSnap = await this.repository.loadApplication(input.jointApplicationId);
    if (applicationSnap === null) {
      throw jointErrors.notFound('联合申请');
    }
    if (
      !(await this.authorization.canViewConclusions({
        subjectId: input.subjectId,
        activityId: applicationSnap.jointActivityId,
        applicantId: applicationSnap.applicantId,
        action: 'VIEW_CONCLUSIONS',
      }))
    ) {
      throw jointErrors.forbidden('无权查看该社团结论列表');
    }
    return this.repository.loadConclusionsByApplication(input.jointApplicationId);
  }
}
