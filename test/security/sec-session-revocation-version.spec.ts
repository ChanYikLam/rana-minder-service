/**
 * 安全控制独立验证：SEC-CTL-004（会话撤销绑定当前账号证据；恢复不复活权限）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5（SEC-CTL-004）、
 * §6.2（禁用/删除立即终止会话并撤销当前访问）。
 *
 * 验证路径（真实类 + 端口级假体，无 pg 依赖）：
 * - src/modules/identity/application/commands/handle-account-status-event.use-case.ts
 * - src/modules/identity/domain/state-machines/account-access.state-machine.ts
 * - src/modules/identity/infrastructure/postgres-session-revocation.ts
 *   （假 DbAdapter 注入构造 + 真 IdentityUnitOfWork）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FakeDbAdapter } from '../../src/shared/testing/fake-db-adapter';
import type { DbAdapter, TransactionContext } from '../../src/shared/db-adapter';
import {
  DefaultHandleAccountStatusEventUseCase,
  type HandleAccountStatusEventInput,
} from '../../src/modules/identity/application/commands/handle-account-status-event.use-case';
import type { AccountAccessRepository } from '../../src/modules/identity/application/ports/account-access-repository.port';
import type {
  IdentityAuditFact,
  IdentityAuditPort,
} from '../../src/modules/identity/application/ports/identity-audit.port';
import type { SessionRevocationPort } from '../../src/modules/identity/application/ports/session-revocation.port';
import {
  AccountAccessState,
  DefaultAccountAccessStateMachine,
} from '../../src/modules/identity/domain/state-machines/account-access.state-machine';
import type { AccountAccessSnapshot } from '../../src/modules/identity/domain/models/account-access';
import { PostgresSessionRevocation } from '../../src/modules/identity/infrastructure/postgres-session-revocation';
import { IdentityUnitOfWork } from '../../src/modules/identity/infrastructure/unit-of-work';

function snapshotOf(
  state: AccountAccessState,
  stateVersion: number,
  sessionRevokeVersion: number,
): AccountAccessSnapshot {
  return {
    subjectId: 'subject-1',
    state,
    stateVersion,
    degradedSince: null,
    lastTrustedObservationAt: new Date('2026-08-01T00:00:00Z'),
    sessionRevokeVersion,
  };
}

interface Harness {
  useCase: DefaultHandleAccountStatusEventUseCase;
  saved: AccountAccessSnapshot[];
  auditFacts: IdentityAuditFact[];
  revocations: Array<{ subjectId: string; version: number }>;
}

function makeHarness(preloaded: AccountAccessSnapshot | null): Harness {
  const saved: AccountAccessSnapshot[] = [];
  const repository: AccountAccessRepository = {
    load: async () => preloaded,
    save: async (s) => {
      saved.push(s);
    },
  };
  const auditFacts: IdentityAuditFact[] = [];
  const audit: IdentityAuditPort = {
    record: async (fact) => {
      auditFacts.push(fact);
    },
  };
  const revocations: Array<{ subjectId: string; version: number }> = [];
  const sessionRevocation: SessionRevocationPort = {
    invalidateSessions: async (subjectId, version) => {
      revocations.push({ subjectId, version });
    },
    getRevocation: async () => null,
    invalidateAllSessions: async () => 0,
  };
  const useCase = new DefaultHandleAccountStatusEventUseCase(
    repository,
    new DefaultAccountAccessStateMachine(),
    audit,
    sessionRevocation,
  );
  return { useCase, saved, auditFacts, revocations };
}

function inputOf(event: HandleAccountStatusEventInput['event']): HandleAccountStatusEventInput {
  return {
    subjectId: 'subject-1',
    event,
    source: 'CASDOOR_EVENT',
    reason: '安全独立验证',
    now: new Date('2026-08-24T08:00:00Z'),
    actor: 'system',
    traceId: null,
  };
}

/** auth_sessions 假适配器：实现 COALESCE(MAX)+1 的撤销版本推进语义。 */
class AuthSessionsFakeDb implements DbAdapter {
  readonly events: string[] = [];
  private rows: Array<{
    session_id: string;
    subject_id: string;
    revoke_version: number;
    revoked_at: Date | null;
  }>;

