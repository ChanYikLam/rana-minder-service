/**
 * 平台适配模块（@Global；默认 NotWired 失败关闭桩，依赖可用性开关显式开启真实实现）。
 *
 * 提供共享适配边界 token：
 * - DB_ADAPTER（T2 已接线：ADAPTERS_DB_REAL=1 时用真实 PostgresDbAdapter）
 * - CASDOOR_ADAPTER / MAIL_CHANNEL_ADAPTER / ADAPTERS_FILECHECK /
 *   ADAPTERS_NOTIFY / ADAPTERS_BACKUP（T3 接线）
 * - DEP_LATEST_RECORDER：外部依赖最近结果记录器（供 observability DepLatestPort 绑定）
 *
 * 接线策略（T3）：每个外部适配器一律 fail-closed，仅当对应 `ADAPTERS_*_REAL=1`
 * 且能解析到配置时才绑定真实实现；否则维持 NotWired 桩（返回 UNAVAILABLE/未知），
 * 不伪健康、不静默成功（ADR-011 §2.1、GOV-008、NFR-003）。
 *
 * 可用性开关约定（与 T2 的 ADAPTERS_DB_REAL 一致）：
 * - ADAPTERS_DB_REAL=1 → PostgresDbAdapter
 * - ADAPTERS_CASDOOR_REAL=1 → HttpCasdoorAdapter
 * - ADAPTERS_MAIL_REAL=1 → SmtpMailChannelAdapter
 * - ADAPTERS_FILECHECK_REAL=1 → ExternalFileCheckAdapter
 * - ADAPTERS_NOTIFY_REAL=1 → HttpNotifyAdapter
 * - ADAPTERS_BACKUP_REAL=1 → ExternalBackupAdapter
 *
 * 生产默认 fail-closed；单元测试不连接外部系统，保持桩行为。
 */

import { Global, Module } from '@nestjs/common';

import {
  DB_ADAPTER,
  CASDOOR_ADAPTER,
  MAIL_CHANNEL_ADAPTER,
  ADAPTERS_FILECHECK,
  ADAPTERS_NOTIFY,
  ADAPTERS_BACKUP,
  DEP_LATEST_RECORDER,
} from './tokens';
import { NotWiredDbAdapter } from './db/not-wired-db.adapter';
import { PostgresDbAdapter } from './db/postgres-db-adapter';
import { NotWiredCasdoorAdapter } from './casdoor/not-wired-casdoor.adapter';
import { HttpCasdoorAdapter } from './casdoor/http-casdoor.adapter';
import { NotWiredMailChannelAdapter } from './mail/not-wired-mail.adapter';
import { SmtpMailChannelAdapter } from './mail/smtp-mail.adapter';
import { ExternalFileCheckAdapter } from './file-check/external-file-check.adapter';
import { ApplicationFileCheck } from '../modules/file/infrastructure/file-check-port';
import { HttpNotifyAdapter, type NotifyAdapter } from './notify/external-notify.adapter';
import { ExternalBackupAdapter } from './backup/external-backup.adapter';
import { NotWiredBackupReportPort } from '../platform/observability/backup-report/backup-report';
import { randomUUID } from 'node:crypto';
import { externalFailure } from '../common/contracts/external-result';
import {
  InMemoryDepLatestRecorder,
  type DepLatestRecorder,
} from './dep-latest/dep-latest-recorder';
import {
  trackCasdoor,
  trackMail,
  trackFileCheck,
  trackNotify,
  trackBackup,
} from './dep-latest/decorators';
import { RANA_MINDER_CONFIG, type RanaMinderConfig } from '../config';
import { isSecretRef, resolveSecret } from '../config';

/** 是否启用真实 PostgreSQL 适配（fail-closed：默认关闭）。 */
export function realDbEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ADAPTERS_DB_REAL === '1';
}

function realEnabled(envKey: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[envKey] === '1';
}

/** 单例外部依赖记录器：各适配器回填结果，observability 状态页读取。 */
const depLatestRecorder: DepLatestRecorder = new InMemoryDepLatestRecorder();

