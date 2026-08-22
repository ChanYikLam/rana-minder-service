/**
 * 联合任务入队器（infrastructure；5.1 JNT 后台任务"发送方"）。
 *
 * 领域命令在业务持久化后，经平台 TaskIntentOutbox.register 写入事务发件箱，
 * 由 TasksModule 调度器在每轮 forwardPending 中转发为 TASK_REPOSITORY 中的
 * 待执行任务，再由已注册的 JNT 处理器消费（接收方见 joint-tasks.ts）。
 *
 * notBefore 取自真实业务截止时间（确认截止 / 通道窗口截止）或终态即时归档；
 * 邀请超时在未接入 INV-001 真实有效期前使用保守默认值（迟于而非早于真实
 * 过期，避免误伤有效邀请），待 INV-001 接入后改为邀请实际过期时刻。
 */

import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';

import { TaskIntentOutbox } from '../../../platform/tasks/outbox/task-intent-outbox';
import { TaskType } from '../../../platform/tasks/contracts/task-type';
import { TaskScopeKind, type TaskScope } from '../../../platform/tasks/contracts/task-scope';
import type { TaskIntent } from '../../../platform/tasks/contracts/task-intent';

const PLATFORM_SCOPE: TaskScope = { kind: TaskScopeKind.PLATFORM };

/** 邀请超时未接入 INV-001 真实有效期前的保守默认（30 天，迟于而非早于真实过期） */
export const INVITATION_TIMEOUT_DEFAULT_MS = 30 * 24 * 60 * 60 * 1000;

interface JointTaskScheduleInput {
  readonly taskType: TaskType;
  readonly activityId: string;
  readonly activityRevision: number;
  readonly idempotencyKey: string;
  readonly notBefore: Date;
  /** 附加业务标识（如 invitationId），透传至任务 payload 供消费方精确定位 */
  readonly refId?: string;
  /** payload 引用字段名（默认 'refId'） */
  readonly refKey?: string;
}

@Injectable()
export class JointTaskEnqueuer {
  constructor(private readonly outbox: TaskIntentOutbox) {}

  private async enqueue(input: JointTaskScheduleInput): Promise<void> {
    const now = new Date();
    const intent: TaskIntent = {
      intentId: randomUUID(),
      taskType: input.taskType,
      idempotencyKey: input.idempotencyKey,
      scope: PLATFORM_SCOPE,
      source: {
        objectType: 'joint-activity',
        objectId: input.activityId,
        version: input.activityRevision,
        scope: PLATFORM_SCOPE,
      },
      payload:
        input.refId !== undefined && input.refKey !== undefined
          ? { activityId: input.activityId, [input.refKey]: input.refId }
          : { activityId: input.activityId },
      notBefore: input.notBefore.toISOString(),
      createdAt: now.toISOString(),
    };
    await this.outbox.register(intent);
  }

  scheduleConfirmDeadlineScan(
    activityId: string,
    activityRevision: number,
    confirmDeadline: Date,
  ): Promise<void> {
    return this.enqueue({
      taskType: TaskType.JOINT_CONFIRM_DEADLINE_SCAN,
      activityId,
      activityRevision,
      idempotencyKey: `joint-confirm-deadline-scan:${activityId}`,
      notBefore: confirmDeadline,
    });
  }

  scheduleInvitationTimeout(
    activityId: string,
    activityRevision: number,
    invitationId: string,
    notBefore: Date,
  ): Promise<void> {
    return this.enqueue({
      taskType: TaskType.JOINT_INVITATION_TIMEOUT,
      activityId,
      activityRevision,
      idempotencyKey: `joint-invitation-timeout:${activityId}:${invitationId}`,
      notBefore,
      refId: invitationId,
      refKey: 'invitationId',
    });
  }

  scheduleChannelAutoClose(
    activityId: string,
    activityRevision: number,
    windowId: string,
    deadline: Date,
  ): Promise<void> {
    return this.enqueue({
      taskType: TaskType.JOINT_CHANNEL_AUTO_CLOSE,
      activityId,
      activityRevision,
      idempotencyKey: `joint-channel-auto-close:${activityId}:${windowId}`,
      notBefore: deadline,
    });
  }

  scheduleForceEndCleanup(activityId: string, activityRevision: number): Promise<void> {
    return this.enqueue({
      taskType: TaskType.JOINT_FORCE_END_CLEANUP,
      activityId,
      activityRevision,
      idempotencyKey: `joint-force-end-cleanup:${activityId}`,
      notBefore: new Date(),
    });
  }

  scheduleArchiveTerminal(activityId: string, activityRevision: number): Promise<void> {
    return this.enqueue({
      taskType: TaskType.JOINT_ARCHIVE_TERMINAL,
      activityId,
      activityRevision,
      idempotencyKey: `joint-archive-terminal:${activityId}`,
      notBefore: new Date(),
    });
  }
}
