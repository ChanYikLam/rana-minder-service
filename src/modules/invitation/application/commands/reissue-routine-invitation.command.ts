import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RoutineInvitationStateMachine } from '../../domain/state-machines/routine-invitation-state-machine';
import type { RoutineInvitation } from '../../domain/models/routine-invitation';
import { InvitationPolicy } from '../../domain/services/invitation-policy';
import { ROUTINE_INVITATION_REPOSITORY } from '../../infrastructure/routine-invitation-repository';
import type { RoutineInvitationRepository } from '../../infrastructure/routine-invitation-repository';

/** 重发输入（MEM-018：已拒绝/已撤回/已过期/目标已成为成员可重新发出） */
export interface ReissueRoutineInput {
  readonly oldInvitationId: string;
  readonly issuerId: string;
  readonly issuerRoles: readonly string[];
  readonly newExpiresAt: string;
  /** 重新校验全部约束（对象/成员/部门/有效期；调用方复核） */
  readonly revalidated: {
    accountValid: boolean;
    notMemberYet: boolean;
    departmentValid: boolean;
  };
}

/** 前置失败 */
export class ReissueRoutineError extends Error {
  constructor(
    code: 'IFC-ERR-003' | 'IFC-ERR-006' | 'IFC-ERR-007' | 'IFC-ERR-009',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ReissueRoutineError';
  }
}

/**
 * 重新发出常规入社邀请（SRS-SM-MEM-004；MEM-018）。
 *
 * - 已拒绝/已撤回/已过期/**目标已成为成员**可重新发出（**重新校验全部约束**）；
 * - 创建全新邀请对象并关联旧邀请；旧邀请不修改（不可复活）；
 * - 与接受/撤回/过期竞争只一个成功（重发以新对象独立存在）。
 */
@Injectable()
export class ReissueRoutineInvitationCommand {
  constructor(
    @Inject(ROUTINE_INVITATION_REPOSITORY) private readonly repo: RoutineInvitationRepository,
    private readonly policy: InvitationPolicy,
    private readonly stateMachine: RoutineInvitationStateMachine = new RoutineInvitationStateMachine(),
  ) {}

  async execute(input: ReissueRoutineInput): Promise<RoutineInvitation> {
    this.policy.assertCanIssue(input.issuerRoles);
    if (!input.revalidated.accountValid) {
      throw new ReissueRoutineError('IFC-ERR-006', '目标账号无效');
    }
    if (!input.revalidated.notMemberYet) {
      throw new ReissueRoutineError('IFC-ERR-006', '目标已是本社团成员');
    }
    const old = await this.repo.load(input.oldInvitationId);
    if (old === null) {
      throw new ReissueRoutineError('IFC-ERR-006', '原邀请不存在');
    }
    if (!this.stateMachine.canReissue(old.status)) {
      throw new ReissueRoutineError('IFC-ERR-007', '当前状态不可重发');
    }
    if (!Number.isFinite(Date.parse(input.newExpiresAt))) {
      throw new ReissueRoutineError('IFC-ERR-006', '无效的新有效期');
    }
    if (old.initialDepartmentId !== null && !input.revalidated.departmentValid) {
      throw new ReissueRoutineError('IFC-ERR-006', '初始部门无效');
    }
    // 同社团同对象最多一份待处理（重新校验）
    const pending = await this.repo.findPending(old.clubId, old.inviteeId);
    if (pending !== null) {
      throw new ReissueRoutineError('IFC-ERR-009', '同社团同对象已存在待处理邀请');
    }

    const now = new Date().toISOString();
    const fresh: RoutineInvitation = {
      routineInvitationId: randomUUID(),
      inviteeId: old.inviteeId,
      clubId: old.clubId,
      issuerId: input.issuerId,
      initialDepartmentId: old.initialDepartmentId,
      status: this.stateMachine.transition('NEW', 'PENDING'),
      version: 1,
      createdAt: now,
      expiresAt: input.newExpiresAt,
      acceptedAt: null,
      activatedAt: null,
      relationTargets: [
        { kind: 'GROUP', refId: old.clubId, confirmed: false },
        ...(old.initialDepartmentId !== null
          ? [{ kind: 'DEPARTMENT' as const, refId: old.initialDepartmentId, confirmed: false }]
          : []),
      ],
      syncStatus: null,
      attemptCount: 0,
      history: [
        {
          at: now,
          type: 'CREATED',
          by: input.issuerId,
          note: `reissue-of:${old.routineInvitationId}`,
        },
      ],
    };
    await this.repo.save(fresh);
    return fresh;
  }
}
