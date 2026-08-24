/**
 * 复用表单用例（SRS-SM-FORM-001 t7；FORM-004/005）。
 *
 * 从既有发布/停用版本（或显式指定来源版本）创建新草稿并保留版本来源引用；
 * 最新已是草稿/预览中则直接复用（接口清单 mock：最新已是草稿直接复用）。
 * 来源版本不可变；已发布 → 新草稿（当前使用指针不变，发布后切换）；已停用 →
 * 新草稿。并发复用最新草稿单胜者（IFC-ERR-010）。
 */

import { randomUUID } from 'node:crypto';
import type { FormDefinitionRepository } from '../ports/form-definition-repository.port';
import type { FormDesignPermissionPort } from '../ports/form-design-permission.port';
import type { FormAuditPort } from '../ports/form-audit.port';
import { FormDefinition } from '../../domain/models/form-definition';
import { FormVersion } from '../../domain/models/form-version';
import { FormVersionState } from '../../domain/state-machines/form-version.state-machine';
import type { FormVersionStateMachine } from '../../domain/state-machines/form-version.state-machine';
import { formErrors } from '../errors';

export interface ReuseFormVersionInput {
  readonly formId: string;
  /** 显式来源版本号（缺省 = 当前使用版本；无则取最新停用/发布版本） */
  readonly sourceVersion?: number | null;
  readonly actor: string;
  readonly now: Date;
  readonly traceId: string | null;
}

export interface ReuseFormVersionResult {
  readonly formId: string;
  readonly draftVersion: number;
  readonly status: 'draft';
  readonly sourceVersion: number | null;
}

export interface ReuseFormVersionUseCase {
  execute(input: ReuseFormVersionInput): Promise<ReuseFormVersionResult>;
}

export class DefaultReuseFormVersionUseCase implements ReuseFormVersionUseCase {
  constructor(
    private readonly repository: FormDefinitionRepository,
    private readonly permission: FormDesignPermissionPort,
    private readonly audit: FormAuditPort,
    private readonly machine: FormVersionStateMachine,
  ) {}

  async execute(input: ReuseFormVersionInput): Promise<ReuseFormVersionResult> {
    const rootSnapshot = await this.repository.loadRoot(input.formId);
    if (rootSnapshot === null) {
      throw formErrors.notFound('表单');
    }
    const root = FormDefinition.fromSnapshot(rootSnapshot);
    if (!(await this.permission.canDesign({ subjectId: input.actor }, root.scope))) {
      throw formErrors.forbidden('当前角色无权复用该表单');
    }

    const latest = await this.repository.loadLatestVersion(input.formId);
    if (latest === null) {
      throw formErrors.preconditionFailed('表单尚无版本');
    }
    if (
      latest.status === FormVersionState.DRAFT ||
      latest.status === FormVersionState.PREVIEW_TESTING
    ) {
      // 接口清单 mock：最新已是草稿直接复用
      return {
        formId: input.formId,
        draftVersion: latest.versionNumber,
        status: 'draft',
        sourceVersion: latest.sourceVersion,
      };
    }

    let source = latest;
    if (input.sourceVersion !== null && input.sourceVersion !== undefined) {
      const explicit = await this.repository.loadVersion(input.formId, input.sourceVersion);
      if (explicit === null) {
        throw formErrors.notFound('表单版本');
      }
      source = explicit;
    } else if (root.currentPublishedVersion !== null) {
      const current = await this.repository.loadVersion(input.formId, root.currentPublishedVersion);
      if (current !== null) {
        source = current;
      }
    }

    const sourceVersion = FormVersion.fromSnapshot(source);
    if (!sourceVersion.canBeReuseSource(this.machine)) {
      throw formErrors.preconditionFailed('复用来源必须是已发布或已停用版本');
    }

    const nextNumber = latest.versionNumber + 1;
    const draft = FormVersion.createDraft({
      id: randomUUID(),
      formId: input.formId,
      versionNumber: nextNumber,
      fields: sourceVersion.fields,
      sourceFormId: input.formId,
      sourceVersion: sourceVersion.versionNumber,
      createdBy: input.actor,
      now: input.now,
    });

    const before = root.version;
    root.pointDraft(nextNumber, input.now);
    await this.repository.insertVersion(draft.toSnapshot());
    await this.repository.saveRoot(root.toSnapshot(), before);

    await this.audit.record({
      type: 'FORM_REUSED',
      subjectId: input.formId,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        action: 'REUSED',
        formId: input.formId,
        fromVersion: sourceVersion.versionNumber,
        toVersion: nextNumber,
      },
    });

    return {
      formId: input.formId,
      draftVersion: nextNumber,
      status: 'draft',
      sourceVersion: sourceVersion.versionNumber,
    };
  }
}
