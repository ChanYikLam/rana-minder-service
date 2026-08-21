/**
 * form 应用层测试桩（spec 共用；不用于生产）。
 *
 * - InMemoryFormDefinitionRepository：根/版本/预览测试/模板申请内存存储，
 *   状态守卫与乐观保存语义同 PostgreSQL 仓储（守卫未命中抛错）；
 * - 桩端口：权限（可编程）、审计（收集事实）、幂等（两阶段语义）、资料目录。
 */

import type { FormDefinitionSnapshot } from '../../domain/models/form-definition';
import type { FormVersionSnapshot } from '../../domain/models/form-version';
import type { FormVersionState } from '../../domain/state-machines/form-version.state-machine';
import type { FormScope } from '../../domain/models/form-scope';
import type { TemplatePublicationSnapshot } from '../../domain/models/template-publication';
import type { FormDefinitionRepository } from '../ports/form-definition-repository.port';
import type { FormPreviewTestSnapshot } from '../ports/form-definition-repository.port';
import type { FormDesignPermissionPort } from '../ports/form-design-permission.port';
import type { FormAuditPort, FormAuditFact } from '../ports/form-audit.port';
import type { FormIdempotencyStore } from '../ports/form-idempotency-store.port';
import type { FormIdempotencyClaimOutcome } from '../ports/form-idempotency-store.port';
import type {
  FormProfileFieldDirectoryPort,
  ProfileFieldDirectoryEntry,
} from '../ports/form-profile-field-directory.port';
import type { FormSubmissionSnapshot } from '../../domain/models/form-submission';
import type { FormSubmissionRepository } from '../ports/form-submission-repository.port';
import type {
  FormFillPermissionInput,
  FormFillPermissionResult,
  FormFillPermissionPort,
} from '../ports/form-fill-permission.port';

export class InMemoryFormDefinitionRepository implements FormDefinitionRepository {
  roots: FormDefinitionSnapshot[] = [];
  versions: FormVersionSnapshot[] = [];
  previewTests: FormPreviewTestSnapshot[] = [];
  publications: TemplatePublicationSnapshot[] = [];

  async loadRoot(id: string): Promise<FormDefinitionSnapshot | null> {
    return this.roots.find((root) => root.id === id) ?? null;
  }

  async listByScope(scope: FormScope): Promise<FormDefinitionSnapshot[]> {
    return this.roots.filter(
      (root) => root.scope.kind === scope.kind && root.scope.ownerId === scope.ownerId,
    );
  }

  async saveRoot(snapshot: FormDefinitionSnapshot, expectedVersion: number): Promise<void> {
    const index = this.roots.findIndex((root) => root.id === snapshot.id);
    if (index < 0) {
      if (expectedVersion !== 0) {
        throw new Error('FormDefinitionRepository.saveRoot: 根版本冲突（乐观锁未命中）');
      }
      this.roots.push(snapshot);
      return;
    }
    if (this.roots[index].version !== expectedVersion) {
      throw new Error('FormDefinitionRepository.saveRoot: 根版本冲突（乐观锁未命中）');
    }
    this.roots[index] = snapshot;
  }

  async loadVersion(formId: string, versionNumber: number): Promise<FormVersionSnapshot | null> {
    return (
      this.versions.find(
        (version) => version.formId === formId && version.versionNumber === versionNumber,
      ) ?? null
    );
  }

  async loadLatestVersion(formId: string): Promise<FormVersionSnapshot | null> {
    const matches = this.versions
      .filter((version) => version.formId === formId)
      .sort((a, b) => b.versionNumber - a.versionNumber);
    return matches[0] ?? null;
  }

  async loadVersions(formId: string): Promise<FormVersionSnapshot[]> {
    return this.versions
      .filter((version) => version.formId === formId)
      .sort((a, b) => a.versionNumber - b.versionNumber);
  }

  async insertVersion(snapshot: FormVersionSnapshot): Promise<void> {
    if (
      this.versions.some(
        (version) =>
          version.formId === snapshot.formId && version.versionNumber === snapshot.versionNumber,
      )
    ) {
      throw new Error('FormDefinitionRepository.insertVersion: 版本号冲突');
    }
    this.versions.push(snapshot);
  }

  async saveVersionWithStatusGuard(
    snapshot: FormVersionSnapshot,
    expectedStatus: FormVersionState,
  ): Promise<void> {
    const index = this.versions.findIndex((version) => version.id === snapshot.id);
    if (index < 0 || this.versions[index].status !== expectedStatus) {
      throw new Error('FormDefinitionRepository.saveVersionWithStatusGuard: 状态守卫未命中');
    }
    this.versions[index] = snapshot;
  }

  async savePreviewTest(snapshot: FormPreviewTestSnapshot): Promise<void> {
    const index = this.previewTests.findIndex(
      (test) => test.formId === snapshot.formId && test.versionNumber === snapshot.versionNumber,
    );
    if (index >= 0) {
      this.previewTests[index] = snapshot;
    } else {
      this.previewTests.push(snapshot);
    }
  }

  async loadPreviewTest(
    formId: string,
    versionNumber: number,
  ): Promise<FormPreviewTestSnapshot | null> {
    return (
      this.previewTests.find(
        (test) => test.formId === formId && test.versionNumber === versionNumber,
      ) ?? null
    );
  }

  async saveTemplatePublication(snapshot: TemplatePublicationSnapshot): Promise<void> {
    const index = this.publications.findIndex((publication) => publication.id === snapshot.id);
    if (index >= 0) {
      this.publications[index] = snapshot;
    } else {
      this.publications.push(snapshot);
    }
  }

