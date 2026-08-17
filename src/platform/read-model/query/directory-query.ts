import { Inject, Injectable } from '@nestjs/common';
import { ProjectionType } from '../contracts';
import type { ProjectionScope, ProjectionType as PT } from '../contracts';
import { QueryEntryRegistry } from './entry-registry';
import type { QueryAuthContext } from './query-context';
import { QuerySource } from './query-result';
import type { ReadModelQueryResult } from './query-result';
import { ReadModelQueryService } from './query-service';
import type { QueryOptions } from './query-options';
import type { PublicDirectoryItem } from '../projection/public-directory.projection';

/** 公开目录入口登记（IFC-QRY-008）：找社团/找活动（单一名称模式，ADR-007 §8） */
export const PUBLIC_DIRECTORY_ENTRY = {
  entryId: 'public-directory',
  entryVersion: 'v1',
  projectionType: ProjectionType.PUBLIC_DIRECTORY,
  requiredScopeKind: 'ANY',
  filterKeys: [
    {
      key: 'name',
      valueType: 'string' as const,
      operators: ['EQ' as const],
      authoritativeField: 'displayName',
    },
    {
      key: 'activityType',
      valueType: 'string' as const,
      operators: ['EQ' as const],
      authoritativeField: 'activityType',
    },
    {
      key: 'signupStatus',
      valueType: 'enum' as const,
      allowedValues: ['OPEN', 'CLOSED'],
      operators: ['EQ' as const],
      authoritativeField: 'signupStatus(derived)',
    },
    {
      key: 'deadline',
      valueType: 'enum' as const,
      // C6.7 截止筛选：今日截止/3日内/7日内（自定义起止待 RANGE 操作符扩展）
      allowedValues: ['TODAY', '3DAYS', '7DAYS'],
      operators: ['EQ' as const],
      authoritativeField: 'deadlineAt(server natural day)',
    },
  ],
  allowedSorts: ['STABLE_DEFAULT'],
  maxLimit: 100,
  allowAnonymous: true,
  fieldProjection: '按访问者类型：匿名最小字段集；管理角色更多管理字段（投影层执行）',
  cachePolicy: 'REBUILDABLE',
} as const;

/** 公开目录查询参数（C6.1/C6.2：单一名称模式 + 三类筛选，同一时刻不组合两个名称条件） */
export interface DirectoryQueryParams {
  /** 名称模式（找社团按展示名称 / 找活动按活动名称；单一名称条件） */
  readonly name?: string;
  /** 活动类型（找活动筛选） */
  readonly activityType?: string;
  /** 报名状态（找活动筛选；"正在报名"为派生值，OPEN 表示可报名） */
  readonly signupStatus?: 'OPEN' | 'CLOSED';
  /** 截止筛选（服务端自然日转换） */
  readonly deadline?: 'TODAY' | '3DAYS' | '7DAYS';
  readonly limit: number;
  readonly cursor?: string;
}

/**
 * 公开目录查询入口（C3.1/IFC-QRY-002）。
 *
 * 先授权/作用域校验（公开目录允许未认证读取）→ 入口筛选校验（未知键/值拒绝）→
 * 派生查询（命中投影/回源重建/明确不可用）。字段投影按访问者类型由投影层执行。
 */
@Injectable()
export class DirectoryQueryService {
  constructor(
    @Inject(ReadModelQueryService) private readonly query: ReadModelQueryService,
    private readonly entries: QueryEntryRegistry,
  ) {}

  async find(
    scope: ProjectionScope,
    auth: QueryAuthContext,
    params: DirectoryQueryParams,
  ): Promise<ReadModelQueryResult<PublicDirectoryItem>> {
    // 同一时刻不组合两个名称条件；首版单筛选键（name/activityType/signupStatus/deadline 至多一个）
    const filter = this.toFilter(params);
    this.entries.assertValidQuery(PUBLIC_DIRECTORY_ENTRY.entryId, scope, {
      filter,
      sort: 'STABLE_DEFAULT',
      limit: params.limit,
      anonymous: auth.visitor === 'ANONYMOUS',
    });
    return this.query.query<PublicDirectoryItem>(
      ProjectionType.PUBLIC_DIRECTORY,
      scope,
      auth,
      { limit: params.limit, cursor: params.cursor, filter },
    );
  }

  private toFilter(
    params: DirectoryQueryParams,
  ): { key: string; value: string; operator: 'EQ' } | undefined {
    const chosen = (
      [
        ['name', params.name],
        ['activityType', params.activityType],
        ['signupStatus', params.signupStatus],
        ['deadline', params.deadline],
      ] as const
    ).filter(([, v]) => v !== undefined && v !== '');
    if (chosen.length > 1) {
      throw new Error('IFC-ERR-VALIDATION: 同一时刻只能使用一个筛选键');
    }
    if (chosen.length === 0) {
      return undefined;
    }
    return { key: chosen[0][0], value: chosen[0][1] as string, operator: 'EQ' };
  }
}

/** 兼容导出：入口类型 */
export type { PT as DirectoryProjectionType };
