/**
 * FormDesignController（interfaces 层；接口清单 §13 表单设计/版本/模板）。
 *
 * 职责：把信封/路径参数组装为用例输入，在单主体 RLS 事务边界内执行（全部请求
 * 在事务内读写，仓储经 ambient 事务；IFC-TX-001），错误经 toApiError 映射。
 * 作用域由服务端路径（clubId）冻结，不采纳客户端自报作用域（IFC-GEN-001）。
 */

import type { FormUnitOfWork } from '../../infrastructure/unit-of-work';
import type { RlsScope } from '../../../../shared/db-adapter';
import type { ActorContext } from './actor-context';
import { toApiError } from '../http/form-error-http';
import type { ApiErrorResult } from '../http/form-error-http';
import type { FormScope } from '../../domain/models/form-scope';
import type { CreateFormDraftUseCase } from '../../application/commands/create-form-draft.use-case';
import type { UpdateFormDraftUseCase } from '../../application/commands/update-form-draft.use-case';
import type { RunFormPreviewTestUseCase } from '../../application/commands/run-form-preview-test.use-case';
import type { MarkFormPreviewPassedUseCase } from '../../application/commands/mark-form-preview-passed.use-case';
import type { PublishFormVersionUseCase } from '../../application/commands/publish-form-version.use-case';
import type { DeprecateFormVersionUseCase } from '../../application/commands/deprecate-form-version.use-case';
import type { ReuseFormVersionUseCase } from '../../application/commands/reuse-form-version.use-case';
import type { CloneFormUseCase } from '../../application/commands/clone-form.use-case';
import type { CopyTemplateUseCase } from '../../application/commands/copy-template.use-case';
import type { RequestTemplatePublicationUseCase } from '../../application/commands/request-template-publication.use-case';
import type { ReviewTemplatePublicationUseCase } from '../../application/commands/review-template-publication.use-case';
import type { ListFormsQuery } from '../../application/queries/list-forms.query';
import type { GetFormDefinitionQuery } from '../../application/queries/get-form-definition.query';
import type { GetFormDesignerStateQuery } from '../../application/queries/get-form-designer-state.query';
import type { ListPlatformTemplatesQuery } from '../../application/queries/list-platform-templates.query';
import type { ListTemplatePublicationsQuery } from '../../application/queries/list-template-publications.query';
import type { TemplatePublicationState } from '../../domain/models/template-publication';

export type FormControllerResult<T> = { readonly ok: true; readonly value: T } | ApiErrorResult;

export interface CreateFormInput {
  readonly title: string;
  readonly description: string | null;
  readonly businessFamily: string | null;
  readonly idempotencyKey?: string;
}

export interface UpdateFormInput {
  readonly fields: readonly unknown[];
}

export interface PreviewTestInput {
  readonly result: 'PASSED' | 'FAILED';
  readonly summary: Record<string, unknown>;
}

export interface ReviewInput {
  readonly decision: 'APPROVE' | 'REJECT';
  readonly reason: string | null;
}

export class FormDesignController {
  constructor(
    private readonly uow: FormUnitOfWork,
    private readonly createDraft: CreateFormDraftUseCase,
    private readonly updateDraft: UpdateFormDraftUseCase,
    private readonly runPreviewTestUsecase: RunFormPreviewTestUseCase,
    private readonly markPreviewPassed: MarkFormPreviewPassedUseCase,
    private readonly publish: PublishFormVersionUseCase,
    private readonly deprecate: DeprecateFormVersionUseCase,
    private readonly reuse: ReuseFormVersionUseCase,
    private readonly cloneForm: CloneFormUseCase,
    private readonly copyTemplateUsecase: CopyTemplateUseCase,
    private readonly requestTemplatePublication: RequestTemplatePublicationUseCase,
    private readonly reviewTemplatePublication: ReviewTemplatePublicationUseCase,
    private readonly listForms: ListFormsQuery,
    private readonly getFormDefinition: GetFormDefinitionQuery,
    private readonly getDesignerStateQuery: GetFormDesignerStateQuery,
    private readonly listTemplatesQuery: ListPlatformTemplatesQuery,
    private readonly listPublicationsQuery: ListTemplatePublicationsQuery,
  ) {}

  private run<T>(actor: ActorContext, fn: () => Promise<T>): Promise<T> {
    const scope: RlsScope = { kind: 'single', subjectId: actor.subjectId };
    return this.uow.run(scope, fn);
  }

  // ----- 组织侧（scope 由路径冻结） -----

  list(actor: ActorContext, scope: FormScope): Promise<FormControllerResult<unknown>> {
    return this.guarded(actor, () => this.listForms.execute({ scope, actor: actor.subjectId }));
  }

