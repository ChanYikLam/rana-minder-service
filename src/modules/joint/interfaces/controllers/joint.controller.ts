/**
 * JointController（interfaces 层；联合主链路编排 JNT-001~006）。
 *
 * 职责：把信封/路径参数组装为用例输入，在单主体 RLS 事务边界内执行，错误经
 * toApiError 映射。作用域由服务端路径 clubId 冻结。
 */

import type { JointUnitOfWork } from '../../infrastructure/unit-of-work';
import type { RlsScope } from '../../../../shared/db-adapter';
import type { ActorContext } from './actor-context';
import { toApiError, type ApiErrorResult } from '../http/joint-error-http';

import type { InitiateJointActivityUseCase } from '../../application/commands/initiate-joint-activity.use-case';
import type { ProposeParticipationUseCase } from '../../application/commands/propose-participation.use-case';
import type { ConfirmParticipationRoundUseCase } from '../../application/commands/confirm-participation-round.use-case';
import type { PublishJointActivityUseCase } from '../../application/commands/publish-joint-activity.use-case';
import type { CancelJointActivityUseCase } from '../../application/commands/cancel-joint-activity.use-case';
import type { BeginEndConfirmUseCase } from '../../application/commands/begin-end-confirm.use-case';
import type { EndJointActivityUseCase } from '../../application/commands/end-joint-activity.use-case';
import type { ForceEndJointActivityUseCase } from '../../application/commands/force-end-joint-activity.use-case';
import type { WithdrawParticipationUseCase } from '../../application/commands/withdraw-participation.use-case';
import type { SuspendParticipationUseCase } from '../../application/commands/suspend-participation.use-case';
import type { ResumeParticipationUseCase } from '../../application/commands/resume-participation.use-case';
import type { OpenJointChannelUseCase } from '../../application/commands/open-joint-channel.use-case';
import type { SuspendJointChannelUseCase } from '../../application/commands/suspend-joint-channel.use-case';
import type { ResumeJointChannelUseCase } from '../../application/commands/resume-joint-channel.use-case';
import type { ExtendJointChannelUseCase } from '../../application/commands/extend-joint-channel.use-case';
import type { CloseJointChannelUseCase } from '../../application/commands/close-joint-channel.use-case';
import type { ReopenJointChannelUseCase } from '../../application/commands/reopen-joint-channel.use-case';
import type { CreateJointApplicationUseCase } from '../../application/commands/create-joint-application.use-case';
import type { SubmitJointApplicationUseCase } from '../../application/commands/submit-joint-application.use-case';
import type { ScheduleJointInterviewUseCase } from '../../application/commands/schedule-joint-interview.use-case';
import type { StartJointInterviewUseCase } from '../../application/commands/start-joint-interview.use-case';
import type { CompleteJointInterviewUseCase } from '../../application/commands/complete-joint-interview.use-case';
import type { VoidJointInterviewUseCase } from '../../application/commands/void-joint-interview.use-case';
import type { RecordJointEvaluationUseCase } from '../../application/commands/record-joint-evaluation.use-case';
import type { EditClubConclusionUseCase } from '../../application/commands/edit-club-conclusion.use-case';
import type { SendClubInvitationUseCase } from '../../application/commands/send-club-invitation.use-case';
import type { HandleInvitationAcceptedUseCase } from '../../application/commands/handle-invitation-accepted.use-case';
import type { HandleInvitationRejectedUseCase } from '../../application/commands/handle-invitation-rejected.use-case';
import type { RestoreFromReviewUseCase } from '../../application/commands/restore-from-review.use-case';
import type { ArchiveConclusionsUseCase } from '../../application/commands/archive-conclusions.use-case';
import type { ArchiveJointApplicationsUseCase } from '../../application/commands/archive-joint-applications.use-case';
import type { AutoCloseChannelUseCase } from '../../application/commands/auto-close-channel.use-case';
import type { ScanStaleReconfirmUseCase } from '../../application/commands/scan-stale-reconfirm.use-case';

import type { GetJointActivityUseCase } from '../../application/queries/get-joint-activity.use-case';
import type { GetJointApplicationUseCase } from '../../application/queries/get-joint-application.use-case';
import type { GetJointChannelUseCase } from '../../application/queries/get-joint-channel.use-case';
import type { GetJointInterviewUseCase } from '../../application/queries/get-joint-interview.use-case';
import type { ListClubConclusionsUseCase } from '../../application/queries/list-club-conclusions.use-case';
import type { ListJointApplicationsUseCase } from '../../application/queries/list-joint-applications.use-case';
import type { ListJointParticipantsUseCase } from '../../application/queries/list-joint-participants.use-case';

