/**
 * RecruitmentModule 装配冒烟测试：完整 DI 图可解析，Nest HTTP 控制器/守卫可实例化。
 *
 * 数据库为未连接桩（失败关闭）：验证失败路径（401 守卫、UoW 无事务拒绝）
 * 而非伪造成功。与 identity.module.spec.ts 同一口径。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { RecruitmentModule } from './recruitment.module';
import {
  RECRUITMENT_AUTH_SESSION_PROVIDER,
  RECRUITMENT_CONTROLLER,
  CREATE_RECRUITMENT_ACTIVITY_USE_CASE,
  PUBLISH_RECRUITMENT_ACTIVITY_USE_CASE,
  OPEN_APPLICATION_CHANNEL_USE_CASE,
  SUBMIT_APPLICATION_USE_CASE,
  RECORD_DEPARTMENT_DECISION_USE_CASE,
  INTERVIEW_WORKFLOW_USE_CASE,
  SEND_ADMISSION_INVITATION_USE_CASE,
  ACCEPT_ADMISSION_INVITATION_USE_CASE,
  LIST_ACTIVITIES_QUERY,
  LIST_APPLICATIONS_QUERY,
  LIST_INTERVIEWS_QUERY,
} from './tokens';
import { RecruitmentAuthGuard } from './interfaces/nest/recruitment-auth.guard';
import { OrgRecruitmentNestController } from './interfaces/nest/org-recruitment.nest.controller';
import { ApplicantRecruitmentNestController } from './interfaces/nest/applicant-recruitment.nest.controller';
import { RecruitmentUnitOfWork } from './infrastructure/unit-of-work';
import type { RecruitmentAuthSessionProvider } from './interfaces/nest/recruitment-auth-session';
import { DbUnavailableError } from '../../adapters/db/not-wired-db.adapter';
import { RANA_MINDER_CONFIG, type RanaMinderConfig, ConfigurationModule } from '../../config';

describe('RecruitmentModule 装配（DI 图 + 失败关闭）', () => {
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
    org: { superAdminUserIds: [] },
    job: { schedulerIntervalMs: 1000, defaultLeaseMs: 60000, maxAttempts: 5 },
  };

  function createModule() {
    return Test.createTestingModule({
      imports: [RecruitmentModule, ConfigurationModule.forRoot()],
    })
      .overrideProvider(RANA_MINDER_CONFIG)
      .useValue(stubConfig)
      .compile();
  }

  it('完整模块可解析：用例/查询/控制器/守卫/工作单元', async () => {
    const module = await createModule();
    assert.ok(module.get(CREATE_RECRUITMENT_ACTIVITY_USE_CASE));
    assert.ok(module.get(PUBLISH_RECRUITMENT_ACTIVITY_USE_CASE));
    assert.ok(module.get(OPEN_APPLICATION_CHANNEL_USE_CASE));
    assert.ok(module.get(SUBMIT_APPLICATION_USE_CASE));
    assert.ok(module.get(RECORD_DEPARTMENT_DECISION_USE_CASE));
    assert.ok(module.get(INTERVIEW_WORKFLOW_USE_CASE));
    assert.ok(module.get(SEND_ADMISSION_INVITATION_USE_CASE));
    assert.ok(module.get(ACCEPT_ADMISSION_INVITATION_USE_CASE));
    assert.ok(module.get(LIST_ACTIVITIES_QUERY));
    assert.ok(module.get(LIST_APPLICATIONS_QUERY));
    assert.ok(module.get(LIST_INTERVIEWS_QUERY));
    assert.ok(module.get(RECRUITMENT_CONTROLLER));
    assert.ok(module.get(OrgRecruitmentNestController));
    assert.ok(module.get(ApplicantRecruitmentNestController));
    assert.ok(module.get(RecruitmentAuthGuard));
    assert.ok(module.get(RecruitmentUnitOfWork));
  });

  it('会话认证链路接入前：受保护端点统一 401（RejectAll 失败关闭）', async () => {
    const module = await createModule();
    const provider = module.get<RecruitmentAuthSessionProvider>(RECRUITMENT_AUTH_SESSION_PROVIDER);
    assert.equal(await provider.resolveSession({} as never), null);
    const guard = module.get(RecruitmentAuthGuard);
    await assert.rejects(
      guard.canActivate({
        switchToHttp: () => ({ getRequest: () => ({}) }),
      } as never),
      (error: unknown) => error instanceof HttpException && error.getStatus() === 401,
    );
  });

  it('数据库桩未连接：UoW 事务边界失败关闭（不静默成功）', async () => {
    const module = await createModule();
    const uow = module.get(RecruitmentUnitOfWork);
    await assert.rejects(
      uow.run({ clubId: 'club-1' } as never, async () => 'never'),
      DbUnavailableError,
    );
  });
});
