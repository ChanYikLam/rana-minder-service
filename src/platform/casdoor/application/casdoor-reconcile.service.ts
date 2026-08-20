/**
 * 周期全量对账服务（CAS-REC-005~009）。
 *
 * 按运行编号/范围/水位分页扫描外部事实，与本地稳定映射/当前关系比对，
 * 产出候选差异摘要；未证明完整时绝不推断删除/失权。
 */

import { Inject, Injectable } from '@nestjs/common';

import {
  CASDOOR_CLOCK,
  CASDOOR_MAPPING_STORE,
  CASDOOR_READ_PORT,
  type CasdoorReadPort,
  type ClockPort,
  type MappingStore,
  type ReconcileEnumeratePage,
  type ReconcileEnumerateRequest,
} from '../contracts/ports';
import type { ExternalResult, EvidenceRef } from '../contracts/external-result';
import {
  groupRefKey,
  type CasdoorGroup,
  type CasdoorUser,
  type GroupStableRef,
  type ReconcileCandidateDifference,
  type ReconcileRun,
  type ReconcileStatus,
} from '../contracts/types';

type AccountRelationItem = { externalUserId: string; groups: readonly GroupStableRef[] };

@Injectable()
export class CasdoorReconcileService {
  constructor(
    @Inject(CASDOOR_READ_PORT)
    private readonly read: CasdoorReadPort,
    @Inject(CASDOOR_MAPPING_STORE)
    private readonly mappings: MappingStore,
    @Inject(CASDOOR_CLOCK)
    private readonly clock: ClockPort,
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

    const account = await this.scanPages<CasdoorUser>(input, 'ACCOUNT');
    pageCount += account.pageCount;
    attemptCount += account.attemptCount;
    evidence.push(...account.evidence);
    if (account.status !== 'COMPLETE_SUCCESS') status = this.worst(status, account.status);

    const group = await this.scanPages<CasdoorGroup>(input, 'GROUP');
    pageCount += group.pageCount;
    attemptCount += group.attemptCount;
    evidence.push(...group.evidence);
    if (group.status !== 'COMPLETE_SUCCESS') status = this.worst(status, group.status);

    const relation = await this.scanPages<AccountRelationItem>(input, 'RELATION');
    pageCount += relation.pageCount;
    attemptCount += relation.attemptCount;
    evidence.push(...relation.evidence);
    if (relation.status !== 'COMPLETE_SUCCESS') status = this.worst(status, relation.status);

    const differences = await this.collectDifferences(
      input.runId,
      account.items,
      group.items,
      relation.items,
    );
    const differenceSummary = this.summarize(differences);
    // CAS-REC-006/007：扫描完整但存在候选差异 → 部分成功，差异进入定向读回处置。
    if (status === 'COMPLETE_SUCCESS' && differences.length > 0) {
      status = 'PARTIAL_SUCCESS';
    }

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

  private summarize(differences: readonly ReconcileCandidateDifference[]): Record<string, number> {
    const summary: Record<string, number> = {};
    for (const diff of differences) {
      const direction = diff.localObservation === null ? 'externalOnly' : 'localOnly';
      const key = `${diff.objectType.toLowerCase()}.${direction}`;
      summary[key] = (summary[key] ?? 0) + 1;
    }
    return summary;
  }

  private async collectDifferences(
    runId: string,
    accounts: readonly CasdoorUser[],
    groups: readonly CasdoorGroup[],
    relations: readonly AccountRelationItem[],
  ): Promise<ReconcileCandidateDifference[]> {
    const differences: ReconcileCandidateDifference[] = [];
    const subjectMappings = await this.mappings.listSubjectMappings();
    const localByExternal = new Map(subjectMappings.map((m) => [m.externalSubjectId, m]));

    // ACCOUNT：外部存在但本地无稳定映射 → 待采纳；本地映射指向的外部账号不存在 → 异常。
    const externalUserIds = new Set(accounts.map((u) => u.externalId));
    for (const user of accounts) {
      if (!localByExternal.has(user.externalId)) {
        differences.push({
          runId,
          objectType: 'ACCOUNT',
          objectRef: user.externalId,
          localObservation: null,
          externalObservation: user,
          impact: 'LOW',
          verifiedByLiveRead: false,
        });
      }
    }
    for (const mapping of subjectMappings) {
      if (!externalUserIds.has(mapping.externalSubjectId)) {
        differences.push({
          runId,
          objectType: 'ACCOUNT',
          objectRef: mapping.externalSubjectId,
          localObservation: mapping,
          externalObservation: null,
          impact: 'HIGH',
          verifiedByLiveRead: false,
        });
      }
    }

    // GROUP：外部定义与本地 Group 映射比对，规则同上。
    const groupMappings = await this.mappings.listGroupMappings();
    const localByExternalRef = new Map(groupMappings.map((m) => [groupRefKey(m.externalRef), m]));
    const externalGroupKeys = new Set(groups.map((g) => groupRefKey(g.ref)));
    for (const group of groups) {
      if (!localByExternalRef.has(groupRefKey(group.ref))) {
        differences.push({
          runId,
          objectType: 'GROUP',
          objectRef: `${group.ref.owner}/${group.ref.name}`,
          localObservation: null,
          externalObservation: group,
          impact: 'LOW',
          verifiedByLiveRead: false,
        });
      }
    }
    for (const mapping of groupMappings) {
      if (!externalGroupKeys.has(groupRefKey(mapping.externalRef))) {
        differences.push({
          runId,
          objectType: 'GROUP',
          objectRef: `${mapping.externalRef.owner}/${mapping.externalRef.name}`,
          localObservation: mapping,
          externalObservation: null,
          impact: 'HIGH',
          verifiedByLiveRead: false,
        });
      }
    }

    // RELATION：外部当前关系与本地登记为 current 的关系比对；权限相关一律高影响。
    const externalByUser = new Map<string, Set<string>>();
    for (const item of relations) {
      const keys = externalByUser.get(item.externalUserId) ?? new Set<string>();
      for (const g of item.groups) keys.add(groupRefKey(g));
      externalByUser.set(item.externalUserId, keys);
    }
    const localCurrent = (await this.mappings.listAllRelations()).filter((r) => r.current);
    const localBySubject = new Map<string, Set<string>>();
    for (const r of localCurrent) {
      const keys = localBySubject.get(r.localSubjectId) ?? new Set<string>();
      keys.add(groupRefKey(r.groupRef));
      localBySubject.set(r.localSubjectId, keys);
    }
    for (const [externalUserId, keys] of externalByUser) {
      const mapping = localByExternal.get(externalUserId);
      const localKeys = mapping
        ? (localBySubject.get(mapping.localSubjectId) ?? new Set())
        : new Set();
      for (const key of keys) {
        if (!localKeys.has(key)) {
          differences.push({
            runId,
            objectType: 'RELATION',
            objectRef: `${externalUserId}@${key}`,
            localObservation: null,
            externalObservation: { externalUserId, groupKey: key },
            impact: 'HIGH',
            verifiedByLiveRead: false,
          });
        }
      }
    }
    for (const [localSubjectId, keys] of localBySubject) {
      const mapping = subjectMappings.find((m) => m.localSubjectId === localSubjectId);
      if (mapping === undefined) continue;
      const externalKeys = externalByUser.get(mapping.externalSubjectId) ?? new Set<string>();
      for (const key of keys) {
        if (!externalKeys.has(key)) {
          differences.push({
            runId,
            objectType: 'RELATION',
            objectRef: `${mapping.externalSubjectId}@${key}`,
            localObservation: { localSubjectId, groupKey: key },
            externalObservation: null,
            impact: 'HIGH',
            verifiedByLiveRead: false,
          });
        }
      }
    }

    return differences;
  }

  private async scanPages<T>(
    input: { runId: string; scope: string; watermark: string; limit: number },
    objectKind: 'ACCOUNT' | 'GROUP' | 'RELATION',
  ): Promise<{
    status: ReconcileStatus;
    pageCount: number;
    attemptCount: number;
    evidence: EvidenceRef[];
    items: T[];
  }> {
    let cursor: string | undefined;
    let pageCount = 0;
    let attemptCount = 0;
    const evidence: EvidenceRef[] = [];
    const items: T[] = [];
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
        items.push(...(page.value.items as readonly T[]));
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

  private worst(a: ReconcileStatus, b: ReconcileStatus): ReconcileStatus {
    if (a === 'FAILED' || b === 'FAILED') return 'FAILED';
    if (a === 'UNCERTAIN' || b === 'UNCERTAIN') return 'UNCERTAIN';
    if (a === 'PARTIAL_SUCCESS' || b === 'PARTIAL_SUCCESS') return 'PARTIAL_SUCCESS';
    return 'COMPLETE_SUCCESS';
  }
}