  async loadTemplatePublication(id: string): Promise<TemplatePublicationSnapshot | null> {
    return this.publications.find((publication) => publication.id === id) ?? null;
  }

  async listTemplatePublications(
    status: TemplatePublicationSnapshot['status'] | null,
  ): Promise<TemplatePublicationSnapshot[]> {
    return status === null
      ? this.publications
      : this.publications.filter((publication) => publication.status === status);
  }

  async saveTemplatePublicationWithStatusGuard(
    snapshot: TemplatePublicationSnapshot,
  ): Promise<void> {
    const index = this.publications.findIndex((publication) => publication.id === snapshot.id);
    if (index < 0 || this.publications[index].status !== 'PENDING') {
      throw new Error(
        'FormDefinitionRepository.saveTemplatePublicationWithStatusGuard: 状态守卫未命中',
      );
    }
    this.publications[index] = snapshot;
  }
}

export class StubFormDesignPermission implements FormDesignPermissionPort {
  allowed = true;
  platformAllowed = true;

  async canDesign(_subject: { readonly subjectId: string }, _scope: FormScope): Promise<boolean> {
    return this.allowed;
  }

  async canManagePlatform(_subject: { readonly subjectId: string }): Promise<boolean> {
    return this.platformAllowed;
  }
}

export class StubFormAudit implements FormAuditPort {
  readonly facts: FormAuditFact[] = [];

  async record(fact: FormAuditFact): Promise<void> {
    this.facts.push(fact);
  }
}

interface IdempotencyRecord {
  scopeKey: string;
  idempotencyKey: string;
  semanticHash: string;
  result: unknown;
}

export class InMemoryFormIdempotencyStore implements FormIdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  async claim(input: {
    scopeKey: string;
    idempotencyKey: string;
    semanticHash: string;
  }): Promise<FormIdempotencyClaimOutcome> {
    const key = `${input.scopeKey}:${input.idempotencyKey}`;
    const existing = this.records.get(key);
    if (existing) {
      return { inserted: false, existingHash: existing.semanticHash };
    }
    this.records.set(key, {
      scopeKey: input.scopeKey,
      idempotencyKey: input.idempotencyKey,
      semanticHash: input.semanticHash,
      result: null,
    });
    return { inserted: true, existingHash: null };
  }

  async complete(input: {
    scopeKey: string;
    idempotencyKey: string;
    semanticHash: string;
    result: unknown;
  }): Promise<void> {
    const key = `${input.scopeKey}:${input.idempotencyKey}`;
    const existing = this.records.get(key);
    if (existing && existing.semanticHash === input.semanticHash) {
      existing.result = input.result;
    }
  }

  async readResult(scopeKey: string, idempotencyKey: string): Promise<unknown | null> {
    return this.records.get(`${scopeKey}:${idempotencyKey}`)?.result ?? null;
  }
}

export class StubProfileFieldDirectory implements FormProfileFieldDirectoryPort {
  readonly entries: readonly ProfileFieldDirectoryEntry[] = [
    { fieldId: 'email', label: '邮箱', readOnly: false },
    { fieldId: 'name', label: '姓名', readOnly: true },
    { fieldId: 'studentId', label: '学号', readOnly: true },
  ];

  async listApproved(): Promise<readonly ProfileFieldDirectoryEntry[]> {
    return this.entries;
  }
}

export class InMemoryFormSubmissionRepository implements FormSubmissionRepository {
  submissions: FormSubmissionSnapshot[] = [];

  async load(id: string): Promise<FormSubmissionSnapshot | null> {
    return this.submissions.find((submission) => submission.id === id) ?? null;
  }

  async loadBySubmitter(
    formId: string,
    versionNumber: number,
    submittedBy: string,
  ): Promise<FormSubmissionSnapshot | null> {
    return (
      this.submissions.find(
        (submission) =>
          submission.formId === formId &&
          submission.versionNumber === versionNumber &&
          submission.submittedBy === submittedBy,
      ) ?? null
    );
  }

  async listByScope(scope: FormScope): Promise<FormSubmissionSnapshot[]> {
    return this.submissions.filter(
      (submission) =>
        submission.scope.kind === scope.kind && submission.scope.ownerId === scope.ownerId,
    );
  }

  async listByForm(formId: string, scope: FormScope): Promise<FormSubmissionSnapshot[]> {
    return this.submissions.filter(
      (submission) =>
        submission.formId === formId &&
        submission.scope.kind === scope.kind &&
        submission.scope.ownerId === scope.ownerId,
    );
  }

  async insert(snapshot: FormSubmissionSnapshot): Promise<void> {
    if (this.submissions.some((submission) => submission.id === snapshot.id)) {
      throw new Error('FormSubmissionRepository.insert: 提交 id 冲突');
    }
    this.submissions.push(snapshot);
  }

  async save(snapshot: FormSubmissionSnapshot, expectedRevision: number): Promise<void> {
    const index = this.submissions.findIndex((submission) => submission.id === snapshot.id);
    if (index < 0 || this.submissions[index].revisionNumber !== expectedRevision) {
      throw new Error('FormSubmissionRepository.save: 修订号守卫未命中');
    }
    this.submissions[index] = snapshot;
  }
}

export class StubFormFillPermission implements FormFillPermissionPort {
  allowed = false;

  async canFill(_input: FormFillPermissionInput): Promise<FormFillPermissionResult> {
    return { allowed: this.allowed };
  }
}
