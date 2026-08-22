import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { InvitationStateMachine } from '../../domain/state-machines/invitation-state-machine';
import type { Invitation, InvitationHistoryEvent } from '../../domain/models/invitation';
import { InvitationKind } from '../../domain/models/invitation';
import { InvitationPolicy } from '../../domain/services/invitation-policy';
import { INVITATION_REPOSITORY } from '../../infrastructure/invitation-repository';
import type { InvitationRepository } from '../../infrastructure/invitation-repository';

/** 创建普通录取邀请输入（SRS-SM-INV-001：新建→待处理；REC-024/REC-045） */
export interface CreateInvitationInput {
  readonly issuerId: string;
  readonly issuerRoles: readonly string[];
  /** 发出方所属社团（必须与目标 clubId 一致，防止跨社团发文） */
  readonly issuerClubId: string;
  readonly inviteeId: string;
  readonly clubId: string;
  /** 已复核部门录取决定（REC-045 复核前置） */
  readonly decisionRef: string;
  /** 有效期（平台范围由调用方校验） */
  readonly expiresAt: string;
  /** 邀请类型（默认普通录取邀请） */
  readonly kind?: InvitationKind;
}

/** 前置失败（IFC-ERR-006/IFC-ERR-009 幂等冲突） */
export class CreateInvitationError extends Error {
  constructor(code: 'IFC-ERR-006' | 'IFC-ERR-009', message: string) {
    super(`${code}: ${message}`);
    this.name = 'CreateInvitationError';
  }
}

/**
 * 创建并发出普通录取邀请（SRS-SM-INV-001：新建→待处理）。
 *
 * - 仅负责人/人事（部门负责人无权）；
 * - 已复核部门录取决定（decisionRef）；
 * - 同社团同对象最多一份待处理邀请（幂等约束）；
 * - 原子创建不可变邀请内容、有效期、结论关联和通知事实（占位）；
 *   不建立成员关系。
 */
@Injectable()
export class CreateInvitationCommand {
  constructor(
    @Inject(INVITATION_REPOSITORY) private readonly repo: InvitationRepository,
    private readonly policy: InvitationPolicy,
    private readonly stateMachine: InvitationStateMachine = new InvitationStateMachine(),
  ) {}

  async execute(input: CreateInvitationInput): Promise<Invitation> {
    // 仅目标社团的负责人/人事可发邀请（IFC-ERR-003）
    this.policy.assertCanIssueForClub(input.issuerRoles, input.issuerClubId, input.clubId);
    // 空值安全校验：调用方可能误传 undefined/空串，避免 trim() 抛裸 TypeError
    if ((input.decisionRef ?? '').trim().length === 0) {
      throw new CreateInvitationError('IFC-ERR-006', '需要已复核的部门录取决定');
    }
    const expires = Date.parse(input.expiresAt);
    if (!Number.isFinite(expires)) {
      throw new CreateInvitationError('IFC-ERR-006', '无效的有效期');
    }
    if (expires <= Date.now()) {
      throw new CreateInvitationError('IFC-ERR-006', '有效期必须晚于当前时间');
    }
    // 同社团同对象最多一份待处理邀请（MEM-018：重复待处理 → IFC-ERR-009 幂等冲突）
    const existing = await this.repo.findPending(input.clubId, input.inviteeId);
    if (existing !== null) {
      throw new CreateInvitationError('IFC-ERR-009', '同社团同对象已存在待处理邀请');
    }

    const now = new Date().toISOString();
    const created: InvitationHistoryEvent = {
      at: now,
      type: 'CREATED',
      by: input.issuerId,
    };
    const invitation: Invitation = {
      invitationId: randomUUID(),
      kind: input.kind ?? InvitationKind.RECRUIT_OFFER,
      inviteeId: input.inviteeId,
      clubId: input.clubId,
      issuerId: input.issuerId,
      decisionRef: input.decisionRef,
      reissuedFromId: null, // 首次创建：无重发来源
      status: this.stateMachine.transition('NEW', 'PENDING'),
      version: 1,
      createdAt: now,
      expiresAt: input.expiresAt,
      acceptedAt: null,
      activation: null,
      history: [created],
    };
    try {
      // 并发兜底：仓储在保存 PENDING 时强制执行“同社团同对象最多一份待处理”
      // 唯一约束（模拟 PostgreSQL 部分唯一索引），防止并发创建击穿幂等（IFC-ERR-009）。
      await this.repo.save(invitation);
    } catch (err) {
      if (err instanceof Error && err.message.includes('IFC-ERR-009')) {
        throw new CreateInvitationError('IFC-ERR-009', '同社团同对象已存在待处理邀请');
      }
      throw err;
    }
    return invitation;
  }
}
