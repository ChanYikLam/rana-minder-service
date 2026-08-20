/**
 * 周期全量对账服务（CAS-REC-005~009）。
 *
 * 按运行编号/范围/水位分页扫描；未证明完整时绝不推断删除/失权。
 */

import { Inject, Injectable } from '@nestjs/common';

import {
  CASDOOR_READ_PORT,
  CASDOOR_CLOCK,
  CASDOOR_MAPPING_STORE,
  type CasdoorReadPort,
  type ClockPort,
  type MappingStore,
} from '../contracts/ports';
import type { ExternalResult, EvidenceRef } from '../contracts/external-result';
import type { ReconcileEnumeratePage, ReconcileEnumerateRequest } from '../contracts/ports';
import type { CasdoorGroup, CasdoorUser, ReconcileRun, ReconcileStatus } from '../contracts/types';
import { groupRefKey } from '../contracts/types';

@Injectable()
export class CasdoorReconcileService {
  constructor(
    @Inject(CASDOOR_READ_PORT)
    private readonly read: CasdoorReadPort,
    @Inject(CASDOOR_CLOCK)
    private readonly clock: ClockPort,
    @Inject(CASDOOR_MAPPING_STORE)
    private readonly mappings: MappingStore,
  ) {}

  async runFullReconciliation(input: {
    readonly runId: string;
    readonly scope: string;
    readonly watermark: string;
    readonly limit: number;
  }): Promise<ReconcileRun> {
    const evidence: EvidenceRef[] = [];
    let pageCount = 0;
    let attemptCount = 0;
    let status: ReconcileStatus = 'COMPLETE_SUCCESS';

    const account = await this.scanPages(input, 'ACCOUNT');
    pageCount += account.pageCount;
    attemptCount += account.attemptCount;
    evidence.push(...account.evidence);
    if (account.status !== 'COMPLETE_SUCCESS') status = this.worst(status, account.status);

    const group = await this.scanPages(input, 'GROUP');
    pageCount += group.pageCount;
    attemptCount += group.attemptCount;
    evidence.push(...group.evidence);
    if (group.status !== 'COMPLETE_SUCCESS') status = this.worst(status, group.status);

    const relation = await this.scanPages(input, 'RELATION');
    pageCount += relation.pageCount;
    attemptCount += relation.attemptCount;
    evidence.push(...relation.evidence);
    if (relation.status !== 'COMPLETE_SUCCESS') status = this.worst(status, relation.status);

    const differenceSummary = await this.computeDifferenceSummary(
      account.items,
      group.items,
      relation.items,
    );

    return {
      runId: input.runId,
      scope: input.scope,
      watermark: input.watermark,
      status,
      pageCount,
      attemptCount,
      completedAt: this.clock.now().toISOString(),
      differenceSummary,
      evidence,
    };
  }

  private async scanPages(
    input: { runId: string; scope: string; watermark: string; limit: number },
    objectKind: 'ACCOUNT' | 'GROUP' | 'RELATION',
  ): Promise<{
    status: ReconcileStatus;
    pageCount: number;
    attemptCount: number;
    evidence: EvidenceRef[];
    items: readonly unknown[];
  }> {
    let cursor: string | undefined;
    let pageCount = 0;
    let attemptCount = 0;
    const evidence: EvidenceRef[] = [];
    const items: unknown[] = [];
    let status: ReconcileStatus = 'COMPLETE_SUCCESS';

    while (true) {
      const request: ReconcileEnumerateRequest = {
        runId: input.runId,
        scope: input.scope,
        watermark: input.watermark,
        cursor,
        limit: input.limit,
        trackingId: `${input.runId}:${objectKind}:${pageCount + 1}`,
      };
      const page = await this.enumeratePage(objectKind, request);
      attemptCount += 1;
      if (page.status === 'TRUSTED_CURRENT' && page.value !== null) {
        pageCount += 1;
        evidence.push(page.value.evidence);
        items.push(...(page.value.items as readonly unknown[]));
        const next = page.value.nextCursor;
        if (next === null) {
          break;
        }
        cursor = next;
        if (pageCount > 1000) {
          status = 'UNCERTAIN';
          break;
        }
      } else {
        status = page.status === 'DEPENDENCY_UNAVAILABLE' ? 'FAILED' : 'UNCERTAIN';
        break;
      }
    }

    return { status, pageCount, attemptCount, evidence, items };
  }

