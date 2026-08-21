/**
 * RecruitmentController（interfaces 层；4.4 招新主链路编排）。
 *
 * 职责：把信封/路径参数组装为用例输入，在单主体 RLS 事务边界内执行，错误经
 * toApiError 映射。作用域由服务端路径 clubId 冻结。
 */

import type { RecruitmentUnitOfWork } from '../../infrastructure/unit-of-work';
import type { RlsScope } from '../../../../shared/db-adapter';
import type { ActorContext } from './actor-context';
import { toApiError, type ApiErrorResult } from '../http/recruitment-error-http';
import type { CreateRecruitmentActivityUseCase } from '../../application/commands/create-recruitment-activity.use-case';
import type { OpenApplicationChannelUseCase } from '../../application/commands/open-application-channel.use-case';
import type { SubmitApplicationUseCase, SubmitApplicationInput } from '../../application/commands/submit-application.use-case';
import type { RecordDepartmentDecisionUseCase, RecordDepartmentDecisionInput } from '../../application/commands/record-department-decision.use-case';
import type { ListActivitiesQuery } from '../../application/queries/list-activities.query';
import type { ListApplicationsQuery } from '../../application/queries/list-applications.query';

type ControllerResult<T> = { readonly ok: true; readonly value: T } | ApiErrorResult;

export class RecruitmentController {
  constructor(
    private readonly uow: RecruitmentUnitOfWork,
    private readonly createActivityUseCase: CreateRecruitmentActivityUseCase,
    private readonly openChannelUseCase: OpenApplicationChannelUseCase,
    private readonly submitApplicationUseCase: SubmitApplicationUseCase,
    private readonly recordDecisionUseCase: RecordDepartmentDecisionUseCase,
    private readonly listActivitiesQuery: ListActivitiesQuery,
    private readonly listApplicationsQuery: ListApplicationsQuery,
  ) {}

  private run<T>(actor: ActorContext, fn: () => Promise<T>): Promise<ControllerResult<T>> {
    const scope: RlsScope = { kind: 'single', subjectId: actor.subjectId };
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
    input: { readonly title: string; readonly description: string | null },
  ): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.createActivityUseCase.execute({
        clubId,
        title: input.title,
        description: input.description,
        actor: actor.subjectId,
        now: actor.now,
      }),
    );
  }

  openChannel(actor: ActorContext, activityId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () =>
      this.openChannelUseCase.execute({ activityId, actor: actor.subjectId, now: actor.now }),
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

  listActivities(actor: ActorContext, clubId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () => this.listActivitiesQuery.execute({ clubId }));
  }

  listApplications(actor: ActorContext, activityId: string): Promise<ControllerResult<unknown>> {
    return this.run(actor, () => this.listApplicationsQuery.execute({ activityId }));
  }
}
