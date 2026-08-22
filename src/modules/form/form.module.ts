/**
 * form 模块 NestJS 装配（interfaces/nest + application + infrastructure）。
 *
 * 自包含分层装配（不 Nest 级依赖 IdentityModule）：FormUnitOfWork（ambient
 * 事务 + RLS 单目标上下文）→ PostgreSQL 仓储/审计/幂等存储 → 领域适配器
 * （权限桩失败关闭 / 静态资料目录）→ 状态机与校验/复制策略（纯规则单例）→
 * 应用用例/查询 → 传输中立 FormDesignController → Nest HTTP 适配控制器与守卫。
 *
 * 会话：经 adaptSessionProvider 转发到 identity 的 AUTH_SESSION_PROVIDER
 * （OIDC 会话链路，B3 已接入）；权限：organization（3.2）
 * 设计/填写权限已接线组织授权（OrgBacked*，ORG-038）；部门级权限解析
 * （ORG-035）无契约支撑前，department 作用域设计仍 fail-closed（见适配器注释）。
 * 资料目录接入共享的 profile-field 常量（src/shared/models，静态实现，随 3.x 配置化目录替换）。
 */

import { Module } from '@nestjs/common';

import { AdaptersModule } from '../../adapters/adapters.module';
import { ObservabilityModule } from '../../platform/observability/module';
import { OrganizationModule } from '../organization/module';
import { IdentityModule } from '../identity/identity.module';
import { AUTH_SESSION_PROVIDER } from '../identity/tokens';
import { adaptSessionProvider } from '../../shared/adapt-session-provider';
import {
  CURRENT_PERMISSIONS_PORT,
} from '../organization/application/ports';
import { DB_ADAPTER } from '../../adapters/tokens';

import {
  FORM_DEFINITION_REPOSITORY,
  FORM_AUDIT_PORT,
  FORM_IDEMPOTENCY_STORE,
  FORM_DESIGN_PERMISSION,
  FORM_PROFILE_FIELD_DIRECTORY,
  FORM_VERSION_MACHINE,
  CREATE_FORM_DRAFT_USE_CASE,
  UPDATE_FORM_DRAFT_USE_CASE,
  RUN_FORM_PREVIEW_TEST_USE_CASE,
  MARK_FORM_PREVIEW_PASSED_USE_CASE,
  PUBLISH_FORM_VERSION_USE_CASE,
  DEPRECATE_FORM_VERSION_USE_CASE,
  REUSE_FORM_VERSION_USE_CASE,
  CLONE_FORM_USE_CASE,
  COPY_TEMPLATE_USE_CASE,
  REQUEST_TEMPLATE_PUBLICATION_USE_CASE,
  REVIEW_TEMPLATE_PUBLICATION_USE_CASE,
  LIST_FORMS_QUERY,
  GET_FORM_DEFINITION_QUERY,
  GET_FORM_DESIGNER_STATE_QUERY,
  LIST_PLATFORM_TEMPLATES_QUERY,
  LIST_TEMPLATE_PUBLICATIONS_QUERY,
  FORM_DESIGN_CONTROLLER,
  FORM_AUTH_SESSION_PROVIDER,
  FORM_SUBMISSION_REPOSITORY,
  FORM_FILL_PERMISSION,
  SUBMIT_FORM_USE_CASE,
  REVISE_SUBMISSION_USE_CASE,
  LIST_SUBMISSIONS_QUERY,
  FORM_SUBMISSION_CONTROLLER,
} from './tokens';

import { FormUnitOfWork } from './infrastructure/unit-of-work';
import { PostgresFormDefinitionRepository } from './infrastructure/postgres-form-definition.repository';
import { PostgresFormAudit } from './infrastructure/postgres-form-audit';
import { PostgresFormIdempotencyStore } from './infrastructure/postgres-form-idempotency-store';
import { PostgresFormSubmissionRepository } from './infrastructure/postgres-form-submission.repository';
import { OrgBackedFormDesignPermission } from './infrastructure/org-form-design-permission';
import { OrgBackedFormFillPermission } from './infrastructure/org-form-fill-permission';
import { StaticProfileFieldDirectory } from './infrastructure/static-profile-field-directory';

import { DefaultFormVersionStateMachine } from './domain/state-machines/form-version.state-machine';