  constructor(rows: AuthSessionsFakeDb['rows']) {
    this.rows = rows.map((r) => ({ ...r }));
  }

  allRows(): AuthSessionsFakeDb['rows'] {
    return this.rows.map((r) => ({ ...r }));
  }

  /** 模拟重新登录：新增一条未失效会话 */
  addSession(sessionId: string, subjectId: string): void {
    this.rows.push({
      session_id: sessionId,
      subject_id: subjectId,
      revoke_version: 0,
      revoked_at: null,
    });
  }

  async beginTransaction(): Promise<TransactionContext> {
    const tx = { id: `tx-${this.events.length + 1}` };
    this.events.push(`begin:${tx.id}`);
    return tx;
  }
  async commit(tx: TransactionContext): Promise<void> {
    this.events.push(`commit:${tx.id}`);
  }
  async rollback(tx: TransactionContext): Promise<void> {
    this.events.push(`rollback:${tx.id}`);
  }
  async setRlsContext(tx: TransactionContext, scope: { kind: string }): Promise<void> {
    this.events.push(`set-rls:${tx.id}:${scope.kind}`);
  }
  async clearRlsContext(tx: TransactionContext): Promise<void> {
    this.events.push(`clear-rls:${tx.id}`);
  }
  async query<T>(_tx: TransactionContext, sql: string, params: readonly unknown[]): Promise<T[]> {
    if (/UPDATE\s+auth_sessions/i.test(sql)) {
      const subjectId = params[0] as string;
      // 与真实 SQL 对齐：COALESCE((SELECT MAX(revoke_version) … WHERE subject_id=$1),0)+1
      const next =
        this.rows
          .filter((r) => r.subject_id === subjectId)
          .reduce((m, r) => Math.max(m, r.revoke_version), 0) + 1;
      const targets = this.rows.filter((r) => r.subject_id === subjectId && r.revoked_at === null);
      for (const row of targets) {
        row.revoke_version = next;
        row.revoked_at = new Date('2026-08-24T09:00:00Z');
      }
      return targets.map(() => ({ revoke_version: String(next) })) as T[];
    }
    return [] as T[];
  }
}

describe('SEC-CTL-004 会话撤销绑定账号事件与恢复边界', () => {
  it('SEC-CTL-004：可信禁用确认立即终止全部会话（撤销版本推进）且同事务落审计、保留历史', async () => {
    const h = makeHarness(null);
    const result = await h.useCase.execute(inputOf({ type: 'DISABLED' }));

    assert.equal(result.transition.allowed, true);
    assert.equal(result.transition.nextState, AccountAccessState.DISABLED);
    assert.equal(result.transition.sessionRevoke, true);
    assert.equal(result.sessionRevokeVersion, 1);
    assert.deepEqual(h.revocations, [{ subjectId: 'subject-1', version: 1 }]);
    assert.equal(h.saved.length, 1);
    assert.equal(h.saved[0].state, AccountAccessState.DISABLED);
    assert.equal(h.auditFacts.length, 1);
    assert.equal(h.auditFacts[0].type, 'ACCOUNT_ACCESS_CHANGED');
  });

  it('SEC-CTL-004：重复禁用幂等返回既有结果，不重复撤销、不重复审计', async () => {
    const h = makeHarness(snapshotOf(AccountAccessState.DISABLED, 1, 1));
    const result = await h.useCase.execute(inputOf({ type: 'DISABLED' }));

    assert.equal(result.transition.allowed, true);
    assert.deepEqual(h.saved, []);
    assert.deepEqual(h.revocations, []);
    assert.deepEqual(h.auditFacts, []);
    assert.equal(result.sessionRevokeVersion, 1);
  });

  it('SEC-CTL-004：恢复要求重新登录（reauthenticationRequired），不自动复活旧权限', async () => {
    const h = makeHarness(snapshotOf(AccountAccessState.DISABLED, 1, 1));
    const result = await h.useCase.execute(inputOf({ type: 'REENABLED' }));

    assert.equal(result.transition.allowed, true);
    assert.equal(result.transition.nextState, AccountAccessState.ACTIVE);
    assert.equal(result.transition.reauthenticationRequired, true);
    assert.deepEqual(h.revocations, [], '恢复路径不得产生新的撤销副作用以外的授权动作');
    assert.equal(h.auditFacts[0].summary['toState'], AccountAccessState.ACTIVE);
  });

  it('SEC-CTL-004：删除后不得猜测禁用——非法跃迁拒绝且零副作用', async () => {
    const h = makeHarness(snapshotOf(AccountAccessState.DELETED, 2, 1));
    await assert.rejects(h.useCase.execute(inputOf({ type: 'DISABLED' })), (err: unknown) => {
      assert.equal((err as { code?: string })['code'], 'IFC-ERR-006');
      return true;
    });
    assert.deepEqual(h.saved, []);
    assert.deepEqual(h.revocations, []);
    assert.deepEqual(h.auditFacts, []);
  });
});

