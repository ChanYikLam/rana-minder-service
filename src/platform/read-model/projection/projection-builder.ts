import type {
  AuthoritativeSnapshot,
  ProjectionRecord,
  ProjectionScope,
  ProjectionType,
  SourceRef,
  Watermark,
} from '../contracts';
import type { DerivationRule } from '../derivation/derivation-rule';
import type { SourcePortRegistry } from './source-port-registry';

/**
 * 重建依据（DATA-DER-001"重建依据"；可追踪重建来源）。
 */
export interface RebuildBasis {
  /** 期望消费的源版本（undefined=按当前最新回源） */
  readonly expectedSourceVersion?: number;
  /** 重建依据描述（如任务引用/恢复重放/人工触发） */
  readonly reason: string;
  /** 请求时间（服务端可信时钟） */
  readonly requestedAt: string;
}

/**
 * 投影构建器：把"权威源只读端口 + 派生规则"组合为可执行重建。
 *
 * 重建流程（IFC-TX-008）：回源读取 → 校验源版本 → 派生 → 组装
 * DATA-DER-001 信封 → 返回记录（持久化由调用方经 ProjectionStore 完成）。
 * 派生失败不改源业务；旧水位不覆盖新结果由 refresh 协调器保障。
 * 源不可用/无数据时返回 null（查询方转为明确不可用，不伪造新鲜结果）。
 */
export interface ProjectionBuilder<TData = unknown> {
  readonly projectionType: ProjectionType;
  /** 重建一个作用域下的投影；返回 null 表示源不可用/对象已删除 */
  rebuild(scope: ProjectionScope, basis: RebuildBasis): Promise<ProjectionRecord<TData> | null>;
}

/**
 * 构建器基类：提供 DATA-DER-001 信封组装公共逻辑。
 * 具体投影实现 rebuild（单对象或集合回源派生）。
 */
export abstract class BaseProjectionBuilder<TData> implements ProjectionBuilder<TData> {
  abstract readonly projectionType: ProjectionType;
  /** 派生规则（纯函数，确定性） */
  abstract readonly rule: DerivationRule<AuthoritativeSnapshot, TData>;
  /** 权威源端口注册表（只读领域权威对象；领域模块实现后注册） */
  abstract readonly sourcePorts: SourcePortRegistry;

  abstract rebuild(scope: ProjectionScope, basis: RebuildBasis): Promise<ProjectionRecord<TData> | null>;

  protected makeWatermark(scope: ProjectionScope, basis: RebuildBasis, sourceVersion: number): Watermark {
    return {
      projectionType: this.projectionType,
      scope,
      formatVersion: this.formatVersion(),
      sourceVersion,
      derivedVersion: basis.expectedSourceVersion ?? sourceVersion,
      generationTaskId: basis.reason,
      generatedAt: basis.requestedAt,
    };
  }

  protected makeRecord(
    source: SourceRef,
    data: TData,
    scope: ProjectionScope,
    basis: RebuildBasis,
    sourceVersion: number,
  ): ProjectionRecord<TData> {
    return {
      projectionType: this.projectionType,
      source,
      watermark: this.makeWatermark(scope, basis, sourceVersion),
      data,
      status: 'ACTIVE',
      rebuildBasis: basis.reason,
    };
  }

  /** 投影格式版本（结构变化时递增） */
  protected abstract formatVersion(): string;
}