  create(
    actor: ActorContext,
    scope: FormScope,
    input: CreateFormInput,
  ): Promise<FormControllerResult<unknown>> {
    return this.guarded(actor, () =>
      this.createDraft.execute({
        scope,
        title: input.title,
        description: input.description,
        businessFamily: input.businessFamily,
        actor: actor.subjectId,
        now: actor.now,
        traceId: actor.traceId,
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }

  getDefinition(actor: ActorContext, formId: string): Promise<FormControllerResult<unknown>> {
    return this.guarded(actor, () =>
      this.getFormDefinition.execute({ formId, actor: actor.subjectId }),
    );
  }

  getDesignerState(actor: ActorContext, formId: string): Promise<FormControllerResult<unknown>> {
    return this.guarded(actor, () =>
      this.getDesignerStateQuery.execute({ formId, actor: actor.subjectId }),
    );
  }

  saveDraft(
    actor: ActorContext,
    formId: string,
    expectedVersion: number,
    input: UpdateFormInput,
  ): Promise<FormControllerResult<unknown>> {
    return this.guarded(actor, () =>
      this.updateDraft.execute({
        formId,
        expectedVersion,
        fields: input.fields,
        actor: actor.subjectId,
        now: actor.now,
        traceId: actor.traceId,
      }),
    );
  }

  runPreviewTest(
    actor: ActorContext,
    formId: string,
    input: PreviewTestInput,
  ): Promise<FormControllerResult<unknown>> {
    return this.guarded(actor, () =>
      this.runPreviewTestUsecase.execute({
        formId,
        result: input.result,
        summary: input.summary,
        actor: actor.subjectId,
        now: actor.now,
        traceId: actor.traceId,
      }),
    );
  }

  confirmPreviewPassed(
    actor: ActorContext,
    formId: string,
  ): Promise<FormControllerResult<unknown>> {
    return this.guarded(actor, () =>
      this.markPreviewPassed.execute({
        formId,
        actor: actor.subjectId,
        now: actor.now,
        traceId: actor.traceId,
      }),
    );
  }

  publishVersion(
    actor: ActorContext,
    formId: string,
    expectedRootVersion: number | null,
  ): Promise<FormControllerResult<unknown>> {
    return this.guarded(actor, () =>
      this.publish.execute({
        formId,
        version: null,
        expectedRootVersion,
        actor: actor.subjectId,
        now: actor.now,
        traceId: actor.traceId,
      }),
    );
  }

  deprecateVersion(
    actor: ActorContext,
    formId: string,
    expectedRootVersion: number | null,
  ): Promise<FormControllerResult<unknown>> {
    return this.guarded(actor, () =>
      this.deprecate.execute({
        formId,
        expectedRootVersion,
        actor: actor.subjectId,
        now: actor.now,
        traceId: actor.traceId,
      }),
    );
  }

  reuseVersion(
    actor: ActorContext,
    formId: string,
    sourceVersion: number | null,
  ): Promise<FormControllerResult<unknown>> {
    return this.guarded(actor, () =>
      this.reuse.execute({
        formId,
        sourceVersion,
        actor: actor.subjectId,
        now: actor.now,
        traceId: actor.traceId,
      }),
    );
  }

  clone(
    actor: ActorContext,
    sourceFormId: string,
    scope: FormScope,
    input: { title: string | null; idempotencyKey?: string },
  ): Promise<FormControllerResult<unknown>> {
    return this.guarded(actor, () =>
      this.cloneForm.execute({
        sourceFormId,
        targetScope: scope,
        title: input.title,
        actor: actor.subjectId,
        now: actor.now,
        traceId: actor.traceId,
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }

  listTemplates(actor: ActorContext): Promise<FormControllerResult<unknown>> {
    return this.guarded(actor, () => this.listTemplatesQuery.execute());
  }

  copyTemplate(
    actor: ActorContext,
    templateId: string,
    scope: FormScope,
    input: { title: string | null; idempotencyKey?: string },
  ): Promise<FormControllerResult<unknown>> {
    return this.guarded(actor, () =>
      this.copyTemplateUsecase.execute({
        templateId,
        targetScope: scope,
        title: input.title,
        actor: actor.subjectId,
        now: actor.now,
        traceId: actor.traceId,
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }

  requestPublication(
    actor: ActorContext,
    formId: string,
    input: { note: string | null; idempotencyKey?: string },
  ): Promise<FormControllerResult<unknown>> {
    return this.guarded(actor, () =>
      this.requestTemplatePublication.execute({
        formId,
        note: input.note,
        actor: actor.subjectId,
        now: actor.now,
        traceId: actor.traceId,
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }

  // ----- 管理侧 -----

  listPublications(
    actor: ActorContext,
    status: TemplatePublicationState | null,
  ): Promise<FormControllerResult<unknown>> {
    return this.guarded(actor, () =>
      this.listPublicationsQuery.execute({ status, actor: actor.subjectId }),
    );
  }

  reviewPublication(
    actor: ActorContext,
    publicationId: string,
    input: ReviewInput,
  ): Promise<FormControllerResult<unknown>> {
    return this.guarded(actor, () =>
      this.reviewTemplatePublication.execute({
        publicationId,
        decision: input.decision,
        reason: input.reason,
        actor: actor.subjectId,
        now: actor.now,
        traceId: actor.traceId,
      }),
    );
  }

  private async guarded<T>(
    actor: ActorContext,
    fn: () => Promise<T>,
  ): Promise<FormControllerResult<T>> {
    return this.run(actor, async () => {
      try {
        return { ok: true as const, value: await fn() };
      } catch (error) {
        return toApiError(error);
      }
    });
  }
}
