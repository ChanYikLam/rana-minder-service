/**
 * 编辑表单草稿用例（SRS-SM-FORM-001 t2；FORM-001~003、006）。
 *
 * 编辑字段、校验、条件和字段权限 → 原子存新草稿版本（乐观锁 expectedVersion =
 * 当前草稿版本号，旧版本编辑拒绝 IFC-ERR-008）；草稿变更使测试通过标志失效
 * （旧测试不能证明新草稿合格，CFG-005）。发布后版本不可覆盖（t5 已发布不可变）。
 *
 * 安全：秘密字段、代码注入、对象越界、固定骨架变更一律拒绝（GOV-003）；
 * 字段校验服务端再执行一次（DATA-FRM-003）。
 */

import { randomUUID } from 'node:crypto';
import type { FormDefinitionRepository } from '../ports/form-definition-repository.port';
import type { FormDesignPermissionPort } from '../ports/form-design-permission.port';
import type { FormProfileFieldDirectoryPort } from '../ports/form-profile-field-directory.port';
import type { FormAuditPort } from '../ports/form-audit.port';
import { FormDefinition } from '../../domain/models/form-definition';
import { FormVersion } from '../../domain/models/form-version';
import type { FormVersionStateMachine } from '../../domain/state-machines/form-version.state-machine';
import { validateFormFieldSet } from '../../domain/services/form-field.validator';
import { formErrors } from '../errors';

export interface UpdateFormDraftInput {
  readonly formId: string;
  /** 当前草稿版本号（乐观锁；不匹配 → IFC-ERR-008） */
  readonly expectedVersion: number;
  readonly fields: readonly unknown[];
  readonly actor: string;
  readonly now: Date;
  readonly traceId: string | null;
}

export interface UpdateFormDraftResult {
  readonly formId: string;
  readonly version: number;
  readonly status: 'draft';
  readonly savedAt: Date;
}

export interface UpdateFormDraftUseCase {
  execute(input: UpdateFormDraftInput): Promise<UpdateFormDraftResult>;
}

export class DefaultUpdateFormDraftUseCase implements UpdateFormDraftUseCase {
  constructor(
    private readonly repository: FormDefinitionRepository,
    private readonly permission: FormDesignPermissionPort,
    private readonly profileDirectory: FormProfileFieldDirectoryPort,
    private readonly audit: FormAuditPort,
    private readonly machine: FormVersionStateMachine,
  ) {}

  async execute(input: UpdateFormDraftInput): Promise<UpdateFormDraftResult> {
    const rootSnapshot = await this.repository.loadRoot(input.formId);
    if (rootSnapshot === null) {
      throw formErrors.notFound('表单');
    }
    const root = FormDefinition.fromSnapshot(rootSnapshot);
    if (!(await this.permission.canDesign({ subjectId: input.actor }, root.scope))) {
      throw formErrors.forbidden('当前角色无权编辑该表单');
    }
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion <= 0) {
      throw formErrors.validationFailed('expectedVersion 必须是正整数', {
        expectedVersion: ['必须是正整数'],
      });
    }

    const latest = await this.repository.loadLatestVersion(input.formId);
    if (latest === null) {
      throw formErrors.preconditionFailed('表单尚无草稿版本');
    }
    if (latest.versionNumber !== input.expectedVersion) {
      throw formErrors.versionConflict();
    }
    const latestVersion = FormVersion.fromSnapshot(latest);
    if (!latestVersion.canUpdate(this.machine)) {
      throw formErrors.preconditionFailed(
        '仅草稿版本可编辑：已发布版本不可覆盖、已停用版本须基于来源新建草稿',
      );
    }

    const directory = await this.profileDirectory.listApproved();
    const validated = validateFormFieldSet(input.fields, directory);

    const nextNumber = latest.versionNumber + 1;
    const nextDraft = FormVersion.createDraft({
      id: randomUUID(),
      formId: input.formId,
      versionNumber: nextNumber,
      fields: validated.fields,
      sourceFormId: latest.sourceFormId,
      sourceVersion: latest.sourceVersion,
      createdBy: input.actor,
      now: input.now,
    });

    const before = root.version;
    root.pointDraft(nextNumber, input.now);
    await this.repository.insertVersion(nextDraft.toSnapshot());
    await this.repository.saveRoot(root.toSnapshot(), before);

    await this.audit.record({
      type: 'FORM_DRAFT_UPDATED',
      subjectId: input.formId,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        action: 'UPDATED',
        formId: input.formId,
        fromVersion: latest.versionNumber,
        toVersion: nextNumber,
        fieldCount: validated.fields.length,
      },
    });

    return { formId: input.formId, version: nextNumber, status: 'draft', savedAt: input.now };
  }
}
