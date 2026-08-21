import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ObjectLocation } from '../domain/models/file-model';

/** 对象存储注入令牌（ObjectStorePort 为接口，注入须用显式 token） */
export const OBJECT_STORE_PORT = Symbol('OBJECT_STORE_PORT');

/** 对象操作结果（不伪装假成功；ADR-008 §2.7、DATA-FIL-004） */
export interface ObjectOpResult {
  readonly ok: boolean;
  /** 失败原因（技术性，脱敏） */
  readonly reason?: string;
}

/**
 * S3 兼容对象存储适配端口（ADR-008、DATA-FIL-002）。
 *
 * - 三个专用私有 Bucket（隔离区/权威原件区/临时派生区），键由服务端
 *   高熵随机生成（≥128 位），客户端不得提交或复用对象键；
 * - 每个对象键严格只写一次、永不覆盖（create-only/防覆盖）；
 * - 对象存储只负责定位和核验，不是业务身份、权限、文件版本或去重键。
 */
export interface ObjectStorePort {
  /** 隔离区只写一次写入（未完成上传/检查中/失败字节） */
  putQuarantine(location: ObjectLocation, bytes: Uint8Array): Promise<ObjectOpResult>;
  /** 晋升：以只写一次的新键复制到权威原件区并核验大小/摘要（DATA-FIL-003） */
  promoteToObject(
    source: ObjectLocation,
    target: ObjectLocation,
    expectedSha256: string,
  ): Promise<ObjectOpResult>;
  /** 读取（检查/对账/核验用） */
  read(location: ObjectLocation): Promise<Uint8Array | null>;
  /** 删除单对象并回读核验（正式删除/清理逐项；IFC-FIL-007/008） */
  deleteAndVerify(location: ObjectLocation): Promise<ObjectOpResult>;
}

/**
 * 进程内对象存储占位（开发期；生产替换为 S3 兼容适配器）。
 * 保留只写一次语义（重复 put 同键失败）。
 */
@Injectable()
export class InMemoryObjectStore implements ObjectStorePort {
  private readonly buckets = new Map<string, Map<string, Uint8Array>>();

  private bucket(role: string): Map<string, Uint8Array> {
    let b = this.buckets.get(role);
    if (b === undefined) {
      b = new Map();
      this.buckets.set(role, b);
    }
    return b;
  }

  async putQuarantine(location: ObjectLocation, bytes: Uint8Array): Promise<ObjectOpResult> {
    return this.putOnce(location, bytes);
  }

  async promoteToObject(
    source: ObjectLocation,
    target: ObjectLocation,
    expectedSha256: string,
  ): Promise<ObjectOpResult> {
    const bytes = await this.read(source);
    if (bytes === null) {
      return { ok: false, reason: '源对象缺失' };
    }
    // 可信摘要必须非空：空摘要视为失败（不得跳过核验，DATA-FIL-003）
    if (expectedSha256.length === 0) {
      return { ok: false, reason: '缺少可信摘要，拒绝晋升' };
    }
    if (this.sha256Hex(bytes) !== expectedSha256) {
      return { ok: false, reason: '内容摘要核验失败' };
    }
    // 只写一次写入权威原件区（与隔离区独立语义，但共享 create-only 防覆盖）
    return this.putOnce(target, bytes);
  }

  async read(location: ObjectLocation): Promise<Uint8Array | null> {
    return this.bucket(location.bucketRole).get(this.keyOf(location)) ?? null;
  }

  async deleteAndVerify(location: ObjectLocation): Promise<ObjectOpResult> {
    const bucket = this.bucket(location.bucketRole);
    const deleted = bucket.delete(this.keyOf(location));
    if (!deleted) {
      return { ok: false, reason: '对象不存在或已删除' };
    }
    // 回读核验：删除后读不到
    const stillThere = bucket.has(this.keyOf(location));
    return { ok: !stillThere, reason: stillThere ? '回读核验失败' : undefined };
  }

  /** 只写一次写入（create-only/防覆盖；DATA-FIL-002），隔离区与原件区共用 */
  private async putOnce(location: ObjectLocation, bytes: Uint8Array): Promise<ObjectOpResult> {
    const key = this.keyOf(location);
    const bucket = this.bucket(location.bucketRole);
    if (bucket.has(key)) {
      return { ok: false, reason: '对象键已存在（只写一次）' };
    }
    bucket.set(key, bytes);
    return { ok: true };
  }

  private keyOf(location: ObjectLocation): string {
    return `${location.keyVersion}/${location.objectKind}/${location.randomKey}`;
  }

  private sha256Hex(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
  }
}
