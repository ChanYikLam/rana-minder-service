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

import { forwardRef, Module } from '@nestjs/common';
import { NotificationController } from './interfaces';
import { NotificationAuthGuard } from './interfaces/notification-auth.guard';
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
import { InMemoryEmailAdapter } from './infrastructure/in-memory-notification-adapters';
import {
  PostgresNotificationRepository,
  PostgresInboxAdapter,
  PostgresChannelDeliveryAttemptRepository,
  PostgresEmailTemplateStore,
  PostgresTemplateSnapshotService,
  PostgresKillSwitchRepository,
  PostgresPrivilegedAuditWriter,
  PostgresEmailConfigStore,
  PostgresNotificationPreferencesStore,
  PostgresClubEmailPolicyStore,
  PostgresPlatformEmailSuspensionStore,
} from './infrastructure/postgres-notification-adapters';
import { SmtpEmailAdapter } from './infrastructure/smtp-email.adapter';
import { AesGcmEmailSecretCipher } from './infrastructure/email-secret-cipher';
import { AdaptersModule } from '../../adapters/adapters.module';
import { DB_ADAPTER } from '../../adapters/tokens';
import { OrgBackedNotificationPrivilegeVerifier } from './infrastructure/org-notification-privilege-verifier';
import { CURRENT_PERMISSIONS_PORT } from '../organization/application/ports';
import { OrganizationModule } from '../organization/module';
import { IdentityModule } from '../identity/identity.module';
import { AUTH_SESSION_PROVIDER } from '../identity/tokens';
import { adaptSessionProvider } from '../../shared/adapt-session-provider';
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
  // forwardRef：组织模块在 ORG_JOBS_PLATFORM=1 时经 TasksModule 反向引用本模块（#68）
  imports: [AdaptersModule, forwardRef(() => OrganizationModule), IdentityModule],
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
    // ----- 4.3 收口：PostgreSQL 持久化（DB 未连接失败关闭）-----
    {
      provide: NOTIFICATION_REPOSITORY,
      useFactory: (db) => new PostgresNotificationRepository(db),
      inject: [DB_ADAPTER],
    },
    {
      provide: INBOX_ADAPTER,
      useFactory: (db) => new PostgresInboxAdapter(db),
      inject: [DB_ADAPTER],
    },
    {
      provide: CHANNEL_DELIVERY_ATTEMPT_REPOSITORY,
      useFactory: (db) => new PostgresChannelDeliveryAttemptRepository(db),
      inject: [DB_ADAPTER],
    },
    {
      provide: TEMPLATE_SNAPSHOT_SERVICE,
      useFactory: (db) => new PostgresTemplateSnapshotService(new PostgresEmailTemplateStore(db)),
      inject: [DB_ADAPTER],
    },
    {
      provide: KILL_SWITCH_REPOSITORY,
      useFactory: (db) => new PostgresKillSwitchRepository(db),
      inject: [DB_ADAPTER],
    },
    {
      provide: PRIVILEGED_AUDIT_WRITER,
      useFactory: (db) => new PostgresPrivilegedAuditWriter(db),
      inject: [DB_ADAPTER],
    },
    {
      provide: EMAIL_CONFIG_STORE,
      useFactory: (db) => new PostgresEmailConfigStore(db),
      inject: [DB_ADAPTER],
    },
    {
      provide: PREFERENCES_STORE,
      useFactory: (db) => new PostgresNotificationPreferencesStore(db),
      inject: [DB_ADAPTER],
    },
    {
      provide: CLUB_EMAIL_POLICY_STORE,
      useFactory: (db) => new PostgresClubEmailPolicyStore(db),
      inject: [DB_ADAPTER],
    },
    {
      provide: PLATFORM_EMAIL_SUSPENSION_STORE,
      useFactory: (db) => new PostgresPlatformEmailSuspensionStore(db),
      inject: [DB_ADAPTER],
    },
    {
      provide: EMAIL_TEMPLATE_STORE,
      useFactory: (db) => new PostgresEmailTemplateStore(db),
      inject: [DB_ADAPTER],
    },
    // ----- 4.3 收口：真实 SMTP 邮件渠道（SMTP_HOST 配置启用；未配置保留开发占位）-----
    {
      provide: EMAIL_ADAPTER,
      useFactory: () => {
        const host = process.env.SMTP_HOST;
        if (host !== undefined && host.trim().length > 0) {
          return new SmtpEmailAdapter({
            host,
            port: Number(process.env.SMTP_PORT ?? '465'),
            fromAddress: process.env.SMTP_FROM_ADDRESS ?? '',
            user: process.env.SMTP_USER,
            password: process.env.SMTP_PASSWORD,
          });
        }
        const nodeEnv = process.env.NODE_ENV ?? 'development';
        if (nodeEnv !== 'test' && nodeEnv !== 'development') {
          throw new Error(
            'EMAIL_ADAPTER: 生产环境必须配置 SMTP_HOST/SMTP_FROM_ADDRESS（fail-closed，禁止内存假发送）',
          );
        }
        return new InMemoryEmailAdapter();
      },
    },
    // 密钥加密（AES-256-GCM；NTF-006）
    {
      provide: EMAIL_SECRET_CIPHER,
      useClass: AesGcmEmailSecretCipher,
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
      useFactory: (identitySession) => adaptSessionProvider(identitySession),
      inject: [AUTH_SESSION_PROVIDER],
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