type ControllerResult<T> = { readonly ok: true; readonly value: T } | ApiErrorResult;

export class JointController {
  constructor(
    private readonly uow: JointUnitOfWork,
    private readonly initiateActivityUseCase: InitiateJointActivityUseCase,
    private readonly proposeParticipationUseCase: ProposeParticipationUseCase,
    private readonly confirmParticipationUseCase: ConfirmParticipationRoundUseCase,
    private readonly publishActivityUseCase: PublishJointActivityUseCase,
    private readonly cancelActivityUseCase: CancelJointActivityUseCase,
    private readonly beginEndConfirmUseCase: BeginEndConfirmUseCase,
    private readonly endActivityUseCase: EndJointActivityUseCase,
    private readonly forceEndActivityUseCase: ForceEndJointActivityUseCase,
    private readonly withdrawParticipationUseCase: WithdrawParticipationUseCase,
    private readonly suspendParticipationUseCase: SuspendParticipationUseCase,
    private readonly resumeParticipationUseCase: ResumeParticipationUseCase,
    private readonly openChannelUseCase: OpenJointChannelUseCase,
    private readonly suspendChannelUseCase: SuspendJointChannelUseCase,
    private readonly resumeChannelUseCase: ResumeJointChannelUseCase,
    private readonly extendChannelUseCase: ExtendJointChannelUseCase,
    private readonly closeChannelUseCase: CloseJointChannelUseCase,
    private readonly reopenChannelUseCase: ReopenJointChannelUseCase,
    private readonly createApplicationUseCase: CreateJointApplicationUseCase,
    private readonly submitApplicationUseCase: SubmitJointApplicationUseCase,
    private readonly scheduleInterviewUseCase: ScheduleJointInterviewUseCase,
    private readonly startInterviewUseCase: StartJointInterviewUseCase,
    private readonly completeInterviewUseCase: CompleteJointInterviewUseCase,
    private readonly voidInterviewUseCase: VoidJointInterviewUseCase,
    private readonly recordEvaluationUseCase: RecordJointEvaluationUseCase,
    private readonly editConclusionUseCase: EditClubConclusionUseCase,
    private readonly sendInvitationUseCase: SendClubInvitationUseCase,
    private readonly handleInvitationAcceptedUseCase: HandleInvitationAcceptedUseCase,
    private readonly handleInvitationRejectedUseCase: HandleInvitationRejectedUseCase,
    private readonly restoreFromReviewUseCase: RestoreFromReviewUseCase,
    private readonly archiveConclusionsUseCase: ArchiveConclusionsUseCase,
    private readonly archiveApplicationsUseCase: ArchiveJointApplicationsUseCase,
    private readonly autoCloseChannelUseCase: AutoCloseChannelUseCase,
    private readonly scanStaleReconfirmUseCase: ScanStaleReconfirmUseCase,
    private readonly getActivityUseCase: GetJointActivityUseCase,
    private readonly getApplicationUseCase: GetJointApplicationUseCase,
    private readonly getChannelUseCase: GetJointChannelUseCase,
    private readonly getInterviewUseCase: GetJointInterviewUseCase,
    private readonly listConclusionsUseCase: ListClubConclusionsUseCase,
    private readonly listApplicationsUseCase: ListJointApplicationsUseCase,
    private readonly listParticipantsUseCase: ListJointParticipantsUseCase,
  ) {}

  private run<T>(actor: ActorContext, fn: () => Promise<T>): Promise<ControllerResult<T>> {
    const scope: RlsScope = { kind: 'unprotected' };
    return this.uow.run(scope, async () => {
      try {
        return { ok: true as const, value: await fn() };
      } catch (error) {
        return toApiError(error);
      }
    });
  }

  // ----- 联合活动（JNT-001） -----
  initiateActivity(
    actor: ActorContext,
    input: {
      readonly title: string;
      readonly description?: string | null;
      readonly confirmDeadline: Date;
      readonly clubIds: string[];
    },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.initiateActivityUseCase.execute({
        title: input.title,
        description: input.description ?? null,
        confirmDeadline: input.confirmDeadline,
        clubIds: input.clubIds,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  publishActivity(actor: ActorContext, activityId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.publishActivityUseCase.execute({ activityId, actor: actor.subjectId, now: actor.now }),
    );
  }

  cancelActivity(actor: ActorContext, activityId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.cancelActivityUseCase.execute({ activityId, actor: actor.subjectId, now: actor.now }),
    );
  }

  beginEndConfirm(actor: ActorContext, activityId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.beginEndConfirmUseCase.execute({ activityId, actor: actor.subjectId, now: actor.now }),
    );
  }

