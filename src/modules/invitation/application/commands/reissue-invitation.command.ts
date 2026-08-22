import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { InvitationStateMachine } from '../../domain/state-machines/invitation-state-machine';
import type { Invitation } from '../../domain/models/invitation';
import { InvitationPolicy } from '../../domain/services/invitation-policy';
import { INVITATION_REPOSITORY } from '../../infrastructure/invitation-repository';
import type { InvitationRepository } from '../../infrastructure/invitation-repository';

/** 重发邀请输入（SRS-SM-INV-001：已拒绝/已撤回/已过期/强制失效→新邀请待处理；REC-024） */
export interface ReissueInvitationInput {
  readonly oldInvitationId: string;
  readonly issuerId: string;
  readonly issuerRoles: readonly string[];
  /** 新有效期（重新创建；平台范围由调用方校验） */
  readonly newExpiresAt: string;
  /** 当前资格/结论仍允许（调用方复核） */
  readonly eligibilityOk: boolean;
}

/** 前置失败（IFC-ERR-003/006/007/009） */
export class ReissueInvitationError extends Error {
  constructor(
    code: 'IFC-ERR-003' | 'IFC-ERR-006' | 'IFC-ERR-007' | 'IFC-ERR-009',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ReissueInvitationError';
  }
}

/**
 * 重新发出邀请（SRS-SM-INV-001）。
 *
 * - 仅负责人/人事（部门负责人无权）；
 * - 仅已拒绝/已撤回/已过期/强制失效可重发（**已接受不可重发**）；
 * - 创建**全新邀请对象**并关联旧邀请；旧邀请不修改、历史保留（不得复活旧邀请）；
 * - 重新校验全部约束（对象资格/结论/有效期/重复待处理）。
 */
@Injectable()
export class ReissueInvitationCommand {
  constructor(
    @Inject(INVITATION_REPOSITORY) private readonly repo: InvitationRepository,
    private readonly policy: InvitationPolicy,
    private readonly stateMachine: InvitationStateMachine = new InvitationStateMachine(),
  ) {}

  async execute(input: ReissueInvitationInput): Promise<Invitation> {
    this.policy.assertCanIssue(input.issuerRoles);
    if (!input.eligibilityOk) {
      throw new ReissueInvitationError('IFC-ERR-006', '当前资格/结论不允许重发');
    }
    const old = await this.repo.load(input.oldInvitationId);
    if (old === null) {
      throw new ReissueInvitationError('IFC-ERR-006', '原邀请不存在');
    }
    if (!this.stateMachine.canReissue(old.status)) {
      throw new ReissueInvitationError('IFC-ERR-007', '当前状态不可重发（已接受不可重发）');
    }
    if (!Number.isFinite(Date.parse(input.newExpiresAt))) {
      throw new ReissueInvitationError('IFC-ERR-006', '无效的新有效期');
    }
    // 同社团同对象最多一份待处理邀请（重新校验；MEM-018）
    const pending = await this.repo.findPending(old.clubId, old.inviteeId);
    if (pending !== null) {
      throw new ReissueInvitationError('IFC-ERR-009', '同社团同对象已存在待处理邀请');
    }

    const now = new Date().toISOString();
    const fresh: Invitation = {
      invitationId: randomUUID(),
      kind: old.kind,
      inviteeId: old.inviteeId,
      clubId: old.clubId,
      issuerId: input.issuerId,
      decisionRef: old.decisionRef,
      reissuedFromId: old.invitationId, // 强引用被重发的旧邀请（REC-024 重发链）
      status: this.stateMachine.transition('NEW', 'PENDING'),
      version: 1,
      createdAt: now,
      expiresAt: input.newExpiresAt,
      acceptedAt: null,
      activation: null,
      history: [
        {
          at: now,
          type: 'CREATED',
          by: input.issuerId,
          note: `reissue-of:${old.invitationId}`,
        },
      ],
    };
    try {
      // 并发兜底：仓储保存 PENDING 时强制执行唯一约束（模拟 PostgreSQL 部分唯一索引），
      // 防止并发重发击穿“同社团同对象最多一份待处理”幂等（IFC-ERR-009）。
      await this.repo.save(fresh);
    } catch (err) {
      if (err instanceof Error && err.message.includes('IFC-ERR-009')) {
        throw new ReissueInvitationError('IFC-ERR-009', '同社团同对象已存在待处理邀请');
      }
      throw err;
    }
    return fresh;
  }
}
