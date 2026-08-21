/**
 * DefaultGetAccountAccessQuery 单元测试（IFC-QRY-005；IDN-009、SRS-FAIL-001、
 * GOV-009）。
 *
 * 覆盖：正常/降级窗口内/窗口外判定、禁用删除立即失效、白名单能力仅服务端
 * 逐请求判定（不含授权/越权判定，仅返回查询结果）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultDegradationPolicy } from '../../domain/services/degradation.policy';
import { AccountAccessState } from '../../domain/state-machines/account-access.state-machine';
import type { AccountAccessSnapshot } from '../../domain/models/account-access';
import type { AccountAccessRepository } from '../ports/account-access-repository.port';
import { DefaultGetAccountAccessQuery } from './get-account-access.query';
import { IdentityErrorCode } from '../errors';

const now = new Date('2026-08-20T12:00:00.000Z');

function accountSnapshot(overrides?: Partial<AccountAccessSnapshot>): AccountAccessSnapshot {
  return {
    subjectId: 'user-1',
    state: AccountAccessState.ACTIVE,
    stateVersion: 1,
    degradedSince: null,
    lastTrustedObservationAt: now,
    sessionRevokeVersion: 0,
    ...overrides,
  };
}

function createQuery(repository: AccountAccessRepository) {
  return new DefaultGetAccountAccessQuery(repository, new DefaultDegradationPolicy());
}

const authenticInput = {
  now,
  category: 'OWN_BASIC_PROFILE_READ' as const,
  sessionAuthenticatedBeforeFailure: true,
};

describe('GetAccountAccessQuery（IFC-QRY-005）', () => {
  it('NOM：账号有效 → 正常放行（非降级）', async () => {
    const repository: AccountAccessRepository = {
      async load() {
        return accountSnapshot();
      },
      async save() {},
    };
    const query = createQuery(repository);

    const result = await query.execute({ subjectId: 'user-1', ...authenticInput });

    assert.equal(result.state, AccountAccessState.ACTIVE);
    assert.equal(result.degraded, false);
    assert.equal(result.whitelistAllowed, true);
  });

  it('SRS-FAIL-001：降级窗口内且会话先行认证 → 白名单放行（剩余 5 分钟）', async () => {
    const repository: AccountAccessRepository = {
      async load() {
        return accountSnapshot({
          state: AccountAccessState.UNVERIFIABLE,
          degradedSince: new Date('2026-08-20T11:50:00Z'),
        });
      },
      async save() {},
    };
    const query = createQuery(repository);

    const result = await query.execute({ subjectId: 'user-1', ...authenticInput });

    assert.equal(result.degraded, true);
    assert.equal(result.withinWindow, true);
    assert.equal(result.remainingWindowMs, 5 * 60 * 1000);
    assert.equal(result.whitelistAllowed, true);
  });

  it('SRS-FAIL-001：窗口内但会话未在故障前认证 → 拒绝', async () => {
    const repository: AccountAccessRepository = {
      async load() {
        return accountSnapshot({
          state: AccountAccessState.UNVERIFIABLE,
          degradedSince: new Date('2026-08-20T11:50:00Z'),
        });
      },
      async save() {},
    };
    const query = createQuery(repository);

    const result = await query.execute({
      subjectId: 'user-1',
      now,
      category: 'OWN_BASIC_PROFILE_READ',
      sessionAuthenticatedBeforeFailure: false,
    });

    assert.equal(result.withinWindow, true);
    assert.equal(result.whitelistAllowed, false);
  });

  it('SRS-FAIL-001：超过 15 分钟窗口 → 拒绝（服务端逐请求判定）', async () => {
    const repository: AccountAccessRepository = {
      async load() {
        return accountSnapshot({
          state: AccountAccessState.UNVERIFIABLE,
          degradedSince: new Date('2026-08-20T11:00:00Z'),
        });
      },
      async save() {},
    };
    const query = createQuery(repository);

    const result = await query.execute({ subjectId: 'user-1', ...authenticInput });

    assert.equal(result.withinWindow, false);
    assert.equal(result.remainingWindowMs, 0);
    assert.equal(result.whitelistAllowed, false);
    assert.equal(result.reason !== null, true);
  });

  it('GOV-009：账号禁用/删除 → 会话立即失效（无宽限）', async () => {
    for (const state of [AccountAccessState.DISABLED, AccountAccessState.DELETED]) {
      const repository: AccountAccessRepository = {
        async load() {
          return accountSnapshot({ state });
        },
        async save() {},
      };
      const query = createQuery(repository);

      const result = await query.execute({ subjectId: 'user-1', ...authenticInput });

      assert.equal(result.state, state);
      assert.equal(result.whitelistAllowed, false);
      assert.equal(result.reason !== null, true);
    }
  });

  it('REV：无账号状态 → IFC-ERR-015', async () => {
    const repository: AccountAccessRepository = {
      async load() {
        return null;
      },
      async save() {},
    };
    const query = createQuery(repository);

    await assert.rejects(
      () => query.execute({ subjectId: 'ghost', ...authenticInput }),
      (err: any) => err.code === IdentityErrorCode.NOT_FOUND,
    );
  });
});
