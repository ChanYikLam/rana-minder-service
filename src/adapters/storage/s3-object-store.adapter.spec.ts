/**
 * S3 兼容对象存储适配器单测（4.2 收口；fake fetch 验证签名/路径/语义）。
 *
 * - SigV4：请求头含 Authorization（AWS4-HMAC-SHA256 Credential/SignedHeaders/
 *   Signature）、x-amz-date、x-amz-content-sha256；Host 为端点主机；
 * - 操作：putQuarantine PUT /{quarantine}/{key}；promoteToObject 服务端复制
 *   （x-amz-copy-source + if-none-match）+ 摘要核验 + 源删除；deleteAndVerify
 *   DELETE + HEAD 回读 404；未配置 fail-closed（构造抛错）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { S3ObjectStoreAdapter, s3KeyOf } from './s3-object-store.adapter';
import type { ObjectLocation } from '../../modules/file/domain/models/file-model';

const CONFIG = {
  endpoint: 'https://s3.example.com',
  region: 'cn-north-1',
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
  buckets: {
    QUARANTINE: 'bucket-quarantine',
    OBJECT: 'bucket-object',
    DERIVED: 'bucket-derived',
  },
};

const LOCATION: ObjectLocation = {
  bucketRole: 'QUARANTINE',
  keyVersion: 'v1',
  randomKey: 'rand-1',
  objectKind: 'UPLOAD',
  actualSize: 3,
  sha256: 'abc',
  storageToken: 'tok',
};

type FakeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function makeAdapter(responder: (input: string | URL, init?: RequestInit) => Promise<Response>): {
  adapter: S3ObjectStoreAdapter;
  calls: Array<{ input: string; init: RequestInit }>;
} {
  const calls: Array<{ input: string; init: RequestInit }> = [];
  const fetchFn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push({ input: url, init });
    return responder(input, init);
  }) as FakeFetch;
  return { adapter: new S3ObjectStoreAdapter({ ...CONFIG, fetchFn }), calls };
}

describe('S3ObjectStoreAdapter（4.2 收口）', () => {
  it('构造：缺少端点/凭据 → 抛错 fail-closed（禁止静默假删除）', () => {
    assert.throws(
      () =>
        new S3ObjectStoreAdapter({
          ...CONFIG,
          accessKeyId: '',
          secretAccessKey: '',
        }),
      /fail-closed/,
    );
  });

  it('putQuarantine：PUT 到隔离区 bucket，请求含 SigV4 签名头', async () => {
    const { adapter, calls } = makeAdapter(async () => new Response(null, { status: 200 }));
    const result = await adapter.putQuarantine(LOCATION, new Uint8Array([1, 2, 3]));
    assert.equal(result.ok, true);
    const call = calls[0];
    assert.ok(call.input.includes('/bucket-quarantine/v1/UPLOAD/rand-1'));
    assert.equal(call.init.method, 'PUT');
    const headers = call.init.headers as Record<string, string>;
    assert.ok(headers.Authorization.startsWith('AWS4-HMAC-SHA256 Credential=AKID/'));
    assert.ok(headers.Authorization.includes('SignedHeaders='));
    assert.ok(headers.Authorization.includes('Signature='));
    assert.ok(headers['x-amz-date']);
    assert.ok(headers['x-amz-content-sha256']);
  });

  it('read：404 → null；200 → 字节', async () => {
    const { adapter } = makeAdapter(
      async () => new Response(new Uint8Array([9, 8, 7]), { status: 200 }),
    );
    const bytes = await adapter.read({ ...LOCATION, bucketRole: 'OBJECT', objectKind: 'OBJECT' });
    assert.deepEqual(Array.from(bytes!), [9, 8, 7]);
  });

  it('read：404 → null', async () => {
    const { adapter } = makeAdapter(async () => new Response(null, { status: 404 }));
    assert.equal(
      await adapter.read({ ...LOCATION, bucketRole: 'OBJECT', objectKind: 'OBJECT' }),
      null,
    );
  });

  it('promoteToObject：复制 + 摘要核验 + 源删除（copy-then-delete）', async () => {
    const target: ObjectLocation = {
      bucketRole: 'OBJECT',
      keyVersion: 'v1',
      randomKey: 'obj-1',
      objectKind: 'OBJECT',
      actualSize: 3,
      sha256: 'abc',
      storageToken: 'tok2',
    };
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const fetchFn = (async (input: string | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : String(input);
      calls.push({ input: url, init });
      if (init.method === 'PUT' && url.includes('bucket-object')) {
        // copy 成功
        return new Response(null, { status: 200 });
      }
      if (init.method === 'GET') {
        // 回读核验：返回与 expectedSha256 匹配的字节
        const bytes = new Uint8Array([1, 2, 3]);
        return new Response(bytes, { status: 200 });
      }
      if (init.method === 'DELETE') {
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    }) as FakeFetch;
    const adapter = new S3ObjectStoreAdapter({ ...CONFIG, fetchFn });
    // expectedSha256 取回读字节 [1,2,3] 的实际摘要（字节哈希 ≠ 字符串哈希）
    const expected = createHash('sha256')
      .update(new Uint8Array([1, 2, 3]))
      .digest('hex');
    const result = await adapter.promoteToObject(LOCATION, target, expected);
    assert.equal(result.ok, true);
    // copy 请求带 x-amz-copy-source（源在隔离区）与 if-none-match（create-only）
    const copy = calls.find((c) => c.init.method === 'PUT' && c.input.includes('bucket-object'))!;
    const headers = copy.init.headers as Record<string, string>;
    assert.ok(headers['x-amz-copy-source'].includes('/bucket-quarantine/v1/UPLOAD/rand-1'));
    assert.equal(headers['x-amz-copy-source-if-none-match'], '*');
    // 源删除发生
    assert.ok(calls.some((c) => c.init.method === 'DELETE'));
  });

  it('promoteToObject：摘要不匹配 → 失败（不伪装成功）', async () => {
    const target: ObjectLocation = {
      bucketRole: 'OBJECT',
      keyVersion: 'v1',
      randomKey: 'obj-2',
      objectKind: 'OBJECT',
      actualSize: 3,
      sha256: 'x',
      storageToken: 't',
    };
    const fetchFn = (async (input: string | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : String(input);
      if (init.method === 'PUT') return new Response(null, { status: 200 });
      if (init.method === 'GET') {
        // 返回与 expectedSha256 不匹配的字节 → 摘要核验失败
        return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
      }
      void url;
      return new Response(null, { status: 404 });
    }) as FakeFetch;
    const adapter = new S3ObjectStoreAdapter({ ...CONFIG, fetchFn });
    const result = await adapter.promoteToObject(
      LOCATION,
      target,
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    assert.equal(result.ok, false);
    assert.match(result.reason!, /摘要不匹配/);
  });

  it('deleteAndVerify：DELETE + HEAD 回读 404 → 成功（幂等）', async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const fetchFn = (async (input: string | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : String(input);
      calls.push({ input: url, init });
      if (init.method === 'DELETE') return new Response(null, { status: 200 });
      if (init.method === 'HEAD') return new Response(null, { status: 404 }); // 回读确认已删除
      void url;
      return new Response(null, { status: 404 });
    }) as FakeFetch;
    const adapter = new S3ObjectStoreAdapter({ ...CONFIG, fetchFn });
    const result = await adapter.deleteAndVerify({
      ...LOCATION,
      bucketRole: 'OBJECT',
      objectKind: 'OBJECT',
    });
    assert.equal(result.ok, true);
    assert.ok(calls.some((c) => c.init.method === 'DELETE'));
    assert.ok(calls.some((c) => c.init.method === 'HEAD'));
  });

  it('deleteAndVerify：HEAD 200（仍存在）→ 失败（回读核验不伪装成功）', async () => {
    const fetchFn = (async (input: string | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : String(input);
      void url;
      if (init.method === 'DELETE') return new Response(null, { status: 200 });
      return new Response(null, { status: 200 }); // HEAD 仍存在
    }) as FakeFetch;
    const adapter = new S3ObjectStoreAdapter({ ...CONFIG, fetchFn });
    const result = await adapter.deleteAndVerify({
      ...LOCATION,
      bucketRole: 'OBJECT',
      objectKind: 'OBJECT',
    });
    assert.equal(result.ok, false);
    assert.match(result.reason!, /仍存在/);
  });

  it('s3KeyOf：键格式 ${keyVersion}/${objectKind}/${randomKey}（不编码业务身份）', () => {
    assert.equal(s3KeyOf(LOCATION), 'v1/UPLOAD/rand-1');
  });
});
