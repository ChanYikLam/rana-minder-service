/**
 * Casdoor 写入服务（CAS-WR-001~013、CAS-REC-001）。
 *
 * 写前本地原子事实由调用方领域模块负责（本服务不代替业务事务）；本服务负责
 * 外部写入、写后定向读回、15 分钟有界重试和复合命令补偿编排。
 */

import { Inject, Injectable } from '@nestjs/common';

import {
  CASDOOR_CLOCK,
  CASDOOR_WRITE_PORT,
  type CasdoorWritePort,
  type ClockPort,
} from '../contracts/ports';
import type { EvidenceRef, ExternalResult } from '../contracts/external-result';
import { classifyMembershipReadback, classifyProfileReadback } from '../domain/result-classifier';
import type {
  CompositeWritePlan,
  CompositeWriteStep,
  WriteConclusion,
  WriteConclusionKind,
} from '../contracts/types';

export interface GroupMembershipWriteInput {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly groupRef: { owner: string; name: string };
  readonly originalMemberIds: readonly string[];
  readonly targetMemberIds: readonly string[];
  readonly requestedAt: string;
  readonly deadline?: string;
}

export interface ProfileWriteInput {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly externalUserId: string;
  readonly originalUser: unknown;
  readonly patch: Readonly<Record<string, unknown>>;
  readonly requestedAt: string;
  readonly deadline?: string;
}

const DEFAULT_GROUP_RETRY_MS = 15 * 60 * 1000;
const RETRY_BASE_DELAY_MS = 200;
const RETRY_MAX_DELAY_MS = 2_000;

@Injectable()
export class CasdoorWriteService {
  constructor(
    @Inject(CASDOOR_WRITE_PORT)
    private readonly write: CasdoorWritePort,
    @Inject(CASDOOR_CLOCK)
    private readonly clock: ClockPort,
  ) {}

  async writeGroupMembership(input: GroupMembershipWriteInput): Promise<WriteConclusion> {
    const startedAt = this.clock.now();
    // CAS-WR-011：deadline 必须解析为合法时间，否则回退到默认 15 分钟窗口，
    // 避免 Invalid Date（getTime() 为 NaN）使超时守卫恒为假而失效。
    const parsedDeadline = input.deadline ? Date.parse(input.deadline) : NaN;
    const deadline = new Date(
      Number.isFinite(parsedDeadline)
        ? parsedDeadline
        : startedAt.getTime() + DEFAULT_GROUP_RETRY_MS,
    );
    const attempts: string[] = [];
    const evidence: EvidenceRef[] = [];
    let attempt = 0;
    const maxAttemptsPerInvocation = 3;

    // original/target 在重试循环内恒定，add/remove 差异仅依赖两者，提前一次算好，
    // 避免每次尝试反复重算（CAS-WR-012）。
    const original = new Set(input.originalMemberIds);
    const target = new Set(input.targetMemberIds);
    const addIds = [...target].filter((id) => !original.has(id));
    const removeIds = [...original].filter((id) => !target.has(id));

    while (true) {
      attempt += 1;
      const attemptId = `${input.commandId}:${attempt}`;
      attempts.push(attemptId);
      const now = this.clock.now();
      if (now.getTime() > deadline.getTime()) {
        return this.conclusion(
          'MANUAL_INTERVENTION_REQUIRED',
          input.commandId,
          attempts,
          evidence,
          '15 分钟自动重试上限已到，需人工核验',
          false,
          now,
        );
      }

      const transportResults: ExternalResult<void>[] = [];
      if (addIds.length > 0) {
        transportResults.push(
          await this.write.addGroupMembers({
            ref: input.groupRef,
            userIds: addIds,
            requestId: attemptId,
            trackingId: input.idempotencyKey,
          }),
        );
      }
      if (removeIds.length > 0) {
        transportResults.push(
          await this.write.removeGroupMembers({
            ref: input.groupRef,
            userIds: removeIds,
            requestId: attemptId,
            trackingId: input.idempotencyKey,
          }),
        );
      }
      if (transportResults.length === 0) {
        return this.conclusion(
          'CONFIRMED',
          input.commandId,
          attempts,
          evidence,
          '目标与原值一致，无需外部写入',
          false,
          now,
        );
      }

      const readback = await this.write.readbackGroupMembers({
        ref: input.groupRef,
        requestId: attemptId,
        trackingId: input.idempotencyKey,
      });
      evidence.push({
        observedAt: readback.evidence.observedAt,
        instance: readback.evidence.instance,
        attemptId,
        version: readback.evidence.version,
      });

      // CAS-WR-008：传输层不可用优先于读回分类判定。写请求未送达时读回往往仍
      // 显示原值，若按分类走会误判为 OLD_VALUE_STILL_PRESENT，掩盖真实故障。
      if (transportResults.some((r) => r.status === 'DEPENDENCY_UNAVAILABLE')) {
        return this.conclusion(
          'DEPENDENCY_UNAVAILABLE',
          input.commandId,
          attempts,
          evidence,
          '依赖不可用，需按故障规则降级',
          true,
          now,
        );
      }

      const classification = classifyMembershipReadback({
        originalMemberIds: input.originalMemberIds,
        expectedMemberIds: input.targetMemberIds,
        readbackMemberIds:
          readback.status === 'TRUSTED_CURRENT'
            ? (readback.value as readonly string[] | null)
            : null,
        readbackStatus: readback.status,
      });

      if (classification === 'TARGET') {
        return this.conclusion(
          'CONFIRMED',
          input.commandId,
          attempts,
          evidence,
          '写后定向读回确认目标关系已形成',
          false,
          now,
        );
      }
      if (classification === 'THIRD' || classification === 'PARTIAL') {
        return this.conclusion(
          classification === 'THIRD' ? 'THIRD_VALUE' : 'PARTIAL_SUCCESS',
          input.commandId,
          attempts,
          evidence,
          classification === 'THIRD' ? '读回第三值，不自动覆盖' : '部分成功，不得授予部分新权限',
          true,
          now,
        );
      }
      if (classification === 'NOT_FOUND') {
        return this.conclusion(
          'FAILED',
          input.commandId,
          attempts,
          evidence,
          '目标 Group 不存在',
          false,
          now,
        );
      }
      // ORIGINAL / UNKNOWN：本调用内做有界重试；仍不确定交给任务调度继续。
      if (attempt >= maxAttemptsPerInvocation) {
        const kind = classification === 'ORIGINAL' ? 'OLD_VALUE_STILL_PRESENT' : 'UNCERTAIN';
        return this.conclusion(
          kind,
          input.commandId,
          attempts,
          evidence,
          kind === 'OLD_VALUE_STILL_PRESENT' ? '多次读回仍为原值' : '多次读回仍不确定',
          true,
          now,
        );
      }
      // 指数退避后再重试，避免瞬时抖动时连续空转。maxAttemptsPerInvocation=3 意味着
      // 循环内实际只在 attempt=1、2 时退避，即 200ms → 400ms（不会到达 800ms）。
      await this.backoff(attempt);
    }
  }