import { DefaultCreateFormDraftUseCase } from './application/commands/create-form-draft.use-case';
import { DefaultUpdateFormDraftUseCase } from './application/commands/update-form-draft.use-case';
import { DefaultRunFormPreviewTestUseCase } from './application/commands/run-form-preview-test.use-case';
import { DefaultMarkFormPreviewPassedUseCase } from './application/commands/mark-form-preview-passed.use-case';
import { DefaultPublishFormVersionUseCase } from './application/commands/publish-form-version.use-case';
import { DefaultDeprecateFormVersionUseCase } from './application/commands/deprecate-form-version.use-case';
import { DefaultReuseFormVersionUseCase } from './application/commands/reuse-form-version.use-case';
import { DefaultCloneFormUseCase } from './application/commands/clone-form.use-case';
import { DefaultCopyTemplateUseCase } from './application/commands/copy-template.use-case';
import { DefaultRequestTemplatePublicationUseCase } from './application/commands/request-template-publication.use-case';
import { DefaultReviewTemplatePublicationUseCase } from './application/commands/review-template-publication.use-case';
import { DefaultListFormsQuery } from './application/queries/list-forms.query';
import { DefaultGetFormDefinitionQuery } from './application/queries/get-form-definition.query';
import { DefaultGetFormDesignerStateQuery } from './application/queries/get-form-designer-state.query';
import { DefaultListPlatformTemplatesQuery } from './application/queries/list-platform-templates.query';
import { DefaultListTemplatePublicationsQuery } from './application/queries/list-template-publications.query';
import { DefaultSubmitFormUseCase } from './application/commands/submit-form.use-case';
import { DefaultReviseSubmissionUseCase } from './application/commands/revise-submission.use-case';
import { DefaultListSubmissionsQuery } from './application/queries/list-submissions.query';

import { FormDesignController } from './interfaces/controllers/form-design.controller';
import { FormSubmissionController } from './interfaces/controllers/form-submission.controller';

import { FormAuthGuard } from './interfaces/nest/form-auth.guard';
import { OrgFormsNestController } from './interfaces/nest/org-forms.nest.controller';
import { AdminFormsNestController } from './interfaces/nest/admin-forms.nest.controller';
import { FormSubmissionNestController } from './interfaces/nest/form-submission.nest.controller';

