/**
 * IdentityModule 装配冒烟测试：完整 DI 图可解析，Nest HTTP 控制器/守卫可实例化。
 *
 * 数据库/Casdoor/邮件为未连接桩（失败关闭）：验证失败路径（401 守卫、UoW
 * 无事务/事务不可用拒绝）而非伪造成功。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { IdentityModule } from './identity.module';
import { ConfigurationModule } from '../../config';
import {
  AUTH_SESSION_PROVIDER,
  APPLY_PROFILE_SYNC_STEP_USE_CASE,
  GET_MY_PROFILE_QUERY,
  PROFILES_CONTROLLER,
  SUBMIT_NAME_CORRECTION_USE_CASE,
  REVIEW_NAME_CORRECTION_USE_CASE,
  APPLY_NAME_CORRECTION_WRITE_USE_CASE,
  NAME_CORRECTION_CONTROLLER,
} from './tokens';
import { AuthGuard } from './interfaces/nest/auth.guard';
import { ProfilesNestController } from './interfaces/nest/profiles.nest.controller';
import { AccountAccessNestController } from './interfaces/nest/account-access.nest.controller';
import { NameCorrectionNestController } from './interfaces/nest/name-correction.nest.controller';
import { IdentityUnitOfWork } from './infrastructure/unit-of-work';
import type { AuthSessionProvider } from './interfaces/nest/auth-session';
import { DbUnavailableError } from '../../adapters/db/not-wired-db.adapter';
import { RANA_MINDER_CONFIG, type RanaMinderConfig, ConfigurationModule } from '../../config';

describe('IdentityModule 装配（DI 图 + 失败关闭）', () => {
  /**
   * AdaptersModule 的真实外部适配器工厂注入 RANA_MINDER_CONFIG（仅 ADAPTERS_*_REAL=1
   * 时消费）。本冒烟测试保持默认 fail-closed 桩，配置不会被实际读取，故注入一份
   * 最小占位配置以满足 Nest DI 解析即可（生产由 @Global ConfigurationModule 提供）。
   */
  const stubConfig: RanaMinderConfig = {
    server: { port: 3000, host: '0.0.0.0', gracefulShutdownTimeoutMs: 10000 },
    database: {
      host: 'localhost',
      port: 5432,
      name: 'ranaminder',
      user: 'ranaminder',
      schema: 'app',
      ssl: false,
      passwordRef: '',
    },
    casdoor: {
      endpoint: '',
      clientId: '',
      organization: '',
      redirectUri: '',
      clientSecretRef: '',
    },
    storage: {
      endpoint: '',
      region: 'us-east-1',
      accessKeyRef: '',
      secretKeyRef: '',
      buckets: {
        quarantine: 'ranaminder-quarantine',
        primary: 'ranaminder-primary',
        derived: 'ranaminder-derived',
      },
    },
    mail: { host: '', port: 25, fromAddress: '' },
    fileCheck: { endpoint: '' },
    notify: { endpoint: '' },
    backup: { endpoint: '' },
    observability: { logLevel: 'info', traceSamplingRate: 1 },
    job: { schedulerIntervalMs: 1000, defaultLeaseMs: 60000, maxAttempts: 5 },
  };

  function createModule() {
    return Test.createTestingModule({
      imports: [IdentityModule, ConfigurationModule.forRoot()],
    })
      .overrideProvider(RANA_MINDER_CONFIG)
      .useValue(stubConfig)
      .compile();
  }

  it('完整模块可解析：用例/查询/控制器/守卫', async () => {
    const module = await createModule();
    assert.ok(module.get(APPLY_PROFILE_SYNC_STEP_USE_CASE));
    assert.ok(module.get(GET_MY_PROFILE_QUERY));
    assert.ok(module.get(PROFILES_CONTROLLER));
    assert.ok(module.get(AuthGuard));
    assert.ok(module.get(ProfilesNestController));
    assert.ok(module.get(AccountAccessNestController));
    assert.ok(module.get(NameCorrectionNestController));
    assert.ok(module.get(SUBMIT_NAME_CORRECTION_USE_CASE));
    assert.ok(module.get(REVIEW_NAME_CORRECTION_USE_CASE));
    assert.ok(module.get(APPLY_NAME_CORRECTION_WRITE_USE_CASE));
    assert.ok(module.get(NAME_CORRECTION_CONTROLLER));
  });

  it('会话认证链路接入前：受保护端点统一 401（RejectAll 失败关闭）', async () => {
    const module = await createModule();
    const provider = module.get<AuthSessionProvider>(AUTH_SESSION_PROVIDER);
    assert.equal(await provider.resolveSession({} as never), null);
    const guard = module.get(AuthGuard);
    await assert.rejects(
      guard.canActivate({
        switchToHttp: () => ({ getRequest: () => ({}), getResponse: () => ({}) }),
      } as never),
      (error: unknown) => error instanceof HttpException && error.getStatus() === 401,
    );
  });

  it('数据库桩未连接：UoW 事务边界失败关闭（不静默成功）', async () => {
    const module = await createModule();
    const uow = module.get(IdentityUnitOfWork);
    await assert.rejects(
      uow.run({ kind: 'single', subjectId: 'user-1' }, async () => 'never'),
      DbUnavailableError,
    );
  });
});
