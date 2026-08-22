/**
 * 通知 HTTP 控制器（IFC-SM-027、接口清单 §7/§14.4/§15.9）。
 *
 * 鉴权：本人通知与紧急关闭端点一律经过 NotificationAuthGuard，
 * 身份只来自服务端会话（NotificationAuthSession），忽略客户端传入的
 * userId/operatorId，杜绝越权读取/标记他人通知（IDOR）。
 *
 * 路由命名空间：
 * - GET  /api/notifications          本人通知列表/类型筛选/未读筛选/隐藏列表
 * - GET  /api/notifications/unread-count 未读数
 * - POST /api/notifications/read-all     全部标记已读
 * - POST /api/notifications/:id/read     标记已读
 * - POST /api/notifications/:id/hide     隐藏（权益通知不可物理删除）
 * - POST /api/notifications/:id/process  标记已处理
 * - GET  /api/me/notifications/preferences 通知偏好
 * - POST /api/me/notifications/preferences 更新通知偏好
 * - POST /api/org/:clubId/notifications/kill-switch 社团级紧急关闭站内信
 * - GET  /api/org/:clubId/notifications/kill-switch 社团级关闭状态
 * - GET/POST /api/admin/notifications/kill-switch 平台级关闭/状态（超管）
 * - POST /api/org/:clubId/notifications/email-config 配置邮件
 */

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type {
  NotificationListResult,
  NotificationUnreadCount,
  NotificationPreferences,
  MeNotificationPreferencesResult,
  MeNotificationPreferencesSaved,
  OrgNotificationPreferencesResult,
  OrgNotificationPreferencesSaved,
  NotificationKillSwitchState,
  NotificationKillSwitchInput,
  EmailConfigView,
  EmailConfigInput,
  EmailConfigSaved,
  EmailConfigTestResult,
  EmailKeyRotated,
  NotificationListQuery,
  EmailTemplateView,
  EmailTemplateSaveInput,
  EmailTemplatePreviewResult,
  EmailTemplateTestResult,
  EmailTemplateRollbackResult,
  EmailOutboxItem,
  NotificationKind,
} from '../../../common/contracts/notifications.contracts';
import { NotificationQueryService } from '../application/queries/notification-query.service';
import {
  ApplyKillSwitchCommand,
  MarkAllReadCommand,
  MarkPresentationStatusCommand,
  ResumeKillSwitchCommand,
} from '../application/commands';
import type {
  KillSwitchRepository,
  EmailConfigStore,
  NotificationPreferencesStore,
  ClubEmailPolicyStore,
  PlatformEmailSuspensionStore,
  ChannelDeliveryAttemptRepository,
  EmailTemplateStore,
} from '../infrastructure';
import type { KillSwitchScope, KillSwitchStateModel, ClubEmailPolicy } from '../domain';
import { defaultClubEmailPolicy } from '../domain';
import {
  CHANNEL_DELIVERY_ATTEMPT_REPOSITORY,
  CLUB_EMAIL_POLICY_STORE,
  EMAIL_CONFIG_STORE,
  EMAIL_TEMPLATE_STORE,
  KILL_SWITCH_REPOSITORY,
  PLATFORM_EMAIL_SUSPENSION_STORE,
  PREFERENCES_STORE,
} from '../tokens';
import {
  SaveEmailConfigCommand,
  TestEmailConfigCommand,
  RotateEmailKeyCommand,
  SaveEmailTemplateCommand,
  RollbackEmailTemplateCommand,
  SendTemplateTestEmailCommand,
  EmailConfigPermissionError,
  PLATFORM_EMAIL_CONFIG_KEY,
  type EmailConfigActor,
  type EmailConfigScope,
} from '../application/commands';
import { EmailTemplateResolver } from '../application/services/email-template-resolver';
import { NotificationAuthGuard, notificationSessionFromRequest } from './notification-auth.guard';

const NOTIFICATION_KINDS = [
  'application',
  'interview',
  'invitation',
  'conclusion',
  'system',
  'member',
  'transition',
  'correction',
];

const DEFAULT_PREFERENCES: NotificationPreferences = {
  application: true,
  interview: true,
  invitation: true,
  conclusion: true,
  system: true,
  member: true,
  transition: true,
  correction: true,
};

