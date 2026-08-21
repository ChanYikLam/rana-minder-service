/**
 * 测试通过并返回发布准备用例（SRS-SM-FORM-001 t4；FORM-002、CFG-005）。
 *
 * 预览/测试 → 草稿（可发布标志 publishable=true）；不自动发布。前置条件：
 * 测试结果对应当前草稿版本（同一版本内最近一次测试为 PASSED）；草稿变更使
 * 通过标志失效（t2 已清空 publishable，本用例只认 PREVIEW_TESTING 当前态）。
 */

import type { FormDefinitionRepository } from '../ports/form-definition-repository.port';
import type { FormDesignPermissionPort } from '../ports/form-design-permission.port';
import type { FormAuditPort } from '../ports/form-audit.port';
import { FormVersion } from '../../domain/models/form-version';
import { FormVersionState } from '../../domain/state-machines/form-version.state-machine';
import type { FormVersionStateMachine } from '../../domain/state-machines/form-version.state-machine';
import { formErrors } from '../errors';

export interface MarkFormPreviewPassedInput {
  readonly formId: string;
  readonly actor: string;
  readonly now: Date;
  readonly traceId: string | null;
}

export interface MarkFormPreviewPassedResult {
  readonly formId: string;
  readonly versionNumber: number;
  readonly publishable: true;
}

export interface MarkFormPreviewPassedUseCase {
  execute(input: MarkFormPreviewPassedInput): Promise<MarkFormPreviewPassedResult>;
}

export class DefaultMarkFormPreviewPassedUseCase implements MarkFormPreviewPassedUseCase {
  constructor(
    private readonly repository: FormDefinitionRepository,
    private readonly permission: FormDesignPermissionPort,
    private readonly audit: FormAuditPort,
    private readonly machine: FormVersionStateMachine,
  ) {}

  async execute(input: MarkFormPreviewPassedInput): Promise<MarkFormPreviewPassedResult> {
    const root = await this.repository.loadRoot(input.formId);
    if (root === null) {
      throw formErrors.notFound('表单');
    }
    if (!(await this.permission.canDesign({ subjectId: input.actor }, root.scope))) {
      throw formErrors.forbidden('当前角色无权确认该表单测试通过');
    }

    const latest = await this.repository.loadLatestVersion(input.formId);
    if (latest === null) {
      throw formErrors.preconditionFailed('表单尚无草稿版本');
    }
    const version = FormVersion.fromSnapshot(latest);
    if (!version.markPreviewPassed(this.machine, input.now)) {
      throw formErrors.preconditionFailed('仅预览/测试中的版本可确认测试通过');
    }

    const test = await this.repository.loadPreviewTest(input.formId, latest.versionNumber);
    if (test === null || test.result !== 'PASSED') {
      throw formErrors.preconditionFailed(
        '测试结果与当前草稿版本不匹配或未通过，请重新运行预览/测试',
      );
    }

    await this.repository.saveVersionWithStatusGuard(
      version.toSnapshot(),
      FormVersionState.PREVIEW_TESTING,
    );

    await this.audit.record({
      type: 'FORM_PREVIEW_TESTED',
      subjectId: input.formId,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        action: 'PASSED_CONFIRMED',
        formId: input.formId,
        versionNumber: latest.versionNumber,
      },
    });

    return { formId: input.formId, versionNumber: latest.versionNumber, publishable: true };
  }
}
