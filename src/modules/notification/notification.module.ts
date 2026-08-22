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
import { NotificationAuthGuard } from './interfaces/notification-auth.guard';
import { RejectAllNotificationAuthSessionProvider } from './interfaces/notification-auth-session';
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
  DispatchOptionalEmailCommand,
  SaveEmailConfigCommand,
  TestEmailConfigCommand,
  RotateEmailKeyCommand,
  SaveEmailTemplateCommand,
  RollbackEmailTemplateCommand,
  SendTemplateTestEmailCommand,
} from './application/commands';
import { EmailTemplateResolver } from './application/services/email-template-resolver';
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
  InMemoryEmailConfigStore,
  InMemoryNotificationPreferencesStore,
  AesGcmEmailSecretCipher,
  InMemoryClubEmailPolicyStore,
  InMemoryPlatformEmailSuspensionStore,
  InMemoryEmailTemplateStore,
} from './infrastructure';
import { OrgBackedNotificationPrivilegeVerifier } from './infrastructure/org-notification-privilege-verifier';
import { CURRENT_PERMISSIONS_PORT } from '../organization/application/ports';
import { OrganizationModule } from '../organization/module';
import {
  CHANNEL_DELIVERY_ATTEMPT_REPOSITORY,
  CLUB_EMAIL_POLICY_STORE,
  EMAIL_ADAPTER,
  EMAIL_CONFIG_STORE,
  EMAIL_SECRET_CIPHER,
  EMAIL_TEMPLATE_STORE,
  INBOX_ADAPTER,
  KILL_SWITCH_REPOSITORY,
  NOTIFICATION_AUTH_SESSION_PROVIDER,
  NOTIFICATION_REPOSITORY,
  PLATFORM_EMAIL_SUSPENSION_STORE,
  PREFERENCES_STORE,
  PRIVILEGED_AUDIT_WRITER,
  RECIPIENT_RESOLVER,
  TEMPLATE_SNAPSHOT_SERVICE,
  NOTIFICATION_PRIVILEGE_VERIFIER,
} from './tokens';

@Module({
  imports: [OrganizationModule],
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
    // 4.3.3 可选邮件渠道命令
    DispatchOptionalEmailCommand,
    SaveEmailConfigCommand,
    TestEmailConfigCommand,
    RotateEmailKeyCommand,
    SaveEmailTemplateCommand,
    RollbackEmailTemplateCommand,
    SendTemplateTestEmailCommand,
    EmailTemplateResolver,
    // 查询服务
    NotificationQueryService,
    // 接口守卫
    NotificationAuthGuard,
    // 基础设施（内存桩，生产替换为 PostgreSQL）
    {
      provide: NOTIFICATION_REPOSITORY,
      useClass: InMemoryNotificationRepository,
    },
    {
      provide: INBOX_ADAPTER,
      useClass: InMemoryInboxAdapter,
    },
    {
      provide: EMAIL_ADAPTER,
      useClass: InMemoryEmailAdapter,
    },
    {
      provide: CHANNEL_DELIVERY_ATTEMPT_REPOSITORY,
      useClass: InMemoryChannelDeliveryAttemptRepository,
    },
    {
      provide: TEMPLATE_SNAPSHOT_SERVICE,
      useClass: InMemoryTemplateSnapshotService,
    },
    {
      provide: KILL_SWITCH_REPOSITORY,
      useClass: InMemoryKillSwitchRepository,
    },
    {
      provide: PRIVILEGED_AUDIT_WRITER,
      useClass: InMemoryPrivilegedAuditWriter,
    },
    // 邮件配置与通知偏好（内存持久化；真实 SMTP/偏好库接入后替换实现）
    {
      provide: EMAIL_CONFIG_STORE,
      useClass: InMemoryEmailConfigStore,
    },
    {
      provide: PREFERENCES_STORE,
      useClass: InMemoryNotificationPreferencesStore,
    },
    // 4.3.3 可选邮件渠道基础设施（密钥加密/策略/模板；生产替换为持久化实现）
    {
      provide: EMAIL_SECRET_CIPHER,
      useClass: AesGcmEmailSecretCipher,
    },
    {
      provide: CLUB_EMAIL_POLICY_STORE,
      useClass: InMemoryClubEmailPolicyStore,
    },
    {
      provide: PLATFORM_EMAIL_SUSPENSION_STORE,
      useClass: InMemoryPlatformEmailSuspensionStore,
    },
    {
      provide: EMAIL_TEMPLATE_STORE,
      useClass: InMemoryEmailTemplateStore,
    },
    // 站内信紧急关闭特权核验（组织授权接线：PLATFORM 仅超管；CLUB 超管或社团管理员）
    {
      provide: NOTIFICATION_PRIVILEGE_VERIFIER,
      useFactory: (permissions) => new OrgBackedNotificationPrivilegeVerifier(permissions),
      inject: [CURRENT_PERMISSIONS_PORT],
    },
    // 领域服务（端口以字符串 Token 注册，接口在运行时被擦除不能作 DI Token）
    {
      provide: RECIPIENT_RESOLVER,
      useClass: DefaultRecipientSnapshotResolver,
    },
    // 认证会话（fail-closed：Casdoor 会话接入前一律拒绝 401；
    // 开发联调可在测试/独立配置中绑定可信边界的会话实现）
    {
      provide: NOTIFICATION_AUTH_SESSION_PROVIDER,
      useClass: RejectAllNotificationAuthSessionProvider,
    },
  ],
  exports: [
    CreateNotificationFactCommand,
    DeliverInboxCommand,
    CreateEmailAttemptCommand,
    RetryChannelDeliveryCommand,
    DispatchOptionalEmailCommand,
    MarkPresentationStatusCommand,
    MarkAllReadCommand,
    ApplyKillSwitchCommand,
    ResumeKillSwitchCommand,
    NotificationQueryService,
  ],
})
export class NotificationModule {}
