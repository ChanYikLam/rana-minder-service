/**
 * DefaultGetMyProfileQuery 单元测试（IFC-QRY-003；API-AUTH-002）。
 *
 * 覆盖：回源权威聚合（资料门、字段、邮箱验证）、逐字段同步状态、
 * 降级窗口剩余时间、profileComplete 派生。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultDegradationPolicy } from '../../domain/services/degradation.policy';
import { ProfileWriteGateState } from '../../domain/state-machines/profile-write-gate.state-machine';
import { AccountAccessState } from '../../domain/state-machines/account-access.state-machine';
import type { ProfileSnapshot } from '../../domain/models/profile';
import type { ProfileSyncIntentSnapshot } from '../../domain/models/profile-sync-intent';
import type { AccountAccessSnapshot } from '../../domain/models/account-access';
import type { ProfileRepository } from '../ports/profile-repository.port';
import type { ProfileSyncIntentRepository } from '../ports/profile-sync-intent-repository.port';
import type { AccountAccessRepository } from '../ports/account-access-repository.port';
import { DefaultGetMyProfileQuery } from './get-my-profile.query';
import { IdentityErrorCode } from '../errors';
import { ProfileSyncState } from '../../domain/state-machines/profile-sync.state-machine';

const now = new Date('2026-08-20T12:00:00.000Z');

function profileSnapshot(overrides?: Partial<ProfileSnapshot>): ProfileSnapshot {
  return {
    subjectId: 'user-1',
    fields: { phone: '13800000000', college: '计算机学院' },
    emailVerified: true,
    verifiedEmail: 'a@example.com',
    pendingEmail: null,
    version: 4,
    gateState: ProfileWriteGateState.WRITABLE,
    restrictions: [{ scopeKey: 'club:2', reason: '社团 2 成员资料缺失', since: now }],
    ...overrides,
  };
}

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

function intentSnapshot(overrides?: Partial<ProfileSyncIntentSnapshot>): ProfileSyncIntentSnapshot {
  return {
    id: 'intent-1',
    subjectId: 'user-1',
    field: 'phone',
    targetVersion: 4,
    priorValue: '13700000000',
    targetValue: '13800000000',
    readbackValue: null,
    state: ProfileSyncState.PENDING_SYNC,
    conflictVersion: null,
    attempts: 0,
    retryAt: null,
    failedSince: null,
    resolvedAt: null,
    createdAt: now,
    ...overrides,
  };
}

function createQuery(overrides?: {
  profileRepository?: ProfileRepository;
  intentRepository?: ProfileSyncIntentRepository;
  accountRepository?: AccountAccessRepository;
}) {
  return new DefaultGetMyProfileQuery(
    overrides?.profileRepository ?? {
      async load() {
        return profileSnapshot();
      },
      async save() {},
    },
    overrides?.intentRepository ?? {
      async load(_subjectId, field) {
        return field === 'phone' ? intentSnapshot() : null;
      },
      async loadMany(_subjectId, fields) {
        return fields.includes('phone') ? [intentSnapshot()] : [];
      },
      async save() {},
    },
    overrides?.accountRepository ?? {
      async load() {
        return accountSnapshot();
      },
      async save() {},
    },
    new DefaultDegradationPolicy(),
  );
}

describe('GetMyProfileQuery（IFC-QRY-003）', () => {
  it('NOM：聚合资料、资料门、字段与逐字段同步状态', async () => {
    const query = createQuery();

    const result = await query.execute({ subjectId: 'user-1', now });

    assert.equal(result.version, 4);
    assert.equal(result.fields.phone, '13800000000');
    assert.equal(result.gateState, ProfileWriteGateState.WRITABLE);
    assert.equal(result.restrictions.length, 1);
    assert.equal(result.restrictions[0].scopeKey, 'club:2');
    assert.equal(result.profileComplete, true);
    assert.equal(result.syncStatus.phone.state, ProfileSyncState.PENDING_SYNC);
    assert.equal(result.syncStatus.phone.targetVersion, 4);
    assert.equal(result.syncStatus.email.state, 'none'); // 未产生同步意图的字段
    assert.equal(result.degraded, false);
  });

  it('IDN-002：待补充状态 → profileComplete=false（仅可浏览+补资料）', async () => {
    const query = createQuery({
      profileRepository: {
        async load() {
          return profileSnapshot({ gateState: ProfileWriteGateState.PENDING_COMPLETION });
        },
        async save() {},
      },
    });

    const result = await query.execute({ subjectId: 'user-1', now });

    assert.equal(result.profileComplete, false);
  });

  it('save 链路复用已知快照：不再整份重新回源（IFC-QRY 高频写后读）', async () => {
    let loadCalls = 0;
    const query = createQuery({
      profileRepository: {
        async load() {
          loadCalls += 1;
          return profileSnapshot({ version: 99 });
        },
        async save() {},
      },
    });

    const result = await query.execute(
      { subjectId: 'user-1', now },
      profileSnapshot({ version: 5, fields: { phone: '13900000000' } }),
    );

    assert.equal(loadCalls, 0);
    assert.equal(result.version, 5);
    assert.equal(result.fields.phone, '13900000000');
  });

  it('IDN-009：降级中返回降级起点与剩余窗口', async () => {
    const degradedSince = new Date('2026-08-20T11:50:00Z'); // 10 分钟前
    const query = createQuery({
      accountRepository: {
        async load() {
          return accountSnapshot({
            state: AccountAccessState.UNVERIFIABLE,
            degradedSince,
          });
        },
        async save() {},
      },
    });

    const result = await query.execute({ subjectId: 'user-1', now });

    assert.equal(result.degraded, true);
    assert.equal(result.degradedSince?.getTime(), degradedSince.getTime());
    assert.equal(result.remainingWindowMs, 5 * 60 * 1000);
  });

  it('REV：资料不存在 → IFC-ERR-015（不伪造结果）', async () => {
    const query = createQuery({
      profileRepository: {
        async load() {
          return null;
        },
        async save() {},
      },
    });

    await assert.rejects(
      () => query.execute({ subjectId: 'ghost', now }),
      (err: any) => err.code === IdentityErrorCode.NOT_FOUND,
    );
  });
});