@UseGuards(NotificationAuthGuard)
@Controller()
export class NotificationController {
  constructor(
    private readonly queryService: NotificationQueryService,
    private readonly markPresentationStatus: MarkPresentationStatusCommand,
    private readonly markAllRead: MarkAllReadCommand,
    private readonly applyKillSwitch: ApplyKillSwitchCommand,
    private readonly resumeKillSwitch: ResumeKillSwitchCommand,
    @Inject(KILL_SWITCH_REPOSITORY)
    private readonly killSwitches: KillSwitchRepository,
    @Inject(EMAIL_CONFIG_STORE)
    private readonly emailConfigs: EmailConfigStore,
    @Inject(PREFERENCES_STORE)
    private readonly preferences: NotificationPreferencesStore,
    // ---- 4.3.3 可选邮件渠道 ----
    private readonly saveEmailConfigCommand: SaveEmailConfigCommand,
    private readonly testEmailConfigCommand: TestEmailConfigCommand,
    private readonly rotateEmailKeyCommand: RotateEmailKeyCommand,
    private readonly saveEmailTemplateCommand: SaveEmailTemplateCommand,
    private readonly rollbackEmailTemplateCommand: RollbackEmailTemplateCommand,
    private readonly sendTemplateTestEmailCommand: SendTemplateTestEmailCommand,
    private readonly templateResolver: EmailTemplateResolver,
    @Inject(CLUB_EMAIL_POLICY_STORE)
    private readonly clubPolicies: ClubEmailPolicyStore,
    @Inject(PLATFORM_EMAIL_SUSPENSION_STORE)
    private readonly platformSuspension: PlatformEmailSuspensionStore,
    @Inject(EMAIL_TEMPLATE_STORE)
    private readonly emailTemplates: EmailTemplateStore,
    @Inject(CHANNEL_DELIVERY_ATTEMPT_REPOSITORY)
    private readonly attemptRepository: ChannelDeliveryAttemptRepository,
  ) {}

  /** 从服务端会话构建配置操作者身份（不信任客户端自报，NTF-006） */
  private actorFrom(request: Request): EmailConfigActor {
    const session = notificationSessionFromRequest(request);
    return {
      userId: session.userId,
      displayName: session.displayName,
      isPlatformAdmin: session.isPlatformAdmin ?? false,
      permissions: session.permissions ?? [],
    };
  }

  /** 平台级管理端只读端点鉴权：仅超级管理员可读（NTF-006.6、清单 §15.9） */
  private assertPlatformAdmin(request: Request): void {
    if (!this.actorFrom(request).isPlatformAdmin) {
      throw new ForbiddenException({
        code: 'IFC-ERR-002',
        message: '平台级管理端点仅超级管理员可访问',
        supportId: null,
      });
    }
  }

  /** 权限/业务错误 → HTTP 映射（403 IFC-ERR-002 / 400 IFC-ERR-005） */
  private mapConfigError(error: unknown): never {
    if (error instanceof EmailConfigPermissionError) {
      throw new ForbiddenException({
        code: 'IFC-ERR-002',
        message: (error as Error).message,
        supportId: null,
      });
    }
    throw new BadRequestException((error as Error).message);
  }

  // -------------------------------------------------------------------------
  // 本人通知（NTF-003：已读/未读/已处理/隐藏、类型筛选、跳转业务页）
  // -------------------------------------------------------------------------

  /** GET /api/notifications（本人列表；userId 取自会话，不信任客户端参数） */
  @Get('/api/notifications')
  async listNotifications(
    @Req() request: Request,
    @Query('cursor') cursor: string | null,
    @Query('limit') limit: string = '20',
    @Query('kind') kind: string | null,
    @Query('unreadOnly') unreadOnly: string | null,
    @Query('includeHidden') includeHidden: string | null,
  ): Promise<NotificationListResult> {
    const { userId } = notificationSessionFromRequest(request);
    const query: NotificationListQuery = {
      kind:
        kind && NOTIFICATION_KINDS.includes(kind) ? (kind as NotificationListQuery['kind']) : null,
      unreadOnly: unreadOnly === 'true',
      includeHidden: includeHidden === 'true',
    };
    return this.queryService.listForUser(userId, query, cursor ?? null, parseInt(limit, 10) || 20);
  }

