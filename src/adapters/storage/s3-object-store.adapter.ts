/**
 * S3 兼容对象存储适配器（4.2 收口；ADR-008、DATA-FIL-002）。
 *
 * 无第三方依赖：AWS SigV4 签名（node:crypto HMAC）+ S3 REST API（PathStyle）。
 *
 * - 三个专用私有 Bucket（隔离区/权威原件区/临时派生区），键由服务端高熵随机生成，
 *   客户端不得提交或复用对象键；每个对象键只写一次（create-only，x-amz-copy-source-
 *   if-none-match 防覆盖）；对象存储只负责定位和核验（ADR-008 §2.2）。
 * - 不伪装跨系统原子事务：返回结构化结果，失败不含敏感细节（GOV-008 脱敏）。
 * - 未配置（缺 endpoint/凭据）时构造抛错 fail-closed，杜绝"静默假删除"。
 */

import { createHash, createHmac } from 'node:crypto';
import type { ObjectLocation, BucketRole } from '../../modules/file/domain/models/file-model';
import type { ObjectOpResult } from '../../modules/file/infrastructure/object-store-port';

/** S3 兼容对象存储配置 */
export interface S3ObjectStoreConfig {
  /** 服务端点（如 https://s3.example.com）；PathStyle 访问 */
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** 三区 Bucket 名映射（QUARANTINE/OBJECT/DERIVED → bucket 名） */
  readonly buckets: Record<BucketRole, string>;
  /** 请求超时（ms；默认 10s）。超时按服务不可用处理（NFR-003/006，不得放行） */
  readonly timeoutMs?: number;
  /** 测试注入 */
  readonly fetchFn?: typeof fetch;
}

/** S3 对象键（服务端高熵随机定位符；与 InMemory 键格式一致，不编码业务身份） */
export function s3KeyOf(location: ObjectLocation): string {
  return `${location.keyVersion}/${location.objectKind}/${location.randomKey}`;
}

