import { Inject, Injectable } from '@nestjs/common';

import type { DepartmentApplication } from '../../domain/models/department-application';
import { DepartmentApplicationPolicy } from '../../domain/services/application-policy';
import { DepartmentApplicationStateMachine } from '../../domain/state-machines/department-application.state-machine';
import { DepartmentApplicationStatus } from '../../domain/state-machines/department-application.state-machine';
import { DEPARTMENT_APPLICATION_REPOSITORY } from '../../infrastructure/department-application-repository';
import type { DepartmentApplicationRepository } from '../../infrastructure/department-application-repository';
import { MEMBERSHIP_NOTIFICATION_PORT, saveNotificationFact } from '../ports';
import type { MembershipNotificationPort } from '../ports';
import { InMemoryMembershipNotificationPort } from '../../infrastructure/in-memory-stubs';

/** 撤回输入（A2：待审批 → 已撤回；本人二次确认） */
export interface WithdrawDepartmentApplicationInput {
  readonly applicationId: string;
  /** 操作者＝申请人本人 */
  readonly operatorId: string;
  /** 本人二次确认 */
  readonly secondConfirmed: boolean;
}

/** 撤回失败（IFC-ERR-003/006/007） */
export class WithdrawApplicationError extends Error {
  constructor(
    readonly code: 'IFC-ERR-003' | 'IFC-ERR-006' | 'IFC-ERR-007',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'WithdrawApplicationError';
  }
}

/**
 * 撤回部门关系申请（A2）。
 *
 * - 仅申请人本人、仅待审批状态、必须二次确认；
 * - 撤回与批准/驳回竞争只一个成功（版本比较交换；失败提示重试读取最新状态）；
 * - 关闭审批待办并保存撤回事件；不改变当前关系。
 */
@Injectable()
export class WithdrawDepartmentApplicationCommand {
  private readonly policy = new DepartmentApplicationPolicy();
  private readonly stateMachine = new DepartmentApplicationStateMachine();

  constructor(
    @Inject(DEPARTMENT_APPLICATION_REPOSITORY)
    private readonly repo: DepartmentApplicationRepository,
    @Inject(MEMBERSHIP_NOTIFICATION_PORT)
    private readonly notifications: MembershipNotificationPort = new InMemoryMembershipNotificationPort(),
  ) {}

  async execute(input: WithdrawDepartmentApplicationInput): Promise<DepartmentApplication> {
    const app = await this.repo.load(input.applicationId);
    if (app === null) {
      throw new WithdrawApplicationError('IFC-ERR-006', '申请不存在');
    }
    this.policy.assertWithdrawConfirmed(app.applicantId, input.operatorId, input.secondConfirmed);

    if (!this.stateMachine.canWithdraw(app.status)) {
      // 已批准待执行后关闭撤回能力（ORG-036）
      throw new WithdrawApplicationError(
        'IFC-ERR-007',
        `当前状态 ${app.status} 不允许撤回（批准后关闭撤回能力）`,
      );
    }

    const nowIso = new Date().toISOString();
    const next: DepartmentApplication = {
      ...app,
      status: this.stateMachine.transition(app.status, DepartmentApplicationStatus.WITHDRAWN),
      version: app.version + 1,
      history: [...app.history, { at: nowIso, type: 'WITHDRAWN', by: input.operatorId }],
    };
    // 单胜者竞争：与批准/驳回并发只一个成功
    const swapped = await this.repo.compareAndSwap(app, next);
    if (!swapped) {
      throw new WithdrawApplicationError(
        'IFC-ERR-007',
        '申请状态已变化（与审批并发），请刷新后按实际状态操作',
      );
    }

    await saveNotificationFact(this.notifications, {
      kind: 'DEPT_APPLICATION_WITHDRAWN',
      toUserIds: [app.applicantId],
      clubId: app.clubId,
      dedupKey: `DEPT_APPLICATION_WITHDRAWN:${app.applicationId}:${next.version}`,
      title: '申请已撤回',
      body: '你已撤回该部门关系申请。',
    });
    return next;
  }
}
