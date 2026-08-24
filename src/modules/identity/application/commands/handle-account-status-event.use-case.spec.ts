/**
 * DefaultHandleAccountStatusEventUseCase 单元测试（IFC-SM-001；IDN-001/008/009）。
 *
 * 覆盖：禁用/删除/降级/回读收口/恢复的推进、幂等重复事件、STA 拒绝、
 * 会话撤销版本推进、审计同事务落点、首次登录聚合根初始化。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultAccountAccessStateMachine } from '../../domain/state-machines/account-access.state-machine';
import { AccountAccessState } from '../../domain/state-machines/account-access.state-machine';
import type { AccountAccessSnapshot } from '../../domain/models/account-access';
import type { AccountAccessRepository } from '../ports/account-access-repository.port';
import type { IdentityAuditPort } from '../ports/identity-audit.port';
import type { SessionRevocationPort } from '../ports/session-revocation.port';
import {
  DefaultHandleAccountStatusEventUseCase,
  type HandleAccountStatusEventInput,
} from './handle-account-status-event.use-case';
import { IdentityErrorCode } from '../errors';

const now = new Date('2026-08-20T12:00:00.000Z');

function activeSnapshot(subjectId = 'user-1'): AccountAccessSnapshot {
  return {
    subjectId,
    state: AccountAccessState.ACTIVE,
    stateVersion: 5,
    degradedSince: null,
    lastTrustedObservationAt: new Date('2026-08-20T10:00:00Z'),
    sessionRevokeVersion: 0,
  };
}

function inMemoryAccountRepository(): AccountAccessRepository & {
  saved: AccountAccessSnapshot[];
  seed: (snapshot: AccountAccessSnapshot) => void;
} {
  const store = new Map<string, AccountAccessSnapshot>();
  return {
    saved: [],
    seed(snapshot) {
      store.set(snapshot.subjectId, snapshot);
    },
    async load(subjectId) {
      return store.get(subjectId) ?? null;
    },
    async save(snapshot) {
      store.set(snapshot.subjectId, snapshot);
      this.saved.push(snapshot);
    },
  };
}

function inMemorySessionRevocation(): SessionRevocationPort & {
  invalidated: { subjectId: string; version: number }[];
} {
  return {
    invalidated: [],
    async invalidateSessions(subjectId, version) {
      this.invalidated.push({ subjectId, version });
    },
    async getRevocation() {
      return null;
    },
    async invalidateAllSessions() {
      return 0;
    },
  };
}

function createUseCase(overrides?: {
  repository?: AccountAccessRepository;
  audit?: IdentityAuditPort;
  sessionRevocation?: SessionRevocationPort;
}) {
  return new DefaultHandleAccountStatusEventUseCase(
    overrides?.repository ?? inMemoryAccountRepository(),
    new DefaultAccountAccessStateMachine(),
    overrides?.audit ?? { async record() {} },
    overrides?.sessionRevocation ?? inMemorySessionRevocation(),
  );
}

function inputFor(
  overrides?: Partial<HandleAccountStatusEventInput>,
): HandleAccountStatusEventInput {
  return {
    subjectId: 'user-1',
    event: { type: 'DISABLED' },
    source: 'CASDOOR_EVENT',
    reason: '对账确认账号禁用',
    now,
    actor: 'system-task',
    traceId: 'tr_task_001',
    ...overrides,
  };
}

describe('HandleAccountStatusEventUseCase（IFC-SM-001）', () => {
  it('NOM：有效 → 禁用（事件/对账确认）→ 会话撤销版本推进、审计同事务', async () => {
    const repository = inMemoryAccountRepository();
    repository.seed(activeSnapshot());
    let audited = 0;
    let auditSubject: string | null = null;
    const audit: IdentityAuditPort = {
      async record(fact) {
        audited += 1;
        auditSubject = fact.subjectId;
      },
    };
    const sessionRevocation = inMemorySessionRevocation();
    const useCase = createUseCase({ repository, audit, sessionRevocation });

    const result = await useCase.execute(inputFor());

    assert.equal(result.transition.allowed, true);
    assert.equal(result.transition.sessionRevoke, true);
    assert.equal(result.stateVersion, 6);
    assert.equal(result.sessionRevokeVersion, 1);
    assert.equal(repository.saved[0].state, AccountAccessState.DISABLED);
    assert.equal(audited, 1);
    assert.equal(auditSubject, 'user-1');
    // IDN-008：禁用可信确认 → 同事务立即失效全部会话
    assert.deepEqual(sessionRevocation.invalidated, [{ subjectId: 'user-1', version: 1 }]);
  });

  it('幂等：重复禁用 → 仅返回既有结果（不产生新状态变化）', async () => {
    const repository = inMemoryAccountRepository();
    repository.seed(activeSnapshot());
    const useCase = createUseCase({ repository });

    await useCase.execute(inputFor());
    const second = await useCase.execute(inputFor());

    assert.equal(second.transition.allowed, true);
    assert.equal(second.transition.sessionRevoke, false); // 已禁用，重复事件不再撤销会话
    assert.equal(repository.saved.length, 1); // 第二次无状态变化不落库
  });

  it('NOM：有效 → 删除（事件/对账确认）→ 会话撤销', async () => {
    const repository = inMemoryAccountRepository();
    repository.seed(activeSnapshot());
    const sessionRevocation = inMemorySessionRevocation();
    const useCase = createUseCase({ repository, sessionRevocation });

    const result = await useCase.execute(inputFor({ event: { type: 'DELETED' } }));

    assert.equal(result.transition.sessionRevoke, true);
    assert.equal(repository.saved[0].state, AccountAccessState.DELETED);
    assert.equal(sessionRevocation.invalidated.length, 1);
  });

  it('NOM：有效 → 暂不可确认（故障判定）→ 记录降级起点', async () => {
    const repository = inMemoryAccountRepository();
    repository.seed(activeSnapshot());
    const useCase = createUseCase({ repository });

    const result = await useCase.execute(inputFor({ event: { type: 'UNVERIFIABLE' } }));

    assert.equal(repository.saved[0].state, AccountAccessState.UNVERIFIABLE);
    assert.equal(repository.saved[0].degradedSince?.getTime(), now.getTime());
    assert.equal(result.transition.sessionRevoke, false);
  });

  it('NOM：回读收口 → 有效（结束降级并要求重新认证）', async () => {
    const repository = inMemoryAccountRepository();
    repository.seed({
      ...activeSnapshot(),
      state: AccountAccessState.UNVERIFIABLE,
      degradedSince: new Date('2026-08-20T11:55:00Z'),
    });
    const useCase = createUseCase({ repository });

    const result = await useCase.execute(
      inputFor({
        event: { type: 'READBACK', readbackState: AccountAccessState.ACTIVE },
        source: 'READBACK',
      }),
    );

    assert.equal(repository.saved[0].state, AccountAccessState.ACTIVE);
    assert.equal(repository.saved[0].degradedSince, null);
    assert.equal(result.transition.reauthenticationRequired, true);
  });

  it('NOM：回读收口 → 禁用（同步终止会话，无 15 分钟宽限）', async () => {
    const repository = inMemoryAccountRepository();
    repository.seed({
      ...activeSnapshot(),
      state: AccountAccessState.UNVERIFIABLE,
      degradedSince: new Date('2026-08-20T11:55:00Z'),
    });
    const useCase = createUseCase({ repository });

    const result = await useCase.execute(
      inputFor({
        event: { type: 'READBACK', readbackState: AccountAccessState.DISABLED },
        source: 'READBACK',
      }),
    );

    assert.equal(repository.saved[0].state, AccountAccessState.DISABLED);
    assert.equal(result.transition.sessionRevoke, true);
  });

  it('NOM：禁用 → 有效（恢复并重新登录）', async () => {
    const repository = inMemoryAccountRepository();
    repository.seed({ ...activeSnapshot(), state: AccountAccessState.DISABLED });
    const useCase = createUseCase({ repository });

    const result = await useCase.execute(inputFor({ event: { type: 'REENABLED' } }));

    assert.equal(repository.saved[0].state, AccountAccessState.ACTIVE);
    assert.equal(result.transition.reauthenticationRequired, true);
  });

  it('STA：已删除账号不得猜测禁用 → 拒绝且不落库', async () => {
    const repository = inMemoryAccountRepository();
    repository.seed({ ...activeSnapshot(), state: AccountAccessState.DELETED });
    const useCase = createUseCase({ repository });

    await assert.rejects(
      () => useCase.execute(inputFor({ event: { type: 'DISABLED' } })),
      (err: any) => err.code === IdentityErrorCode.PRECONDITION_FAILED,
    );
    assert.equal(repository.saved.length, 0);
  });

  it('REV：降级中账号收到禁用事件不得直接落禁用（须以回读收口）', async () => {
    const repository = inMemoryAccountRepository();
    repository.seed({
      ...activeSnapshot(),
      state: AccountAccessState.UNVERIFIABLE,
      degradedSince: new Date('2026-08-20T11:55:00Z'),
    });
    const useCase = createUseCase({ repository });

    await assert.rejects(
      () => useCase.execute(inputFor({ event: { type: 'DISABLED' } })),
      (err: any) => err.code === IdentityErrorCode.PRECONDITION_FAILED,
    );
    assert.equal(repository.saved.length, 0);
  });

  it('NOM：首次登录无聚合根 → 初始化为有效并推进禁用', async () => {
    const repository = inMemoryAccountRepository();
    const useCase = createUseCase({ repository });

    const result = await useCase.execute(inputFor());

    assert.equal(result.transition.allowed, true);
    assert.equal(repository.saved[0].state, AccountAccessState.DISABLED);
    assert.equal(repository.saved[0].stateVersion, 1);
  });
});
