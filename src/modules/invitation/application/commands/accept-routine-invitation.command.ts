import { Inject, Injectable } from '@nestjs/common';
import { RoutineInvitationStateMachine } from '../../domain/state-machines/routine-invitation-state-machine';
import type { RoutineInvitation } from '../../domain/models/routine-invitation';
import { InvitationPolicy } from '../../domain/services/invitation-policy';
import { ROUTINE_INVITATION_REPOSITORY } from '../../infrastructure/routine-invitation-repository';
import type { RoutineInvitationRepository } from '../../infrastructure/routine-invitation-repository';

/** 整体接受输入（SRS-SM-MEM-004：待处理→已接受待生效/目标已成为成员） */
export interface AcceptRoutineInput {
  readonly routineInvitationId: string;
  readonly principalId: string;
  /** 账号有效/平台必需资料和邮箱验证完成/社团与初始部门有效（调用方复核） */
  readonly eligibilityOk: boolean;
  /** 接受时回读确认目标已是本社团当前成员（MEM-018） */
  readonly alreadyMember: boolean;
}

/** 前置失败（IFC-ERR-003/006/007） */
export class AcceptRoutineError extends Error {
  constructor(code: 'IFC-ERR-003' | 'IFC-ERR-006' | 'IFC-ERR-007', message: string) {
    super(`${code}: ${message}`);
    this.name = 'AcceptRoutineError';
  }
}

/**
 * 被邀请人整体接受（SRS-SM-MEM-004：待处理→已接受待生效）。
 *
 * - 仅邀请指定对象本人；**只能整体接受**（不可拆分）；
 * - 账号有效、资料门满足、社团/初始部门有效、仍非成员、未过期；
 * - 接受时回读已通过其他路径成为成员 → **目标已成为成员**（不记录为本邀请
 *   已接受、不创建新经历）；
 * - 进入"已接受待生效"：Casdoor 社团及可选部门关系全部回读确认前不开放权限；
 * - 与撤回/过期竞争只一个成功（compareAndSwap）；重复接受返回原结果。
 */
@Injectable()
export class AcceptRoutineInvitationCommand {
  constructor(
    @Inject(ROUTINE_INVITATION_REPOSITORY) private readonly repo: RoutineInvitationRepository,
    private readonly policy: InvitationPolicy,
    private readonly stateMachine: RoutineInvitationStateMachine = new RoutineInvitationStateMachine(),
  ) {}

  async execute(input: AcceptRoutineInput): Promise<RoutineInvitation> {
    const invitation = await this.repo.load(input.routineInvitationId);
    if (invitation === null) {
      throw new AcceptRoutineError('IFC-ERR-006', '邀请不存在');
    }
    this.policy.assertIsInvitee(input.principalId, invitation.inviteeId);
    if (
      invitation.status === 'ACCEPTED_PENDING_ACTIVATION' ||
      invitation.status === 'ACTIVATED' ||
      invitation.status === 'SYNC_FAILED_PENDING_RETRY' ||
      invitation.status === 'HIGH_PRIORITY_SYNC_ANOMALY'
    ) {
      return invitation; // 幂等：接受事实已建立
    }
    if (!input.eligibilityOk) {
      throw new AcceptRoutineError('IFC-ERR-006', '账号/资料/资格校验未通过');
    }
    if (invitation.status !== 'PENDING') {
      throw new AcceptRoutineError('IFC-ERR-007', '邀请不在待处理状态，无法接受');
    }
    if (Date.parse(invitation.expiresAt) < Date.now()) {
      throw new AcceptRoutineError('IFC-ERR-006', '邀请已过期');
    }

    const now = new Date().toISOString();
    // 接受时回读已是成员 → 目标已成为成员（关闭但不记录为本邀请已接受）
    if (input.alreadyMember) {
      const closed: RoutineInvitation = {
        ...invitation,
        status: this.stateMachine.transition('PENDING', 'TARGET_ALREADY_MEMBER'),
        version: invitation.version + 1,
        history: [
          ...invitation.history,
          { at: now, type: 'TARGET_ALREADY_MEMBER', by: input.principalId },
        ],
      };
      if (!(await this.repo.compareAndSwap(invitation, closed))) {
        throw new AcceptRoutineError('IFC-ERR-007', '邀请状态已被并发变更');
      }
      return closed;
    }

    // 整体接受 → 已接受待生效（Casdoor 回读确认前不开放权限；MEM-018/ORG-027）
    const accepted: RoutineInvitation = {
      ...invitation,
      status: this.stateMachine.transition('PENDING', 'ACCEPTED_PENDING_ACTIVATION'),
      version: invitation.version + 1,
      acceptedAt: now,
      syncStatus: 'PENDING',
      history: [...invitation.history, { at: now, type: 'ACCEPTED', by: input.principalId }],
    };
    if (!(await this.repo.compareAndSwap(invitation, accepted))) {
      throw new AcceptRoutineError('IFC-ERR-007', '邀请状态已被并发变更，接受失败');
    }
    return accepted;
  }
}