  /** GET /api/notifications/unread-count（本人未读数） */
  @Get('/api/notifications/unread-count')
  async unreadCount(@Req() request: Request): Promise<NotificationUnreadCount> {
    const { userId } = notificationSessionFromRequest(request);
    const result = await this.queryService.unreadCount(userId);
    return { count: result.count };
  }

  /** POST /api/notifications/read-all（本人全部标记已读） */
  @Post('/api/notifications/read-all')
  @HttpCode(HttpStatus.OK)
  async readAll(@Req() request: Request): Promise<{ success: boolean; updatedCount: number }> {
    const { userId } = notificationSessionFromRequest(request);
    const result = await this.markAllRead.execute(userId);
    return { success: true, updatedCount: result.updatedCount };
  }

  /** POST /api/notifications/:id/read（本人标记已读） */
  @Post('/api/notifications/:id/read')
  @HttpCode(HttpStatus.OK)
  async markRead(@Req() request: Request, @Param('id') id: string): Promise<{ success: boolean }> {
    const { userId } = notificationSessionFromRequest(request);
    await this.runMark(id, userId, 'READ');
    return { success: true };
  }

  /** POST /api/notifications/:id/hide（权益通知不可物理删除，归入隐藏列表） */
  @Post('/api/notifications/:id/hide')
  @HttpCode(HttpStatus.OK)
  async hide(@Req() request: Request, @Param('id') id: string): Promise<{ success: boolean }> {
    const { userId } = notificationSessionFromRequest(request);
    await this.runMark(id, userId, 'HIDDEN');
    return { success: true };
  }

  /** POST /api/notifications/:id/process（本人标记已处理） */
  @Post('/api/notifications/:id/process')
  @HttpCode(HttpStatus.OK)
  async markProcessed(
    @Req() request: Request,
    @Param('id') id: string,
  ): Promise<{ success: boolean }> {
    const { userId } = notificationSessionFromRequest(request);
    await this.runMark(id, userId, 'PROCESSED');
    return { success: true };
  }

