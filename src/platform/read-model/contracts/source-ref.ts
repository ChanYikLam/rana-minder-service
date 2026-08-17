import type { ProjectionScope } from './scope';

/**
 * 权威源对象引用（只读领域权威对象）。
 *
 * read-model 只通过该引用识别"从哪个权威对象派生"，绝不反向写入
 * 领域状态（IFC-DATA-012：派生数据不得成为授权、状态、唯一性或恢复事实）。
 */
export interface SourceRef {
  /**
   * 权威对象类型（领域模块内的稳定类型标识，如 'CLUB'/'ACTIVITY'/'PERSON'）。
   * 由 AuthoritativeSourcePort.objectType 提供，二者必须一致。
   */
  readonly objectType: string;
  /** 权威对象稳定标识（UUIDv7，IFC-DATA-001：名称不得成为授权或业务引用） */
  readonly objectId: string;
  /** 权威对象当前版本（IFC-DATA-004：当前状态、不可变版本） */
  readonly version: number;
  /** 源对象适用作用域 */
  readonly scope: ProjectionScope;
}
