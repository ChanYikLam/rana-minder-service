/**
 * joint 模块 NestJS 装配（interfaces/nest + application + infrastructure）。
 *
 * 自包含分层装配：JointUnitOfWork（事务边界）→ PostgreSQL 仓储 →
 * 授权/表单/邀请/配置/通知/审计端口（3.x 接入前 fail-closed 桩）→ 应用用例/查询
 * → 传输中立 JointController → Nest HTTP 适配控制器与守卫。
 *
 * 会话：Casdoor OIDC 会话链路接入前绑定 RejectAllJointAuthSessionProvider
 * （fail-closed，受保护端点 401）；授权：3.x 组织/身份授权落地前绑定
 * NotWiredJointAuthorization（全部管理/提交操作拒绝）。
 */

import { Module } from '@nestjs/common';

import { AdaptersModule } from '../../adapters/adapters.module';
import { ObservabilityModule } from '../../platform/observability/module';
import { TasksModule } from '../../platform/tasks/module';
import { DB_ADAPTER } from '../../adapters/tokens';

import {
  JOINT_REPOSITORY,
  JOINT_AUTHORIZATION,
  JOINT_FORM_PORT,
  JOINT_INVITATION_PORT,
  JOINT_NOTIFICATION_PORT,
  JOINT_AUDIT_PORT,
  JOINT_AUTH_SESSION_PROVIDER,
  JOINT_INVITATION_WEBHOOK_PROVIDER,
  JOINT_CONTROLLER,
  INITIATE_JOINT_ACTIVITY_USE_CASE,
  PROPOSE_PARTICIPATION_USE_CASE,
  CONFIRM_PARTICIPATION_ROUND_USE_CASE,
  PUBLISH_JOINT_ACTIVITY_USE_CASE,
  CANCEL_JOINT_ACTIVITY_USE_CASE,
  BEGIN_END_CONFIRM_USE_CASE,
  END_JOINT_ACTIVITY_USE_CASE,
  FORCE_END_JOINT_ACTIVITY_USE_CASE,
  WITHDRAW_PARTICIPATION_USE_CASE,
  SUSPEND_PARTICIPATION_USE_CASE,
  RESUME_PARTICIPATION_USE_CASE,
  OPEN_JOINT_CHANNEL_USE_CASE,
  SUSPEND_JOINT_CHANNEL_USE_CASE,
  RESUME_JOINT_CHANNEL_USE_CASE,
  EXTEND_JOINT_CHANNEL_USE_CASE,
  CLOSE_JOINT_CHANNEL_USE_CASE,
  REOPEN_JOINT_CHANNEL_USE_CASE,
  CREATE_JOINT_APPLICATION_USE_CASE,
  SUBMIT_JOINT_APPLICATION_USE_CASE,
  SCHEDULE_JOINT_INTERVIEW_USE_CASE,
  START_JOINT_INTERVIEW_USE_CASE,
  COMPLETE_JOINT_INTERVIEW_USE_CASE,
  VOID_JOINT_INTERVIEW_USE_CASE,
  RECORD_JOINT_EVALUATION_USE_CASE,
  EDIT_CLUB_CONCLUSION_USE_CASE,
  SEND_CLUB_INVITATION_USE_CASE,
  HANDLE_INVITATION_ACCEPTED_USE_CASE,
  HANDLE_INVITATION_REJECTED_USE_CASE,
  RESTORE_FROM_REVIEW_USE_CASE,
  ARCHIVE_CONCLUSIONS_USE_CASE,
  ARCHIVE_JOINT_APPLICATIONS_USE_CASE,
  AUTO_CLOSE_CHANNEL_USE_CASE,
  SCAN_STALE_RECONFIRM_USE_CASE,
  GET_JOINT_ACTIVITY_QUERY,
  GET_JOINT_APPLICATION_QUERY,
  GET_JOINT_CHANNEL_QUERY,
  GET_JOINT_INTERVIEW_QUERY,
  LIST_CLUB_CONCLUSIONS_QUERY,
  LIST_JOINT_APPLICATIONS_QUERY,
  LIST_JOINT_PARTICIPANTS_QUERY,
} from './tokens';