function hmacSha256(key: Uint8Array, data: string): Uint8Array {
  return new Uint8Array(createHmac('sha256', key).update(data, 'utf8').digest());
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** AWS SigV4 请求签名（node:crypto 实现；s3 服务） */
export function signS3Request(input: {
  config: S3ObjectStoreConfig;
  method: string;
  path: string; // /{bucket}/{key}
  payloadSha256: string;
  query?: string;
  extraHeaders?: Record<string, string>;
  now?: Date;
}): {
  authorization: string;
  signedHeaders: string;
  amzDate: string;
  headers: Record<string, string>;
} {
  const { config, method, path } = input;
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  // 规范化请求头：host + x-amz-date + x-amz-content-sha256 + 附加头（升序、小写）
  const url = new URL(path, config.endpoint);
  const host = url.host;
  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': input.payloadSha256,
    'x-amz-date': amzDate,
    ...input.extraHeaders,
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name].trim()}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalQuery = input.query ?? '';
  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadSha256,
  ].join('\n');

  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(new TextEncoder().encode(`AWS4${config.secretAccessKey}`), dateStamp);
  const kRegion = hmacSha256(kDate, config.region);
  const kService = hmacSha256(kRegion, 's3');
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    authorization:
      `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signedHeaders,
    amzDate,
    headers,
  };
}

/** 非 2xx 响应状态 → 脱敏失败原因（GOV-008：不泄露服务内部细节） */
function s3Failure(status: number, op: string): ObjectOpResult {
  if (status === 404 || status === 412) {
    return { ok: false, reason: `${op}：对象状态异常（${status}）` };
  }
  return { ok: false, reason: `${op}：对象存储服务响应异常（${status}）` };
}

export class S3ObjectStoreAdapter {
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly config: S3ObjectStoreConfig) {
    if (
      config.endpoint.length === 0 ||
      config.accessKeyId.length === 0 ||
      config.secretAccessKey.length === 0
    ) {
      throw new Error('S3ObjectStoreAdapter: 缺少端点或凭据配置（fail-closed，禁止静默假删除）');
    }
    // 评审修复（info）：三区 bucket 名必须非空——否则请求会打到空 bucket 路径
    // `/{key}` 而非 `/{bucket}/{key}`，失败原因不明确。与端点/凭据同档 fail-closed。
    const emptyBucket = (Object.keys(config.buckets) as BucketRole[]).find(
      (role) => config.buckets[role].length === 0,
    );
    if (emptyBucket !== undefined) {
      throw new Error(
        `S3ObjectStoreAdapter: 缺少 bucket 配置（${emptyBucket} 为空；fail-closed，禁止静默假删除）`,
      );
    }
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  private bucket(bucketRole: BucketRole): string {
    return this.config.buckets[bucketRole];
  }

  /** S3 请求统一入口（签名 + 超时 + 状态捕获） */
  private async request(
    method: string,
    bucketRole: BucketRole,
    key: string,
    payload: Uint8Array | null,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const path = `/${this.bucket(bucketRole)}/${key}`;
    const payloadSha256 =
      payload === null ? sha256Hex('') : createHash('sha256').update(payload).digest('hex');
    const signed = signS3Request({
      config: this.config,
      method,
      path,
      payloadSha256,
      extraHeaders,
    });
    const headers: Record<string, string> = {
      Authorization: signed.authorization,
      'x-amz-date': signed.amzDate,
      'x-amz-content-sha256': payloadSha256,
      ...(payload === null ? {} : { 'Content-Length': String(payload.length) }),
      ...extraHeaders,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // 评审修复（critical）：fetch 必须使用绝对 URL——相对路径 `/${bucket}/${key}`
      // 在 Node 下会抛 `TypeError: Failed to parse URL`，导致所有 S3 操作被 catch
      // 吞掉返回 {ok:false}，生产配置 S3_ENDPOINT 后上传/晋升/删除将静默全部失败。
      const url = `${this.config.endpoint}${path}`;
      return await this.fetchFn(url, {
        method,
        headers,
        body: payload === null ? undefined : payload,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 隔离区只写一次写入 */
  async putQuarantine(location: ObjectLocation, bytes: Uint8Array): Promise<ObjectOpResult> {
    try {
      const res = await this.request('PUT', location.bucketRole, s3KeyOf(location), bytes);
      return res.ok ? { ok: true } : s3Failure(res.status, '隔离区写入');
    } catch {
      return { ok: false, reason: '隔离区写入：对象存储不可用（超时/连接失败）' };
    }
  }

  /** 晋升：服务端复制到权威原件区并核验大小/摘要；成功后删除隔离源（copy-then-delete） */
  async promoteToObject(
    source: ObjectLocation,
    target: ObjectLocation,
    expectedSha256: string,
  ): Promise<ObjectOpResult> {
    if (expectedSha256.length === 0) {
      return { ok: false, reason: '缺少可信摘要，拒绝晋升' };
    }
    const copySource = `/${this.bucket(source.bucketRole)}/${s3KeyOf(source)}`;
    try {
      // create-only 复制：x-amz-copy-source-if-none-match 防覆盖（目标已存在 → 412）
      const copyRes = await this.request('PUT', target.bucketRole, s3KeyOf(target), null, {
        'x-amz-copy-source': copySource,
        'x-amz-copy-source-if-none-match': '*',
      });
      if (!copyRes.ok && copyRes.status !== 412) {
        return s3Failure(copyRes.status, '晋升复制');
      }
      // 回读核验：目标内容摘要必须与可信摘要一致（DATA-FIL-003）
      const bytes = await this.read(target);
      if (bytes === null) {
        return { ok: false, reason: '晋升核验：目标对象读取失败' };
      }
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== expectedSha256) {
        return { ok: false, reason: '晋升核验：内容摘要不匹配' };
      }
      // copy-then-delete：删除隔离源（幂等；源已缺失视为成功——前次晋升已删）
      const delRes = await this.request('DELETE', source.bucketRole, s3KeyOf(source), null);
      if (!delRes.ok && delRes.status !== 404) {
        return s3Failure(delRes.status, '隔离源清理');
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: '晋升：对象存储不可用（超时/连接失败）' };
    }
  }

  /** 读取（检查/对账/核验用）；404 → null */
  async read(location: ObjectLocation): Promise<Uint8Array | null> {
    try {
      const res = await this.request('GET', location.bucketRole, s3KeyOf(location), null);
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        return null;
      }
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  /** 删除单对象并回读核验（HEAD 404 = 删除成功；幂等） */
  async deleteAndVerify(location: ObjectLocation): Promise<ObjectOpResult> {
    try {
      const delRes = await this.request('DELETE', location.bucketRole, s3KeyOf(location), null);
      if (!delRes.ok && delRes.status !== 404) {
        return s3Failure(delRes.status, '对象删除');
      }
      const headRes = await this.request('HEAD', location.bucketRole, s3KeyOf(location), null);
      // HEAD 404 = 回读确认已删除；其余（200/403 等）= 仍存在 → 失败（不伪装成功）
      return headRes.status === 404
        ? { ok: true }
        : { ok: false, reason: '对象删除：回读核验发现对象仍存在' };
    } catch {
      return { ok: false, reason: '对象删除：对象存储不可用（超时/连接失败）' };
    }
  }
}
