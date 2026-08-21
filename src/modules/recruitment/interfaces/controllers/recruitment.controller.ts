/**
 * RecruitmentController（interfaces 层；4.4 招新主链路编排，含 REC-005 面试）。
 *
 * 职责：把信封/路径参数组装为用例输入，在单主体 RLS 事务边界内执行，错误经
 * toApiError 映射。作用域由服务端路径 clubId 冻结。
 */

import type { RecruitmentUnitOfWork } from '../../infrastructure/unit-of-work';
import type { RlsScope } from '../../../../shared/db-adapter';
import type { ActorContext } from './actor-context';
import { toApiError, type ApiErrorResult } from '../http/recruitment-error-http';
import type { CreateRecruitmentActivityUseCase } from '../../application/commands/create-recruitment-activity.use-case';
import type { PublishRecruitmentActivityUseCase } from '../../application/commands/publish-recruitment-activity.use-case';
import type { OpenApplicationChannelUseCase } from '../../application/commands/open-application-channel.use-case';
import type {
  SubmitApplicationUseCase,
  SubmitApplicationInput,
} from '../../application/commands/submit-application.use-case';
import type {
  RecordDepartmentDecisionUseCase,
  RecordDepartmentDecisionInput,
} from '../../application/commands/record-department-decision.use-case';
import type { InterviewWorkflowUseCase } from '../../application/commands/interview-workflow.use-case';
import type { ListActivitiesQuery } from '../../application/queries/list-activities.query';
import type { ListApplicationsQuery } from '../../application/queries/list-applications.query';
import type { ListInterviewsQuery } from '../../application/queries/list-interviews.query';
import type {
  SendAdmissionInvitationUseCase,
  AcceptAdmissionInvitationUseCase,
} from '../../application/commands/admission.use-case';

type ControllerResult<T> = { readonly ok: true; readonly value: T } | ApiErrorResult;

export class RecruitmentController {
  constructor(
    private readonly uow: RecruitmentUnitOfWork,
    private readonly createActivityUseCase: CreateRecruitmentActivityUseCase,
    private readonly publishActivityUseCase: PublishRecruitmentActivityUseCase,
    private readonly openChannelUseCase: OpenApplicationChannelUseCase,
    private readonly submitApplicationUseCase: SubmitApplicationUseCase,
    private readonly recordDecisionUseCase: RecordDepartmentDecisionUseCase,
    private readonly interviewWorkflow: InterviewWorkflowUseCase,
    private readonly listActivitiesQuery: ListActivitiesQuery,
    private readonly listApplicationsQuery: ListApplicationsQuery,
    private readonly listInterviewsQuery: ListInterviewsQuery,
    private readonly sendInvitationUseCase: SendAdmissionInvitationUseCase,
    private readonly acceptInvitationUseCase: AcceptAdmissionInvitationUseCase,
  ) {}

  private run<T>(actor: ActorContext, fn: () => Promise<T>): Promise<ControllerResult<T>> {
    // 招新域负责人需跨 owner 读全部申请/面试/活动（按 clubId/activityId 查询），
    // 非 subjectId 单行可见；首版无组织授权数据可做 RLS 过滤，故用 unprotected
    // 上下文（与 RecruitmentUnitOfWork 注释一致），由应用层负责按 clubId 授权。
    const scope: RlsScope = { kind: 'unprotected' };
    return this.uow.run(scope, async () => {
      try {
        return { ok: true as const, value: await fn() };
      } catch (error) {
        return toApiError(error);
      }
    });
  }

  createActivity(
    actor: ActorContext,
    clubId: string,
    input: {
      readonly title: string;
      readonly description: string | null;
      readonly endDate?: Date | null;
    },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.createActivityUseCase.execute({
        clubId,
        title: input.title,
        description: input.description,
        endDate: input.endDate ?? null,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  publishActivity(actor: ActorContext, activityId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.publishActivityUseCase.execute({
        activityId,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  openChannel(
    actor: ActorContext,
    activityId: string,
    input: {
      readonly minChoices?: number;
      readonly maxChoices?: number;
    },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.openChannelUseCase.execute({
        activityId,
        minChoices: input.minChoices,
        maxChoices: input.maxChoices,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  submitApplication(
    actor: ActorContext,
    input: Omit<SubmitApplicationInput, 'actor' | 'now'>,
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.submitApplicationUseCase.execute({ ...input, actor: actor.subjectId, now: actor.now }),
    );
  }

  recordDecision(
    actor: ActorContext,
    applicationId: string,
    input: Omit<RecordDepartmentDecisionInput, 'applicationId' | 'actor' | 'now'>,
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.recordDecisionUseCase.execute({
        ...input,
        applicationId,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  scheduleInterview(
    actor: ActorContext,
    input: {
      readonly applicationId: string;
      readonly roundId: string;
      readonly interviewerId: string;
      readonly scheduledAt: Date;
      readonly location: string | null;
    },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.interviewWorkflow.schedule({ ...input, actor: actor.subjectId, now: actor.now }),
    );
  }

  startInterview(actor: ActorContext, interviewId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.interviewWorkflow.start({ interviewId, actor: actor.subjectId, now: actor.now }),
    );
  }

  completeInterview(actor: ActorContext, interviewId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.interviewWorkflow.complete({ interviewId, actor: actor.subjectId, now: actor.now }),
    );
  }

  voidInterview(actor: ActorContext, interviewId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.interviewWorkflow.void({ interviewId, actor: actor.subjectId, now: actor.now }),
    );
  }

  cancelInterview(actor: ActorContext, interviewId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.interviewWorkflow.cancel({ interviewId, actor: actor.subjectId, now: actor.now }),
    );
  }

  skipInterview(
    actor: ActorContext,
    input: { readonly interviewId: string; readonly reason: string },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.interviewWorkflow.skip({ ...input, actor: actor.subjectId, now: actor.now }),
    );
  }

  holdInterview(
    actor: ActorContext,
    input: { readonly interviewId: string; readonly until: Date },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.interviewWorkflow.hold({ ...input, actor: actor.subjectId, now: actor.now }),
    );
  }

  resumeInterview(actor: ActorContext, interviewId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.interviewWorkflow.resume({ interviewId, actor: actor.subjectId, now: actor.now }),
    );
  }

  recordInterviewEvaluation(
    actor: ActorContext,
    input: { readonly interviewId: string; readonly values: Record<string, unknown> },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.interviewWorkflow.recordEvaluation({ ...input, actor: actor.subjectId, now: actor.now }),
    );
  }

  listActivities(actor: ActorContext, clubId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () => this.listActivitiesQuery.execute({ clubId }));
  }

  listApplications(actor: ActorContext, activityId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () => this.listApplicationsQuery.execute({ activityId }));
  }

  listInterviews(actor: ActorContext, roundId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () => this.listInterviewsQuery.execute({ roundId }));
  }

  sendInvitation(
    actor: ActorContext,
    applicationId: string,
    expectedVersion?: number,
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.sendInvitationUseCase.execute({
        applicationId,
        actor: actor.subjectId,
        now: actor.now,
        expectedVersion,
      }),
    );
  }

  acceptInvitation(
    actor: ActorContext,
    applicationId: string,
    expectedVersion?: number,
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.acceptInvitationUseCase.execute({
        applicationId,
        actor: actor.subjectId,
        now: actor.now,
        expectedVersion,
      }),
    );
  }
}