@Module({
  imports: [AdaptersModule, ObservabilityModule, OrganizationModule, IdentityModule],
  controllers: [OrgFormsNestController, AdminFormsNestController, FormSubmissionNestController],
  providers: [
    // ----- 会话（认证基建接入前失败关闭）-----
    {
      provide: FORM_AUTH_SESSION_PROVIDER,
      useFactory: (identitySession) => adaptSessionProvider(identitySession),
      inject: [AUTH_SESSION_PROVIDER],
    },
    FormAuthGuard,
    // ----- 工作单元（ambient 事务 + RLS 单目标上下文）-----
    {
      provide: FormUnitOfWork,
      useFactory: (db) => new FormUnitOfWork(db),
      inject: [DB_ADAPTER],
    },
    // ----- PostgreSQL 仓储/审计/幂等存储（事务外读写失败关闭）-----
    {
      provide: FORM_DEFINITION_REPOSITORY,
      useFactory: (db, uow) => new PostgresFormDefinitionRepository(db, uow),
      inject: [DB_ADAPTER, FormUnitOfWork],
    },
    {
      provide: FORM_AUDIT_PORT,
      useFactory: (db, uow) => new PostgresFormAudit(db, uow),
      inject: [DB_ADAPTER, FormUnitOfWork],
    },
    {
      provide: FORM_IDEMPOTENCY_STORE,
      useFactory: (db, uow) => new PostgresFormIdempotencyStore(db, uow),
      inject: [DB_ADAPTER, FormUnitOfWork],
    },
    // ----- 领域适配器（组织授权接线 / 静态资料目录；部门作用域仍 fail-closed，见适配器注释）-----
    {
      provide: FORM_DESIGN_PERMISSION,
      useFactory: (permissions) => new OrgBackedFormDesignPermission(permissions),
      inject: [CURRENT_PERMISSIONS_PORT],
    },
    { provide: FORM_PROFILE_FIELD_DIRECTORY, useClass: StaticProfileFieldDirectory },
    // ----- 状态机与策略（纯规则单例）-----
    { provide: FORM_VERSION_MACHINE, useClass: DefaultFormVersionStateMachine },
    // ----- 应用命令 -----
    {
      provide: CREATE_FORM_DRAFT_USE_CASE,
      useFactory: (repo, permission, audit, idempotency) =>
        new DefaultCreateFormDraftUseCase(repo, permission, audit, idempotency),
      inject: [
        FORM_DEFINITION_REPOSITORY,
        FORM_DESIGN_PERMISSION,
        FORM_AUDIT_PORT,
        FORM_IDEMPOTENCY_STORE,
      ],
    },
    {
      provide: UPDATE_FORM_DRAFT_USE_CASE,
      useFactory: (repo, permission, directory, audit, machine) =>
        new DefaultUpdateFormDraftUseCase(repo, permission, directory, audit, machine),
      inject: [
        FORM_DEFINITION_REPOSITORY,
        FORM_DESIGN_PERMISSION,
        FORM_PROFILE_FIELD_DIRECTORY,
        FORM_AUDIT_PORT,
        FORM_VERSION_MACHINE,
      ],
    },
    {
      provide: RUN_FORM_PREVIEW_TEST_USE_CASE,
      useFactory: (repo, permission, audit, machine) =>
        new DefaultRunFormPreviewTestUseCase(repo, permission, audit, machine),
      inject: [
        FORM_DEFINITION_REPOSITORY,
        FORM_DESIGN_PERMISSION,
        FORM_AUDIT_PORT,
        FORM_VERSION_MACHINE,
      ],
    },
    {
      provide: MARK_FORM_PREVIEW_PASSED_USE_CASE,
      useFactory: (repo, permission, audit, machine) =>
        new DefaultMarkFormPreviewPassedUseCase(repo, permission, audit, machine),
      inject: [
        FORM_DEFINITION_REPOSITORY,
        FORM_DESIGN_PERMISSION,
        FORM_AUDIT_PORT,
        FORM_VERSION_MACHINE,
      ],
    },
    {
      provide: PUBLISH_FORM_VERSION_USE_CASE,
      useFactory: (repo, permission, directory, audit, machine) =>
        new DefaultPublishFormVersionUseCase(repo, permission, directory, audit, machine),
      inject: [
        FORM_DEFINITION_REPOSITORY,
        FORM_DESIGN_PERMISSION,
        FORM_PROFILE_FIELD_DIRECTORY,
        FORM_AUDIT_PORT,
        FORM_VERSION_MACHINE,
      ],
    },
    {
      provide: DEPRECATE_FORM_VERSION_USE_CASE,
      useFactory: (repo, permission, audit, machine) =>
        new DefaultDeprecateFormVersionUseCase(repo, permission, audit, machine),
      inject: [
        FORM_DEFINITION_REPOSITORY,
        FORM_DESIGN_PERMISSION,
        FORM_AUDIT_PORT,
        FORM_VERSION_MACHINE,
      ],
    },
    {
      provide: REUSE_FORM_VERSION_USE_CASE,
      useFactory: (repo, permission, audit, machine) =>
        new DefaultReuseFormVersionUseCase(repo, permission, audit, machine),
      inject: [
        FORM_DEFINITION_REPOSITORY,
        FORM_DESIGN_PERMISSION,
        FORM_AUDIT_PORT,
        FORM_VERSION_MACHINE,
      ],
    },
    {
      provide: CLONE_FORM_USE_CASE,
      useFactory: (repo, permission, audit, idempotency) =>
        new DefaultCloneFormUseCase(repo, permission, audit, idempotency),
      inject: [
        FORM_DEFINITION_REPOSITORY,
        FORM_DESIGN_PERMISSION,
        FORM_AUDIT_PORT,
        FORM_IDEMPOTENCY_STORE,
      ],
    },
    {
      provide: COPY_TEMPLATE_USE_CASE,
      useFactory: (repo, permission, audit, idempotency) =>
        new DefaultCopyTemplateUseCase(repo, permission, audit, idempotency),
      inject: [
        FORM_DEFINITION_REPOSITORY,
        FORM_DESIGN_PERMISSION,
        FORM_AUDIT_PORT,
        FORM_IDEMPOTENCY_STORE,
      ],
    },
    {
      provide: REQUEST_TEMPLATE_PUBLICATION_USE_CASE,
      useFactory: (repo, permission, audit, idempotency) =>
        new DefaultRequestTemplatePublicationUseCase(repo, permission, audit, idempotency),
      inject: [
        FORM_DEFINITION_REPOSITORY,
        FORM_DESIGN_PERMISSION,
        FORM_AUDIT_PORT,
        FORM_IDEMPOTENCY_STORE,
      ],
    },
    {
      provide: REVIEW_TEMPLATE_PUBLICATION_USE_CASE,
      useFactory: (repo, permission, audit) =>
        new DefaultReviewTemplatePublicationUseCase(repo, permission, audit),
      inject: [FORM_DEFINITION_REPOSITORY, FORM_DESIGN_PERMISSION, FORM_AUDIT_PORT],
    },
    // ----- 应用查询 -----
    {
      provide: LIST_FORMS_QUERY,
      useFactory: (repo, permission) => new DefaultListFormsQuery(repo, permission),
      inject: [FORM_DEFINITION_REPOSITORY, FORM_DESIGN_PERMISSION],
    },
    {
      provide: GET_FORM_DEFINITION_QUERY,
      useFactory: (repo, permission) => new DefaultGetFormDefinitionQuery(repo, permission),
      inject: [FORM_DEFINITION_REPOSITORY, FORM_DESIGN_PERMISSION],
    },
    {
      provide: GET_FORM_DESIGNER_STATE_QUERY,
      useFactory: (repo, permission) => new DefaultGetFormDesignerStateQuery(repo, permission),
      inject: [FORM_DEFINITION_REPOSITORY, FORM_DESIGN_PERMISSION],
    },
    {
      provide: LIST_PLATFORM_TEMPLATES_QUERY,
      useFactory: (repo) => new DefaultListPlatformTemplatesQuery(repo),
      inject: [FORM_DEFINITION_REPOSITORY],
    },
    {
      provide: LIST_TEMPLATE_PUBLICATIONS_QUERY,
      useFactory: (repo, permission) => new DefaultListTemplatePublicationsQuery(repo, permission),
      inject: [FORM_DEFINITION_REPOSITORY, FORM_DESIGN_PERMISSION],
    },
    // ----- FORM-002 提交/修订/列表（权限失败关闭桩）-----
    {
      provide: FORM_SUBMISSION_REPOSITORY,
      useFactory: (db, uow) => new PostgresFormSubmissionRepository(db, uow),
      inject: [DB_ADAPTER, FormUnitOfWork],
    },
    {
      provide: FORM_FILL_PERMISSION,
      useFactory: (permissions) => new OrgBackedFormFillPermission(permissions),
      inject: [CURRENT_PERMISSIONS_PORT],
    },
    {
      provide: SUBMIT_FORM_USE_CASE,
      useFactory: (repo, definitions, permission, audit, idempotency) =>
        new DefaultSubmitFormUseCase(repo, definitions, permission, audit, idempotency),
      inject: [
        FORM_SUBMISSION_REPOSITORY,
        FORM_DEFINITION_REPOSITORY,
        FORM_FILL_PERMISSION,
        FORM_AUDIT_PORT,
        FORM_IDEMPOTENCY_STORE,
      ],
    },
    {
      provide: REVISE_SUBMISSION_USE_CASE,
      useFactory: (repo, definitions, permission, audit) =>
        new DefaultReviseSubmissionUseCase(repo, definitions, permission, audit),
      inject: [
        FORM_SUBMISSION_REPOSITORY,
        FORM_DEFINITION_REPOSITORY,
        FORM_FILL_PERMISSION,
        FORM_AUDIT_PORT,
      ],
    },
    {
      provide: LIST_SUBMISSIONS_QUERY,
      useFactory: (repo) => new DefaultListSubmissionsQuery(repo),
      inject: [FORM_SUBMISSION_REPOSITORY],
    },
    {
      provide: FORM_SUBMISSION_CONTROLLER,
      useFactory: (uow, submit, revise, list) =>
        new FormSubmissionController(uow, submit, revise, list),
      inject: [
        FormUnitOfWork,
        SUBMIT_FORM_USE_CASE,
        REVISE_SUBMISSION_USE_CASE,
        LIST_SUBMISSIONS_QUERY,
      ],
    },
    // ----- 传输中立控制器 -----
    {
      provide: FORM_DESIGN_CONTROLLER,
      useFactory: (
        uow,
        createDraft,
        updateDraft,
        runPreviewTest,
        markPreviewPassed,
        publish,
        deprecate,
        reuse,
        cloneForm,
        copyTemplate,
        requestPublication,
        reviewPublication,
        listForms,
        getFormDefinition,
        getDesignerState,
        listTemplates,
        listPublications,
      ) =>
        new FormDesignController(
          uow,
          createDraft,
          updateDraft,
          runPreviewTest,
          markPreviewPassed,
          publish,
          deprecate,
          reuse,
          cloneForm,
          copyTemplate,
          requestPublication,
          reviewPublication,
          listForms,
          getFormDefinition,
          getDesignerState,
          listTemplates,
          listPublications,
        ),
      inject: [
        FormUnitOfWork,
        CREATE_FORM_DRAFT_USE_CASE,
        UPDATE_FORM_DRAFT_USE_CASE,
        RUN_FORM_PREVIEW_TEST_USE_CASE,
        MARK_FORM_PREVIEW_PASSED_USE_CASE,
        PUBLISH_FORM_VERSION_USE_CASE,
        DEPRECATE_FORM_VERSION_USE_CASE,
        REUSE_FORM_VERSION_USE_CASE,
        CLONE_FORM_USE_CASE,
        COPY_TEMPLATE_USE_CASE,
        REQUEST_TEMPLATE_PUBLICATION_USE_CASE,
        REVIEW_TEMPLATE_PUBLICATION_USE_CASE,
        LIST_FORMS_QUERY,
        GET_FORM_DEFINITION_QUERY,
        GET_FORM_DESIGNER_STATE_QUERY,
        LIST_PLATFORM_TEMPLATES_QUERY,
        LIST_TEMPLATE_PUBLICATIONS_QUERY,
      ],
    },
  ],
  exports: [FormUnitOfWork, FORM_AUTH_SESSION_PROVIDER, FormAuthGuard],
})
export class FormModule {}