@Global()
@Module({
  providers: [
    // ---- DB（T2：默认 fail-closed 桩；ADAPTERS_DB_REAL=1 时用真实 PostgresDbAdapter）----
    {
      provide: DB_ADAPTER,
      useFactory: (config: RanaMinderConfig) => {
        if (!realDbEnabled()) {
          return new NotWiredDbAdapter();
        }
        const db = config.database;
        // passwordRef 可能是明文（由 DATABASE_PASSWORD 直接回落）或 ${env:...} 引用；
        // 仅对引用形式执行解密，明文直接使用（ADR-010 最小披露）。
        const password = isSecretRef(db.passwordRef)
          ? resolveSecret(db.passwordRef)
          : db.passwordRef;
        return new PostgresDbAdapter({
          host: db.host,
          port: db.port,
          database: db.name,
          user: db.user,
          password,
          ssl: db.ssl,
          sslRejectUnauthorized: db.sslRejectUnauthorized,
          // 统一业务 Schema（ADR-014）：连接级 search_path 钉到 <schema>,public
          schema: db.schema,
        });
      },
      inject: [RANA_MINDER_CONFIG],
    },
    // ---- 外部依赖最近结果记录器（T3，供 observability DepLatestPort 绑定）----
    {
      provide: DEP_LATEST_RECORDER,
      useValue: depLatestRecorder,
    },
    // ---- Casdoor（T3）----
    {
      provide: CASDOOR_ADAPTER,
      useFactory: (config: RanaMinderConfig, recorder: DepLatestRecorder) => {
        if (!realEnabled('ADAPTERS_CASDOOR_REAL')) {
          return new NotWiredCasdoorAdapter();
        }
        const casdoor = config.casdoor;
        const clientSecret = isSecretRef(casdoor.clientSecretRef)
          ? resolveSecret(casdoor.clientSecretRef)
          : casdoor.clientSecretRef;
        return trackCasdoor(
          new HttpCasdoorAdapter({
            endpoint: casdoor.endpoint,
            clientId: casdoor.clientId,
            organization: casdoor.organization,
            clientSecret,
          }),
          recorder,
        );
      },
      inject: [RANA_MINDER_CONFIG, DEP_LATEST_RECORDER],
    },
    // ---- Mail（T3）----
    {
      provide: MAIL_CHANNEL_ADAPTER,
      useFactory: (config: RanaMinderConfig, recorder: DepLatestRecorder) => {
        if (!realEnabled('ADAPTERS_MAIL_REAL')) {
          return new NotWiredMailChannelAdapter();
        }
        const mail = config.mail;
        const user = mail.userRef
          ? isSecretRef(mail.userRef)
            ? resolveSecret(mail.userRef)
            : mail.userRef
          : undefined;
        const password = mail.passwordRef
          ? isSecretRef(mail.passwordRef)
            ? resolveSecret(mail.passwordRef)
            : mail.passwordRef
          : undefined;
        return trackMail(
          new SmtpMailChannelAdapter({
            host: mail.host,
            port: mail.port,
            fromAddress: mail.fromAddress,
            ...(user !== undefined ? { user } : {}),
            ...(password !== undefined ? { password } : {}),
          }),
          recorder,
        );
      },
      inject: [RANA_MINDER_CONFIG, DEP_LATEST_RECORDER],
    },
    // ---- File-check（T3）----
    {
      provide: ADAPTERS_FILECHECK,
      useFactory: (config: RanaMinderConfig, recorder: DepLatestRecorder) => {
        // 默认：应用侧初检（不信任扩展名、默认禁止可执行/脚本/高风险压缩）；
        // 开启 ADAPTERS_FILECHECK_REAL 且配置了端点时委托外部检查服务。
        if (!realEnabled('ADAPTERS_FILECHECK_REAL') || !config.fileCheck.endpoint) {
          return new ApplicationFileCheck();
        }
        const token = isSecretRef(config.fileCheck.tokenRef)
          ? resolveSecret(config.fileCheck.tokenRef)
          : config.fileCheck.tokenRef;
        return trackFileCheck(
          new ExternalFileCheckAdapter({
            endpoint: config.fileCheck.endpoint,
            ...(token !== undefined ? { token } : {}),
          }),
          recorder,
        );
      },
      inject: [RANA_MINDER_CONFIG, DEP_LATEST_RECORDER],
    },
    // ---- Notify（T3）----
    {
      provide: ADAPTERS_NOTIFY,
      useFactory: (config: RanaMinderConfig, recorder: DepLatestRecorder): NotifyAdapter => {
        if (!realEnabled('ADAPTERS_NOTIFY_REAL') || !config.notify.endpoint) {
          // fail-closed：未启用或未配置端点时返回不可用桩（对象为 UNAVAILABLE 语义）。
          return {
            async send() {
              return externalFailure(
                'UNAVAILABLE',
                {
                  code: 'NOTIFY-NOT-WIRED',
                  message: '外部通知渠道适配未启用（首版桩）',
                  retryable: true,
                  rawStatusCode: null,
                },
                randomUUID(),
                new Date(),
              );
            },
          };
        }
        const token = isSecretRef(config.notify.tokenRef)
          ? resolveSecret(config.notify.tokenRef)
          : config.notify.tokenRef;
        return trackNotify(
          new HttpNotifyAdapter({
            endpoint: config.notify.endpoint,
            ...(token !== undefined ? { token } : {}),
          }),
          recorder,
        );
      },
      inject: [RANA_MINDER_CONFIG, DEP_LATEST_RECORDER],
    },
    // ---- Backup（T3）----
    {
      provide: ADAPTERS_BACKUP,
      useFactory: (config: RanaMinderConfig, recorder: DepLatestRecorder) => {
        if (!realEnabled('ADAPTERS_BACKUP_REAL') || !config.backup.endpoint) {
          // fail-closed：未启用或未配置端点时返回空集桩（不抛异常、不伪造备份记录）。
          return new NotWiredBackupReportPort();
        }
        const token = isSecretRef(config.backup.tokenRef)
          ? resolveSecret(config.backup.tokenRef)
          : config.backup.tokenRef;
        return trackBackup(
          new ExternalBackupAdapter({
            endpoint: config.backup.endpoint,
            ...(token !== undefined ? { token } : {}),
          }),
          recorder,
        );
      },
      inject: [RANA_MINDER_CONFIG, DEP_LATEST_RECORDER],
    },
  ],
  exports: [
    DB_ADAPTER,
    CASDOOR_ADAPTER,
    MAIL_CHANNEL_ADAPTER,
    ADAPTERS_FILECHECK,
    ADAPTERS_NOTIFY,
    ADAPTERS_BACKUP,
    DEP_LATEST_RECORDER,
  ],
})
export class AdaptersModule {}
