/**
 * 预览/测试表单草稿用例（SRS-SM-FORM-001 t3；FORM-002、CFG-005）。
 *
 * 草稿 → 预览/测试：存测试快照与结果（不读越权真实数据），测试结果绑定草稿
 * 版本；测试未通过回草稿（publishable=false）。扫描服务不可用等依赖不可用时
 * 不得宣称测试通过（IFC-ERR-012 语义由调用方/4.1.2 文件检查链路承接）。
 */

import { randomUUID } from 'node:crypto';
import type { FormDefinitionRepository } from '../ports/form-definition-repository.port';
import type { FormDesignPermissionPort } from '../ports/form-design-permission.port';
import type { FormAuditPort } from '../ports/form-audit.port';
import { FormVersion } from '../../domain/models/form-version';
import { FormVersionState } from '../../domain/state-machines/form-version.state-machine';
import type { FormVersionStateMachine } from '../../domain/state-machines/form-version.state-machine';
import { formErrors } from '../errors';

export interface RunFormPreviewTestInput {
  readonly formId: string;
  readonly result: 'PASSED' | 'FAILED';
  /** 脱敏测试摘要（不含真实提交数据） */
  readonly summary: Record<string, unknown>;
  readonly actor: string;
  readonly now: Date;
  readonly traceId: string | null;
}

export interface RunFormPreviewTestResult {
  readonly formId: string;
  readonly versionNumber: number;
  readonly result: 'PASSED' | 'FAILED';
}

export interface RunFormPreviewTestUseCase {
  execute(input: RunFormPreviewTestInput): Promise<RunFormPreviewTestResult>;
}

export class DefaultRunFormPreviewTestUseCase implements RunFormPreviewTestUseCase {
  constructor(
    private readonly repository: FormDefinitionRepository,
    private readonly permission: FormDesignPermissionPort,
    private readonly audit: FormAuditPort,
    private readonly machine: FormVersionStateMachine,
  ) {}

  async execute(input: RunFormPreviewTestInput): Promise<RunFormPreviewTestResult> {
    const root = await this.repository.loadRoot(input.formId);
    if (root === null) {
      throw formErrors.notFound('表单');
    }
    if (!(await this.permission.canDesign({ subjectId: input.actor }, root.scope))) {
      throw formErrors.forbidden('当前角色无权运行该表单预览/测试');
    }
    if (input.result !== 'PASSED' && input.result !== 'FAILED') {
      throw formErrors.validationFailed('测试结果必须是 PASSED 或 FAILED', {
        result: ['必须是 PASSED 或 FAILED'],
      });
    }

    const latest = await this.repository.loadLatestVersion(input.formId);
    if (latest === null) {
      throw formErrors.preconditionFailed('表单尚无草稿版本');
    }
    const version = FormVersion.fromSnapshot(latest);
    if (!version.runPreviewTest(this.machine, input.now)) {
      throw formErrors.preconditionFailed('仅草稿版本可运行预览/测试');
    }

    await this.repository.saveVersionWithStatusGuard(version.toSnapshot(), FormVersionState.DRAFT);
    await this.repository.savePreviewTest({
      id: randomUUID(),
      formId: input.formId,
      versionNumber: latest.versionNumber,
      result: input.result,
      summary: input.summary,
      testedBy: input.actor,
      testedAt: input.now,
    });

    if (input.result === 'FAILED') {
      version.markPreviewFailed(this.machine, input.now);
      await this.repository.saveVersionWithStatusGuard(
        version.toSnapshot(),
        FormVersionState.PREVIEW_TESTING,
      );
    }

    await this.audit.record({
      type: 'FORM_PREVIEW_TESTED',
      subjectId: input.formId,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        action: 'PREVIEW_TESTED',
        formId: input.formId,
        versionNumber: latest.versionNumber,
        result: input.result,
      },
    });

    return { formId: input.formId, versionNumber: latest.versionNumber, result: input.result };
  }
}
