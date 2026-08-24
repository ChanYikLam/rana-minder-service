/**
 * 文件模块 OBJECT_STORE_PORT 提供者配置单测（4.2 收口；env 注入验证配置分支）。
 *
 * 评审 info 加固：验证 createObjectStorePort 各分支——
 * 1) 配置 STORAGE_ENDPOINT（文档键）→ 返回 S3ObjectStoreAdapter（真实收口）；
 * 2) 旧 S3_ENDPOINT 别名回退（兼容）；
 * 3) 生产/非开发未配置 endpoint → 抛错 fail-closed（禁止内存假持久化）；
 * 4) test/development 未配置 → 返回 InMemoryObjectStore（开发占位）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createObjectStorePort } from './module';
import { S3ObjectStoreAdapter } from '../../adapters/storage/s3-object-store.adapter';
import { InMemoryObjectStore } from './infrastructure/object-store-port';

const STORAGE_ENV: NodeJS.ProcessEnv = {
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_REGION: 'us-east-1',
  STORAGE_ACCESS_KEY: 'ak',
  STORAGE_SECRET_KEY: 'sk',
  STORAGE_BUCKET_QUARANTINE: 'q',
  STORAGE_BUCKET_PRIMARY: 'p',
  STORAGE_BUCKET_DERIVED: 'd',
};

describe('createObjectStorePort（OBJECT_STORE_PORT 提供者，4.2 收口）', () => {
  it('配置 STORAGE_ENDPOINT（文档键）→ 返回 S3 适配器（真实收口）', () => {
    const port = createObjectStorePort(STORAGE_ENV);
    assert.ok(port instanceof S3ObjectStoreAdapter);
  });

  it('旧 S3_ENDPOINT 别名回退（兼容）→ 返回 S3 适配器', () => {
    const port = createObjectStorePort({
      ...STORAGE_ENV,
      STORAGE_ENDPOINT: undefined,
      S3_ENDPOINT: 'http://s3.example.com',
      S3_REGION: 'cn-north-1',
      S3_ACCESS_KEY_ID: 'ak2',
      S3_SECRET_ACCESS_KEY: 'sk2',
      S3_BUCKET_QUARANTINE: 'q2',
      S3_BUCKET_OBJECT: 'p2',
      S3_BUCKET_DERIVED: 'd2',
    });
    assert.ok(port instanceof S3ObjectStoreAdapter);
  });

  it('生产/非开发未配置 endpoint → 抛错 fail-closed（禁止内存假持久化）', () => {
    assert.throws(
      () => createObjectStorePort({ NODE_ENV: 'production' }),
      /生产环境必须配置 STORAGE_ENDPOINT.*fail-closed/,
    );
  });

  it('test 环境未配置 → 返回 InMemoryObjectStore（开发占位）', () => {
    const port = createObjectStorePort({ NODE_ENV: 'test' });
    assert.ok(port instanceof InMemoryObjectStore);
  });

  it('development 默认未配置 → 返回 InMemoryObjectStore（本地开发）', () => {
    const port = createObjectStorePort({});
    assert.ok(port instanceof InMemoryObjectStore);
  });
});