import { JointUnitOfWork } from './infrastructure/unit-of-work';
import { PostgresJointRepository } from './infrastructure/postgres-joint.repository';
import { NotWiredJointAuthorization } from './application/ports/joint-authorization.port';
import { NotWiredJointForm } from './application/ports/joint-form.port';
import { NotWiredJointInvitation } from './application/ports/joint-invitation.port';
import { NotWiredJointNotification } from './application/ports/joint-notification.port';
import { NotWiredJointAudit } from './application/ports/joint-audit.port';

import { DefaultInitiateJointActivityUseCase } from './application/commands/initiate-joint-activity.use-case';
import { DefaultProposeParticipationUseCase } from './application/commands/propose-participation.use-case';
import { DefaultConfirmParticipationRoundUseCase } from './application/commands/confirm-participation-round.use-case';
import { DefaultPublishJointActivityUseCase } from './application/commands/publish-joint-activity.use-case';
import { DefaultCancelJointActivityUseCase } from './application/commands/cancel-joint-activity.use-case';
import { DefaultBeginEndConfirmUseCase } from './application/commands/begin-end-confirm.use-case';
import { DefaultEndJointActivityUseCase } from './application/commands/end-joint-activity.use-case';
import { DefaultForceEndJointActivityUseCase } from './application/commands/force-end-joint-activity.use-case';
import { DefaultWithdrawParticipationUseCase } from './application/commands/withdraw-participation.use-case';
import { DefaultSuspendParticipationUseCase } from './application/commands/suspend-participation.use-case';
import { DefaultResumeParticipationUseCase } from './application/commands/resume-participation.use-case';
import { DefaultOpenJointChannelUseCase } from './application/commands/open-joint-channel.use-case';
import { DefaultSuspendJointChannelUseCase } from './application/commands/suspend-joint-channel.use-case';
import { DefaultResumeJointChannelUseCase } from './application/commands/resume-joint-channel.use-case';
import { DefaultExtendJointChannelUseCase } from './application/commands/extend-joint-channel.use-case';
import { DefaultCloseJointChannelUseCase } from './application/commands/close-joint-channel.use-case';
import { DefaultReopenJointChannelUseCase } from './application/commands/reopen-joint-channel.use-case';
import { DefaultCreateJointApplicationUseCase } from './application/commands/create-joint-application.use-case';
import { DefaultSubmitJointApplicationUseCase } from './application/commands/submit-joint-application.use-case';
import { DefaultScheduleJointInterviewUseCase } from './application/commands/schedule-joint-interview.use-case';
import { DefaultStartJointInterviewUseCase } from './application/commands/start-joint-interview.use-case';
import { DefaultCompleteJointInterviewUseCase } from './application/commands/complete-joint-interview.use-case';
import { DefaultVoidJointInterviewUseCase } from './application/commands/void-joint-interview.use-case';
import { DefaultRecordJointEvaluationUseCase } from './application/commands/record-joint-evaluation.use-case';
import { DefaultEditClubConclusionUseCase } from './application/commands/edit-club-conclusion.use-case';
import { DefaultSendClubInvitationUseCase } from './application/commands/send-club-invitation.use-case';
import { DefaultHandleInvitationAcceptedUseCase } from './application/commands/handle-invitation-accepted.use-case';
import { DefaultHandleInvitationRejectedUseCase } from './application/commands/handle-invitation-rejected.use-case';
import { DefaultRestoreFromReviewUseCase } from './application/commands/restore-from-review.use-case';
import { DefaultArchiveConclusionsUseCase } from './application/commands/archive-conclusions.use-case';
import { DefaultArchiveJointApplicationsUseCase } from './application/commands/archive-joint-applications.use-case';
import { DefaultAutoCloseChannelUseCase } from './application/commands/auto-close-channel.use-case';
import { DefaultScanStaleReconfirmUseCase } from './application/commands/scan-stale-reconfirm.use-case';

