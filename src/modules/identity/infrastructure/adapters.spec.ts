/**
 * 基础设施适配器单元测试（infrastructure）。
 *
 * 覆盖：
 * - CasdoorUserAdapter：观测映射（账号状态/字段抽取）、状态不可映射 → 结果不确定、
 *   失败分类透传、写入响应不是可信回读；
 * - ProfileSyncTaskWriter：任务意图与业务事实同事务落库、按 (type,subject,field,version)
 *   幂等去重；
 * - MailVerificationChannel：委托渠道投递（令牌只经调用方回传）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CasdoorUserAdapter } from './casdoor-user.adapter';
import { ProfileSyncTaskWriter } from './profile-sync-task.writer';
import { MailVerificationChannel } from './mail-verification.channel';
import { IdentityUnitOfWork } from './unit-of-work';
import { FakeDbAdapter } from './testing/fake-db-adapter';
import { AccountAccessState } from '../domain/state-machines/account-access.state-machine';
import type {
  CasdoorAdapter,
  CasdoorUser,
  CasdoorUserPatch,
} from '../../../adapters/casdoor/casdoor-adapter';
import type { MailChannelAdapter } from '../../../adapters/mail/mail-channel-adapter';
import {
  externalSuccess,
  externalFailure,
  type ExternalResult,
} from '../../../common/contracts/external-result';

const now = new Date('2026-08-20T12:00:00.000Z');

function casdoorUser(overrides?: Partial<CasdoorUser>): CasdoorUser {
  return {
    id: 'user-1',
    name: '张三',
    studentId: '20240001',
    email: 'a@example.com',
    phone: '13800000000',
    college: '计算机学院',
    grade: '2024',
    state: AccountAccessState.ACTIVE,
    externalVersion: 'v-9',
    ...overrides,
  };
}

function fakeCasdoor(getUser: () => Promise<ExternalResult<CasdoorUser>>): CasdoorAdapter {
  return {
    async getUser() {
      return getUser();
    },
    async updateUser() {
      return externalSuccess(undefined, 'a-1', now);
    },
  };
}

describe('CasdoorUserAdapter（CAS-READ-002/003、CAS-WR-*）', () => {
  it('readAccountStatus：ACTIVE → 观测成功，携带外部版本证据', async () => {
    const adapter = new CasdoorUserAdapter(
      fakeCasdoor(async () => externalSuccess(casdoorUser(), 'a-1', now)),
    );

    const result = await adapter.readAccountStatus('user-1');

    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.data?.state, AccountAccessState.ACTIVE);
    assert.equal(result.data?.externalVersion, 'v-9');
  });

  it('readAccountStatus：状态无法映射 → UNCERTAIN（失败关闭）', async () => {
    const adapter = new CasdoorUserAdapter(
      fakeCasdoor(async () => externalSuccess(casdoorUser({ state: 'MYSTERY' }), 'a-1', now)),
    );

    const result = await adapter.readAccountStatus('user-1');

    assert.equal(result.status, 'UNCERTAIN');
    assert.equal(result.data, null);
  });

  it('readAccountStatus：外部不可用 → UNAVAILABLE 透传（IFC-ERR-012 语义）', async () => {
    const adapter = new CasdoorUserAdapter(
      fakeCasdoor(async () =>
        externalFailure(
          'UNAVAILABLE',
          { code: 'CAS-DOWN', message: '不可用', retryable: true, rawStatusCode: 503 },
          'a-1',
          now,
        ),
      ),
    );

    const result = await adapter.readAccountStatus('user-1');

    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.error?.code, 'CAS-DOWN');
  });

  it('readProfileField：按字段抽取（email/phone/name/studentId）', async () => {
    const adapter = new CasdoorUserAdapter(
      fakeCasdoor(async () => externalSuccess(casdoorUser(), 'a-1', now)),
    );

    assert.equal((await adapter.readProfileField('user-1', 'phone')).data?.value, '13800000000');
    assert.equal((await adapter.readProfileField('user-1', 'email')).data?.value, 'a@example.com');
    assert.equal((await adapter.readProfileField('user-1', 'name')).data?.value, '张三');
    assert.equal((await adapter.readProfileField('user-1', 'studentId')).data?.value, '20240001');
  });

  it('writeProfileField：委托 updateUser 并返回写入回显（非可信读回）', async () => {
    let patched: CasdoorUserPatch | null = null;
    const casdoor: CasdoorAdapter = {
      async getUser() {
        return externalSuccess(casdoorUser(), 'a-1', now);
      },
      async updateUser(_userId, patch) {
        patched = patch;
        return externalSuccess(undefined, 'a-1', now);
      },
    };
    const adapter = new CasdoorUserAdapter(casdoor);

    const result = await adapter.writeProfileField('user-1', 'phone', '13900000000');

    assert.equal(result.status, 'SUCCESS');
    assert.deepEqual(patched, { phone: '13900000000' });
    assert.equal(result.data?.value, '13900000000');
    assert.equal(result.data?.externalVersion, null); // 回显不是可信读回
  });
});

describe('ProfileSyncTaskWriter（事务发件箱）', () => {
  it('scheduleProfileSync/Readback：任务与业务同事务落库', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    const writer = new ProfileSyncTaskWriter(db, uow);

    await uow.run({ kind: 'single', subjectId: 'user-1' }, async () => {
      await writer.scheduleProfileSync('user-1', 'phone', 4, 'intent-1');
      await writer.scheduleProfileReadback('user-1', 'phone', 4, 'intent-1');
    });

    assert.equal(db.queries.length, 2);
    assert.equal(db.queries[0].params[1], 'profile_sync');
    assert.equal(db.queries[0].params[0], 'profile_sync:user-1:phone:4');
    assert.equal(db.queries[1].params[1], 'profile_readback');
    assert.equal(db.queries[1].params[0], 'profile_readback:user-1:phone:4');
    const payload = JSON.parse(db.queries[0].params[3] as string) as { intentId: string };
    assert.equal(payload.intentId, 'intent-1');
    assert.match(db.queries[0].sql, /ON CONFLICT DO NOTHING/);
  });
});

describe('MailVerificationChannel（IFC-TX-005）', () => {
  it('委托渠道投递验证邮件（令牌不落日志/审计）', async () => {
    const received: Parameters<MailChannelAdapter['sendVerificationEmail']>[0][] = [];
    const mail: MailChannelAdapter = {
      async sendVerificationEmail(input) {
        received.push(input);
        return externalSuccess(undefined, 'a-1', now);
      },
    };
    const channel = new MailVerificationChannel(mail);

    await channel.sendVerificationEmail({
      subjectId: 'user-1',
      toEmail: 'new@example.com',
      token: 'v-1:secret',
      expiresAt: new Date(now.getTime() + 86400000),
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].toEmail, 'new@example.com');
    assert.equal(received[0].code, 'v-1:secret');
  });
});
