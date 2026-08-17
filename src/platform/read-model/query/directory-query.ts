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
      // C6.7 截止筛选：预设（今日/3日/7日）走 EQ；自定义起止走 RANGE（服务端自然日转换）
      allowedValues: ['TODAY', '3DAYS', '7DAYS'],
      operators: ['EQ' as const, 'RANGE' as const],
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
  /** 截止预设（服务端自然日转换；与 deadlineRange 互斥） */
  readonly deadline?: 'TODAY' | '3DAYS' | '7DAYS';
  /** 自定义截止起止（C6.7；与 deadline 预设互斥，至少一端） */
  readonly deadlineRange?: { from?: string; to?: string };
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
    return this.query.query<PublicDirectoryItem>(ProjectionType.PUBLIC_DIRECTORY, scope, auth, {
      limit: params.limit,
      cursor: params.cursor,
      filter,
    });
  }

  private toFilter(
    params: DirectoryQueryParams,
  ): { key: string; value: string | { from?: string; to?: string }; operator: 'EQ' | 'RANGE' } | undefined {
    const chosen: { key: string; value: string | { from?: string; to?: string }; operator: 'EQ' | 'RANGE' }[] = [];
    if (params.name !== undefined && params.name !== '') {
      chosen.push({ key: 'name', value: params.name, operator: 'EQ' });
    }
    if (params.activityType !== undefined && params.activityType !== '') {
      chosen.push({ key: 'activityType', value: params.activityType, operator: 'EQ' });
    }
    if (params.signupStatus !== undefined) {
      chosen.push({ key: 'signupStatus', value: params.signupStatus, operator: 'EQ' });
    }
    if (params.deadline !== undefined) {
      chosen.push({ key: 'deadline', value: params.deadline, operator: 'EQ' });
    }
    if (params.deadlineRange !== undefined) {
      chosen.push({ key: 'deadline', value: params.deadlineRange, operator: 'RANGE' });
    }
    if (chosen.length > 1) {
      throw new Error('IFC-ERR-VALIDATION: 同一时刻只能使用一个筛选键');
    }
    return chosen[0];
  }
}

/** 兼容导出：入口类型 */
export type { PT as DirectoryProjectionType };