  endActivity(actor: ActorContext, activityId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.endActivityUseCase.execute({ activityId, actor: actor.subjectId, now: actor.now }),
    );
  }

  forceEndActivity(
    actor: ActorContext,
    input: { readonly activityId: string; readonly reason: string },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.forceEndActivityUseCase.execute({
        activityId: input.activityId,
        reason: input.reason,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  // ----- 参与社团（JNT-002） -----
  proposeParticipation(
    actor: ActorContext,
    input: { readonly activityId: string; readonly clubId: string },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.proposeParticipationUseCase.execute({
        activityId: input.activityId,
        clubId: input.clubId,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  confirmParticipation(
    actor: ActorContext,
    input: { readonly activityId: string; readonly clubId: string },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.confirmParticipationUseCase.execute({
        activityId: input.activityId,
        clubId: input.clubId,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  withdrawParticipation(
    actor: ActorContext,
    input: { readonly activityId: string; readonly clubId: string },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.withdrawParticipationUseCase.execute({
        activityId: input.activityId,
        clubId: input.clubId,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  suspendParticipation(
    actor: ActorContext,
    input: { readonly activityId: string; readonly clubId: string },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.suspendParticipationUseCase.execute({
        activityId: input.activityId,
        clubId: input.clubId,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  resumeParticipation(
    actor: ActorContext,
    input: {
      readonly activityId: string;
      readonly clubId: string;
      readonly suspendedForMs: number;
    },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.resumeParticipationUseCase.execute({
        activityId: input.activityId,
        clubId: input.clubId,
        suspendedForMs: input.suspendedForMs,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  // ----- 联合报名通道（JNT-006） -----
  openChannel(
    actor: ActorContext,
    input: {
      readonly jointActivityId: string;
      readonly deadline: Date;
      readonly windowId?: string;
    },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.openChannelUseCase.execute({
        jointActivityId: input.jointActivityId,
        deadline: input.deadline,
        windowId: input.windowId,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  suspendChannel(actor: ActorContext, jointActivityId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.suspendChannelUseCase.execute({
        jointActivityId,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  resumeChannel(
    actor: ActorContext,
    input: {
      readonly jointActivityId: string;
      readonly deadline: Date;
      readonly windowId?: string;
    },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.resumeChannelUseCase.execute({
        jointActivityId: input.jointActivityId,
        deadline: input.deadline,
        windowId: input.windowId,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  extendChannel(
    actor: ActorContext,
    input: { readonly jointActivityId: string; readonly deadline: Date },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.extendChannelUseCase.execute({
        jointActivityId: input.jointActivityId,
        deadline: input.deadline,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  closeChannel(actor: ActorContext, jointActivityId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.closeChannelUseCase.execute({ jointActivityId, actor: actor.subjectId, now: actor.now }),
    );
  }

  reopenChannel(
    actor: ActorContext,
    input: {
      readonly jointActivityId: string;
      readonly deadline: Date;
      readonly windowId?: string;
    },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.reopenChannelUseCase.execute({
        jointActivityId: input.jointActivityId,
        deadline: input.deadline,
        windowId: input.windowId,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  // ----- 联合申请（JNT-003） -----
  createApplication(
    actor: ActorContext,
    input: { readonly jointActivityId: string; readonly applicantId: string },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.createApplicationUseCase.execute({
        jointActivityId: input.jointActivityId,
        applicantId: input.applicantId,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  submitApplication(
    actor: ActorContext,
    input: {
      readonly applicationId: string;
      readonly formRef: { formId: string; submissionId: string; versionNumber: number };
      readonly consentSnapshotHash: string;
      readonly sharedNote?: string | null;
    },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.submitApplicationUseCase.execute({
        applicationId: input.applicationId,
        formRef: input.formRef,
        consentSnapshotHash: input.consentSnapshotHash,
        sharedNote: input.sharedNote ?? null,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  // ----- 联合面试（JNT-004） -----
  scheduleInterview(
    actor: ActorContext,
    input: {
      readonly jointActivityId: string;
      readonly jointApplicationId: string;
      readonly scheduledAt: Date;
      readonly location: string;
      readonly method: string;
      readonly id?: string;
    },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.scheduleInterviewUseCase.execute({
        jointActivityId: input.jointActivityId,
        jointApplicationId: input.jointApplicationId,
        scheduledAt: input.scheduledAt,
        location: input.location,
        method: input.method,
        id: input.id,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  startInterview(actor: ActorContext, interviewId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.startInterviewUseCase.execute({ interviewId, actor: actor.subjectId, now: actor.now }),
    );
  }

  completeInterview(actor: ActorContext, interviewId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.completeInterviewUseCase.execute({
        interviewId,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  voidInterview(
    actor: ActorContext,
    input: { readonly interviewId: string; readonly reason: string },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.voidInterviewUseCase.execute({
        interviewId: input.interviewId,
        reason: input.reason,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  recordEvaluation(
    actor: ActorContext,
    input: {
      readonly interviewId: string;
      readonly clubId: string;
      readonly values: Record<string, unknown>;
    },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.recordEvaluationUseCase.execute({
        interviewId: input.interviewId,
        clubId: input.clubId,
        values: input.values,
        subjectId: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  // ----- 社团结论与邀请（JNT-005） -----
  editConclusion(
    actor: ActorContext,
    input: {
      readonly jointActivityId: string;
      readonly jointApplicationId: string;
      readonly clubId: string;
      readonly decision: 'ADMIT' | 'TRANSFER' | 'REJECT';
      readonly note?: string | null;
    },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.editConclusionUseCase.execute({
        jointActivityId: input.jointActivityId,
        jointApplicationId: input.jointApplicationId,
        clubId: input.clubId,
        decision: input.decision,
        note: input.note ?? null,
        editorId: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  sendInvitation(actor: ActorContext, conclusionId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.sendInvitationUseCase.execute({
        conclusionId,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  handleInvitationAccepted(
    conclusionId: string,
    invitationId: string,
  ): Promise<ControllerResult<unknown>> {
    const now = new Date();
    const actor = { subjectId: 'invitation-webhook', now, traceId: '' } as ActorContext;
    return this.run(actor, () =>
      this.handleInvitationAcceptedUseCase.execute({ conclusionId, invitationId, now }),
    );
  }

  handleInvitationRejected(
    conclusionId: string,
    invitationId: string,
  ): Promise<ControllerResult<unknown>> {
    const now = new Date();
    const actor = { subjectId: 'invitation-webhook', now, traceId: '' } as ActorContext;
    return this.run(actor, () =>
      this.handleInvitationRejectedUseCase.execute({ conclusionId, invitationId, now }),
    );
  }

  restoreFromReview(actor: ActorContext, conclusionId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.restoreFromReviewUseCase.execute({
        conclusionId,
        subjectId: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  // ----- 任务式（TASK，无授权） -----
  archiveConclusions(actor: ActorContext, activityId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.archiveConclusionsUseCase.execute({ activityId, now: actor.now }),
    );
  }

  archiveApplications(actor: ActorContext, activityId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.archiveApplicationsUseCase.execute({ activityId, now: actor.now }),
    );
  }

  autoCloseChannel(
    actor: ActorContext,
    jointActivityId: string,
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.autoCloseChannelUseCase.execute({ jointActivityId, now: actor.now }),
    );
  }

  scanStaleReconfirm(actor: ActorContext, activityId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.scanStaleReconfirmUseCase.execute({ activityId, now: actor.now }),
    );
  }

  // ----- 查询（JNT-001~006） -----
  getActivity(
    actor: ActorContext,
    activityId: string,
    clubId: string,
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.getActivityUseCase.execute({
        activityId,
        subjectId: actor.subjectId,
        clubId,
      }),
    );
  }

  getApplication(actor: ActorContext, applicationId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.getApplicationUseCase.execute({
        applicationId,
        subjectId: actor.subjectId,
      }),
    );
  }

  getChannel(actor: ActorContext, jointActivityId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () => this.getChannelUseCase.execute({ jointActivityId }));
  }

  getInterview(actor: ActorContext, interviewId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.getInterviewUseCase.execute({
        interviewId,
        subjectId: actor.subjectId,
      }),
    );
  }

  listConclusions(
    actor: ActorContext,
    jointApplicationId: string,
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.listConclusionsUseCase.execute({
        jointApplicationId,
        subjectId: actor.subjectId,
      }),
    );
  }

  listApplications(
    actor: ActorContext,
    activityId: string,
    clubId: string,
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.listApplicationsUseCase.execute({
        activityId,
        subjectId: actor.subjectId,
        clubId,
      }),
    );
  }

  listParticipants(
    actor: ActorContext,
    activityId: string,
    clubId: string,
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.listParticipantsUseCase.execute({
        activityId,
        subjectId: actor.subjectId,
        clubId,
      }),
    );
  }
}
