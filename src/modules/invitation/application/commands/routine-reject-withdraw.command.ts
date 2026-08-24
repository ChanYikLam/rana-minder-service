import { Inject, Injectable } from '@nestjs/common';
import { RoutineInvitationStateMachine } from '../../domain/state-machines/routine-invitation-state-machine';
import type { RoutineInvitation } from '../../domain/models/routine-invitation';
import { InvitationPolicy } from '../../domain/services/invitation-policy';
import { ROUTINE_INVITATION_REPOSITORY } from '../../infrastructure/routine-invitation-repository';
import type { RoutineInvitationRepository } from '../../infrastructure/routine-invitation-repository';

/** 拒绝/撤回输入（SRS-SM-MEM-004：待处理→已拒绝/已撤回） */
export interface RoutineRejectInput {
  readonly routineInvitationId: string;
  readonly principalId: string;
}

export interface RoutineWithdrawInput {
  readonly routineInvitationId: string;
  readonly principalId: string;
  readonly principalRoles: readonly string[];
}

/** 前置失败 */
export class RoutineRejectError extends Error {
  readonly code: 'IFC-ERR-003' | 'IFC-ERR-006' | 'IFC-ERR-007';
  constructor(code: 'IFC-ERR-003' | 'IFC-ERR-006' | 'IFC-ERR-007', message: string) {
    super(`${code}: ${message}`);
    this.name = 'RoutineRejectError';
    this.code = code;
  }
}

/** 被邀请人拒绝（待处理→已拒绝；MEM-018） */
@Injectable()
export class RejectRoutineInvitationCommand {
  constructor(
    @Inject(ROUTINE_INVITATION_REPOSITORY) private readonly repo: RoutineInvitationRepository,
    private readonly policy: InvitationPolicy,
    private readonly stateMachine: RoutineInvitationStateMachine = new RoutineInvitationStateMachine(),
  ) {}

  async execute(input: RoutineRejectInput): Promise<RoutineInvitation> {
    const invitation = await this.repo.load(input.routineInvitationId);
    if (invitation === null) {
      throw new RoutineRejectError('IFC-ERR-006', '邀请不存在');
    }
    this.policy.assertIsInvitee(input.principalId, invitation.inviteeId);
    if (invitation.status === 'REJECTED') {
      return invitation; // 幂等
    }
    if (invitation.status !== 'PENDING') {
      throw new RoutineRejectError('IFC-ERR-007', '仅待处理邀请可拒绝');
    }
    const now = new Date().toISOString();
    const rejected: RoutineInvitation = {
      ...invitation,
      status: this.stateMachine.transition('PENDING', 'REJECTED'),
      version: invitation.version + 1,
      history: [...invitation.history, { at: now, type: 'REJECTED', by: input.principalId }],
    };
    if (!(await this.repo.compareAndSwap(invitation, rejected))) {
      throw new RoutineRejectError('IFC-ERR-007', '邀请状态已被并发变更');
    }
    return rejected;
  }
}

/** 发送方撤回（待处理→已撤回；负责人/人事；MEM-018） */
@Injectable()
export class WithdrawRoutineInvitationCommand {
  constructor(
    @Inject(ROUTINE_INVITATION_REPOSITORY) private readonly repo: RoutineInvitationRepository,
    private readonly policy: InvitationPolicy,
    private readonly stateMachine: RoutineInvitationStateMachine = new RoutineInvitationStateMachine(),
  ) {}

  async execute(input: RoutineWithdrawInput): Promise<RoutineInvitation> {
    this.policy.assertCanIssue(input.principalRoles);
    const invitation = await this.repo.load(input.routineInvitationId);
    if (invitation === null) {
      throw new RoutineRejectError('IFC-ERR-006', '邀请不存在');
    }
    if (invitation.status === 'WITHDRAWN') {
      return invitation; // 幂等
    }
    if (invitation.status !== 'PENDING') {
      throw new RoutineRejectError('IFC-ERR-007', '仅待处理邀请可撤回');
    }
    const now = new Date().toISOString();
    const withdrawn: RoutineInvitation = {
      ...invitation,
      status: this.stateMachine.transition('PENDING', 'WITHDRAWN'),
      version: invitation.version + 1,
      history: [...invitation.history, { at: now, type: 'WITHDRAWN', by: input.principalId }],
    };
    if (!(await this.repo.compareAndSwap(invitation, withdrawn))) {
      throw new RoutineRejectError('IFC-ERR-007', '邀请状态已被并发变更');
    }
    return withdrawn;
  }
}
