/**
 * 周期全量对账服务（CAS-REC-005~009）。
 *
 * 按运行编号/范围/水位分页扫描；未证明完整时绝不推断删除/失权。
 */

import { Inject, Injectable } from '@nestjs/common';

import {
  CASDOOR_READ_PORT,
  CASDOOR_CLOCK,
  type CasdoorReadPort,
  type ClockPort,
} from '../contracts/ports';
import type { ExternalResult, EvidenceRef } from '../contracts/external-result';
import type { ReconcileEnumeratePage, ReconcileEnumerateRequest } from '../contracts/ports';
import type { ReconcileRun, ReconcileStatus } from '../contracts/types';

@Injectable()
export class CasdoorReconcileService {
  constructor(
    @Inject(CASDOOR_READ_PORT)
    private readonly read: CasdoorReadPort,
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

    return {
      runId: input.runId,
      scope: input.scope,
      watermark: input.watermark,
      status,
      pageCount,
      attemptCount,
      completedAt: this.clock.now().toISOString(),
      differenceSummary: {},
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
  }> {
    let cursor: string | undefined;
    let pageCount = 0;
    let attemptCount = 0;
    const evidence: EvidenceRef[] = [];
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

    return { status, pageCount, attemptCount, evidence };
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
