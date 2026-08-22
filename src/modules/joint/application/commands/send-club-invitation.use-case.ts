/**
 * 发送社团录取邀请用例（JNT-005）。经邀请端口发出并回写结论。
 */

import { JointConclusion } from '../../domain/models/joint-conclusion';
import { JointConclusionStateMachine } from '../../domain/state-machines/joint-conclusion.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import type { JointInvitationPort } from '../ports/joint-invitation.port';
import { jointErrors } from '../errors';
import {
  INVITATION_TIMEOUT_DEFAULT_MS,
  type JointTaskEnqueuer,
} from '../../infrastructure/joint-task-enqueuer';

export interface SendClubInvitationInput {
  readonly conclusionId: string;
  readonly actingClubId: string;
  readonly actor: string;
  readonly now: Date;
}

export interface SendClubInvitationUseCase {
  execute(input: SendClubInvitationInput): Promise<void>;
}

export class DefaultSendClubInvitationUseCase implements SendClubInvitationUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
    private readonly invitation: JointInvitationPort,
    private readonly tasks: JointTaskEnqueuer,
  ) {}

  async execute(input: SendClubInvitationInput): Promise<void> {
    if (
      !(await this.authorization.canManageInvitation({
        subjectId: input.actor,
        clubId: input.actingClubId,
        action: 'INVITE',
      }))
    ) {
      throw jointErrors.forbidden('仅授权用户可发送社团邀请');
    }
    const conclusionSnap = await this.repository.loadConclusion(input.conclusionId);
    if (conclusionSnap === null) {
      throw jointErrors.notFound('社团结论');
    }
    if (input.actingClubId !== conclusionSnap.clubId) {
      throw jointErrors.forbidden('仅可操作本组织的社团结论');
    }
    if (conclusionSnap.decision == null) {
      throw jointErrors.preconditionFailed('未填写结论前禁止发送邀请');
    }
    const applicationSnap = await this.repository.loadApplication(
      conclusionSnap.jointApplicationId,
    );
    if (applicationSnap === null) {
      throw jointErrors.notFound('联合申请');
    }

    const machine = new JointConclusionStateMachine();
    const trial = JointConclusion.fromSnapshot(conclusionSnap);
    if (!trial.sendInvite(machine, { invitationId: '_precheck_', now: input.now })) {
      throw jointErrors.preconditionFailed('当前结论状态不允许发送邀请');
    }

    const inv = await this.invitation.sendJointInvitation({
      jointActivityId: conclusionSnap.jointActivityId,
      jointApplicationId: conclusionSnap.jointApplicationId,
      clubId: conclusionSnap.clubId,
      applicantId: applicationSnap.applicantId,
      decision: conclusionSnap.decision,
      freezeRemainingMs: undefined,
    });

    const conclusion = JointConclusion.fromSnapshot(conclusionSnap);
    if (
      !conclusion.sendInvite(machine, {
        invitationId: inv.invitationId,
        now: input.now,
      })
    ) {
      throw jointErrors.preconditionFailed('社团邀请发送失败');
    }
    await this.repository.saveConclusion(conclusion.toSnapshot(), conclusionSnap.revisionNumber);

    const notBefore = new Date(input.now.getTime() + INVITATION_TIMEOUT_DEFAULT_MS);
    await this.tasks.scheduleInvitationTimeout(
      conclusionSnap.jointActivityId,
      conclusionSnap.revisionNumber,
      inv.invitationId,
      notBefore,
    );
  }
}