import { DefaultGetJointActivityUseCase } from './application/queries/get-joint-activity.use-case';
import { DefaultGetJointApplicationUseCase } from './application/queries/get-joint-application.use-case';
import { DefaultGetJointChannelUseCase } from './application/queries/get-joint-channel.use-case';
import { DefaultGetJointInterviewUseCase } from './application/queries/get-joint-interview.use-case';
import { DefaultListClubConclusionsUseCase } from './application/queries/list-club-conclusions.use-case';
import { DefaultListJointApplicationsUseCase } from './application/queries/list-joint-applications.use-case';
import { DefaultListJointParticipantsUseCase } from './application/queries/list-joint-participants.use-case';

import { JointController } from './interfaces/controllers/joint.controller';
import { RejectAllJointAuthSessionProvider } from './interfaces/nest/joint-auth-session';
import { JointAuthGuard } from './interfaces/nest/joint-auth.guard';
import { OrgJointNestController } from './interfaces/nest/org-joint.nest.controller';
import { ApplicantJointNestController } from './interfaces/nest/applicant-joint.nest.controller';
import {
  JointInvitationWebhookGuard,
  NotWiredJointInvitationWebhookAuth,
} from './interfaces/nest/joint-invitation-webhook.guard';
import { JointInvitationWebhookController } from './interfaces/nest/joint-invitation-webhook.controller';
import { JointTaskRegistrar } from './infrastructure/joint-task-registrar';
import { JointTaskEnqueuer } from './infrastructure/joint-task-enqueuer';

