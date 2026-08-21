/**
 * 发布不可变版本用例（SRS-SM-FORM-001 t5；FORM-002/005、CFG-005）。
 *
 * 草稿（可发布）→ 已发布不可变版本：原子创建发布版本并切换当前使用指针；
 * 不得覆盖任何旧发布版本；并发发布只一个成为当前版本（SQL 状态守卫单胜者，
 * IFC-ERR-010），失败时旧版本完整有效（XCC-FAIL-013）。
 *
 * 发布前全量重验：固定骨架、字段权限、秘密字段、引用（DATA-FRM-003、GOV-003）；
 * 测试通过标志过期/校验失败/版本冲突一律拒绝（IFC-ERR-008/006）。
 */

import type { FormDefinitionRepository } from '../ports/form-definition-repository.port';
import type { FormDesignPermissionPort } from '../ports/form-design-permission.port';
import type { FormProfileFieldDirectoryPort } from '../ports/form-profile-field-directory.port';
import type { FormAuditPort } from '../ports/form-audit.port';
import { FormDefinition } from '../../domain/models/form-definition';
import { FormVersion } from '../../domain/models/form-version';
import { FormVersionState } from '../../domain/state-machines/form-version.state-machine';
import type { FormVersionStateMachine } from '../../domain/state-machines/form-version.state-machine';
import { validateFormFieldSet } from '../../domain/services/form-field.validator';
import { formErrors } from '../errors';

export interface PublishFormVersionInput {
  readonly formId: string;
  /** 待发布草稿版本号（缺省 = 当前草稿） */
  readonly version?: number | null;
  /** 根乐观版本（期望值；指针变化必须携带期望版本，IFC-GEN-007） */
  readonly expectedRootVersion?: number | null;
  readonly actor: string;
  readonly now: Date;
  readonly traceId: string | null;
}

export interface PublishFormVersionResult {
  readonly formId: string;
  readonly version: number;
  readonly status: 'published';
  readonly publishedAt: Date;
}

export interface PublishFormVersionUseCase {
  execute(input: PublishFormVersionInput): Promise<PublishFormVersionResult>;
}

export class DefaultPublishFormVersionUseCase implements PublishFormVersionUseCase {
  constructor(
    private readonly repository: FormDefinitionRepository,
    private readonly permission: FormDesignPermissionPort,
    private readonly profileDirectory: FormProfileFieldDirectoryPort,
    private readonly audit: FormAuditPort,
    private readonly machine: FormVersionStateMachine,
  ) {}

  async execute(input: PublishFormVersionInput): Promise<PublishFormVersionResult> {
    const rootSnapshot = await this.repository.loadRoot(input.formId);
    if (rootSnapshot === null) {
      throw formErrors.notFound('表单');
    }
    const root = FormDefinition.fromSnapshot(rootSnapshot);
    if (!(await this.permission.canDesign({ subjectId: input.actor }, root.scope))) {
      throw formErrors.forbidden('当前角色无权发布该表单');
    }

    const latest = await this.repository.loadLatestVersion(input.formId);
    if (latest === null) {
      throw formErrors.preconditionFailed('表单尚无草稿版本');
    }
    const target =
      input.version === null || input.version === undefined
        ? latest
        : await this.repository.loadVersion(input.formId, input.version);
    if (target === null) {
      throw formErrors.notFound('表单版本');
    }
    if (target.versionNumber !== latest.versionNumber) {
      throw formErrors.preconditionFailed('仅当前草稿版本可发布（旧草稿版本已失效）');
    }

    const version = FormVersion.fromSnapshot(target);
    if (!version.publish(this.machine, input.actor, input.now)) {
      throw formErrors.preconditionFailed('仅通过预览/测试的草稿版本可发布（已发布不可覆盖）');
    }

    // 发布前全量重验（固定骨架、字段权限、秘密字段、引用；DATA-FRM-003）
    const directory = await this.profileDirectory.listApproved();
    validateFormFieldSet(target.fields as unknown as readonly unknown[], directory);

    await this.repository.saveVersionWithStatusGuard(version.toSnapshot(), FormVersionState.DRAFT);

    const before = root.version;
    if (
      input.expectedRootVersion !== null &&
      input.expectedRootVersion !== undefined &&
      input.expectedRootVersion !== before
    ) {
      throw formErrors.versionConflict();
    }
    root.pointPublished(target.versionNumber, input.now);
    await this.repository.saveRoot(root.toSnapshot(), before);

    await this.audit.record({
      type: 'FORM_PUBLISHED',
      subjectId: input.formId,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        action: 'PUBLISHED',
        formId: input.formId,
        versionNumber: target.versionNumber,
        publishedAt: input.now.toISOString(),
      },
    });

    return {
      formId: input.formId,
      version: target.versionNumber,
      status: 'published',
      publishedAt: input.now,
    };
  }
}
