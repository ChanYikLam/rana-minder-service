import { Inject, Injectable } from '@nestjs/common';
import type { Invitation } from '../../domain/models/invitation';
import { ActivationStatus } from '../../domain/models/invitation';
import { CASDOOR_RELATION_PORT } from '../../infrastructure/casdoor-relation-port';
import type { CasdoorRelationPort } from '../../infrastructure/casdoor-relation-port';
import { INVITATION_REPOSITORY } from '../../infrastructure/invitation-repository';
import type { InvitationRepository } from '../../infrastructure/invitation-repository';

/** 激活解析输入（系统任务：Casdoor 写后定向读回确认；REC-026、ORG-027） */
export interface ResolveActivationInput {
  readonly invitationId: string;
  /** 15 分钟仍失败（调用方任务计时传入） */
  readonly deadlineExceeded: boolean;
}

/** 激活解析结果 */
export interface ResolveActivationResult {
  readonly invitation: Invitation;
  /** 是否已生效（回读确认完成） */
  readonly activated: boolean;
}

/** 激活解析前置失败（IFC-ERR-006） */
export class ResolveActivationError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-006: ${message}`);
    this.name = 'ResolveActivationError';
  }
}

/**
 * 成员身份生效意图解析（REC-026、ORG-027、MEM-002）。
 *
 * - Casdoor 写入并**定向回读确认**成功 → 激活（ACTIVATED），成员权限才生效；
 * - 回读未确认 → 保持 PROCESSING（页面显示"成员身份生效处理中"，不开放权限）；
 * - **15 分钟仍失败** → 同步失败待重试（保持已接受、成员未生效、通知申请人与
 *   管理员——通知由调用方/审计占位）；
 * - 接受事实不回滚；无需本人再次接受（先回读后重试）。
 */
@Injectable()
export class ResolveActivationCommand {
  constructor(
    @Inject(INVITATION_REPOSITORY) private readonly repo: InvitationRepository,
    @Inject(CASDOOR_RELATION_PORT) private readonly casdoor: CasdoorRelationPort,
  ) {}

  async execute(input: ResolveActivationInput): Promise<ResolveActivationResult> {
    const invitation = await this.repo.load(input.invitationId);
    if (invitation === null) {
      throw new ResolveActivationError('邀请不存在');
    }
    if (invitation.status !== 'ACCEPTED' || invitation.activation === null) {
      throw new ResolveActivationError('邀请未接受或不存在生效意图');
    }
    const activation = invitation.activation;
    if (activation.status === ActivationStatus.ACTIVATED) {
      return { invitation, activated: true }; // 幂等
    }

    // 先回读后重试：写入并定向回读确认
    const result = await this.casdoor.writeAndReadBackGroup(
      invitation.clubId,
      invitation.inviteeId,
    );
    const now = new Date().toISOString();
    const nextAttempt = activation.attemptCount + 1;

    let nextStatus: ActivationStatus;
    if (result.ok && result.confirmed) {
      nextStatus = ActivationStatus.ACTIVATED; // 回读确认完成 → 成员权限生效
    } else if (input.deadlineExceeded) {
      nextStatus = ActivationStatus.SYNC_FAILED_PENDING_RETRY; // 15 分钟仍失败：保持已接受、成员未生效
    } else {
      nextStatus = ActivationStatus.PROCESSING; // 未到期：保持处理中
    }

    const updated: Invitation = {
      ...invitation,
      activation: {
        ...activation,
        status: nextStatus,
        attemptCount: nextAttempt,
        lastAttemptAt: now,
        lastError: result.ok ? undefined : (result.reason ?? 'casdoor-write-readback-failed'),
      },
    };
    await this.repo.save(updated);
    return { invitation: updated, activated: nextStatus === ActivationStatus.ACTIVATED };
  }
}
