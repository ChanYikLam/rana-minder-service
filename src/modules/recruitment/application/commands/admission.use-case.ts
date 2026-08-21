/**
 * 录取邀请与接受用例（REC-043 录取邀请、REC-044 最终未录取衔接）。
 *
 * 负责人/人事基于部门 ADMIT 发 offer（SUBMITTED → ADMITTED）；申请人本人（或
 * 管理员）接受进入 ACCEPTED，成员生效由 4.5 衔接。授权 fail-closed 桩默认拒绝。
 */

import { Application } from '../../domain/models/application';
import type { RecruitmentRepository } from '../ports/recruitment-repository.port';
import type { RecruitmentAuthorizationPort } from '../ports/recruitment-authorization.port';
import { recruitmentErrors } from '../errors';

export interface SendInvitationInput {
  readonly applicationId: string;
  readonly actor: string;
  readonly now: Date;
  readonly expectedVersion?: number;
}
export interface AcceptInvitationInput {
  readonly applicationId: string;
  readonly actor: string;
  readonly now: Date;
  readonly expectedVersion?: number;
}
export interface AdmissionResult {
  readonly status: string;
}

export class SendAdmissionInvitationUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(input: SendInvitationInput): Promise<AdmissionResult> {
    const snapshot = await this.repository.loadApplication(input.applicationId);
    if (snapshot === null) {
      throw recruitmentErrors.notFound('招新申请');
    }
    if (
      !(await this.authorization.canManageRecruitment({
        clubId: snapshot.clubId,
        subjectId: input.actor,
        activityId: snapshot.activityId,
      }))
    ) {
      throw recruitmentErrors.forbidden('仅负责人/人事可发送录取邀请');
    }
    if (input.expectedVersion !== undefined && snapshot.revisionNumber !== input.expectedVersion) {
      throw recruitmentErrors.conflict('申请版本冲突，请刷新后重试');
    }
    const application = Application.fromSnapshot(snapshot);
    if (!application.sendAdmissionInvitation(input.now)) {
      throw recruitmentErrors.preconditionFailed('当前申请状态不允许发送录取邀请');
    }
    await this.repository.saveApplication(application.toSnapshot());
    return { status: application.status };
  }
}

export class AcceptAdmissionInvitationUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(input: AcceptInvitationInput): Promise<AdmissionResult> {
    const snapshot = await this.repository.loadApplication(input.applicationId);
    if (snapshot === null) {
      throw recruitmentErrors.notFound('招新申请');
    }
    const isApplicant = snapshot.applicantId === input.actor;
    if (
      !isApplicant &&
      !(await this.authorization.canManageRecruitment({
        clubId: snapshot.clubId,
        subjectId: input.actor,
        activityId: snapshot.activityId,
      }))
    ) {
      throw recruitmentErrors.forbidden('仅申请人本人或负责人/人事可接受录取');
    }
    if (input.expectedVersion !== undefined && snapshot.revisionNumber !== input.expectedVersion) {
      throw recruitmentErrors.conflict('申请版本冲突，请刷新后重试');
    }
    const application = Application.fromSnapshot(snapshot);
    if (!application.acceptInvitation(input.now)) {
      throw recruitmentErrors.preconditionFailed('当前申请状态不允许接受录取');
    }
    await this.repository.saveApplication(application.toSnapshot());
    return { status: application.status };
  }
}
