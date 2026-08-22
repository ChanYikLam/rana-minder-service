/**
 * FormModule 装配验收测试（B4 form 收口）：
 *
 * 验证 B2/B3 落地后 form 模块的 DI 图正确解析：
 * - 设计/填写权限已接线 OrgBacked*（不再是 NotWired 桩）
 * - 会话 provider 经 adaptSessionProvider 转发到 identity AUTH_SESSION_PROVIDER
 * - 守卫在无会话时仍 401 fail-closed
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { FormModule } from './form.module';
import {
  FORM_DESIGN_PERMISSION,
  FORM_FILL_PERMISSION,
  FORM_AUTH_SESSION_PROVIDER,
} from './tokens';
import { FormAuthGuard } from './interfaces/nest/form-auth.guard';
import { OrgBackedFormDesignPermission } from './infrastructure/org-form-design-permission';
import { OrgBackedFormFillPermission } from './infrastructure/org-form-fill-permission';
import { RANA_MINDER_CONFIG, type RanaMinderConfig, ConfigurationModule } from '../../config';

const stubConfig: RanaMinderConfig = {
  server: { port: 3000, host: '0.0.0.0', gracefulShutdownTimeoutMs: 10000 },
  database: {
    host: 'localhost', port: 5432, name: 'ranaminder', user: 'ranaminder',
    schema: 'app', ssl: false, passwordRef: '',
  },
  casdoor: {
    endpoint: '', clientId: '', organization: '', redirectUri: '', clientSecretRef: '',
  },
  storage: {
    endpoint: '', region: 'us-east-1', accessKeyRef: '', secretKeyRef: '',
    buckets: { quarantine: 'q', primary: 'p', derived: 'd' },
  },
  mail: { host: '', port: 25, fromAddress: '' },
  fileCheck: { endpoint: '' },
  notify: { endpoint: '' },
  backup: { endpoint: '' },
  observability: { logLevel: 'info', traceSamplingRate: 1 },
  job: { schedulerIntervalMs: 1000, defaultLeaseMs: 60000, maxAttempts: 5 },
};

describe('FormModule 装配验收（B4 - 权限/会话接线）', () => {
  function createModule() {
    return Test.createTestingModule({
      imports: [FormModule, ConfigurationModule.forRoot()],
    })
      .overrideProvider(RANA_MINDER_CONFIG)
      .useValue(stubConfig)
      .compile();
  }

  it('设计权限已接线组织授权（OrgBackedFormDesignPermission，不再是 NotWired）', async () => {
    const module = await createModule();
    const provider = module.get(FORM_DESIGN_PERMISSION);
    assert.ok(provider instanceof OrgBackedFormDesignPermission);
  });

  it('填写权限已接线组织授权（OrgBackedFormFillPermission）', async () => {
    const module = await createModule();
    const provider = module.get(FORM_FILL_PERMISSION);
    assert.ok(provider instanceof OrgBackedFormFillPermission);
  });

  it('会话 provider 经 adaptSessionProvider 转发到 identity', async () => {
    const module = await createModule();
    const provider = module.get(FORM_AUTH_SESSION_PROVIDER);
    assert.ok(provider);
    assert.equal(typeof provider.resolveSession, 'function');
  });

  it('守卫在无会话时仍 401（casdoor.endpoint 为空 → identity 退回 RejectAll）', async () => {
    const module = await createModule();
    const guard = module.get(FormAuthGuard);
    await assert.rejects(
      guard.canActivate({
        switchToHttp: () => ({ getRequest: () => ({}) }),
      } as never),
      (error: unknown) => error instanceof HttpException && error.getStatus() === 401,
    );
  });
});