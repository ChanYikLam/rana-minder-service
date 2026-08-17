import { Inject, Injectable } from '@nestjs/common';
import { ProjectionType } from '../contracts';
import type { ProjectionScope } from '../contracts';
import { QueryEntryRegistry } from './entry-registry';
import type { QueryAuthContext } from './query-context';
import { QuerySource } from './query-result';
import type { ReadModelQueryResult } from './query-result';
import { ReadModelQueryService } from './query-service';
import type { PersonalCenterItem } from '../projection/personal-center.projection';

/** 个人中心入口登记（IFC-QRY-008）：只聚合本人事项 + 当前仍有权角色型事项（IFC-QRY-003） */
export const PERSONAL_CENTER_ENTRY = {
  entryId: 'personal-center',
  entryVersion: 'v1',
  projectionType: ProjectionType.PERSONAL_CENTER,
  requiredScopeKind: 'SUBJECT',
  filterKeys: [
    {
      key: 'kind',
      valueType: 'string' as const,
      operators: ['EQ' as const],
      authoritativeField: 'itemKind',
    },
  ],
  allowedSorts: ['STABLE_DEFAULT'],
  maxLimit: 100,
  allowAnonymous: false,
  fieldProjection: '每项携带真实作用域与稳定目标引用；失权后旧链接/缓存/入口失效',
  cachePolicy: 'REBUILDABLE',
} as const;

/** 个人中心查询参数（C6.9） */
export interface PersonalCenterQueryParams {
  /** 事项类型筛选（申请/日程/邀请/待办/成员经历等） */
  readonly kind?: string;
  readonly limit: number;
  readonly cursor?: string;
}

/**
 * 全局个人中心查询入口（C3.2/IFC-QRY-003）。
 *
 * 只聚合本人事项和当前仍有权的角色型事项：作用域强制为 SUBJECT 且
 * subjectId 必须等于当前主体（防止跨主体读取）；每项携带真实作用域与
 * 稳定目标引用（详情与执行逐对象重验）。
 */
@Injectable()
export class PersonalCenterQueryService {
  constructor(
    @Inject(ReadModelQueryService) private readonly query: ReadModelQueryService,
    private readonly entries: QueryEntryRegistry,
  ) {}

  async queryMy(
    auth: QueryAuthContext,
    params: PersonalCenterQueryParams,
  ): Promise<ReadModelQueryResult<PersonalCenterItem>> {
    if (auth.principalId === null) {
      throw new Error('IFC-ERR-FORBIDDEN: 个人中心需要认证');
    }
    // 只聚合本人：作用域锚定当前主体，拒绝他人/跨主体作用域
    const scope: ProjectionScope = { kind: 'SUBJECT', subjectId: auth.principalId };
    const filter =
      params.kind !== undefined && params.kind !== ''
        ? { key: 'kind', value: params.kind, operator: 'EQ' as const }
        : undefined;
    this.entries.assertValidQuery(PERSONAL_CENTER_ENTRY.entryId, scope, {
      filter,
      sort: 'STABLE_DEFAULT',
      limit: params.limit,
      anonymous: false,
    });
    return this.query.query<PersonalCenterItem>(
      ProjectionType.PERSONAL_CENTER,
      scope,
      auth,
      { limit: params.limit, cursor: params.cursor, filter },
    );
  }
}

/** 兼容导出：入口类型 */
export type { ProjectionScope as PersonalCenterScope };
