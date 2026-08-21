/**
 * 提交姓名更正申请用例（IDN-016）。
 *
 * 学生提交申请（可附证明引用）；同一主体同时最多一条待裁决申请（重复提交
 * 拒绝，幂等）；旧姓名以调用方经 Casdoor 可信读回取得的观测值为准
 * （CAS-REC-001，本用例不伪造旧值）。申请事实与审计同事务提交（IFC-TX-001）。
 */

import { randomUUID } from 'node:crypto';
import { NameCorrectionRequest } from '../../domain/models/name-correction-request';
import type { NameCorrectionRequestRepository } from '../ports/name-correction-repository.port';
import type { IdentityAuditPort } from '../ports/identity-audit.port';
import { identityErrors } from '../errors';

const MAX_NAME_LENGTH = 64;
const MAX_PROOF_REFERENCE_LENGTH = 512;

export interface SubmitNameCorrectionInput {
  readonly subjectId: string;
  /** 提交时的可信观测旧姓名（调用方读回取得） */
  readonly oldName: string;
  readonly requestedName: string;
  /** 证明引用（可附证明；只存引用） */
  readonly proofReference: string | null;
  readonly now: Date;
  readonly actor: string;
  readonly traceId: string | null;
}

export interface SubmitNameCorrectionResult {
  readonly requestId: string;
}

export interface SubmitNameCorrectionUseCase {
  execute(input: SubmitNameCorrectionInput): Promise<SubmitNameCorrectionResult>;
}

export class DefaultSubmitNameCorrectionUseCase implements SubmitNameCorrectionUseCase {
  constructor(
    private readonly repository: NameCorrectionRequestRepository,
    private readonly audit: IdentityAuditPort,
  ) {}

  async execute(input: SubmitNameCorrectionInput): Promise<SubmitNameCorrectionResult> {
    if (input.oldName.trim().length === 0 || input.oldName.length > MAX_NAME_LENGTH) {
      throw identityErrors.preconditionFailed('旧姓名缺失或超长（须以可信观测为准）');
    }
    if (input.requestedName.trim().length === 0 || input.requestedName.length > MAX_NAME_LENGTH) {
      throw identityErrors.preconditionFailed('新姓名缺失或超长');
    }
    if (input.proofReference !== null && input.proofReference.length > MAX_PROOF_REFERENCE_LENGTH) {
      throw identityErrors.preconditionFailed('证明引用超长');
    }
    if (input.requestedName === input.oldName) {
      throw identityErrors.preconditionFailed('新姓名与旧姓名相同，无需更正');
    }

    const pending = await this.repository.findPendingBySubject(input.subjectId);
    if (pending !== null) {
      throw identityErrors.preconditionFailed('已有待裁决的姓名更正申请，请等待审批结果');
    }

    const request = NameCorrectionRequest.create({
      id: randomUUID(),
      subjectId: input.subjectId,
      oldName: input.oldName,
      requestedName: input.requestedName,
      proofReference: input.proofReference,
      now: input.now,
    });
    await this.repository.save(request.toSnapshot(), request.events, 0);

    await this.audit.record({
      type: 'NAME_CORRECTION',
      subjectId: input.subjectId,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        action: 'SUBMITTED',
        requestId: request.id,
        oldName: request.oldName,
        requestedName: request.requestedName,
        hasProof: input.proofReference !== null,
      },
    });

    return { requestId: request.id };
  }
}
