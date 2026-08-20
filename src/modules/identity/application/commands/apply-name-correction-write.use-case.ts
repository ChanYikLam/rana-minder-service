/**
 * 姓名更正写回收口用例（IDN-016；CAS-WR-006/007、CAS-REC-001）。
 *
 * 由 job 任务（profile_name_write）在租约内调用：对已批准申请执行
 * Casdoor 姓名写回；写后定向读回由 Casdoor 适配层保证（外部结果
 * SUCCESS 即目标已形成）。收口后打幂等标记（迟到重放安全，ADR-004）。
 *
 * 边界：
 * - 非 APPROVED 申请 → 拒绝执行（异常任务，重试至失败留证据）；
 * - 外部不可用/不确定 → 上抛（任务层退避重试）；
 * - 已收口（appliedAt 非空）→ 幂等返回，不重复写。
 */

import type { NameCorrectionRequestRepository } from '../ports/name-correction-repository.port';
import type { CasdoorUserPort } from '../ports/casdoor-user.port';
import type { IdentityAuditPort } from '../ports/identity-audit.port';
import { NameCorrectionRequest } from '../../domain/models/name-correction-request';
import { NameCorrectionState } from '../../domain/state-machines/name-correction.state-machine';
import { AuthoritativeProfileField } from '../../domain/models/profile-field';
import { identityErrors } from '../errors';

export interface ApplyNameCorrectionWriteInput {
  readonly requestId: string;
  readonly subjectId: string;
  readonly newName: string;
  readonly now: Date;
  readonly actor: string;
  readonly traceId: string | null;
}

export interface ApplyNameCorrectionWriteResult {
  readonly requestId: string;
  readonly synced: boolean;
}

export interface ApplyNameCorrectionWriteUseCase {
  execute(input: ApplyNameCorrectionWriteInput): Promise<ApplyNameCorrectionWriteResult>;
}

export class DefaultApplyNameCorrectionWriteUseCase implements ApplyNameCorrectionWriteUseCase {
  constructor(
    private readonly repository: NameCorrectionRequestRepository,
    private readonly casdoor: CasdoorUserPort,
    private readonly audit: IdentityAuditPort,
  ) {}

  async execute(input: ApplyNameCorrectionWriteInput): Promise<ApplyNameCorrectionWriteResult> {
    const snapshot = await this.repository.load(input.requestId);
    if (snapshot === null) {
      throw identityErrors.notFound('姓名更正申请');
    }
    if (snapshot.subjectId !== input.subjectId || snapshot.requestedName !== input.newName) {
      throw identityErrors.preconditionFailed('任务载荷与申请事实不一致，拒绝执行');
    }
    const request = NameCorrectionRequest.fromSnapshot(snapshot);
    if (request.appliedAt !== null) {
      return { requestId: request.id, synced: false }; // 幂等：迟到重放安全
    }
    if (request.status !== NameCorrectionState.APPROVED) {
      throw identityErrors.preconditionFailed('申请未批准，拒绝执行姓名写回');
    }

    const written = await this.casdoor.writeProfileField(
      input.subjectId,
      AuthoritativeProfileField.NAME,
      input.newName,
    );
    if (written.status !== 'SUCCESS') {
      throw identityErrors.externalUnknown('Casdoor 姓名写回未收口，任务重试');
    }

    request.markApplied(input.now);
    await this.repository.save(request.toSnapshot(), request.events);

    await this.audit.record({
      type: 'NAME_CORRECTION',
      subjectId: input.subjectId,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        action: 'APPLIED',
        requestId: request.id,
        oldName: request.oldName,
        newName: request.requestedName,
      },
    });

    return { requestId: request.id, synced: true };
  }
}
