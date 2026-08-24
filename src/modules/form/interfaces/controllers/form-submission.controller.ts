/**
 * FormSubmissionController（interfaces 层；FORM-002 提交/修订/列表）。
 *
 * 职责：把信封/路径参数组装为用例输入，在单主体 RLS 事务边界内执行，错误经
 * toApiError 映射。作用域由服务端路径（clubId）冻结（IFC-GEN-001）。
 */

import type { FormUnitOfWork } from '../../infrastructure/unit-of-work';
import type { RlsScope } from '../../../../shared/db-adapter';
import type { ActorContext } from './actor-context';
import { toApiError } from '../http/form-error-http';
import type { ApiErrorResult } from '../http/form-error-http';
import type { FormScope } from '../../domain/models/form-scope';
import type { SubmitFormUseCase } from '../../application/commands/submit-form.use-case';
import type { ReviseSubmissionUseCase } from '../../application/commands/revise-submission.use-case';
import type { ListSubmissionsQuery } from '../../application/queries/list-submissions.query';

export type SubmissionControllerResult<T> =
  { readonly ok: true; readonly value: T } | ApiErrorResult;

export interface SubmitFormBody {
  readonly formId: string;
  readonly versionNumber: number;
  readonly values: Record<string, unknown>;
  readonly idempotencyKey?: string;
}

export interface ReviseSubmissionBody {
  readonly values: Record<string, unknown>;
}

export class FormSubmissionController {
  constructor(
    private readonly uow: FormUnitOfWork,
    private readonly submitUseCase: SubmitFormUseCase,
    private readonly reviseUseCase: ReviseSubmissionUseCase,
    private readonly listQuery: ListSubmissionsQuery,
  ) {}

  private run<T>(actor: ActorContext, fn: () => Promise<T>): Promise<T> {
    const scope: RlsScope = { kind: 'single', subjectId: actor.subjectId };
    return this.uow.run(scope, fn);
  }

  submit(
    actor: ActorContext,
    scope: FormScope,
    body: SubmitFormBody,
  ): Promise<SubmissionControllerResult<unknown>> {
    return this.guarded(actor, () =>
      this.submitUseCase.execute({
        formId: body.formId,
        versionNumber: body.versionNumber,
        scope,
        submittedBy: actor.subjectId,
        values: body.values,
        actor: actor.subjectId,
        now: actor.now,
        traceId: actor.traceId,
        idempotencyKey: body.idempotencyKey,
      }),
    );
  }

  revise(
    actor: ActorContext,
    submissionId: string,
    body: ReviseSubmissionBody,
  ): Promise<SubmissionControllerResult<unknown>> {
    return this.guarded(actor, () =>
      this.reviseUseCase.execute({
        submissionId,
        values: body.values,
        actor: actor.subjectId,
        now: actor.now,
        traceId: actor.traceId,
      }),
    );
  }

  list(
    actor: ActorContext,
    scope: FormScope,
    formId?: string,
  ): Promise<SubmissionControllerResult<unknown>> {
    return this.guarded(actor, () => this.listQuery.execute({ scope, formId }));
  }

  private async guarded<T>(
    actor: ActorContext,
    fn: () => Promise<T>,
  ): Promise<SubmissionControllerResult<T>> {
    return this.run(actor, async () => {
      try {
        return { ok: true as const, value: await fn() };
      } catch (error) {
        return toApiError(error);
      }
    });
  }
}
