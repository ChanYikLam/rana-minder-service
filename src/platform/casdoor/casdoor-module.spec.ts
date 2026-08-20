import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Test } from '@nestjs/testing';

import { CasdoorModule } from './module';
import {
  CasdoorEventService,
  CASDOOR_WEBHOOK_ENABLED,
  CASDOOR_WEBHOOK_MAX_SEEN_ENTRIES,
  CASDOOR_WEBHOOK_STATIC_SECRET,
} from './application/casdoor-event.service';
import { CasdoorReadService } from './application/casdoor-read.service';
import { CasdoorWriteService } from './application/casdoor-write.service';
import { CasdoorReconcileService } from './application/casdoor-reconcile.service';
import {
  CASDOOR_CLOCK,
  CASDOOR_MAPPING_STORE,
  CASDOOR_READ_PORT,
  CASDOOR_WRITE_PORT,
} from './contracts/ports';

describe('CasdoorModule', () => {
  it('全部 provider 可被 Nest DI 解析，应用启动不失败', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CasdoorModule] }).compile();
    assert.ok(moduleRef.get(CasdoorEventService) instanceof CasdoorEventService);
    assert.ok(moduleRef.get(CasdoorReadService) instanceof CasdoorReadService);
    assert.ok(moduleRef.get(CasdoorWriteService) instanceof CasdoorWriteService);
    assert.ok(moduleRef.get(CasdoorReconcileService) instanceof CasdoorReconcileService);
    assert.ok(moduleRef.get(CASDOOR_READ_PORT));
    assert.ok(moduleRef.get(CASDOOR_WRITE_PORT));
    assert.ok(moduleRef.get(CASDOOR_MAPPING_STORE));
    assert.ok(moduleRef.get(CASDOOR_CLOCK));
    // Webhook 默认关闭且未配置秘密（CAS-EVT-001/002）
    assert.equal(moduleRef.get(CASDOOR_WEBHOOK_ENABLED), false);
    assert.equal(moduleRef.get(CASDOOR_WEBHOOK_STATIC_SECRET), null);
    assert.equal(moduleRef.get(CASDOOR_WEBHOOK_MAX_SEEN_ENTRIES), 10_000);
    await moduleRef.close();
  });
});
