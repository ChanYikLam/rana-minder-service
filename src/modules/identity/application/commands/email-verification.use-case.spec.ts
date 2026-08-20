/**
 * DefaultEmailVerificationUseCase 单元测试（IFC-SM-002 R003/R004/R005；IDN-011、IFC-TX-005）。
 *
 * 覆盖：发送/重发前置（邮箱有效、频率、发信能力）、单次令牌消费（24 小时/已用/错令牌）、
 * 验证成功后旧邮箱替换、邮箱同步意图创建与任务登记。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultProfileWriteGateStateMachine } from '../../domain/state-machines/profile-write-gate.state-machine';
import { DefaultProfileGatePolicy } from '../../domain/services/profile-gate.policy';
import { ProfileWriteGateState } from '../../domain/state-machines/profile-write-gate.state-machine';
import type { ProfileRepository } from '../ports/profile-repository.port';
import type { EmailVerificationRepository } from '../ports/email-verification-repository.port';
import type { ProfileSyncIntentRepository } from '../ports/profile-sync-intent-repository.port';
import type { MailVerificationPort } from '../ports/mail-verification.port';
import type { ProfileSyncTaskPort } from '../ports/profile-sync-task.port';
import type { IdentityAuditPort } from '../ports/identity-audit.port';
import { DefaultEmailVerificationUseCase } from './email-verification.use-case';
import { IdentityErrorCode } from '../errors';
import { EmailVerification } from '../../domain/models/email-verification';
import type { ProfileSnapshot } from '../../domain/models/profile';

const now = new Date('2026-08-20T12:00:00.000Z');

type VerificationSnapshot = ReturnType<EmailVerification['toSnapshot']>;

function pendingEmailProfile(overrides?: Partial<ProfileSnapshot>): ProfileSnapshot {
  return {
    subjectId: 'user-1',
    fields: { phone: '13700000000', email: 'old@example.com' },
    emailVerified: true,
    verifiedEmail: 'old@example.com',
    pendingEmail: 'new@example.com',
    version: 4,
    gateState: ProfileWriteGateState.PENDING_EMAIL_VERIFICATION,
    restrictions: [],
    ...overrides,
  };
}

function inMemoryProfileRepository(): ProfileRepository & {
  saved: ProfileSnapshot[];
  seed: (snapshot: ProfileSnapshot) => void;
} {
  const store = new Map<string, ProfileSnapshot>();
  return {
    saved: [],
    seed(snapshot) {
      store.set(snapshot.subjectId, snapshot);
    },
    async load(subjectId) {
      return store.get(subjectId) ?? null;
    },
    async save(snapshot, _events, _expectedVersion) {
      store.set(snapshot.subjectId, snapshot);
      this.saved.push(snapshot);
    },
  };
}

function inMemoryVerificationRepository(): EmailVerificationRepository & {
  saved: VerificationSnapshot[];
  seed: (snapshot: VerificationSnapshot) => void;
} {
  const store = new Map<string, VerificationSnapshot>();
  return {
    saved: [],
    seed(snapshot) {
      store.set(snapshot.id, snapshot);
    },
    async load(id) {
      return store.get(id) ?? null;
    },
    async save(snapshot) {
      store.set(snapshot.id, snapshot);
      this.saved.push(snapshot);
    },
    async findLatestBySubjectAndEmail(subjectId, email) {
      for (const v of store.values()) {
        if (v.subjectId === subjectId && v.email === email) {
          return v;
        }
      }
      return null;
    },
  };
}

function inMemorySyncIntentRepository(): ProfileSyncIntentRepository & { saved: any[] } {
  const store = new Map<string, any>();
  return {
    saved: [],
    async load() {
      return null;
    },
    async loadMany() {
      return [];
    },
    async save(snapshot) {
      store.set(`${snapshot.subjectId}:${snapshot.field}`, snapshot);
      this.saved.push(snapshot);
    },
  };
}

function createUseCase(overrides?: {
  repository?: ProfileRepository;
  verificationRepository?: EmailVerificationRepository;
  intentRepository?: ProfileSyncIntentRepository;
  mailPort?: MailVerificationPort;
  taskPort?: ProfileSyncTaskPort;
  audit?: IdentityAuditPort;
}) {
  return new DefaultEmailVerificationUseCase(
    overrides?.repository ?? inMemoryProfileRepository(),
    overrides?.verificationRepository ?? inMemoryVerificationRepository(),
    overrides?.intentRepository ?? inMemorySyncIntentRepository(),
    overrides?.mailPort ?? { async sendVerificationEmail() {} },
    overrides?.taskPort ?? {
      async scheduleProfileSync() {},
      async scheduleProfileReadback() {},
      async scheduleNameCorrectionWrite() {},
    },
    overrides?.audit ?? { async record() {} },
    new DefaultProfileWriteGateStateMachine(),
    new DefaultProfileGatePolicy(),
  );
}

describe('EmailVerificationUseCase R003 发送/重发验证邮件', () => {
  it('NOM：待邮箱验证状态 → 签发新令牌（只存哈希）、邮件意图登记、审计', async () => {
    const repository = inMemoryProfileRepository();
    repository.seed(pendingEmailProfile());
    const verificationRepository = inMemoryVerificationRepository();
    const sent: { toEmail: string; token: string }[] = [];
    let audited = 0;
    const useCase = createUseCase({
      repository,
      verificationRepository,
      mailPort: {
        async sendVerificationEmail(input) {
          sent.push({ toEmail: input.toEmail, token: input.token });
        },
      },
      audit: {
        async record() {
          audited += 1;
        },
      },
    });

    await useCase.sendVerificationEmail({
      subjectId: 'user-1',
      email: 'new@example.com',
      now,
      mailCapable: true,
      actor: 'user-1',
      traceId: null,
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].toEmail, 'new@example.com');
    assert.ok(sent[0].token.length >= 64);
    assert.equal(verificationRepository.saved.length, 1);
    const saved = verificationRepository.saved[0];
    assert.notEqual(saved.tokenHash, sent[0].token); // 只存哈希
    assert.equal(saved.email, 'new@example.com');
    assert.equal(audited, 1);
  });

  it('REV：重发频率超限 → 拒绝（60 秒冷却内）', async () => {
    const repository = inMemoryProfileRepository();
    repository.seed(pendingEmailProfile());
    const verificationRepository = inMemoryVerificationRepository();
    const earlier = new Date(now.getTime() - 10 * 1000);
    const { verification } = EmailVerification.issue(
      'v-1',
      'user-1',
      'new@example.com',
      1,
      earlier,
    );
    verificationRepository.seed(verification.toSnapshot());
    const useCase = createUseCase({ repository, verificationRepository });

    await assert.rejects(
      () =>
        useCase.sendVerificationEmail({
          subjectId: 'user-1',
          email: 'new@example.com',
          now,
          mailCapable: true,
          actor: 'user-1',
          traceId: null,
        }),
      (err: any) => err.code === IdentityErrorCode.PRECONDITION_FAILED,
    );
  });

  it('IDN-011/R004：重发使旧请求失效（supersede 落库，旧链接不再可消费）', async () => {
    const repository = inMemoryProfileRepository();
    repository.seed(pendingEmailProfile());
    const verificationRepository = inMemoryVerificationRepository();
    const earlier = new Date(now.getTime() - 10 * 60 * 1000);
    const { verification: oldRequest } = EmailVerification.issue(
      'v-1',
      'user-1',
      'new@example.com',
      1,
      earlier,
    );
    verificationRepository.seed(oldRequest.toSnapshot());
    const useCase = createUseCase({ repository, verificationRepository });

    await useCase.sendVerificationEmail({
      subjectId: 'user-1',
      email: 'new@example.com',
      now,
      mailCapable: true,
      actor: 'user-1',
      traceId: null,
    });

    const stored = await verificationRepository.load('v-1');
    assert.ok(stored);
    assert.equal(stored.consumedAt?.getTime(), now.getTime());
    assert.equal(oldRequest.toSnapshot().consumedAt, null); // 原快照对象未被旁路改动
  });

  it('REV：平台发信能力不可用 → 拒绝（运维故障，不绕过验证）', async () => {
    const repository = inMemoryProfileRepository();
    repository.seed(pendingEmailProfile());
    const useCase = createUseCase({ repository });

    await assert.rejects(
      () =>
        useCase.sendVerificationEmail({
          subjectId: 'user-1',
          email: 'new@example.com',
          now,
          mailCapable: false,
          actor: 'user-1',
          traceId: null,
        }),
      (err: any) => err.code === IdentityErrorCode.PRECONDITION_FAILED,
    );
  });

  it('STA：非待邮箱验证状态 → 拒绝（已可写无需验证）', async () => {
    const repository = inMemoryProfileRepository();
    repository.seed(
      pendingEmailProfile({
        gateState: ProfileWriteGateState.WRITABLE,
        emailVerified: true,
        pendingEmail: null,
      }),
    );
    const useCase = createUseCase({ repository });

    await assert.rejects(
      () =>
        useCase.sendVerificationEmail({
          subjectId: 'user-1',
          email: 'new@example.com',
          now,
          mailCapable: true,
          actor: 'user-1',
          traceId: null,
        }),
      (err: any) => err.code === IdentityErrorCode.PRECONDITION_FAILED,
    );
  });
});

describe('EmailVerificationUseCase R005 验证链接成功', () => {
  it('NOM：单次令牌消费成功 → 替换旧有效邮箱、创建邮箱同步意图、任务登记', async () => {
    const repository = inMemoryProfileRepository();
    repository.seed(pendingEmailProfile());
    const verificationRepository = inMemoryVerificationRepository();
    const { verification, token } = EmailVerification.issue(
      'v-1',
      'user-1',
      'new@example.com',
      1,
      new Date(now.getTime() - 60_000),
    );
    verificationRepository.seed(verification.toSnapshot());
    const intentRepository = inMemorySyncIntentRepository();
    let scheduled = 0;
    const useCase = createUseCase({
      repository,
      verificationRepository,
      intentRepository,
      taskPort: {
        async scheduleProfileSync() {
          scheduled += 1;
        },
        async scheduleProfileReadback() {},
        async scheduleNameCorrectionWrite() {},
      },
    });

    const result = await useCase.consumeVerificationToken({
      verificationId: 'v-1',
      token,
      now,
      actor: 'user-1',
      traceId: null,
    });

    assert.equal(result.verifiedEmail, 'new@example.com');
    assert.equal(repository.saved.length, 1);
    const profile = repository.saved[0];
    assert.equal(profile.verifiedEmail, 'new@example.com');
    assert.equal(profile.pendingEmail, null);
    assert.equal(profile.fields.email, 'new@example.com');
    assert.equal(intentRepository.saved.length, 1);
    assert.equal(intentRepository.saved[0].field, 'email');
    assert.equal(intentRepository.saved[0].targetValue, 'new@example.com');
    assert.equal(scheduled, 1);
    // 验证请求标记已消费
    assert.equal(verificationRepository.saved[0].consumedAt !== null, true);
  });

  it('REV：令牌不匹配 → 拒绝，业务与验证请求均不变', async () => {
    const repository = inMemoryProfileRepository();
    repository.seed(pendingEmailProfile());
    const verificationRepository = inMemoryVerificationRepository();
    const { verification } = EmailVerification.issue(
      'v-1',
      'user-1',
      'new@example.com',
      1,
      new Date(now.getTime() - 60_000),
    );
    verificationRepository.seed(verification.toSnapshot());
    const useCase = createUseCase({ repository, verificationRepository });

    await assert.rejects(
      () =>
        useCase.consumeVerificationToken({
          verificationId: 'v-1',
          token: '0'.repeat(64),
          now,
          actor: 'user-1',
          traceId: null,
        }),
      (err: any) => err.code === IdentityErrorCode.PRECONDITION_FAILED,
    );
    assert.equal(repository.saved.length, 0);
    assert.equal(verificationRepository.saved.length, 0); // 验证请求未被改写
  });

  it('REV：待验证邮箱已变化（旧链接目标 ≠ 当前 pending）→ 拒绝，不回改 verifiedEmail', async () => {
    const repository = inMemoryProfileRepository();
    repository.seed(pendingEmailProfile()); // pendingEmail = new@example.com
    const verificationRepository = inMemoryVerificationRepository();
    // 旧链接：签发给另一个目标邮箱（例如更早一次请求的 another@example.com）
    const { verification, token } = EmailVerification.issue(
      'v-1',
      'user-1',
      'another@example.com',
      1,
      new Date(now.getTime() - 60_000),
    );
    verificationRepository.seed(verification.toSnapshot());
    const useCase = createUseCase({ repository, verificationRepository });

    await assert.rejects(
      () =>
        useCase.consumeVerificationToken({
          verificationId: 'v-1',
          token,
          now,
          actor: 'user-1',
          traceId: null,
        }),
      (err: any) => err.code === IdentityErrorCode.PRECONDITION_FAILED,
    );
    assert.equal(repository.saved.length, 0); // 资料未变，verifiedEmail 不回改
    assert.equal(verificationRepository.saved.length, 0); // 验证请求未被消费改写
  });

  it('REV：链接过期（超过 24 小时）→ 拒绝，保持待验证', async () => {
    const repository = inMemoryProfileRepository();
    repository.seed(pendingEmailProfile());
    const verificationRepository = inMemoryVerificationRepository();
    const { verification, token } = EmailVerification.issue(
      'v-1',
      'user-1',
      'new@example.com',
      1,
      new Date(now.getTime() - 25 * 60 * 60 * 1000),
    );
    verificationRepository.seed(verification.toSnapshot());
    const useCase = createUseCase({ repository, verificationRepository });

    await assert.rejects(
      () =>
        useCase.consumeVerificationToken({
          verificationId: 'v-1',
          token,
          now,
          actor: 'user-1',
          traceId: null,
        }),
      (err: any) => err.code === IdentityErrorCode.PRECONDITION_FAILED,
    );
    assert.equal(repository.saved.length, 0);
  });
});
