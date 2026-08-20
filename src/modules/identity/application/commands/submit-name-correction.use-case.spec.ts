/**
 * DefaultSubmitNameCorrectionUseCase 单元测试（IDN-016 提交申请）。
 *
 * 覆盖：新姓名/证明引用校验、同一主体重复提交拒绝（幂等）、
 * 审计记录旧姓名（NAME_CORRECTION action=SUBMITTED）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DefaultSubmitNameCorrectionUseCase,
  type SubmitNameCorrectionInput,
} from './submit-name-correction.use-case';
import type { NameCorrectionRequestRepository } from '../ports/name-correction-repository.port';
import type { IdentityAuditPort } from '../ports/identity-audit.port';
import { IdentityCommandError, IdentityErrorCode } from '../errors';
import type { NameCorrectionRequestSnapshot } from '../../domain/models/name-correction-request';
import { NameCorrectionState } from '../../domain/state-machines/name-correction.state-machine';

const now = new Date('2026-08-20T12:00:00.000Z');

function inMemoryRepository(): NameCorrectionRequestRepository & {
  saved: NameCorrectionRequestSnapshot[];
  seed: (snapshot: NameCorrectionRequestSnapshot) => void;
} {
  const store = new Map<string, NameCorrectionRequestSnapshot>();
  return {
    saved: [],
    seed(snapshot) {
      store.set(snapshot.id, snapshot);
    },
    async load(id) {
      return store.get(id) ?? null;
    },
    async findPendingBySubject(subjectId) {
      const pending = [...store.values()].find(
        (s) => s.subjectId === subjectId && s.status === NameCorrectionState.SUBMITTED,
      );
      return pending ?? null;
    },
    async save(snapshot) {
      store.set(snapshot.id, snapshot);
      this.saved.push(snapshot);
    },
  };
}

function inputFor(overrides?: Partial<SubmitNameCorrectionInput>): SubmitNameCorrectionInput {
  return {
    subjectId: 'user-1',
    oldName: '旧姓名',
    requestedName: '新姓名',
    proofReference: null,
    now,
    actor: 'user-1',
    traceId: 'tr-1',
    ...overrides,
  };
}

describe('DefaultSubmitNameCorrectionUseCase（IDN-016 提交）', () => {
  it('NOM：提交申请 → 保存 + 审计保留旧姓名（action=SUBMITTED）', async () => {
    const repository = inMemoryRepository();
    const captured: { summary: Record<string, unknown> | null } = { summary: null };
    const audit: IdentityAuditPort = { async record(fact) { captured.summary = fact.summary; } };
    const useCase = new DefaultSubmitNameCorrectionUseCase(repository, audit);

    const result = await useCase.execute(inputFor());

    assert.ok(result.requestId.length > 0);
    assert.equal(repository.saved.length, 1);
    assert.equal(repository.saved[0].status, NameCorrectionState.SUBMITTED);
    assert.equal(repository.saved[0].oldName, '旧姓名');
    assert.equal(repository.saved[0].requestedName, '新姓名');
    assert.equal(captured.summary?.action, 'SUBMITTED');
    assert.equal(captured.summary?.oldName, '旧姓名');
    assert.equal(captured.summary?.requestedName, '新姓名');
  });

  it('REV：同一主体已有待裁决申请 → 拒绝（IFC-ERR-006）', async () => {
    const repository = inMemoryRepository();
    repository.seed({
      id: 'req-existing',
      subjectId: 'user-1',
      oldName: '旧姓名',
      requestedName: '另一个新姓名',
      proofReference: null,
      status: NameCorrectionState.SUBMITTED,
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      appliedAt: null,
      version: 0,
      createdAt: now,
    });
    const useCase = new DefaultSubmitNameCorrectionUseCase(repository, { async record() {} });

    await assert.rejects(
      useCase.execute(inputFor({ requestedName: '再一个姓名' })),
      (error: unknown) =>
        error instanceof IdentityCommandError && error.code === IdentityErrorCode.PRECONDITION_FAILED,
    );
  });

  it('REV：新姓名与旧姓名相同 → 拒绝', async () => {
    const useCase = new DefaultSubmitNameCorrectionUseCase(inMemoryRepository(), { async record() {} });
    await assert.rejects(
      useCase.execute(inputFor({ requestedName: '旧姓名' })),
      (error: unknown) =>
        error instanceof IdentityCommandError && error.code === IdentityErrorCode.PRECONDITION_FAILED,
    );
  });

  it('REV：空/超长姓名或超长证明引用 → 拒绝', async () => {
    const useCase = new DefaultSubmitNameCorrectionUseCase(inMemoryRepository(), { async record() {} });
    await assert.rejects(useCase.execute(inputFor({ requestedName: '' })), IdentityCommandError);
    await assert.rejects(useCase.execute(inputFor({ requestedName: 'x'.repeat(65) })), IdentityCommandError);
    await assert.rejects(
      useCase.execute(inputFor({ proofReference: 'x'.repeat(513) })),
      IdentityCommandError,
    );
  });
});