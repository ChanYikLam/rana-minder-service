/**
 * 提交联合申请用例（JNT-003）。硬前提：共享同意快照哈希匹配。
 */

import { JointApplication } from '../../domain/models/joint-application';
import { JointApplicationStateMachine } from '../../domain/state-machines/joint-application.state-machine';
import { ConsentVerifier } from '../../domain/services/consent-verifier';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointFormPort } from '../ports/joint-form.port';
import { jointErrors } from '../errors';

export interface SubmitJointApplicationInput {
  readonly applicationId: string;
  readonly formRef: { formId: string; submissionId: string; versionNumber: number };
  readonly consentSnapshotHash: string;
  readonly sharedNote?: string | null;
  readonly actor: string;
  readonly now: Date;
}

export interface SubmitJointApplicationResult {
  readonly applicationId: string;
  readonly revisionNumber: number;
}

export interface SubmitJointApplicationUseCase {
  execute(input: SubmitJointApplicationInput): Promise<SubmitJointApplicationResult>;
}

export class DefaultSubmitJointApplicationUseCase implements SubmitJointApplicationUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly form: JointFormPort,
  ) {}

  async execute(input: SubmitJointApplicationInput): Promise<SubmitJointApplicationResult> {
    const applicationSnap = await this.repository.loadApplication(input.applicationId);
    if (applicationSnap === null) {
      throw jointErrors.notFound('联合申请');
    }
    if (applicationSnap.applicantId !== input.actor) {
      throw jointErrors.forbidden('仅申请人本人可提交联合申请');
    }

    const activitySnap = await this.repository.loadActivity(applicationSnap.jointActivityId);
    if (activitySnap === null) {
      throw jointErrors.notFound('联合活动');
    }
    if (
      activitySnap.status === 'ENDED' ||
      activitySnap.status === 'CANCELLED' ||
      activitySnap.status === 'FORCE_ENDED'
    ) {
      throw jointErrors.preconditionFailed('联合活动已结束，无法提交申请');
    }

    const participantSnaps = await this.repository.loadParticipantsByActivity(
      applicationSnap.jointActivityId,
    );
    let participatingClubIds = participantSnaps
      .filter((p) => p.status === 'PARTICIPATING')
      .map((p) => p.clubId);
    if (participatingClubIds.length === 0) {
      participatingClubIds = participantSnaps
        .filter((p) => p.status === 'CONFIRMED')
        .map((p) => p.clubId);
    }

    const expectedConsentHash = ConsentVerifier.computeConsentHash(
      [...new Set(participatingClubIds)].sort(),
    );

    const resolved = await this.form.resolveSubmission({
      formId: input.formRef.formId,
      submissionId: input.formRef.submissionId,
      versionNumber: input.formRef.versionNumber,
    });
    if (resolved === null) {
      throw jointErrors.validation('表单提交不存在或版本无效');
    }

    const application = JointApplication.fromSnapshot(applicationSnap);
    if (
      !application.submit(new JointApplicationStateMachine(), {
        formRef: {
          formId: resolved.formId,
          submissionId: resolved.submissionId,
          versionNumber: resolved.versionNumber,
        },
        participantsSnapshot: participatingClubIds,
        consentSnapshotHash: input.consentSnapshotHash,
        expectedConsentHash,
        sharedNote: input.sharedNote,
        now: input.now,
      })
    ) {
      throw jointErrors.preconditionFailed('联合申请提交失败');
    }
    await this.repository.saveApplication(application.toSnapshot(), applicationSnap.revisionNumber);
    return {
      applicationId: application.id,
      revisionNumber: application.toSnapshot().revisionNumber,
    };
  }
}
