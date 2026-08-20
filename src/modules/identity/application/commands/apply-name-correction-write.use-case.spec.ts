/**
 * DefaultApplyNameCorrectionWriteUseCase 单元测试（IDN-016 写回收口 + CAS-REC-001）。
 *
 * 覆盖：成功写回 + 幂等标记 + 审计（保留旧姓名）、已收口重放幂等返回、
 * 未批准申请拒绝执行、载荷与申请事实不一致拒绝、外部未收口上抛（任务重试）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DefaultApplyNameCorrectionWriteUseCase,
  type ApplyNameCorrectionWriteInput,
} from './apply-name-correction-write.use-case';
import type { NameCorrectionRequestRepository } from '../ports/name-correction-repository.port';
import type { CasdoorUserPort } from '../ports/casdoor-user.port';
import type { IdentityAuditPort } from '../ports/identity-audit.port';
import { NameCorrectionState } from '../../domain/state-machines/name-correction.state-machine';
import { IdentityCommandError, IdentityErrorCode } from '../errors';
import type { NameCorrectionRequestSnapshot } from '../../domain/models/name-correction-request';
import { externalSuccess, externalFailure } from '../../../../common/contracts/external-result';

const now = new Date('2026-08-20T12:00:00.000Z');

function approvedSnapshot(): NameCorrectionRequestSnapshot {
  return {
    id: 'req-1',
    subjectId: 'user-1',
    oldName: '旧姓名',
    requestedName: '新姓名',
    proofReference: null,
    status: NameCorrectionState.APPROVED,
    decidedBy: 'admin-1',
    decidedAt: new Date('2026-08-20T11:50:00Z'),
    decisionReason: '核验通过',
    appliedAt: null,
    version: 1,
    createdAt: new Date('2026-08-20T11:00:00Z'),
  };
}

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
    async findPendingBySubject() {
      return null;
    },
    async save(snapshot) {
      store.set(snapshot.id, snapshot);
      this.saved.push(snapshot);
    },
  };
}

function casdoor(writeResult: { status: string }): CasdoorUserPort {
  const port: CasdoorUserPort = {
    async readAccountStatus() {
      return externalFailure(
        'UNAVAILABLE',
        { code: 'CAS-NOT-WIRED', message: 'stub', retryable: true, rawStatusCode: null },
        'x',
        new Date(),
      );
    },
    async readProfileField() {
      return externalFailure(
        'UNAVAILABLE',
        { code: 'CAS-NOT-WIRED', message: 'stub', retryable: true, rawStatusCode: null },
        'x',
        new Date(),
      );
    },
    async writeProfileField() {
      if (writeResult.status === 'SUCCESS') {
        return externalSuccess(
          { field: 'name', value: '新姓名', externalVersion: null, observedAt: now },
          'x',
          now,
        );
      }
      return externalFailure(
        'UNAVAILABLE',
        { code: 'CAS-NOT-WIRED', message: 'stub', retryable: true, rawStatusCode: null },
        'x',
        now,
      );
    },
  };
  return port;
}

function inputFor(
  overrides?: Partial<ApplyNameCorrectionWriteInput>,
): ApplyNameCorrectionWriteInput {
  return {
    requestId: 'req-1',
    subjectId: 'user-1',
    newName: '新姓名',
    now,
    actor: 'svc:profile-name-write',
    traceId: 'name-correction:user-1:req-1',
    ...overrides,
  };
}

describe('DefaultApplyNameCorrectionWriteUseCase（IDN-016 写回收口）', () => {
  it('NOM：写回成功 → 幂等标记 + 审计（action=APPLIED，保留旧姓名）', async () => {
    const repository = inMemoryRepository();
    repository.seed(approvedSnapshot());
    const captured: { summary: Record<string, unknown> | null } = { summary: null };
    const audit: IdentityAuditPort = {
      async record(fact) {
        captured.summary = fact.summary;
      },
    };
    const useCase = new DefaultApplyNameCorrectionWriteUseCase(
      repository,
      casdoor({ status: 'SUCCESS' }),
      audit,
    );

    const result = await useCase.execute(inputFor());

    assert.equal(result.synced, true);
    assert.ok(repository.saved[0].appliedAt instanceof Date);
    assert.equal(captured.summary?.action, 'APPLIED');
    assert.equal(captured.summary?.oldName, '旧姓名');
    assert.equal(captured.summary?.newName, '新姓名');
  });

  it('幂等：已收口重放 → 返回 synced=false（迟到重放安全，ADR-004）', async () => {
    const repository = inMemoryRepository();
    repository.seed({ ...approvedSnapshot(), appliedAt: new Date('2026-08-20T11:55:00Z') });
    let audited = 0;
    const audit: IdentityAuditPort = {
      async record() {
        audited += 1;
      },
    };
    const useCase = new DefaultApplyNameCorrectionWriteUseCase(
      repository,
      casdoor({ status: 'SUCCESS' }),
      audit,
    );

    const result = await useCase.execute(inputFor());

    assert.equal(result.synced, false);
    assert.equal(audited, 0);
  });

  it('REV：申请未批准 → 拒绝执行（异常任务，重试至失败留证据）', async () => {
    const repository = inMemoryRepository();
    repository.seed({ ...approvedSnapshot(), status: NameCorrectionState.REJECTED });
    const useCase = new DefaultApplyNameCorrectionWriteUseCase(
      repository,
      casdoor({ status: 'SUCCESS' }),
      { async record() {} },
    );

    await assert.rejects(
      useCase.execute(inputFor()),
      (error: unknown) =>
        error instanceof IdentityCommandError &&
        error.code === IdentityErrorCode.PRECONDITION_FAILED,
    );
  });

  it('REV：载荷与申请事实不一致 → 拒绝', async () => {
    const repository = inMemoryRepository();
    repository.seed(approvedSnapshot());
    const useCase = new DefaultApplyNameCorrectionWriteUseCase(
      repository,
      casdoor({ status: 'SUCCESS' }),
      { async record() {} },
    );

    await assert.rejects(
      useCase.execute(inputFor({ subjectId: 'user-999' })),
      (error: unknown) =>
        error instanceof IdentityCommandError &&
        error.code === IdentityErrorCode.PRECONDITION_FAILED,
    );
  });

  it('REV：外部未收口 → 上抛（任务退避重试，CAS-WR-006/007）', async () => {
    const repository = inMemoryRepository();
    repository.seed(approvedSnapshot());
    const useCase = new DefaultApplyNameCorrectionWriteUseCase(
      repository,
      casdoor({ status: 'UNAVAILABLE' }),
      { async record() {} },
    );

    await assert.rejects(
      useCase.execute(inputFor()),
      (error: unknown) =>
        error instanceof IdentityCommandError && error.code === IdentityErrorCode.EXTERNAL_UNKNOWN,
    );
    assert.equal(repository.saved.length, 0);
  });
});