  private async enumeratePage(
    objectKind: 'ACCOUNT' | 'GROUP' | 'RELATION',
    request: ReconcileEnumerateRequest,
  ): Promise<ExternalResult<ReconcileEnumeratePage<unknown>>> {
    if (objectKind === 'ACCOUNT')
      return this.read.enumerateAccounts(request) as Promise<
        ExternalResult<ReconcileEnumeratePage<unknown>>
      >;
    if (objectKind === 'GROUP')
      return this.read.enumerateGroups(request) as Promise<
        ExternalResult<ReconcileEnumeratePage<unknown>>
      >;
    return this.read.enumerateRelations(request) as Promise<
      ExternalResult<ReconcileEnumeratePage<unknown>>
    >;
  }

  /**
   * 将外部全量枚举与本地映射/关系比对，产出可观测的对账差异计数。
   *
   * 当前仅做“外部存在但本地无映射/关系”的单向差异统计；反向（本地有但外部
   * 缺）需依赖本地全量快照，由后续基础设施版对账补充。
   */
  private async computeDifferenceSummary(
    accountItems: readonly unknown[],
    groupItems: readonly unknown[],
    relationItems: readonly unknown[],
  ): Promise<Readonly<Record<string, number>>> {
    const summary: Record<string, number> = {
      accountsWithoutLocalMapping: 0,
      groupsWithoutLocalMapping: 0,
      relationsWithoutLocalMapping: 0,
      relationsMissingLocally: 0,
    };

    const localRelations = await this.mappings.listAllRelations();
    const localRelationKeys = new Set(
      localRelations
        .filter((r) => r.current)
        .map((r) => `${r.localSubjectId}\u0000${groupRefKey(r.groupRef)}`),
    );

    for (const item of accountItems as readonly CasdoorUser[]) {
      const mapping = await this.mappings.findSubjectMappingByExternal(item.externalId);
      if (mapping === null) summary.accountsWithoutLocalMapping += 1;
    }

    for (const item of groupItems as readonly CasdoorGroup[]) {
      const mapping = await this.mappings.findGroupMappingByExternal(item.ref);
      if (mapping === null) summary.groupsWithoutLocalMapping += 1;
    }

    for (const item of relationItems as readonly {
      externalUserId: string;
      groups: readonly { owner: string; name: string }[];
    }[]) {
      const subjectMapping = await this.mappings.findSubjectMappingByExternal(item.externalUserId);
      for (const ref of item.groups) {
        const groupMapping = await this.mappings.findGroupMappingByExternal(ref);
        if (subjectMapping === null || groupMapping === null) {
          summary.relationsWithoutLocalMapping += 1;
          continue;
        }
        const key = `${subjectMapping.localSubjectId}\u0000${groupRefKey(ref)}`;
        if (!localRelationKeys.has(key)) summary.relationsMissingLocally += 1;
      }
    }

    return summary;
  }

  private worst(a: ReconcileStatus, b: ReconcileStatus): ReconcileStatus {
    if (a === 'FAILED' || b === 'FAILED') return 'FAILED';
    if (a === 'UNCERTAIN' || b === 'UNCERTAIN') return 'UNCERTAIN';
    if (a === 'PARTIAL_SUCCESS' || b === 'PARTIAL_SUCCESS') return 'PARTIAL_SUCCESS';
    return 'COMPLETE_SUCCESS';
  }
}
