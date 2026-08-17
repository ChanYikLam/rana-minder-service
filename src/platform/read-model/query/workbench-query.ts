import { Inject, Injectable } from '@nestjs/common';
import { ProjectionType } from '../contracts';
import type { ProjectionScope } from '../contracts';
import { OBJECT_AUTHORIZATION_PORT } from '../contracts/authorization-port';
import type { AuthorizationAction, ObjectAuthorizationPort } from '../contracts/authorization-port';
import { QueryEntryRegistry } from './entry-registry';
import type { QueryAuthContext } from './query-context';
import { QuerySource } from './query-result';
import type { ReadModelQueryResult } from './query-result';
import { ReadModelQueryService } from './query-service';
import type { WorkbenchItem } from '../projection/club-workbench.projection';

/** 工作台入口登记（IFC-QRY-008）：固定当前社团，打开/筛选/详情/命令均重新授权（接口契约 §9.6） */
export const CLUB_WORKBENCH_ENTRY = {
  entryId: 'club-workbench',
  entryVersion: 'v1',
  projectionType: ProjectionType.CLUB_WORKBENCH,
  requiredScopeKind: 'CLUB',
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
  fieldProjection: '固定当前社团管理数据；不跨社团合并；打开/筛选/详情/命令逐对象重验授权',
  cachePolicy: 'REBUILDABLE',
} as const;

/** 工作台查询参数（C6.11） */
export interface WorkbenchQueryParams {
  /** 条目类型筛选（角色型待办/异常/批次/任务等） */
  readonly kind?: string;
  readonly limit: number;
  readonly cursor?: string;
}

/**
 * 当前社团管理工作台查询入口（C3.3/IFC-QRY-003、接口契约 §9.6）。
 *
 * 固定当前社团工作空间：作用域强制为 CLUB 且 clubId 必须显式给出；
 * 不跨社团合并管理数据；授权由服务端入口判定（越界作用域拒绝），
 * 打开/筛选/详情和命令经 verifyObject 逐对象重验（C6.11）。
 */
@Injectable()
export class WorkbenchQueryService {
  constructor(
    @Inject(ReadModelQueryService) private readonly query: ReadModelQueryService,
    private readonly entries: QueryEntryRegistry,
    @Inject(OBJECT_AUTHORIZATION_PORT)
    private readonly objectAuth: ObjectAuthorizationPort,
  ) {}

  async queryClub(
    clubId: string,
    auth: QueryAuthContext,
    params: WorkbenchQueryParams,
  ): Promise<ReadModelQueryResult<WorkbenchItem>> {
    if (clubId.length === 0) {
      throw new Error('IFC-ERR-VALIDATION: 缺少当前社团标识');
    }
    const scope: ProjectionScope = { kind: 'CLUB', clubId };
    const filter =
      params.kind !== undefined && params.kind !== ''
        ? { key: 'kind', value: params.kind, operator: 'EQ' as const }
        : undefined;
    this.entries.assertValidQuery(CLUB_WORKBENCH_ENTRY.entryId, scope, {
      filter,
      sort: 'STABLE_DEFAULT',
      limit: params.limit,
      anonymous: false,
    });
    return this.query.query<WorkbenchItem>(
      ProjectionType.CLUB_WORKBENCH,
      scope,
      auth,
      { limit: params.limit, cursor: params.cursor, filter },
    );
  }

  /**
   * C6.11 逐对象重验：打开/详情/命令前重新授权。
   *
   * 授权判定由组织与授权模块实现（本模块只承接判定结果）；
   * 占位实现 fail-closed（领域授权模块接入前一律拒绝，绝不越权）。
   */
  async verifyObject(
    principalId: string,
    object: { objectType: string; objectId: string },
    action: AuthorizationAction,
  ): Promise<boolean> {
    return this.objectAuth.verify(principalId, object, action);
  }
}

/** 兼容导出：入口类型 */
export type { ProjectionScope as WorkbenchScope };
