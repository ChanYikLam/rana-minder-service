import type { ProjectionScope } from './scope';
import type { SourceRef } from './source-ref';

/**
 * 权威对象快照（只读视图）。
 *
 * 领域模块以只读视图暴露权威对象；不暴露内部可变状态，
 * 防止 read-model 意外写入或依赖实现细节。
 */
export interface AuthoritativeSnapshot {
  /** 稳定标识 */
  readonly objectId: string;
  /** 当前版本（IFC-DATA-004） */
  readonly version: number;
  /** 适用作用域 */
  readonly scope: ProjectionScope;
  /** 只读业务视图（具体结构由领域模块定义，read-model 不假定） */
  readonly view: unknown;
  /** 最近变更时间（服务端可信时钟，ISO 8601；供失效/新鲜度判定） */
  readonly changedAt: string;
}

/**
 * 权威源只读端口（read-model 自洽引用"只读领域权威对象"）。
 *
 * 由各领域模块（identity/organization/recruitment/joint 等）实现；
 * read-model 只经该端口读取，绝不写入任何领域状态、不参与授权判定。
 * 派生失败/滞后时只能回源、转任务或明确不可用（IFC-QRY-009.8）。
 */
export interface AuthoritativeSourcePort {
  /** 权威对象类型（与 SourceRef.objectType 一致） */
  readonly objectType: string;

  /** 读取权威对象当前快照（回源）。对象不存在或已删除时返回 null。 */
  readCurrent(ref: SourceRef): Promise<AuthoritativeSnapshot | null>;

  /** 按版本读取（重建时校验源版本不落后；版本不可得返回 null） */
  readAtVersion(ref: SourceRef, version: number): Promise<AuthoritativeSnapshot | null>;

  /**
   * 列举作用域内可派生对象（集合投影：公开目录/个人中心/工作台用）。
   * 作用域过滤由服务端执行，read-model 不越权、不跨作用域合并。
   */
  list(scope: ProjectionScope): Promise<readonly AuthoritativeSnapshot[]>;
}
