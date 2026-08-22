import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { InvitationStateMachine } from '../../domain/state-machines/invitation-state-machine';
import type { Invitation } from '../../domain/models/invitation';
import { InvitationPolicy } from '../../domain/services/invitation-policy';
import { INVITATION_REPOSITORY } from '../../infrastructure/invitation-repository';
import type { InvitationRepository } from '../../infrastructure/invitation-repository';

/** 接受邀请输入（SRS-SM-INV-001：待处理→已接受；REC-026） */
export interface AcceptInvitationInput {
  readonly invitationId: string;
  readonly principalId: string;
  /** 账号有效/资料门满足等由调用方复核后传入 */
  readonly eligibilityOk: boolean;
}

/** 接受前置失败（IFC-ERR-003/006/007） */
export class AcceptInvitationError extends Error {
  constructor(code: 'IFC-ERR-003' | 'IFC-ERR-006' | 'IFC-ERR-007', message: string) {
    super(`${code}: ${message}`);
    this.name = 'AcceptInvitationError';
  }
}

/**
 * 接受邀请（SRS-SM-INV-001：待处理→已接受；REC-026、JNT-016、ORG-027）。
 *
 * - 仅邀请指定本人；账号有效、资料门满足、未过期/撤回、对象仍具资格；
 * - **接受不可逆**：已接受不能撤销或改回待处理；
 * - **成员业务生效时间 = 接受时间**；原子保存接受事实＋成员生效意图；
 * - **Casdoor 写后回读确认前**激活状态为 PROCESSING（页面显示"成员身份
 *   生效处理中"），不得开放成员权限；
 * - **单胜者**：接受与撤回/过期/强制失效比较并交换只一个成功；
 * - 重复接受返回原结果（幂等）。
 */
@Injectable()
export class AcceptInvitationCommand {
  constructor(
    @Inject(INVITATION_REPOSITORY) private readonly repo: InvitationRepository,
    private readonly policy: InvitationPolicy,
    private readonly stateMachine: InvitationStateMachine = new InvitationStateMachine(),
  ) {}

  async execute(input: AcceptInvitationInput): Promise<Invitation> {
    const invitation = await this.repo.load(input.invitationId);
    if (invitation === null) {
      throw new AcceptInvitationError('IFC-ERR-006', '邀请不存在');
    }
    // 先校验本人（非本人不得读取/操作终态邀请）
    this.policy.assertIsInvitee(input.principalId, invitation.inviteeId);
    // 幂等：已接受 → 返回原结果
    if (invitation.status === 'ACCEPTED') {
      return invitation;
    }
    if (!input.eligibilityOk) {
      throw new AcceptInvitationError('IFC-ERR-006', '账号/资料/资格校验未通过');
    }
    if (!this.stateMachine.canTransition(invitation.status, 'ACCEPTED')) {
      throw new AcceptInvitationError('IFC-ERR-007', '邀请不在待处理状态，无法接受');
    }
    if (Date.parse(invitation.expiresAt) < Date.now()) {
      throw new AcceptInvitationError('IFC-ERR-006', '邀请已过期');
    }

    const now = new Date().toISOString();
    const accepted: Invitation = {
      ...invitation,
      status: this.stateMachine.transition(invitation.status, 'ACCEPTED'),
      version: invitation.version + 1,
      acceptedAt: now,
      activation: {
        intentionId: randomUUID(),
        invitationId: invitation.invitationId,
        memberEffectiveAt: now, // 成员业务生效时间 = 接受时间（REC-026）
        status: 'PROCESSING', // 回读确认前：成员身份生效处理中，不开放权限（ORG-027）
        attemptCount: 0,
      },
      history: [...invitation.history, { at: now, type: 'ACCEPTED', by: input.principalId }],
    };
    const swapped = await this.repo.compareAndSwap(invitation, accepted);
    if (!swapped) {
      // 与撤回/过期/强制失效竞争：单胜者失败 → 不改变
      throw new AcceptInvitationError('IFC-ERR-007', '邀请状态已被并发变更，接受失败');
    }
    return accepted;
  }
}
