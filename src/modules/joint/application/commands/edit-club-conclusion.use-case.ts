/**
 * 编辑社团结论用例（JNT-005）。结论不存在则创建可编辑态。
 */

import { JointConclusion } from '../../domain/models/joint-conclusion';
import type { JointConclusionDecision } from '../../domain/state-machines/joint-conclusion.state-machine';
import { JointConclusionStateMachine } from '../../domain/state-machines/joint-conclusion.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';
import { assertOrgScope } from '../require-org-scope';

export interface EditClubConclusionInput {
  readonly jointActivityId: string;
  readonly jointApplicationId: string;
  readonly clubId: string;
  readonly actingClubId: string;
  readonly decision: JointConclusionDecision;
  readonly note?: string | null;
  readonly editorId: string;
  readonly now: Date;
  readonly id?: string;
}

export interface EditClubConclusionResult {
  readonly conclusionId: string;
}

export interface EditClubConclusionUseCase {
  execute(input: EditClubConclusionInput): Promise<EditClubConclusionResult>;
}

export class DefaultEditClubConclusionUseCase implements EditClubConclusionUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: EditClubConclusionInput): Promise<EditClubConclusionResult> {
    if (input.actingClubId !== input.clubId) {
      throw jointErrors.forbidden('仅可编辑本组织的社团结论');
    }
    const applicationSnap = await this.repository.loadApplication(input.jointApplicationId);
    if (applicationSnap === null) {
      throw jointErrors.notFound('联合申请');
    }
    if (applicationSnap.jointActivityId !== input.jointActivityId) {
      throw jointErrors.preconditionFailed('联合申请不属于该联合活动，无法编辑社团结论');
    }
    await assertOrgScope(this.repository, input.jointActivityId, input.actingClubId);
    if (
      !(await this.authorization.canEditConclusion({
        subjectId: input.editorId,
        activityId: input.jointActivityId,
        clubId: input.actingClubId,
        action: 'EDIT_CONCLUSION',
      }))
    ) {
      throw jointErrors.forbidden('无权编辑该社团结论');
    }
    const conclusionId = JointConclusion.conclusionId(input.jointApplicationId, input.clubId);
    let conclusionSnap;
    let expectedRevision: number;

    const existing = await this.repository.loadConclusion(conclusionId);
    if (existing === null) {
      const conclusion = JointConclusion.createEditable({
        jointActivityId: input.jointActivityId,
        jointApplicationId: input.jointApplicationId,
        clubId: input.clubId,
        now: input.now,
      });
      await this.repository.saveConclusion(conclusion.toSnapshot(), -1);
      const saved = await this.repository.loadConclusion(conclusionId);
      if (saved === null) {
        throw jointErrors.preconditionFailed('社团结论创建失败');
      }
      conclusionSnap = saved;
      expectedRevision = saved.revisionNumber;
    } else {
      if (existing.status !== 'EDITABLE' && existing.status !== 'REVIEW_PENDING') {
        throw jointErrors.preconditionFailed('仅可编辑或待复核态的结论可改写');
      }
      conclusionSnap = existing;
      expectedRevision = existing.revisionNumber;
    }

    const conclusion = JointConclusion.fromSnapshot(conclusionSnap);
    if (
      !conclusion.edit(new JointConclusionStateMachine(), {
        decision: input.decision,
        note: input.note,
        editorId: input.editorId,
        now: input.now,
      })
    ) {
      throw jointErrors.preconditionFailed('社团结论编辑失败');
    }
    await this.repository.saveConclusion(conclusion.toSnapshot(), expectedRevision);
    return { conclusionId };
  }
}
