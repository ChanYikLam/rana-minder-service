/**
 * 平台适配接线（T2）单元测试。
 *
 * 覆盖：
 * - `realDbEnabled`：默认 fail-closed（未开启时返回 false），显式 `ADAPTERS_DB_REAL=1`
 *   才开启真实 PostgreSQL 适配；
 * - `AdaptersModule` 在未开启时 DB_ADAPTER 解析为 NotWiredDbAdapter（桩），
 *   开启时解析为 PostgresDbAdapter（真实实现）。
 *
 * 注：真实连接（BEGIN/COMMIT/SET LOCAL）由 test/integration 对真实 PG 验证，
 * 单元测试不连接外部系统。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';

import { AdaptersModule, realDbEnabled } from './adapters.module';
import { DB_ADAPTER } from './tokens';
import { NotWiredDbAdapter } from './db/not-wired-db.adapter';
import { PostgresDbAdapter } from './db/postgres-db-adapter';
import { ConfigurationModule, RANA_MINDER_CONFIG } from '../config';

describe('realDbEnabled（真实 DB 适配开关）', () => {
  it('默认关闭（fail-closed），未显式开启时不启用真实适配', () => {
    assert.equal(realDbEnabled({}), false);
    assert.equal(realDbEnabled({ ADAPTERS_DB_REAL: '0' }), false);
    assert.equal(realDbEnabled({ DATABASE_HOST: 'localhost' }), false);
  });

  it('仅当 ADAPTERS_DB_REAL=1 时启用真实适配', () => {
    assert.equal(realDbEnabled({ ADAPTERS_DB_REAL: '1' }), true);
  });
});

describe('AdaptersModule 接线（DB_ADAPTER 选择）', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = process.env;
    // 补齐配置加载器必填项（与 .env.example 对齐）；单元测试不连接真实外部系统。
    process.env = {
      ...savedEnv,
      NODE_ENV: 'test',
      DATABASE_PASSWORD: 'test-password',
      CASDOOR_CLIENT_SECRET: 'test-secret',
      CASDOOR_CLIENT_ID: 'test-client',
      CASDOOR_ORGANIZATION: 'test-org',
      CASDOOR_ENDPOINT: 'https://casdoor.example.edu',
      CASDOOR_REDIRECT_URI: 'http://localhost:3000/api/auth/callback',
      STORAGE_ENDPOINT: 'http://localhost:9000',
      STORAGE_ACCESS_KEY: 'test-access',
      STORAGE_SECRET_KEY: 'test-secret-key',
    };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('未开启开关：DB_ADAPTER 解析为 NotWiredDbAdapter 桩', async () => {
    delete process.env.ADAPTERS_DB_REAL;
    const module = await Test.createTestingModule({
      imports: [ConfigurationModule.forRoot(), AdaptersModule],
    }).compile();
    const db = module.get(DB_ADAPTER);
    assert.ok(db instanceof NotWiredDbAdapter);
    await module.close();
  });

  it('开启开关：DB_ADAPTER 解析为 PostgresDbAdapter 真实实现', async () => {
    process.env.ADAPTERS_DB_REAL = '1';
    const module = await Test.createTestingModule({
      imports: [ConfigurationModule.forRoot(), AdaptersModule],
    }).compile();
    const db = module.get(DB_ADAPTER);
    assert.ok(db instanceof PostgresDbAdapter);
    // 关闭时释放连接池
    await module.close();
  });

  it('配置 token 可注入 RANA_MINDER_CONFIG（接线前提）', async () => {
    const module = await Test.createTestingModule({
      imports: [ConfigurationModule.forRoot(), AdaptersModule],
    }).compile();
    const config = module.get(RANA_MINDER_CONFIG);
    assert.ok(config);
    assert.equal(config.database.schema, 'app');
    await module.close();
  });
});
