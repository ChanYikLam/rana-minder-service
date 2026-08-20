/**
 * 姓名更正裁决用例（IDN-016；CAS-REC-003 高风险命令）。
 *
 * 超级管理员审批（批准/驳回，须显式裁决与原因，二次确认）：
 * - 裁决者必须是超级管理员（ORG-029，失败关闭）；
 * - 高风险命令要求最近 10 分钟重新认证（HighRiskCommandGuard）；
 * - 批准：推进 APPROVED + 审计（保留旧姓名，IDN-016）+ 同事务登记
 *   profile_name_write 任务（Casdoor 写入由 job 租约执行，写后定向读回收口）；
 * - 驳回：推进 REJECTED + 审计；
 * - 裁决只一次（状态机终态），迟到重复裁决拒绝。
 */

import type { NameCorrectionRequestRepository } from '../ports/name-correction-repository.port';
import type { SuperAdminVerifierPort } from '../ports/super-admin-verifier.port';
import type { ProfileSyncTaskPort } from '../ports/profile-sync-task.port';
import type { IdentityAuditPort } from '../ports/identity-audit.port';
import type { NameCorrectionStateMachine } from '../../domain/state-machines/name-correction.state-machine';
import { NameCorrectionRequest } from '../../domain/models/name-correction-request';
import { HighRiskCommandGuard } from '../services/high-risk-command.guard';
import { IdentityCommandError, IdentityErrorCode, identityErrors } from '../errors';

export const NameCorrectionDecision = {
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
} as const;
export type NameCorrectionDecision =
  (typeof NameCorrectionDecision)[keyof typeof NameCorrectionDecision];

export interface ReviewNameCorrectionInput {
  readonly requestId: string;
  readonly decision: NameCorrectionDecision;
  readonly reason: string;
  readonly reviewerId: string;
  readonly now: Date;
  readonly actor: string;
  readonly traceId: string | null;
}

export interface ReviewNameCorrectionResult {
  readonly requestId: string;
  readonly decision: NameCorrectionDecision;
  readonly newName: string | null;
}

export interface ReviewNameCorrectionUseCase {
  execute(input: ReviewNameCorrectionInput): Promise<ReviewNameCorrectionResult>;
}

export class DefaultReviewNameCorrectionUseCase implements ReviewNameCorrectionUseCase {
  constructor(
    private readonly repository: NameCorrectionRequestRepository,
    private readonly superAdminVerifier: SuperAdminVerifierPort,
    private readonly reauthGuard: HighRiskCommandGuard,
    private readonly taskPort: ProfileSyncTaskPort,
    private readonly audit: IdentityAuditPort,
    private readonly machine: NameCorrectionStateMachine,
  ) {}

  async execute(input: ReviewNameCorrectionInput): Promise<ReviewNameCorrectionResult> {
    if (input.reason.trim().length === 0) {
      throw identityErrors.preconditionFailed('裁决原因必填（二次确认要求说明）');
    }
    if (!(await this.superAdminVerifier.isSuperAdmin(input.reviewerId))) {
      throw new IdentityCommandError(IdentityErrorCode.FORBIDDEN, '仅超级管理员可裁决姓名更正申请');
    }
    await this.reauthGuard.assertFreshReauth(input.reviewerId, input.now);

    const snapshot = await this.repository.load(input.requestId);
    if (snapshot === null) {
      throw identityErrors.notFound('姓名更正申请');
    }
    const request = NameCorrectionRequest.fromSnapshot(snapshot);

    const decided =
      input.decision === NameCorrectionDecision.APPROVE
        ? request.approve(this.machine, input.reviewerId, input.reason, input.now)
        : request.reject(this.machine, input.reviewerId, input.reason, input.now);
    if (!decided) {
      throw identityErrors.preconditionFailed('该申请已裁决或不可再裁决（终态）');
    }

    await this.repository.save(request.toSnapshot(), request.events);

    await this.audit.record({
      type: 'NAME_CORRECTION',
      subjectId: request.subjectId,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        action: input.decision,
        requestId: request.id,
        oldName: request.oldName,
        newName: input.decision === NameCorrectionDecision.APPROVE ? request.requestedName : null,
        reason: input.reason,
      },
    });

    if (input.decision === NameCorrectionDecision.APPROVE) {
      await this.taskPort.scheduleNameCorrectionWrite(
        request.id,
        request.subjectId,
        request.requestedName,
        input.now,
      );
    }

    return {
      requestId: request.id,
      decision: input.decision,
      newName: input.decision === NameCorrectionDecision.APPROVE ? request.requestedName : null,
    };
  }
}