@Module({
  imports: [AdaptersModule, ObservabilityModule, TasksModule],
  controllers: [
    OrgJointNestController,
    ApplicantJointNestController,
    JointInvitationWebhookController,
  ],
  providers: [
    // ----- 会话（认证基建接入前失败关闭）-----
    {
      provide: JOINT_AUTH_SESSION_PROVIDER,
      useClass: RejectAllJointAuthSessionProvider,
    },
    JointAuthGuard,
    // ----- 邀请回调 Webhook 鉴权（INV-001 接入前失败关闭）-----
    {
      provide: JOINT_INVITATION_WEBHOOK_PROVIDER,
      useClass: NotWiredJointInvitationWebhookAuth,
    },
    JointInvitationWebhookGuard,
    // ----- 定时任务注册（接入 TasksModule 调度）-----
    JointTaskRegistrar,
    JointTaskEnqueuer,
    // ----- 工作单元（事务边界）-----
    {
      provide: JointUnitOfWork,
      useFactory: (db) => new JointUnitOfWork(db),
      inject: [DB_ADAPTER],
    },
    // ----- PostgreSQL 仓储 -----
    {
      provide: JOINT_REPOSITORY,
      useFactory: (db, uow) => new PostgresJointRepository(db, uow),
      inject: [DB_ADAPTER, JointUnitOfWork],
    },
    // ----- 端口（3.x 接入前失败关闭桩）-----
    { provide: JOINT_AUTHORIZATION, useClass: NotWiredJointAuthorization },
    { provide: JOINT_FORM_PORT, useClass: NotWiredJointForm },
    { provide: JOINT_INVITATION_PORT, useClass: NotWiredJointInvitation },
    { provide: JOINT_NOTIFICATION_PORT, useClass: NotWiredJointNotification },
    { provide: JOINT_AUDIT_PORT, useClass: NotWiredJointAudit },

    // ----- 联合活动（JNT-001） -----
    {
      provide: INITIATE_JOINT_ACTIVITY_USE_CASE,
      useFactory: (repo, auth, tasks) => new DefaultInitiateJointActivityUseCase(repo, auth, tasks),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION, JointTaskEnqueuer],
    },
    {
      provide: PUBLISH_JOINT_ACTIVITY_USE_CASE,
      useFactory: (repo, auth) => new DefaultPublishJointActivityUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },
    {
      provide: CANCEL_JOINT_ACTIVITY_USE_CASE,
      useFactory: (repo, auth, tasks) => new DefaultCancelJointActivityUseCase(repo, auth, tasks),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION, JointTaskEnqueuer],
    },
    {
      provide: BEGIN_END_CONFIRM_USE_CASE,
      useFactory: (repo, auth) => new DefaultBeginEndConfirmUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },
    {
      provide: END_JOINT_ACTIVITY_USE_CASE,
      useFactory: (repo, auth, tasks) => new DefaultEndJointActivityUseCase(repo, auth, tasks),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION, JointTaskEnqueuer],
    },
    {
      provide: FORCE_END_JOINT_ACTIVITY_USE_CASE,
      useFactory: (repo, auth, tasks) => new DefaultForceEndJointActivityUseCase(repo, auth, tasks),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION, JointTaskEnqueuer],
    },

    // ----- 参与社团（JNT-002） -----
    {
      provide: PROPOSE_PARTICIPATION_USE_CASE,
      useFactory: (repo, auth) => new DefaultProposeParticipationUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },
    {
      provide: CONFIRM_PARTICIPATION_ROUND_USE_CASE,
      useFactory: (repo, auth) => new DefaultConfirmParticipationRoundUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },
    {
      provide: WITHDRAW_PARTICIPATION_USE_CASE,
      useFactory: (repo, auth) => new DefaultWithdrawParticipationUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },
    {
      provide: SUSPEND_PARTICIPATION_USE_CASE,
      useFactory: (repo, auth) => new DefaultSuspendParticipationUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },
    {
      provide: RESUME_PARTICIPATION_USE_CASE,
      useFactory: (repo, auth) => new DefaultResumeParticipationUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },

    // ----- 联合报名通道（JNT-006） -----
    {
      provide: OPEN_JOINT_CHANNEL_USE_CASE,
      useFactory: (repo, auth, tasks) => new DefaultOpenJointChannelUseCase(repo, auth, tasks),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION, JointTaskEnqueuer],
    },
    {
      provide: SUSPEND_JOINT_CHANNEL_USE_CASE,
      useFactory: (repo, auth) => new DefaultSuspendJointChannelUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },
    {
      provide: RESUME_JOINT_CHANNEL_USE_CASE,
      useFactory: (repo, auth, tasks) => new DefaultResumeJointChannelUseCase(repo, auth, tasks),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION, JointTaskEnqueuer],
    },
    {
      provide: EXTEND_JOINT_CHANNEL_USE_CASE,
      useFactory: (repo, auth, tasks) => new DefaultExtendJointChannelUseCase(repo, auth, tasks),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION, JointTaskEnqueuer],
    },
    {
      provide: CLOSE_JOINT_CHANNEL_USE_CASE,
      useFactory: (repo, auth) => new DefaultCloseJointChannelUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },
    {
      provide: REOPEN_JOINT_CHANNEL_USE_CASE,
      useFactory: (repo, auth, tasks) => new DefaultReopenJointChannelUseCase(repo, auth, tasks),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION, JointTaskEnqueuer],
    },

    // ----- 联合申请（JNT-003） -----
    {
      provide: CREATE_JOINT_APPLICATION_USE_CASE,
      useFactory: (repo) => new DefaultCreateJointApplicationUseCase(repo),
      inject: [JOINT_REPOSITORY],
    },
    {
      provide: SUBMIT_JOINT_APPLICATION_USE_CASE,
      useFactory: (repo, form) => new DefaultSubmitJointApplicationUseCase(repo, form),
      inject: [JOINT_REPOSITORY, JOINT_FORM_PORT],
    },

    // ----- 联合面试（JNT-004） -----
    {
      provide: SCHEDULE_JOINT_INTERVIEW_USE_CASE,
      useFactory: (repo, auth) => new DefaultScheduleJointInterviewUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },
    {
      provide: START_JOINT_INTERVIEW_USE_CASE,
      useFactory: (repo, auth) => new DefaultStartJointInterviewUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },
    {
      provide: COMPLETE_JOINT_INTERVIEW_USE_CASE,
      useFactory: (repo, auth) => new DefaultCompleteJointInterviewUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },
    {
      provide: VOID_JOINT_INTERVIEW_USE_CASE,
      useFactory: (repo, auth) => new DefaultVoidJointInterviewUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },
    {
      provide: RECORD_JOINT_EVALUATION_USE_CASE,
      useFactory: (repo, auth) => new DefaultRecordJointEvaluationUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },

    // ----- 社团结论与邀请（JNT-005） -----
    {
      provide: EDIT_CLUB_CONCLUSION_USE_CASE,
      useFactory: (repo, auth) => new DefaultEditClubConclusionUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },
    {
      provide: SEND_CLUB_INVITATION_USE_CASE,
      useFactory: (repo, auth, invitation, tasks) =>
        new DefaultSendClubInvitationUseCase(repo, auth, invitation, tasks),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION, JOINT_INVITATION_PORT, JointTaskEnqueuer],
    },
    {
      provide: HANDLE_INVITATION_ACCEPTED_USE_CASE,
      useFactory: (repo) => new DefaultHandleInvitationAcceptedUseCase(repo),
      inject: [JOINT_REPOSITORY],
    },
    {
      provide: HANDLE_INVITATION_REJECTED_USE_CASE,
      useFactory: (repo) => new DefaultHandleInvitationRejectedUseCase(repo),
      inject: [JOINT_REPOSITORY],
    },
    {
      provide: RESTORE_FROM_REVIEW_USE_CASE,
      useFactory: (repo, invitation, auth) =>
        new DefaultRestoreFromReviewUseCase(repo, invitation, auth),
      inject: [JOINT_REPOSITORY, JOINT_INVITATION_PORT, JOINT_AUTHORIZATION],
    },

    // ----- 任务式（TASK，无授权） -----
    {
      provide: ARCHIVE_CONCLUSIONS_USE_CASE,
      useFactory: (repo) => new DefaultArchiveConclusionsUseCase(repo),
      inject: [JOINT_REPOSITORY],
    },
    {
      provide: ARCHIVE_JOINT_APPLICATIONS_USE_CASE,
      useFactory: (repo) => new DefaultArchiveJointApplicationsUseCase(repo),
      inject: [JOINT_REPOSITORY],
    },
    {
      provide: AUTO_CLOSE_CHANNEL_USE_CASE,
      useFactory: (repo) => new DefaultAutoCloseChannelUseCase(repo),
      inject: [JOINT_REPOSITORY],
    },
    {
      provide: SCAN_STALE_RECONFIRM_USE_CASE,
      useFactory: (repo) => new DefaultScanStaleReconfirmUseCase(repo),
      inject: [JOINT_REPOSITORY],
    },

    // ----- 查询（JNT-001~006） -----
    {
      provide: GET_JOINT_ACTIVITY_QUERY,
      useFactory: (repo, auth) => new DefaultGetJointActivityUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },
    {
      provide: GET_JOINT_APPLICATION_QUERY,
      useFactory: (repo, auth) => new DefaultGetJointApplicationUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },
    {
      provide: GET_JOINT_CHANNEL_QUERY,
      useFactory: (repo, auth) => new DefaultGetJointChannelUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },
    {
      provide: GET_JOINT_INTERVIEW_QUERY,
      useFactory: (repo, auth) => new DefaultGetJointInterviewUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },
    {
      provide: LIST_CLUB_CONCLUSIONS_QUERY,
      useFactory: (repo, auth) => new DefaultListClubConclusionsUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },
    {
      provide: LIST_JOINT_APPLICATIONS_QUERY,
      useFactory: (repo, auth) => new DefaultListJointApplicationsUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },
    {
      provide: LIST_JOINT_PARTICIPANTS_QUERY,
      useFactory: (repo, auth) => new DefaultListJointParticipantsUseCase(repo, auth),
      inject: [JOINT_REPOSITORY, JOINT_AUTHORIZATION],
    },

    // ----- 传输中立控制器 -----
    {
      provide: JOINT_CONTROLLER,
      useFactory: (
        uow,
        initiate,
        propose,
        confirm,
        publish,
        cancel,
        beginEnd,
        end,
        forceEnd,
        withdraw,
        suspend,
        resume,
        openChannel,
        suspendChannel,
        resumeChannel,
        extendChannel,
        closeChannel,
        reopenChannel,
        createApp,
        submitApp,
        schedule,
        start,
        complete,
        voidItw,
        recordEval,
        editConclusion,
        sendInv,
        acceptInv,
        rejectInv,
        restore,
        archiveConclusions,
        archiveApplications,
        autoClose,
        scanStale,
        getActivity,
        getApplication,
        getChannel,
        getInterview,
        listConclusions,
        listApplications,
        listParticipants,
      ) =>
        new JointController(
          uow,
          initiate,
          propose,
          confirm,
          publish,
          cancel,
          beginEnd,
          end,
          forceEnd,
          withdraw,
          suspend,
          resume,
          openChannel,
          suspendChannel,
          resumeChannel,
          extendChannel,
          closeChannel,
          reopenChannel,
          createApp,
          submitApp,
          schedule,
          start,
          complete,
          voidItw,
          recordEval,
          editConclusion,
          sendInv,
          acceptInv,
          rejectInv,
          restore,
          archiveConclusions,
          archiveApplications,
          autoClose,
          scanStale,
          getActivity,
          getApplication,
          getChannel,
          getInterview,
          listConclusions,
          listApplications,
          listParticipants,
        ),
      inject: [
        JointUnitOfWork,
        INITIATE_JOINT_ACTIVITY_USE_CASE,
        PROPOSE_PARTICIPATION_USE_CASE,
        CONFIRM_PARTICIPATION_ROUND_USE_CASE,
        PUBLISH_JOINT_ACTIVITY_USE_CASE,
        CANCEL_JOINT_ACTIVITY_USE_CASE,
        BEGIN_END_CONFIRM_USE_CASE,
        END_JOINT_ACTIVITY_USE_CASE,
        FORCE_END_JOINT_ACTIVITY_USE_CASE,
        WITHDRAW_PARTICIPATION_USE_CASE,
        SUSPEND_PARTICIPATION_USE_CASE,
        RESUME_PARTICIPATION_USE_CASE,
        OPEN_JOINT_CHANNEL_USE_CASE,
        SUSPEND_JOINT_CHANNEL_USE_CASE,
        RESUME_JOINT_CHANNEL_USE_CASE,
        EXTEND_JOINT_CHANNEL_USE_CASE,
        CLOSE_JOINT_CHANNEL_USE_CASE,
        REOPEN_JOINT_CHANNEL_USE_CASE,
        CREATE_JOINT_APPLICATION_USE_CASE,
        SUBMIT_JOINT_APPLICATION_USE_CASE,
        SCHEDULE_JOINT_INTERVIEW_USE_CASE,
        START_JOINT_INTERVIEW_USE_CASE,
        COMPLETE_JOINT_INTERVIEW_USE_CASE,
        VOID_JOINT_INTERVIEW_USE_CASE,
        RECORD_JOINT_EVALUATION_USE_CASE,
        EDIT_CLUB_CONCLUSION_USE_CASE,
        SEND_CLUB_INVITATION_USE_CASE,
        HANDLE_INVITATION_ACCEPTED_USE_CASE,
        HANDLE_INVITATION_REJECTED_USE_CASE,
        RESTORE_FROM_REVIEW_USE_CASE,
        ARCHIVE_CONCLUSIONS_USE_CASE,
        ARCHIVE_JOINT_APPLICATIONS_USE_CASE,
        AUTO_CLOSE_CHANNEL_USE_CASE,
        SCAN_STALE_RECONFIRM_USE_CASE,
        GET_JOINT_ACTIVITY_QUERY,
        GET_JOINT_APPLICATION_QUERY,
        GET_JOINT_CHANNEL_QUERY,
        GET_JOINT_INTERVIEW_QUERY,
        LIST_CLUB_CONCLUSIONS_QUERY,
        LIST_JOINT_APPLICATIONS_QUERY,
        LIST_JOINT_PARTICIPANTS_QUERY,
      ],
    },
  ],
  exports: [JointUnitOfWork, JOINT_AUTH_SESSION_PROVIDER, JointAuthGuard],
})
export class JointModule {}
