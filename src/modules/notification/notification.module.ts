/**
 * 通知模块（NestJS 模块注册）。
 *
 * 领域模块 · 通知
 * 状态机：SRS-SM-NTF-001（通知事实/渠道，10 条转换；IFC-SM-027）
 *
 * 核心职责：
 * - 通知事实、收件人快照、站内信与渠道投递
 * - 通知事实＋逻辑事件 ID＋收件人快照与权益业务结果在同一本地事务原子保存
 * - 关键不变量：影响学生权益的变化必须形成通知事实，不能静默发生（NTF-001）
 * - 通知与已读状态不得成为业务状态权威，业务链接每次打开重新鉴权（NTF-003）
 * - 站内信收件箱：已读/未读/全部已读/类型筛选/跳转业务页/已处理/隐藏/
 *   有期限通知当前办理状态（NTF-003）
 * - 紧急关闭：超管按全平台或指定社团关闭（原因/二次确认/预计恢复时间/
 *   特权审计）；关闭期间仍保存事实与快照、标记暂停投递；恢复按原事件
 *   时间升序补投且不重复业务（NTF-001、IFC-NTF-001、XCC-FAIL-009）
 *
 * 事务边界：
 * - IFC-TX-002：通知事实＋收件人快照在领域命令事务内保存
 * - IFC-TX-005：站内信/邮件渠道投递、失败重试与恢复补投
 */

import { Module } from '@nestjs/common';
import { NotificationController } from './interfaces';
import {
  CreateNotificationFactCommand,
  DeliverInboxCommand,
  CreateEmailAttemptCommand,
  RetryChannelDeliveryCommand,
  PauseInboxCommand,
  ResumeInboxCommand,
  MarkPermanentFailureCommand,
  ManualResendCommand,
  MarkPresentationStatusCommand,
  MarkAllReadCommand,
  ApplyKillSwitchCommand,
  ResumeKillSwitchCommand,
} from './application/commands';
import { NotificationQueryService } from './application/queries';
import { DefaultRecipientSnapshotResolver } from './domain/services';
import {
  InMemoryNotificationRepository,
  InMemoryInboxAdapter,
  InMemoryEmailAdapter,
  InMemoryChannelDeliveryAttemptRepository,
  InMemoryTemplateSnapshotService,
  InMemoryKillSwitchRepository,
  InMemoryPrivilegedAuditWriter,
} from './infrastructure';

@Module({
  controllers: [NotificationController],
  providers: [
    // 应用命令
    CreateNotificationFactCommand,
    DeliverInboxCommand,
    CreateEmailAttemptCommand,
    RetryChannelDeliveryCommand,
    PauseInboxCommand,
    ResumeInboxCommand,
    MarkPermanentFailureCommand,
    ManualResendCommand,
    MarkPresentationStatusCommand,
    MarkAllReadCommand,
    ApplyKillSwitchCommand,
    ResumeKillSwitchCommand,
    // 查询服务
    NotificationQueryService,
    // 领域服务
    DefaultRecipientSnapshotResolver,
    // 基础设施（内存桩，生产替换为 PostgreSQL）
    {
      provide: 'NotificationRepository',
      useClass: InMemoryNotificationRepository,
    },
    {
      provide: 'InboxAdapter',
      useClass: InMemoryInboxAdapter,
    },
    {
      provide: 'EmailAdapter',
      useClass: InMemoryEmailAdapter,
    },
    {
      provide: 'ChannelDeliveryAttemptRepository',
      useClass: InMemoryChannelDeliveryAttemptRepository,
    },
    {
      provide: 'TemplateSnapshotService',
      useClass: InMemoryTemplateSnapshotService,
    },
    {
      provide: 'KillSwitchRepository',
      useClass: InMemoryKillSwitchRepository,
    },
    {
      provide: 'PrivilegedAuditWriter',
      useClass: InMemoryPrivilegedAuditWriter,
    },
  ],
  exports: [
    CreateNotificationFactCommand,
    DeliverInboxCommand,
    CreateEmailAttemptCommand,
    MarkPresentationStatusCommand,
    MarkAllReadCommand,
    ApplyKillSwitchCommand,
    ResumeKillSwitchCommand,
    NotificationQueryService,
  ],
})
export class NotificationModule {}
