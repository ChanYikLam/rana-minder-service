/**
 * 保存邮件发信配置命令（NTF-006；接口清单 §14.4 / §15.9）。
 *
 * 规则（产品行为已冻结）：
 * - 每个社团必须配置自己的邮箱发信密钥，不能借用其他社团密钥
 *   （配置按 clubId 隔离；平台配置使用保留键）；
 * - 社团负责人或超级管理员任一方均可单独配置；人事管理员和部门负责人
 *   无权查看或修改（权限：club:email:config 或平台超管）；
 * - 密钥不明文回显、不明文存储（AES-256-GCM 加密落库），只能重填或轮换；
 * - 新配置或关键信息变更后必须重新通过测试邮件才能启用（verified=false）；
 * - 所有配置变化写入特权审计并通知负责人（审计条目含操作者与范围，
 *   不含密钥明文）。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  EmailConfigRecord,
  EmailConfigStore,
  EmailSecretCipher,
  PrivilegedAuditWriter,
} from '../../infrastructure';
import { EMAIL_CONFIG_STORE, EMAIL_SECRET_CIPHER, PRIVILEGED_AUDIT_WRITER } from '../../tokens';
import { PLATFORM_EMAIL_CONFIG_KEY } from './dispatch-optional-email.command';

/** 配置作用域 */
export type EmailConfigScope =
  { readonly type: 'CLUB'; readonly clubId: string } | { readonly type: 'PLATFORM' };

/** 操作者身份（来自服务端会话＋权限解析，不信任客户端自报） */
export interface EmailConfigActor {
  readonly userId: string;
  readonly displayName: string;
  /** 平台超管标记 */
  readonly isPlatformAdmin: boolean;
  /** 服务端权限码集合（如 club:email:config）；未提供视为空集 */
  readonly permissions?: readonly string[];
}

/** 保存输入 */
export interface SaveEmailConfigInput {
  readonly scope: EmailConfigScope;
  readonly actor: EmailConfigActor;
  readonly smtpHost: string;
  readonly smtpPort?: number;
  readonly smtpUser: string;
  readonly fromName: string;
  readonly encryption?: 'ssl' | 'tls' | 'none';
  /**
   * 发信密钥（写-only）：只允许重填，永不回显。
   * 缺省时沿用已存密钥（仅当主机/账号等未变化时才有意义——
   * 任何关键变更都会将 verified 置 false 要求重新测试）。
   */
  readonly smtpSecret?: string;
}

/** 权限不足错误（控制器映射 403 IFC-ERR-002） */
export class EmailConfigPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailConfigPermissionError';
  }
}

/** 社团邮件配置权限码（接口清单 §2：hr 同负责人但无本权限） */
export const CLUB_EMAIL_CONFIG_PERMISSION = 'club:email:config';

/** 校验操作者可管理该作用域的邮件配置（NTF-006.6） */
export function assertCanManageEmailConfig(scope: EmailConfigScope, actor: EmailConfigActor): void {
  if (scope.type === 'PLATFORM') {
    if (!actor.isPlatformAdmin) {
      throw new EmailConfigPermissionError('平台邮件配置仅超级管理员可管理');
    }
    return;
  }
  const hasClubPermission = (actor.permissions ?? []).includes(CLUB_EMAIL_CONFIG_PERMISSION);
  if (!hasClubPermission && !actor.isPlatformAdmin) {
    throw new EmailConfigPermissionError('无权管理该社团邮件配置（需 club:email:config 或超管）');
  }
}

@Injectable()
export class SaveEmailConfigCommand {
  private readonly logger = new Logger(SaveEmailConfigCommand.name);

  constructor(
    @Inject(EMAIL_CONFIG_STORE)
    private readonly emailConfigs: EmailConfigStore,
    @Inject(EMAIL_SECRET_CIPHER)
    private readonly cipher: EmailSecretCipher,
    @Inject(PRIVILEGED_AUDIT_WRITER)
    private readonly audit: PrivilegedAuditWriter,
  ) {}

  async execute(input: SaveEmailConfigInput): Promise<EmailConfigRecord> {
    assertCanManageEmailConfig(input.scope, input.actor);

    const storeKey = input.scope.type === 'CLUB' ? input.scope.clubId : PLATFORM_EMAIL_CONFIG_KEY;
    if (input.scope.type === 'CLUB' && !input.scope.clubId) {
      throw new Error('社团标识不能为空');
    }
    if (!input.smtpHost || !input.smtpUser || !input.fromName) {
      throw new Error('SMTP 主机、账号与发件展示名不能为空');
    }

    const existing = await this.emailConfigs.findByClub(storeKey);

    // ---- 密钥处理：只能重填，不明文存储/回显（NTF-006.7）----
    let secretCiphertext = existing?.secretCiphertext ?? null;
    let secretFingerprint = existing?.secretFingerprint ?? null;
    let secretChanged = false;
    if (input.smtpSecret != null && input.smtpSecret.length > 0) {
      secretCiphertext = this.cipher.encrypt(input.smtpSecret);
      secretFingerprint = this.cipher.fingerprint(input.smtpSecret);
      secretChanged = existing?.secretFingerprint !== secretFingerprint;
    }
    if (!secretCiphertext) {
      throw new Error('发信密钥缺失：新配置必须填写密钥');
    }

    // ---- 关键信息变更检测：任何变更都要求重新测试后启用（NTF-006.7）----
    const hostChanged = existing ? existing.smtpHost !== input.smtpHost : true;
    const userChanged = existing ? existing.smtpUser !== input.smtpUser : true;
    const portChanged = existing ? existing.smtpPort !== (input.smtpPort ?? 587) : true;
    const mustRetest = !existing || hostChanged || userChanged || portChanged || secretChanged;

    const now = new Date().toISOString();
    const saved = await this.emailConfigs.save({
      clubId: storeKey,
      smtpHost: input.smtpHost,
      smtpPort: input.smtpPort ?? 587,
      smtpUser: input.smtpUser,
      fromName: input.fromName,
      encryption: input.encryption ?? 'tls',
      secretCiphertext,
      secretFingerprint,
      verified: mustRetest ? false : (existing?.verified ?? false),
      lastTestPassedAt: mustRetest ? null : (existing?.lastTestPassedAt ?? null),
      keyRotatedAt: existing?.keyRotatedAt ?? null,
      savedAt: now,
    });

    // ---- 特权审计：所有配置变化审计（不含密钥明文/密文）----
    await this.audit.write({
      actorId: input.actor.userId,
      actorName: input.actor.displayName,
      action: 'notification.email_config.save',
      scope: input.scope.type === 'PLATFORM' ? 'platform' : 'club:' + storeKey,
      targetType: 'email_config',
      targetId: storeKey,
      reason: mustRetest ? '配置变更，需重新测试后启用' : '配置保存（未变更关键项）',
      detail: {
        smtpHost: input.smtpHost,
        smtpUser: input.smtpUser,
        encryption: saved.encryption,
        secretFingerprint: secretFingerprint ?? '',
        verified: String(saved.verified),
      },
      traceId: null,
      occurredAt: now,
    });

    this.logger.log(
      '邮件配置已保存: scope=' +
        storeKey +
        ', verified=' +
        saved.verified +
        '（密钥不回显；变更需测试后启用）',
    );
    return saved;
  }
}
