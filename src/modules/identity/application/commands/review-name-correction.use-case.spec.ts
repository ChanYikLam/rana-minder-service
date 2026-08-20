/**
 * DefaultReviewNameCorrectionUseCase 单元测试（IDN-016 超管裁决 + CAS-REC-003）。
 *
 * 覆盖：非超管拒绝（IFC-ERR-003）、重认证过期拒绝（IFC-ERR-002）、
 * 批准 → 推进 APPROVED + 审计保留旧姓名 + 同事务登记姓名写回任务、
 * 驳回 → REJECTED、终态重复裁决拒绝、任务载荷与事实一致。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultNameCorrectionStateMachine } from '../../domain/state-machines/name-correction.state-machine';
import { NameCorrectionState } from '../../domain/state-machines/name-correction.state-machine';
import {
  DefaultReviewNameCorrectionUseCase,
  NameCorrectionDecision,
  type ReviewNameCorrectionInput,
} from './review-name-correction.use-case';
import type { NameCorrectionRequestRepository } from '../ports/name-correction-repository.port';
import type { SuperAdminVerifierPort } from '../ports/super-admin-verifier.port';
import type { ProfileSyncTaskPort } from '../ports/profile-sync-task.port';
import type { IdentityAuditPort } from '../ports/identity-audit.port';
import { HighRiskCommandGuard } from '../services/high-risk-command.guard';
import { IdentityCommandError, IdentityErrorCode } from '../errors';
import type { NameCorrectionRequestSnapshot } from '../../domain/models/name-correction-request';

const now = new Date('2026-08-20T12:00:00.000Z');

function pendingSnapshot(id = 'req-1'): NameCorrectionRequestSnapshot {
  return {
    id,
    subjectId: 'user-1',
    oldName: '旧姓名',
    requestedName: '新姓名',
    proofReference: null,
    status: NameCorrectionState.SUBMITTED,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    appliedAt: null,
    version: 0,
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

function freshReauthGuard(): HighRiskCommandGuard {
  return new HighRiskCommandGuard({
    async latestReauthAt() {
      return new Date(now.getTime() - 60_000);
    },
    async record() {},
  });
}

function superAdmin(allowed = true): SuperAdminVerifierPort {
  return {
    async isSuperAdmin() {
      return allowed;
    },
  };
}

function taskPort(): ProfileSyncTaskPort & {
  nameWriteTasks: { requestId: string; subjectId: string; newName: string }[];
} {
  const port: ProfileSyncTaskPort & {
    nameWriteTasks: { requestId: string; subjectId: string; newName: string }[];
  } = {
    nameWriteTasks: [],
    async scheduleProfileSync() {},
    async scheduleProfileReadback() {},
    async scheduleNameCorrectionWrite(requestId, subjectId, newName) {
      this.nameWriteTasks.push({ requestId, subjectId, newName });
    },
  };
  return port;
}

function inputFor(overrides?: Partial<ReviewNameCorrectionInput>): ReviewNameCorrectionInput {
  return {
    requestId: 'req-1',
    decision: NameCorrectionDecision.APPROVE,
    reason: '证明材料核验通过',
    reviewerId: 'admin-1',
    now,
    actor: 'admin-1',
    traceId: 'tr-review',
    ...overrides,
  };
}

describe('DefaultReviewNameCorrectionUseCase（IDN-016 裁决）', () => {
  it('NOM：超管批准 → APPROVED + 审计保留旧姓名 + 登记姓名写回任务', async () => {
    const repository = inMemoryRepository();
    repository.seed(pendingSnapshot());
    const captured: { summary: Record<string, unknown> | null } = { summary: null };
    const audit: IdentityAuditPort = {
      async record(fact) {
        captured.summary = fact.summary;
      },
    };
    const tasks = taskPort();
    const useCase = new DefaultReviewNameCorrectionUseCase(
      repository,
      superAdmin(true),
      freshReauthGuard(),
      tasks,
      audit,
      new DefaultNameCorrectionStateMachine(),
    );

    const result = await useCase.execute(inputFor());

    assert.equal(result.decision, NameCorrectionDecision.APPROVE);
    assert.equal(result.newName, '新姓名');
    assert.equal(repository.saved[0].status, NameCorrectionState.APPROVED);
    assert.equal(repository.saved[0].decidedBy, 'admin-1');
    assert.equal(captured.summary?.action, 'APPROVE');
    assert.equal(captured.summary?.oldName, '旧姓名');
    assert.equal(captured.summary?.newName, '新姓名');
    assert.deepEqual(tasks.nameWriteTasks, [
      { requestId: 'req-1', subjectId: 'user-1', newName: '新姓名' },
    ]);
  });

  it('REV：非超管 → 拒绝（IFC-ERR-003，失败关闭）', async () => {
    const repository = inMemoryRepository();
    repository.seed(pendingSnapshot());
    const useCase = new DefaultReviewNameCorrectionUseCase(
      repository,
      superAdmin(false),
      freshReauthGuard(),
      taskPort(),
      { async record() {} },
      new DefaultNameCorrectionStateMachine(),
    );

    await assert.rejects(
      useCase.execute(inputFor()),
      (error: unknown) =>
        error instanceof IdentityCommandError && error.code === IdentityErrorCode.FORBIDDEN,
    );
    assert.equal(repository.saved.length, 0);
  });

  it('REV：重认证过期/缺失 → 拒绝（IFC-ERR-002 高风险命令）', async () => {
    const repository = inMemoryRepository();
    repository.seed(pendingSnapshot());
    const staleGuard = new HighRiskCommandGuard({
      async latestReauthAt() {
        return null;
      },
      async record() {},
    });
    const useCase = new DefaultReviewNameCorrectionUseCase(
      repository,
      superAdmin(true),
      staleGuard,
      taskPort(),
      { async record() {} },
      new DefaultNameCorrectionStateMachine(),
    );

    await assert.rejects(
      useCase.execute(inputFor()),
      (error: unknown) =>
        error instanceof IdentityCommandError && error.code === IdentityErrorCode.REAUTH_REQUIRED,
    );
  });

  it('NOM：驳回 → REJECTED + 审计（不登记写回任务）', async () => {
    const repository = inMemoryRepository();
    repository.seed(pendingSnapshot());
    let auditedAction: string | null = null;
    const audit: IdentityAuditPort = {
      async record(fact) {
        auditedAction = fact.summary.action as string;
      },
    };
    const tasks = taskPort();
    const useCase = new DefaultReviewNameCorrectionUseCase(
      repository,
      superAdmin(true),
      freshReauthGuard(),
      tasks,
      audit,
      new DefaultNameCorrectionStateMachine(),
    );

    const result = await useCase.execute(inputFor({ decision: NameCorrectionDecision.REJECT }));

    assert.equal(result.decision, NameCorrectionDecision.REJECT);
    assert.equal(result.newName, null);
    assert.equal(repository.saved[0].status, NameCorrectionState.REJECTED);
    assert.equal(auditedAction, 'REJECT');
    assert.equal(tasks.nameWriteTasks.length, 0);
  });

  it('REV：终态重复裁决 → 拒绝（裁决只一次）', async () => {
    const repository = inMemoryRepository();
    repository.seed({
      ...pendingSnapshot(),
      status: NameCorrectionState.APPROVED,
      decidedBy: 'admin-1',
    });
    const useCase = new DefaultReviewNameCorrectionUseCase(
      repository,
      superAdmin(true),
      freshReauthGuard(),
      taskPort(),
      { async record() {} },
      new DefaultNameCorrectionStateMachine(),
    );

    await assert.rejects(
      useCase.execute(inputFor()),
      (error: unknown) =>
        error instanceof IdentityCommandError &&
        error.code === IdentityErrorCode.PRECONDITION_FAILED,
    );
  });

  it('REV：裁决原因缺失 → 拒绝（二次确认要求说明）', async () => {
    const useCase = new DefaultReviewNameCorrectionUseCase(
      inMemoryRepository(),
      superAdmin(true),
      freshReauthGuard(),
      taskPort(),
      { async record() {} },
      new DefaultNameCorrectionStateMachine(),
    );
    await assert.rejects(
      useCase.execute(inputFor({ reason: '  ' })),
      (error: unknown) =>
        error instanceof IdentityCommandError &&
        error.code === IdentityErrorCode.PRECONDITION_FAILED,
    );
  });
});
