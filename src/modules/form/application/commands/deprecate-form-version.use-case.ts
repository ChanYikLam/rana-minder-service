/**
 * 停用表单用例（SRS-SM-FORM-001 t6；FORM-002、CFG-005）。
 *
 * 已发布不可变版本 → 已停用：置为停用并清空当前使用指针；停用幂等
 * （已停用/无当前发布版本重复停用成功返回）。不可再提交；复用走来源复用
 * （t7）。停用不删除数据（FORM-008），仅提示未归档（IFC-ERR-016 由 4.1.2
 * 承接）。并发停用单胜者（IFC-ERR-010）。
 */

import type { FormDefinitionRepository } from '../ports/form-definition-repository.port';
import type { FormDesignPermissionPort } from '../ports/form-design-permission.port';
import type { FormAuditPort } from '../ports/form-audit.port';
import { FormDefinition } from '../../domain/models/form-definition';
import { FormVersion } from '../../domain/models/form-version';
import { FormVersionState } from '../../domain/state-machines/form-version.state-machine';
import type { FormVersionStateMachine } from '../../domain/state-machines/form-version.state-machine';
import { formErrors } from '../errors';

export interface DeprecateFormVersionInput {
  readonly formId: string;
  readonly expectedRootVersion?: number | null;
  readonly actor: string;
  readonly now: Date;
  readonly traceId: string | null;
}

export interface DeprecateFormVersionResult {
  readonly formId: string;
  readonly status: 'deprecated';
  readonly deprecatedAt: Date;
}

export interface DeprecateFormVersionUseCase {
  execute(input: DeprecateFormVersionInput): Promise<DeprecateFormVersionResult>;
}

export class DefaultDeprecateFormVersionUseCase implements DeprecateFormVersionUseCase {
  constructor(
    private readonly repository: FormDefinitionRepository,
    private readonly permission: FormDesignPermissionPort,
    private readonly audit: FormAuditPort,
    private readonly machine: FormVersionStateMachine,
  ) {}

  async execute(input: DeprecateFormVersionInput): Promise<DeprecateFormVersionResult> {
    const rootSnapshot = await this.repository.loadRoot(input.formId);
    if (rootSnapshot === null) {
      throw formErrors.notFound('表单');
    }
    const root = FormDefinition.fromSnapshot(rootSnapshot);
    if (!(await this.permission.canDesign({ subjectId: input.actor }, root.scope))) {
      throw formErrors.forbidden('当前角色无权停用该表单');
    }

    const currentPublished = root.currentPublishedVersion;
    if (currentPublished === null) {
      // 幂等：无当前发布版本（已停用或从未发布）重复停用成功
      await this.audit.record({
        type: 'FORM_DEPRECATED',
        subjectId: input.formId,
        occurredAt: input.now,
        actor: input.actor,
        traceId: input.traceId,
        summary: { action: 'DEPRECATED_IDEMPOTENT', formId: input.formId, versionNumber: null },
      });
      return { formId: input.formId, status: 'deprecated', deprecatedAt: input.now };
    }

    const current = await this.repository.loadVersion(input.formId, currentPublished);
    if (current === null) {
      throw formErrors.notFound('表单版本');
    }
    const version = FormVersion.fromSnapshot(current);
    if (!version.deprecate(this.machine, input.actor, input.now)) {
      throw formErrors.preconditionFailed('仅已发布版本可停用');
    }

    await this.repository.saveVersionWithStatusGuard(
      version.toSnapshot(),
      FormVersionState.PUBLISHED,
    );

    const before = root.version;
    if (
      input.expectedRootVersion !== null &&
      input.expectedRootVersion !== undefined &&
      input.expectedRootVersion !== before
    ) {
      throw formErrors.versionConflict();
    }
    root.clearPublishedPointer(input.now);
    await this.repository.saveRoot(root.toSnapshot(), before);

    await this.audit.record({
      type: 'FORM_DEPRECATED',
      subjectId: input.formId,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        action: 'DEPRECATED',
        formId: input.formId,
        versionNumber: current.versionNumber,
        deprecatedAt: input.now.toISOString(),
      },
    });

    return { formId: input.formId, status: 'deprecated', deprecatedAt: input.now };
  }
}