  private async backoff(attempt: number): Promise<void> {
    const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  async updateUserProfile(input: ProfileWriteInput): Promise<WriteConclusion> {
    const now = this.clock.now();
    const attemptId = `${input.commandId}:1`;
    const transport = await this.write.updateUser({
      externalUserId: input.externalUserId,
      patch: input.patch,
      requestId: attemptId,
      trackingId: input.idempotencyKey,
    });
    const readback = await this.write.readbackUser({
      externalUserId: input.externalUserId,
      requestId: attemptId,
      trackingId: input.idempotencyKey,
    });
    const evidence: EvidenceRef[] = [readback.evidence];
    const classification = classifyProfileReadback({
      originalValue: input.originalUser,
      expectedValue: { ...(input.originalUser as object), ...input.patch },
      readbackValue: readback.status === 'TRUSTED_CURRENT' ? readback.value : null,
      readbackStatus: readback.status,
    });
    // CAS-WR-009：传输层不可用优先于读回分类判定，避免把写未送达误报为
    // OLD_VALUE_STILL_PRESENT / UNCERTAIN，掩盖真实故障。
    if (transport.status === 'DEPENDENCY_UNAVAILABLE') {
      return this.conclusion(
        'DEPENDENCY_UNAVAILABLE',
        input.commandId,
        [attemptId],
        evidence,
        '依赖不可用',
        true,
        now,
      );
    }
    if (classification === 'TARGET') {
      return this.conclusion(
        'CONFIRMED',
        input.commandId,
        [attemptId],
        evidence,
        '资料写后定向读回确认',
        false,
        now,
      );
    }
    if (classification === 'ORIGINAL') {
      return this.conclusion(
        'OLD_VALUE_STILL_PRESENT',
        input.commandId,
        [attemptId],
        evidence,
        '读回仍为原值，等待同步',
        true,
        now,
      );
    }
    if (classification === 'THIRD') {
      return this.conclusion(
        'THIRD_VALUE',
        input.commandId,
        [attemptId],
        evidence,
        '资料第三值冲突，需本人选择',
        false,
        now,
      );
    }
    return this.conclusion(
      'UNCERTAIN',
      input.commandId,
      [attemptId],
      evidence,
      '响应不确定，需定向读回',
      true,
      now,
    );
  }

  async executeCompositePlan(
    plan: CompositeWritePlan,
    input: {
      readonly commandId: string;
      readonly idempotencyKey: string;
    },
  ): Promise<WriteConclusion> {
    const now = this.clock.now();
    const attempts: string[] = [];
    const evidence: EvidenceRef[] = [];
    const executedAdds: CompositeWriteStep[] = [];

    // CAS-Q-001 方案 A：新增按基础/低权限 → 具体/高权限；撤权按具体 → 基础。
    const ordered = [...plan.steps].sort((a, b) => {
      if (a.action === 'ADD' && b.action === 'ADD') return a.privilegeRank - b.privilegeRank;
      if (a.action === 'REMOVE' && b.action === 'REMOVE') return b.privilegeRank - a.privilegeRank;
      // 先做低风险 ADD，再做 REMOVE，减少临时越权窗口。
      return a.action === 'ADD' ? -1 : 1;
    });

    for (const step of ordered) {
      const result = await this.writeGroupMembership({
        commandId: `${plan.commandId}:${step.stepId}`,
        idempotencyKey: `${input.idempotencyKey}:${step.stepId}`,
        groupRef: step.groupRef,
        originalMemberIds: step.originalMemberIds,
        targetMemberIds: step.expectedMemberIds,
        requestedAt: now.toISOString(),
        deadline: plan.deadline,
      });
      attempts.push(...result.attemptIds);
      evidence.push(...result.evidence);
      if (result.kind !== 'CONFIRMED') {
        // CAS-WR-010 补偿：当前失败的 ADD step 可能已部分写入（如 PARTIAL_SUCCESS），
        // 与已确认的 ADD step 一并逆序回滚，确保不残留任何新增的部分权限。
        const toRollback = [...executedAdds];
        if (step.action === 'ADD') toRollback.push(step);
        let compensationConfirmed = true;
        if (toRollback.length > 0) {
          // 逆序移除本命令已新增关系，并对每个补偿移除做读回确认；
          // 任一移除未确认时不得声称已完全回滚，保留人工核验。
          for (const added of [...toRollback].reverse()) {
            const removeIds = added.expectedMemberIds.filter(
              (id) => !added.originalMemberIds.includes(id),
            );
            if (removeIds.length === 0) continue;
            const removeResult = await this.write.removeGroupMembers({
              ref: added.groupRef,
              userIds: removeIds,
              requestId: `${plan.commandId}:comp:${added.stepId}`,
              trackingId: input.idempotencyKey,
            });
            if (removeResult.status !== 'TRUSTED_CURRENT') {
              compensationConfirmed = false;
              continue;
            }
            const verify = await this.write.readbackGroupMembers({
              ref: added.groupRef,
              requestId: `${plan.commandId}:comp-verify:${added.stepId}`,
              trackingId: input.idempotencyKey,
            });
            const verifiedMembers = verify.status === 'TRUSTED_CURRENT' ? verify.value : null;
            if (verifiedMembers === null || removeIds.some((id) => verifiedMembers.includes(id))) {
              compensationConfirmed = false;
            }
          }
        }
        return this.conclusion(
          result.kind === 'DEPENDENCY_UNAVAILABLE'
            ? 'DEPENDENCY_UNAVAILABLE'
            : 'MANUAL_INTERVENTION_REQUIRED',
          plan.commandId,
          attempts,
          evidence,
          compensationConfirmed
            ? '复合 Group 写入未全部确认，已回滚本命令新增/可能部分写入的关系并读回确认，不授予部分新权限'
            : '复合 Group 写入未全部确认，且补偿移除未完全确认，可能残留新增关系，需人工核验',
          result.retryable,
          now,
        );
      }
      if (step.action === 'ADD') executedAdds.push(step);
    }

    return this.conclusion(
      'CONFIRMED',
      plan.commandId,
      attempts,
      evidence,
      '复合 Group 全部写后读回确认',
      false,
      now,
    );
  }

  private conclusion(
    kind: WriteConclusionKind,
    commandId: string,
    attemptIds: readonly string[],
    evidence: readonly EvidenceRef[],
    reason: string,
    retryable: boolean,
    now: Date,
  ): WriteConclusion {
    return {
      kind,
      commandId,
      attemptIds: [...attemptIds],
      evidence: [...evidence],
      reason,
      retryable,
      completedAt: now.toISOString(),
    };
  }
}