  private async runMark(
    id: string,
    userId: string,
    target: 'READ' | 'PROCESSED' | 'HIDDEN',
  ): Promise<void> {
    try {
      await this.markPresentationStatus.execute(id, userId, target);
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes('不存在')) throw new NotFoundException(message);
      throw new BadRequestException(message);
    }
  }

  // -------------------------------------------------------------------------
  // 通知偏好（本人，userId 取自会话）
  // -------------------------------------------------------------------------

  /** GET /api/me/notifications/preferences（按会话 userId 真实落库读取） */
  @Get('/api/me/notifications/preferences')
  async myPreferences(@Req() request: Request): Promise<MeNotificationPreferencesResult> {
    const { userId } = notificationSessionFromRequest(request);
    const stored = await this.preferences.get(userId);
    const preferences: NotificationPreferences = {
      ...DEFAULT_PREFERENCES,
      ...(stored?.preferences ?? {}),
    };
    return { preferences, savedAt: stored?.savedAt ?? null };
  }

  /** POST /api/me/notifications/preferences（按会话 userId 合并并持久化） */
  @Post('/api/me/notifications/preferences')
  async updateMyPreferences(
    @Req() request: Request,
    @Body('preferences') preferences: Partial<NotificationPreferences>,
  ): Promise<MeNotificationPreferencesSaved> {
    const { userId } = notificationSessionFromRequest(request);
    const stored = await this.preferences.get(userId);
    const full: NotificationPreferences = {
      ...DEFAULT_PREFERENCES,
      ...(stored?.preferences ?? {}),
      ...preferences,
    };
    const { savedAt } = await this.preferences.set(userId, full);
    return { preferences: full, savedAt };
  }

  // -------------------------------------------------------------------------
  // 紧急关闭站内信（NTF-001、SRS-FAIL-009、IFC-NTF-001、XCC-FAIL-009）
  // -------------------------------------------------------------------------

  /** POST /api/org/:clubId/notifications/kill-switch（社团级；操作者取自会话） */
  @Post('/api/org/:clubId/notifications/kill-switch')
  @HttpCode(HttpStatus.OK)
  async clubKillSwitch(
    @Req() request: Request,
    @Param('clubId') clubId: string,
    @Body() input: NotificationKillSwitchInput,
  ): Promise<NotificationKillSwitchState> {
    const session = notificationSessionFromRequest(request);
    return this.toggleKillSwitch('CLUB', clubId, input, session.userId, session.displayName);
  }

  /** GET /api/org/:clubId/notifications/kill-switch（社团级状态） */
  @Get('/api/org/:clubId/notifications/kill-switch')
  async getClubKillSwitch(@Param('clubId') clubId: string): Promise<NotificationKillSwitchState> {
    return this.toState(await this.killSwitches.findByScope('CLUB', clubId));
  }

  /** POST /api/admin/notifications/kill-switch（平台级，超管；清单 15.9） */
  @Post('/api/admin/notifications/kill-switch')
  @HttpCode(HttpStatus.OK)
  async platformKillSwitch(
    @Req() request: Request,
    @Body() input: NotificationKillSwitchInput,
  ): Promise<NotificationKillSwitchState> {
    const session = notificationSessionFromRequest(request);
    return this.toggleKillSwitch('PLATFORM', null, input, session.userId, session.displayName);
  }

  /** GET /api/admin/notifications/kill-switch（平台级状态；超管） */
  @Get('/api/admin/notifications/kill-switch')
  async getPlatformKillSwitch(@Req() request: Request): Promise<NotificationKillSwitchState> {
    this.assertPlatformAdmin(request);
    return this.toState(await this.killSwitches.findByScope('PLATFORM', null));
  }

  /**
   * 关闭（active=true）或恢复（active=false）站内信。
   * 关闭必须：填原因、二次确认、设预计恢复时间（并写入特权审计）。
   */
  private async toggleKillSwitch(
    scope: KillSwitchScope,
    clubId: string | null,
    input: NotificationKillSwitchInput,
    operatorId: string,
    operatorName: string,
  ): Promise<NotificationKillSwitchState> {
    try {
      if (input.active) {
        const result = await this.applyKillSwitch.execute({
          scope,
          clubId,
          reason: input.reason ?? '',
          expectedRecoveryAt: input.expectedRecoveryAt ?? null,
          confirmed: input.confirmed ?? false,
          operatorId,
          operatorName,
        });
        return this.toState(result.state);
      }
      const result = await this.resumeKillSwitch.execute({
        scope,
        clubId,
        operatorId,
        operatorName,
      });
      return this.toState(result.state);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  private toState(state: KillSwitchStateModel | null): NotificationKillSwitchState {
    if (!state) {
      return {
        active: false,
        scope: null,
        clubId: null,
        reason: '',
        operatorName: '',
        stoppedAt: '',
        droppedCount: 0,
      };
    }
    return {
      active: state.active,
      scope: state.scope === 'PLATFORM' ? 'platform' : 'club',
      clubId: state.clubId,
      reason: state.reason,
      operatorName: state.operatorName,
      stoppedAt: state.stoppedAt ?? '',
      droppedCount: state.droppedCount,
    };
  }

  // -------------------------------------------------------------------------
  // 邮件配置（NTF-006：社团独立密钥、不明文回显、测试后启用）
  // -------------------------------------------------------------------------

  /** 配置视图脱敏映射：只暴露"已配置"与指纹，永不回显密钥（NTF-006.7） */
  private toConfigView(
    config: {
      smtpHost: string;
      smtpPort: number;
      smtpUser: string;
      fromName: string;
      encryption: 'ssl' | 'tls' | 'none';
      secretCiphertext: string | null;
      secretFingerprint: string | null;
      verified: boolean;
      lastTestPassedAt: string | null;
      keyRotatedAt: string | null;
    } | null,
  ): EmailConfigView {
    return {
      smtpHost: config?.smtpHost ?? '',
      smtpPort: config?.smtpPort ?? 587,
      smtpUser: config?.smtpUser ?? '',
      fromName: config?.fromName ?? '',
      encryption: config?.encryption ?? 'tls',
      secretConfigured: Boolean(config?.secretCiphertext),
      secretFingerprint: config?.secretFingerprint ?? null,
      verified: config?.verified ?? false,
      lastTestPassedAt: config?.lastTestPassedAt ?? null,
      keyRotatedAt: config?.keyRotatedAt ?? null,
    };
  }

  /**
   * GET /api/org/:clubId/notifications/email-config
   * 脱敏读取；人事管理员与部门负责人无权查看（需 club:email:config 或超管）。
   */
  @Get('/api/org/:clubId/notifications/email-config')
  async getEmailConfig(
    @Req() request: Request,
    @Param('clubId') clubId: string,
  ): Promise<EmailConfigView> {
    try {
      assertScopeAccess(this.actorFrom(request), { type: 'CLUB', clubId });
    } catch (error) {
      this.mapConfigError(error);
    }
    const config = await this.emailConfigs.findByClub(clubId);
    return this.toConfigView(config);
  }

  /**
   * POST /api/org/:clubId/notifications/email-config
   * 保存配置（密钥加密落库；关键变更后必须重新测试才能启用）。
   */
  @Post('/api/org/:clubId/notifications/email-config')
  async saveEmailConfig(
    @Req() request: Request,
    @Param('clubId') clubId: string,
    @Body() input: EmailConfigInput,
  ): Promise<EmailConfigSaved> {
    try {
      const saved = await this.saveEmailConfigCommand.execute({
        scope: { type: 'CLUB', clubId },
        actor: this.actorFrom(request),
        smtpHost: input.smtpHost,
        smtpPort: input.smtpPort,
        smtpUser: input.smtpUser,
        fromName: input.fromName,
        encryption: input.encryption,
        smtpSecret: input.smtpSecret,
      });
      return { ...this.toConfigView(saved), savedAt: saved.savedAt };
    } catch (error) {
      this.mapConfigError(error);
    }
  }

  /**
   * POST /api/org/:clubId/notifications/email-config/test
   * 发送测试邮件；通过后配置启用（verified=true，NTF-006.7）。
   */
  @Post('/api/org/:clubId/notifications/email-config/test')
  async testEmailConfig(
    @Req() request: Request,
    @Param('clubId') clubId: string,
    @Body() body: { to?: string } | undefined,
  ): Promise<EmailConfigTestResult> {
    try {
      const result = await this.testEmailConfigCommand.execute({
        scope: { type: 'CLUB', clubId },
        actor: this.actorFrom(request),
        to: body?.to,
      });
      if (!result.ok) {
        throw new BadRequestException({
          code: 'IFC-ERR-006',
          message: result.sanitizedError ?? '测试邮件未通过，配置保持未启用',
          supportId: null,
        });
      }
      return { status: 'sent', sentAt: result.sentAt as string, to: result.to as string };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.mapConfigError(error);
    }
  }

  /**
   * POST /api/org/:clubId/notifications/email-config/rotate-key
   * 密钥轮换：旧密钥立即失效，须重填并通过测试邮件后启用。
   */
  @Post('/api/org/:clubId/notifications/email-config/rotate-key')
  async rotateKey(
    @Req() request: Request,
    @Param('clubId') clubId: string,
  ): Promise<EmailKeyRotated> {
    try {
      return await this.rotateEmailKeyCommand.execute({
        scope: { type: 'CLUB', clubId },
        actor: this.actorFrom(request),
      });
    } catch (error) {
      this.mapConfigError(error);
    }
  }

  // -------------------------------------------------------------------------
  // 平台邮件配置（接口清单 §15.9：平台级鉴权 isPlatformAdmin）
  // -------------------------------------------------------------------------

  /** GET /api/admin/notifications/email-config（平台 SMTP 配置，脱敏；超管） */
  @Get('/api/admin/notifications/email-config')
  async getAdminEmailConfig(@Req() request: Request): Promise<EmailConfigView> {
    this.assertPlatformAdmin(request);
    const config = await this.emailConfigs.findByClub(PLATFORM_EMAIL_CONFIG_KEY);
    return this.toConfigView(config);
  }

  /** POST /api/admin/notifications/email-config（保存平台配置） */
  @Post('/api/admin/notifications/email-config')
  async saveAdminEmailConfig(
    @Req() request: Request,
    @Body() input: EmailConfigInput,
  ): Promise<EmailConfigSaved> {
    try {
      const saved = await this.saveEmailConfigCommand.execute({
        scope: { type: 'PLATFORM' },
        actor: this.actorFrom(request),
        smtpHost: input.smtpHost,
        smtpPort: input.smtpPort,
        smtpUser: input.smtpUser,
        fromName: input.fromName,
        encryption: input.encryption,
        smtpSecret: input.smtpSecret,
      });
      return { ...this.toConfigView(saved), savedAt: saved.savedAt };
    } catch (error) {
      this.mapConfigError(error);
    }
  }

  /** POST /api/admin/notifications/email-config/test（平台测试邮件） */
  @Post('/api/admin/notifications/email-config/test')
  async testAdminEmailConfig(
    @Req() request: Request,
    @Body() body: { to?: string } | undefined,
  ): Promise<EmailConfigTestResult> {
    try {
      const result = await this.testEmailConfigCommand.execute({
        scope: { type: 'PLATFORM' },
        actor: this.actorFrom(request),
        to: body?.to,
      });
      if (!result.ok) {
        throw new BadRequestException({
          code: 'IFC-ERR-006',
          message: result.sanitizedError ?? '测试邮件未通过，配置保持未启用',
          supportId: null,
        });
      }
      return { status: 'sent', sentAt: result.sentAt as string, to: result.to as string };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.mapConfigError(error);
    }
  }

  /** POST /api/admin/notifications/email-config/rotate-key（平台密钥轮换） */
  @Post('/api/admin/notifications/email-config/rotate-key')
  async rotateAdminKey(@Req() request: Request): Promise<EmailKeyRotated> {
    try {
      return await this.rotateEmailKeyCommand.execute({
        scope: { type: 'PLATFORM' },
        actor: this.actorFrom(request),
      });
    } catch (error) {
      this.mapConfigError(error);
    }
  }

  // -------------------------------------------------------------------------
  // 社团通知偏好（NTF-004：负责人/人事按类型关闭本社团邮件；默认开启）
  // -------------------------------------------------------------------------

  /** GET /api/org/:clubId/notifications/preferences（社团级邮件开关目录） */
  @Get('/api/org/:clubId/notifications/preferences')
  async orgPreferences(
    @Req() request: Request,
    @Param('clubId') clubId: string,
  ): Promise<OrgNotificationPreferencesResult> {
    this.assertOrgReadAccess(request, clubId);
    const policy = await this.clubPolicies.findByClub(clubId);
    const preferences = this.policyToPreferences(policy);
    return { preferences, savedAt: policy?.updatedAt ?? null };
  }

  /**
   * POST /api/org/:clubId/notifications/preferences
   * 更新社团级邮件开关（负责人/人事；未知 kind 拒绝，不静默接受）。
   */
  @Post('/api/org/:clubId/notifications/preferences')
  async updateOrgPreferences(
    @Req() request: Request,
    @Param('clubId') clubId: string,
    @Body('preferences') preferences: Partial<NotificationPreferences>,
  ): Promise<OrgNotificationPreferencesSaved> {
    const actor = this.actorFrom(request);
    const hasAccess =
      actor.isPlatformAdmin ||
      (actor.permissions ?? []).some(
        (p) => p === 'club:config:manage' || p === 'club:email:config',
      );
    if (!hasAccess) {
      throw new ForbiddenException({
        code: 'IFC-ERR-002',
        message: '无权管理该社团通知偏好',
        supportId: null,
      });
    }
    for (const [key, value] of Object.entries(preferences ?? {})) {
      if (!(NOTIFICATION_KINDS as readonly string[]).includes(key)) {
        throw new BadRequestException('未知通知类型: ' + key);
      }
      if (typeof value !== 'boolean') {
        throw new BadRequestException('偏好值必须为布尔: ' + key);
      }
    }
    const existing = await this.clubPolicies.findByClub(clubId);
    const base = existing ?? defaultClubEmailPolicy(clubId);
    const now = new Date().toISOString();
    const mergedKinds: Partial<Record<NotificationKind, boolean>> = {
      ...base.kindEmailEnabled,
    };
    for (const [key, value] of Object.entries(preferences ?? {})) {
      mergedKinds[key as NotificationKind] = value as boolean;
    }
    const saved = await this.clubPolicies.save({
      ...base,
      kindEmailEnabled: mergedKinds,
      updatedBy: actor.userId,
      updatedAt: now,
    });
    return {
      preferences: this.policyToPreferences(saved),
      savedAt: saved.updatedAt ?? now,
    };
  }

  private policyToPreferences(policy: ClubEmailPolicy | null): NotificationPreferences {
    const preferences = {} as NotificationPreferences;
    for (const kind of NOTIFICATION_KINDS as readonly NotificationKind[]) {
      const override = policy?.kindEmailEnabled[kind];
      preferences[kind] = override !== undefined ? override : true; // 默认开启（NTF-004.1）
    }
    return preferences;
  }

  /** 社团偏好读取权限：负责人/人事（club:config:manage / club:email:config）或超管 */
  private assertOrgReadAccess(request: Request, _clubId: string): void {
    const actor = this.actorFrom(request);
    const hasAccess =
      actor.isPlatformAdmin ||
      (actor.permissions ?? []).some(
        (p) => p === 'club:config:manage' || p === 'club:email:config',
      );
    if (!hasAccess) {
      throw new ForbiddenException({
        code: 'IFC-ERR-002',
        message: '无权查看该社团通知偏好',
        supportId: null,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 邮件模板（NTF-005：预览/测试/版本/回滚；失效回退平台默认）
  // -------------------------------------------------------------------------

  /** GET /api/admin/notifications/templates（平台模板目录，§15.9；超管） */
  @Get('/api/admin/notifications/templates')
  async adminTemplateDirectory(@Req() request: Request): Promise<{
    items: {
      kind: NotificationKind;
      title: string;
      body: string;
      emailSubject?: string;
      emailBody?: string;
      channel: ['inbox'] | ['inbox', 'email'];
      link: string | null;
      dedupKey: string | null;
    }[];
  }> {
    this.assertPlatformAdmin(request);
    const items: {
      kind: NotificationKind;
      title: string;
      body: string;
      emailSubject?: string;
      emailBody?: string;
      channel: ['inbox'] | ['inbox', 'email'];
      link: string | null;
      dedupKey: string | null;
    }[] = [];
    for (const kind of NOTIFICATION_KINDS as readonly NotificationKind[]) {
      const template = await this.emailTemplates.findActive({ type: 'PLATFORM' }, kind);
      if (!template) continue;
      items.push({
        kind,
        title: template.subject,
        body: stripHtml(template.htmlBody),
        emailSubject: template.subject,
        emailBody: template.htmlBody,
        channel: ['inbox', 'email'],
        link: null,
        dedupKey: null,
      });
    }
    return { items };
  }

  /** POST /api/org/:clubId/notifications/email-templates/:kind（保存社团自定义模板） */
  @Post('/api/org/:clubId/notifications/email-templates/:kind')
  async saveClubTemplate(
    @Req() request: Request,
    @Param('clubId') clubId: string,
    @Param('kind') kind: string,
    @Body() input: EmailTemplateSaveInput,
  ): Promise<EmailTemplateView> {
    try {
      const { template } = await this.saveEmailTemplateCommand.execute({
        scope: { type: 'CLUB', clubId },
        actor: this.actorFrom(request),
        kind,
        subject: input.subject,
        htmlBody: input.htmlBody,
      });
      return this.toTemplateView(template);
    } catch (error) {
      this.mapConfigError(error);
    }
  }

  /** POST /api/org/:clubId/notifications/email-templates/:kind/preview（预览渲染） */
  @Post('/api/org/:clubId/notifications/email-templates/:kind/preview')
  async previewClubTemplate(
    @Req() request: Request,
    @Param('clubId') clubId: string,
    @Param('kind') kind: string,
    @Body() input: (EmailTemplateSaveInput & { variables?: Record<string, string> }) | undefined,
  ): Promise<EmailTemplatePreviewResult> {
    this.assertOrgReadAccess(request, clubId);
    const hasDraft = Boolean(input?.subject || input?.htmlBody);
    const preview = await this.templateResolver.preview({
      kind: kind as NotificationKind,
      clubId,
      draftSubject: hasDraft ? (input?.subject ?? '') : null,
      draftHtmlBody: hasDraft ? (input?.htmlBody ?? '') : null,
      variables: input?.variables ?? {},
    });
    if (!preview.ok) {
      return {
        ok: false,
        subject: null,
        htmlBody: null,
        ignoredVariables: [],
        source: 'DRAFT',
        violations: preview.violations,
      };
    }
    return {
      ok: true,
      subject: preview.subject,
      htmlBody: preview.htmlBody,
      ignoredVariables: preview.ignoredVariables,
      source: preview.source,
      violations: [],
    };
  }

  /** POST /api/org/:clubId/notifications/email-templates/:kind/test（模板测试邮件） */
  @Post('/api/org/:clubId/notifications/email-templates/:kind/test')
  async testClubTemplate(
    @Req() request: Request,
    @Param('clubId') clubId: string,
    @Param('kind') kind: string,
    @Body() input: (EmailTemplateSaveInput & { to?: string }) | undefined,
  ): Promise<EmailTemplateTestResult> {
    try {
      // 发信账号来自该社团自己的已验证配置（不能借用，NTF-006）
      const config = await this.emailConfigs.findByClub(clubId);
      if (!config || !config.verified || !config.secretCiphertext) {
        throw new BadRequestException('社团无有效发信配置，请先配置并通过测试邮件');
      }
      return await this.sendTemplateTestEmailCommand.execute({
        kind,
        clubId,
        draftSubject: input?.subject ?? null,
        draftHtmlBody: input?.htmlBody ?? null,
        to: input?.to ?? '',
        fromAddress: config.smtpUser,
        fromDisplayName: config.fromName,
      });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.mapConfigError(error);
    }
  }

  /** POST /api/org/:clubId/notifications/email-templates/:kind/rollback（版本回滚） */
  @Post('/api/org/:clubId/notifications/email-templates/:kind/rollback')
  async rollbackClubTemplate(
    @Req() request: Request,
    @Param('clubId') clubId: string,
    @Param('kind') kind: string,
    @Body() input: { version: number } | undefined,
  ): Promise<EmailTemplateRollbackResult> {
    try {
      const rolled = await this.rollbackEmailTemplateCommand.execute({
        scope: { type: 'CLUB', clubId },
        actor: this.actorFrom(request),
        kind,
        version: input?.version ?? 0,
      });
      return { rolledBack: true, activeVersion: rolled.activeVersion };
    } catch (error) {
      this.mapConfigError(error);
    }
  }

  private toTemplateView(template: {
    templateId: string;
    kind: NotificationKind;
    scope: { type: 'PLATFORM' } | { type: 'CLUB'; clubId: string };
    subject: string;
    htmlBody: string;
    activeVersion: number;
    updatedBy: string | null;
    updatedAt: string | null;
  }): EmailTemplateView {
    return {
      templateId: template.templateId,
      kind: template.kind,
      scopeType: template.scope.type,
      clubId: template.scope.type === 'CLUB' ? template.scope.clubId : null,
      subject: template.subject,
      htmlBody: template.htmlBody,
      activeVersion: template.activeVersion,
      updatedBy: template.updatedBy,
      updatedAt: template.updatedAt,
    };
  }

  // -------------------------------------------------------------------------
  // 邮件外发箱（接口清单 §15.9：最近 50 条，只读）
  // -------------------------------------------------------------------------

  /** GET /api/admin/notifications/email-outbox（邮件发送记录，只读；超管） */
  @Get('/api/admin/notifications/email-outbox')
  async adminEmailOutbox(@Req() request: Request): Promise<{ items: EmailOutboxItem[] }> {
    this.assertPlatformAdmin(request);
    const attempts = await this.attemptRepository.findRecentEmailAttempts(50);
    return {
      items: attempts.map((attempt) => ({
        id: attempt.attemptId,
        toUserId: attempt.recipientId ?? attempt.snapshotId ?? '',
        toEmail: attempt.targetAddress ?? '',
        subject: attempt.emailSubject ?? '',
        body: attempt.emailBody ?? '',
        kind: 'system' as NotificationKind,
        clubId:
          attempt.senderIdentity && attempt.senderIdentity !== 'platform'
            ? attempt.senderIdentity
            : null,
        sentAt: attempt.completedAt ?? attempt.createdAt,
      })),
    };
  }
}

/** 从 HTML 提取纯文本（模板目录展示用） */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** 社团邮件配置访问校验（查看与修改同权：club:email:config 或超管，NTF-006.6） */
function assertScopeAccess(actor: EmailConfigActor, scope: EmailConfigScope): void {
  if (scope.type === 'PLATFORM') {
    if (!actor.isPlatformAdmin) {
      throw new EmailConfigPermissionError('平台邮件配置仅超级管理员可管理');
    }
    return;
  }
  const hasClubPermission = (actor.permissions ?? []).includes('club:email:config');
  if (!hasClubPermission && !actor.isPlatformAdmin) {
    throw new EmailConfigPermissionError('无权查看或管理该社团邮件配置');
  }
}
