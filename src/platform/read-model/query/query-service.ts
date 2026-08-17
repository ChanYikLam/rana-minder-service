import { Inject, Injectable } from '@nestjs/common';
import type { ProjectionScope, ProjectionType } from '../contracts';
import type { ProjectionRegistry } from '../projection/projection-registry';
import { PROJECTION_STORE } from '../projection/projection-store';
import type { ProjectionStore } from '../projection/projection-store';
import type { QueryAuthContext } from './query-context';
import type { QueryOptions } from './query-options';
import { QuerySource } from './query-result';
import type { ReadModelQueryResult } from './query-result';

/**
 * 只读查询入口（query/）：服务端授权后投影。
 *
 * 编排：先授权/作用域校验 → 读投影（命中且有效则返回）→
 * 投影失效/缺失时回源同步重建（REFRESHED）或明确不可用（UNAVAILABLE）。
 * 集合只读：仅服务端冻结有限集合；详情与执行逐对象重验（IFC-QRY-002/003）。
 */
@Injectable()
export class ReadModelQueryService {
  constructor(
    private readonly registry: ProjectionRegistry,
    @Inject(PROJECTION_STORE) private readonly store: ProjectionStore,
  ) {}

  /**
   * 查询派生结果。scope 必须在授权作用域内（公开目录允许匿名）且
   * 不得越界（DATA-SCP 语义：服务端重建并拒绝越界）。
   */
  async query<TItem>(
    projectionType: ProjectionType,
    scope: ProjectionScope,
    auth: QueryAuthContext,
    opts: QueryOptions,
  ): Promise<ReadModelQueryResult<TItem>> {
    this.assertGranted(projectionType, scope, auth);
    this.assertOptions(opts, scope);

    const builder = this.registry.get(projectionType);

    // 1) 命中有效投影 → 直接返回（字段投影由调用方按 visitor 执行）
    const record = await this.store.load<TItem>(projectionType, scope);
    if (record !== null && record.status === 'ACTIVE') {
      return this.paginate(record.data, opts, scope);
    }

    // 2) 投影失效/缺失 → 回源同步重建（IFC-QRY-009.8 安全回源）
    const rebuilt = await builder.rebuild(scope, {
      reason: 'query-rebuild',
      requestedAt: new Date().toISOString(),
    });
    if (rebuilt === null) {
      return this.unavailable<TItem>();
    }
    await this.store.save(rebuilt);
    return {
      ...this.paginate(rebuilt.data as TItem, opts, scope),
      watermark: rebuilt.watermark,
      source: QuerySource.REFRESHED,
    };
  }

  private assertGranted(
    projectionType: ProjectionType,
    scope: ProjectionScope,
    auth: QueryAuthContext,
  ): void {
    if (projectionType === 'PUBLIC_DIRECTORY' && auth.visitor === 'ANONYMOUS') {
      return; // 公开目录：未认证可读，但字段投影按访问者类型执行
    }
    const granted = auth.grantedScopes.some((s) => this.sameScope(s, scope));
    if (!granted) {
      throw new Error('IFC-ERR-FORBIDDEN: 查询作用域未授权');
    }
  }

  private assertOptions(opts: QueryOptions, scope: ProjectionScope): void {
    if (opts.limit <= 0 || opts.limit > 100) {
      throw new Error('IFC-ERR-VALIDATION: limit 必须为 1..100');
    }
    if (opts.filter !== undefined && opts.filter.operator !== 'EQ') {
      throw new Error('IFC-ERR-VALIDATION: 未知操作符');
    }
    if (opts.cursor !== undefined) {
      // 游标必须可解析且绑定当前作用域/筛选；损坏、跨作用域或跨入口复用一律拒绝
      this.decodeCursor(opts.cursor, opts, scope);
    }
  }

  private paginate<TItem>(
    data: unknown,
    opts: QueryOptions,
    scope: ProjectionScope,
  ): ReadModelQueryResult<TItem> {
    const items = Array.isArray(data) ? (data as TItem[]) : [];
    const total = items.length;
    const page = items.slice(0, opts.limit);
    const nextCursor =
      items.length > opts.limit ? this.encodeCursor(opts, opts.limit, scope) : null;
    return {
      items: page,
      nextCursor,
      total,
      watermark: null,
      source: QuerySource.PROJECTION,
    };
  }

  private unavailable<TItem>(): ReadModelQueryResult<TItem> {
    return {
      items: [],
      nextCursor: null,
      total: 0,
      watermark: null,
      source: QuerySource.UNAVAILABLE,
    };
  }

  private sameScope(a: ProjectionScope, b: ProjectionScope): boolean {
    return (
      a.kind === b.kind &&
      a.clubId === b.clubId &&
      a.unionId === b.unionId &&
      a.subjectId === b.subjectId
    );
  }

  private encodeCursor(opts: QueryOptions, offset: number, scope: ProjectionScope): string {
    const payload = JSON.stringify({
      v: 'rm-qry-1',
      offset,
      filter: opts.filter ?? null,
      scope: this.canonicalScope(scope),
    });
    return Buffer.from(payload, 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string, opts: QueryOptions, scope: ProjectionScope): void {
    let parsed: { v: string; offset: number; filter: unknown; scope?: unknown };
    try {
      parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      throw new Error('IFC-ERR-VALIDATION: 损坏的游标');
    }
    if (parsed.v !== 'rm-qry-1' || !Number.isInteger(parsed.offset) || parsed.offset < 0) {
      throw new Error('IFC-ERR-VALIDATION: 损坏的游标');
    }
    // 游标绑定作用域：跨作用域/跨入口复用的旧游标一律拒绝（不静默换结果集）
    if (parsed.scope === undefined || !this.sameScope(parsed.scope as ProjectionScope, scope)) {
      throw new Error('IFC-ERR-VALIDATION: 游标与作用域不匹配');
    }
    // 游标绑定筛选：筛选变化后旧游标拒绝（不静默换结果集）
    const filterJson = JSON.stringify(opts.filter ?? null);
    if (filterJson !== JSON.stringify(parsed.filter)) {
      throw new Error('IFC-ERR-VALIDATION: 游标与筛选不匹配');
    }
  }

  /** 作用域规范化（稳定键序，供游标签名与跨入口比较） */
  private canonicalScope(scope: ProjectionScope): ProjectionScope {
    return {
      kind: scope.kind,
      clubId: scope.clubId,
      unionId: scope.unionId,
      subjectId: scope.subjectId,
      visitor: scope.visitor,
    };
  }
}
