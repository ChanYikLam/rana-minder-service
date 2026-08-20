/**
 * 姓名更正写回任务处理器（job 模块；IDN-016、CAS-WR-006/007、CAS-REC-001）。
 *
 * 由 JobTaskRunner 以 profile_name_write 类型分发：以服务账号身份在单主体
 * RLS 事务边界内调用 ApplyNameCorrectionWriteUseCase（Casdoor 姓名写回 +
 * 幂等收口）。任务载荷只携带稳定引用（requestId/subjectId/newName）。
 *
 * 结算语义（ADR-004）：业务抛错 → 退避重试；已收口重放 → 幂等返回。
 */

import { identityErrors } from '../identity/application/errors';
import { IdentityUnitOfWork } from '../identity/infrastructure/unit-of-work';
import type { ApplyNameCorrectionWriteUseCase } from '../identity/application/commands/apply-name-correction-write.use-case';
import type { ClaimedJobTask } from './job-task.store';
import type { JobTaskHandler } from './job-task-runner';

export const JOB_SERVICE_ACCOUNT = 'svc:profile-name-write';

interface NameCorrectionWritePayload {
  readonly requestId: string;
  readonly subjectId: string;
  readonly newName: string;
}

export class ProfileNameWriteTaskHandler implements JobTaskHandler {
  constructor(
    private readonly useCase: ApplyNameCorrectionWriteUseCase,
    private readonly uow: IdentityUnitOfWork,
  ) {}

  async execute(task: ClaimedJobTask): Promise<void> {
    const payload = validatePayload(task.payload);
    await this.uow.run({ kind: 'single', subjectId: payload.subjectId }, () =>
      this.useCase.execute({
        requestId: payload.requestId,
        subjectId: payload.subjectId,
        newName: payload.newName,
        now: new Date(),
        actor: JOB_SERVICE_ACCOUNT,
        traceId: task.id,
      }),
    );
  }
}

function validatePayload(payload: unknown): NameCorrectionWritePayload {
  if (payload === null || typeof payload !== 'object') {
    throw identityErrors.preconditionFailed('任务载荷格式不正确');
  }
  const record = payload as Record<string, unknown>;
  if (
    typeof record.requestId !== 'string' ||
    typeof record.subjectId !== 'string' ||
    typeof record.newName !== 'string' ||
    record.requestId.length === 0 ||
    record.subjectId.length === 0 ||
    record.newName.length === 0
  ) {
    throw identityErrors.preconditionFailed('任务载荷格式不正确');
  }
  return { requestId: record.requestId, subjectId: record.subjectId, newName: record.newName };
}