describe('SEC-CTL-004 invalidateAllSessions 撤销版本单调推进（假 uow/db 注入真实 Postgres 类）', () => {
  it('SEC-CTL-004：撤销版本随每次吊销单调推进，仅未失效会话被标记，他主体不受影响', async () => {
    const db = new AuthSessionsFakeDb([
      { session_id: 's1', subject_id: 'u1', revoke_version: 2, revoked_at: null },
      { session_id: 's2', subject_id: 'u1', revoke_version: 5, revoked_at: new Date(0) },
      { session_id: 's3', subject_id: 'u2', revoke_version: 0, revoked_at: null },
    ]);
    const uow = new IdentityUnitOfWork(db);
    const revocation = new PostgresSessionRevocation(db, uow);

    let first = 0;
    await uow.run({ kind: 'single', subjectId: 'u1' }, async () => {
      first = await revocation.invalidateAllSessions('u1');
    });
    assert.equal(first, 6, '首推版本 = 历史 MAX+1（单调）');

    // 模拟重新登录产生新的未失效会话后再次吊销：版本必须继续递增
    const rows = db.allRows();
    assert.notEqual(rows.find((r) => r.session_id === 's1')?.revoked_at, null);
    db.addSession('s9', 'u1');
    let second = 0;
    await uow.run({ kind: 'single', subjectId: 'u1' }, async () => {
      second = await revocation.invalidateAllSessions('u1');
    });
    assert.ok(second > first, `再次吊销版本须单调递增（${second} > ${first}）`);
    assert.equal(second, 7);

    const finalRows = db.allRows();
    const s3 = finalRows.find((r) => r.session_id === 's3');
    assert.equal(s3?.revoke_version, 0, '其他主体会话不受影响');
    assert.equal(s3?.revoked_at, null);
    assert.ok(finalRows.filter((r) => r.subject_id === 'u1').every((r) => r.revoked_at !== null));
    assert.ok(
      db.events.some((e) => e.endsWith(':single')),
      '须在单目标 RLS 上下文内执行',
    );
  });

  it('SEC-CTL-004：脱离工作单元事务调用吊销被拒绝（无活动事务禁止读写）', async () => {
    const db = new AuthSessionsFakeDb([
      { session_id: 's1', subject_id: 'u1', revoke_version: 0, revoked_at: null },
    ]);
    const revocation = new PostgresSessionRevocation(db, new IdentityUnitOfWork(db));
    await assert.rejects(revocation.invalidateAllSessions('u1'), /无活动事务/);
  });
});

describe('SEC-CTL-004 FakeDbAdapter 复用核验（端口级假体可用性）', () => {
  it('SEC-CTL-004：共享假适配器记录 RLS 生命周期事件，供上述真实类驱动', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    await uow.run({ kind: 'single', subjectId: 'u9' }, async () => undefined);
    assert.deepEqual(
      db.events.map((e) => e.split(':')[0]),
      ['begin', 'set-rls', 'commit', 'clear-rls'],
    );
  });
});
