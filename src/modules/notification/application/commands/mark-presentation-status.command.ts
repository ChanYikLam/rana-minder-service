/**
 * 站内信呈现状态命令（NTF-003、SRS-SM-NTF-001 转换 5）。
 *
 * 收件人本人标记已读/已处理/隐藏：
 * - 权益通知不可物理删除，但可归入已处理或隐藏列表；
 * - 已处理/隐藏为终态，不可逆回；
 * - 仅收件人本人可操作（非本人按不存在处理，不泄露他人通知）。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { InboxAdapter, NotificationRepository } from '../../infrastructure';
import {
  InboxPresentationStatus,
  NotificationStateMachine,
  validatePresentationStatusTransition,
} from '../../domain';
import { INBOX_ADAPTER, NOTIFICATION_REPOSITORY } from '../../tokens';

export type PresentationTargetStatus = Extract<
  InboxPresentationStatus,
  'READ' | 'PROCESSED' | 'HIDDEN'
>;

export interface MarkPresentationStatusResult {
  readonly presentationId: string;
  readonly status: InboxPresentationStatus;
}

@Injectable()
export class MarkPresentationStatusCommand {
  private readonly logger = new Logger(MarkPresentationStatusCommand.name);
  private readonly stateMachine = new NotificationStateMachine();

  constructor(
    @Inject(INBOX_ADAPTER)
    private readonly inboxAdapter: InboxAdapter,
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repository: NotificationRepository,
  ) {}

  /**
   * 标记站内信呈现状态。
   *
   * @param presentationId 呈现标识
   * @param recipientId 收件人主体标识（本人）
   * @param target 目标状态：READ | PROCESSED | HIDDEN
   * @throws 呈现不存在或非本人 → 视为不存在；终态逆回或未投递 → 拒绝
   */
  async execute(
    presentationId: string,
    recipientId: string,
    target: PresentationTargetStatus,
  ): Promise<MarkPresentationStatusResult> {
    const presentation = await this.inboxAdapter.findPresentation(presentationId);
    // 非本人或不存在统一按不存在处理（不泄露他人通知）
    if (!presentation || presentation.recipientId !== recipientId) {
      throw new Error(`站内信不存在: ${presentationId}`);
    }

    // 领域校验：已处理/隐藏终态不可逆回
    const modelError = validatePresentationStatusTransition(presentation.status, target);
    if (modelError) {
      throw new Error(modelError);
    }

    // 状态机校验：通知事实必须已投递才能标记
    const fact = await this.repository.findFactById(presentation.factId);
    const transition = this.stateMachine.evaluate({
      type: this.transitionType(target),
      currentStatus: fact?.status ?? 'CREATED_PENDING_DELIVERY',
      currentPresentationStatus: presentation.status,
    });
    if (!transition.allowed) {
      throw new Error(`标记失败: ${transition.reason}`);
    }

    const updated = await this.inboxAdapter.updatePresentationStatus(
      presentationId,
      target,
      presentation.version,
    );

    this.logger.log(`站内信 ${presentationId} 标记为 ${target}（收件人 ${recipientId}）`);
    return { presentationId, status: updated.status };
  }

  private transitionType(target: PresentationTargetStatus) {
    switch (target) {
      case 'READ':
        return 'MARK_READ' as const;
      case 'PROCESSED':
        return 'MARK_PROCESSED' as const;
      case 'HIDDEN':
        return 'MARK_HIDDEN' as const;
    }
  }
}
