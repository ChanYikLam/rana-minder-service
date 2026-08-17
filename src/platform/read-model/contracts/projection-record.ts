import type { ProjectionType } from './projection-type';
import type { SourceRef } from './source-ref';
import type { Watermark } from './watermark';

/**
 * 派生记录状态。
 */
export const ProjectionRecordStatus = {
  /** 有效（可读投影） */
  ACTIVE: 'ACTIVE',
  /** 已失效（等待重建或明确不可用；不得再作为新鲜结果返回） */
  INVALIDATED: 'INVALIDATED',
} as const;

export type ProjectionRecordStatus = (typeof ProjectionRecordStatus)[keyof typeof ProjectionRecordStatus];

/**
 * 投影记录信封（DATA-DER-001）。
 *
 * 每个可持久化派生记录至少保存：派生类型、源对象/源版本、源作用域、
 * 派生版本或水位、生成任务、生成时间、失效/删除状态和重建依据。
 * 派生记录不能产生源对象不存在的状态、权限或历史（IFC-DATA-012）。
 */
export interface ProjectionRecord<TData = unknown> {
  /** 派生类型 */
  readonly projectionType: ProjectionType;
  /** 源对象/源版本（含源作用域） */
  readonly source: SourceRef;
  /** 派生版本或水位 */
  readonly watermark: Watermark;
  /** 投影数据（可重建，不承载授权结论） */
  readonly data: TData;
  /** 失效/删除状态 */
  readonly status: ProjectionRecordStatus;
  /** 失效时间（status=INVALIDATED 时必填） */
  readonly invalidatedAt?: string;
  /** 重建依据（回源引用，保证可定位重建来源） */
  readonly rebuildBasis: string;
}
