import { randomUUID } from 'node:crypto';
import type { ObjectLocation } from '../models/file-model';

/**
 * 高熵随机定位符（≥128 位有效熵；服务端生成，客户端不得提交/复用对象键；DATA-FIL-002）。
 * 两个 UUID 拼接以保证足够熵，供隔离区/权威原件区对象键使用。
 */
export function randomObjectKey(): string {
  return `${randomUUID()}${randomUUID()}`;
}

/**
 * 对象定位去重键（DATA-FIL-001：对象定位记录负责定位和核验）。
 *
 * 按 `bucketRole/keyVersion/objectKind/randomKey` 唯一，供清理队列/删除清单
 * 对同一对象去重，避免同一对象被重复登记/删除两次或元数据冗余（FORM-009、
 * IFC-FIL-008）。注意：与对象存储适配端内部使用的键（不含 bucketRole）不同——
 * 存储端以 bucket 分桶，各 bucket 内键无需携带角色前缀；本工具用于跨 bucket
 * 的元数据去重，故必须含 bucketRole。
 */
export function locationKeyOf(
  loc: Pick<ObjectLocation, 'bucketRole' | 'keyVersion' | 'objectKind' | 'randomKey'>,
): string {
  return `${loc.bucketRole}/${loc.keyVersion}/${loc.objectKind}/${loc.randomKey}`;
}
