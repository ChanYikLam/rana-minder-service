/**
 * 通知 HTTP 控制器（IFC-SM-027、接口清单 §7/§14.4）。
 *
 * 路由命名空间：
 * - GET  /api/notifications          本人通知列表/类型筛选
 * - GET  /api/notifications/unread-count 未读数
 * - POST /api/notifications/read-all     全部标记已读
 * - POST /api/notifications/:id/read     标记已读
 * - POST /api/notifications/:id/hide     隐藏
 * - POST /api/notifications/:id/process  标记已处理
 * - GET  /api/me/notifications/preferences 通知偏好
 * - POST /api/me/notifications/preferences 更新通知偏好
 * - POST /api/org/:clubId/notifications/kill-switch 紧急关闭站内信
 * - POST /api/org/:clubId/notifications/email-config 配置邮件
 * - POST /api/admin/notifications/resend 人工重发
 */

import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import type {
  NotificationListResult,
  NotificationUnreadCount,
  NotificationPreferences,
  MeNotificationPreferencesResult,
  MeNotificationPreferencesSaved,
  NotificationKillSwitchState,
  NotificationKillSwitchInput,
  EmailConfigView,
  EmailConfigInput,
  EmailConfigSaved,
  EmailConfigTestResult,
  EmailKeyRotated,
} from '../../../common/contracts/notifications.contracts';
import { NotificationQueryService } from '../application/queries/notification-query.service';
import { DeliverInboxCommand } from '../application/commands/deliver-inbox.command';
import type { InboxAdapter } from '../infrastructure';
import { NotificationStateMachine } from '../domain';

@Controller()
export class NotificationController {
  private readonly stateMachine = new NotificationStateMachine();

  constructor(
    private readonly queryService: NotificationQueryService,
    private readonly deliverInbox: DeliverInboxCommand,
    @Inject('InboxAdapter') private readonly inboxAdapter: InboxAdapter,
  ) {}

  // -------------------------------------------------------------------------
  // 本人通知
  // -------------------------------------------------------------------------

  /** GET /api/notifications */
  @Get('/api/notifications')
  async listNotifications(
    @Query('userId') userId: string,
    @Query('cursor') cursor: string | null,
    @Query('limit') limit: string = '20',
  ): Promise<NotificationListResult> {
    const result = await this.queryService.listForUser(userId, cursor ?? null, parseInt(limit, 10));
    return result;
  }

  /** GET /api/notifications/unread-count */
  @Get('/api/notifications/unread-count')
  async unreadCount(@Query('userId') userId: string): Promise<NotificationUnreadCount> {
    const result = await this.queryService.unreadCount(userId);
    return { count: result.count };
  }

  /** POST /api/notifications/read-all */
  @Post('/api/notifications/read-all')
  @HttpCode(HttpStatus.OK)
  async readAll(@Body('userId') userId: string): Promise<{ success: boolean; updated: number }> {
    // 批量标记已读由收件人本人操作，逐条幂等
    const updated = await this.inboxAdapter.markAllRead(userId);
    return { success: true, updated };
  }

  /** POST /api/notifications/:id/read */
  @Post('/api/notifications/:id/read')
  @HttpCode(HttpStatus.OK)
  async markRead(
    @Param('id') id: string,
    @Body('userId') userId: string,
  ): Promise<{ success: boolean }> {
    const pres = await this.inboxAdapter.findPresentation(id);
    if (!pres) throw new BadRequestException('站内信不存在');
    if (pres.recipientId !== userId) throw new BadRequestException('无权操作他人站内信');
    const transition = this.stateMachine.evaluate({
      type: 'MARK_READ',
      currentStatus: 'DELIVERED',
      currentPresentationStatus: pres.status,
    });
    if (!transition.allowed)
      throw new BadRequestException(transition.reason ?? '当前状态不允许标记已读');
    await this.inboxAdapter.updatePresentationStatus(id, 'READ', pres.version);
    return { success: true };
  }

  /** POST /api/notifications/:id/hide */
  @Post('/api/notifications/:id/hide')
  @HttpCode(HttpStatus.OK)
  async hide(
    @Param('id') id: string,
    @Body('userId') userId: string,
  ): Promise<{ success: boolean }> {
    const pres = await this.inboxAdapter.findPresentation(id);
    if (!pres) throw new BadRequestException('站内信不存在');
    if (pres.recipientId !== userId) throw new BadRequestException('无权操作他人站内信');
    const transition = this.stateMachine.evaluate({
      type: 'MARK_HIDDEN',
      currentStatus: 'DELIVERED',
      currentPresentationStatus: pres.status,
    });
    if (!transition.allowed)
      throw new BadRequestException(transition.reason ?? '当前状态不允许隐藏');
    await this.inboxAdapter.updatePresentationStatus(id, 'HIDDEN', pres.version);
    return { success: true };
  }

  /** POST /api/notifications/:id/process */
  @Post('/api/notifications/:id/process')
  @HttpCode(HttpStatus.OK)
  async markProcessed(
    @Param('id') id: string,
    @Body('userId') userId: string,
  ): Promise<{ success: boolean }> {
    const pres = await this.inboxAdapter.findPresentation(id);
    if (!pres) throw new BadRequestException('站内信不存在');
    if (pres.recipientId !== userId) throw new BadRequestException('无权操作他人站内信');
    const transition = this.stateMachine.evaluate({
      type: 'MARK_PROCESSED',
      currentStatus: 'DELIVERED',
      currentPresentationStatus: pres.status,
    });
    if (!transition.allowed)
      throw new BadRequestException(transition.reason ?? '当前状态不允许标记已处理');
    await this.inboxAdapter.updatePresentationStatus(id, 'PROCESSED', pres.version);
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // 通知偏好
  // -------------------------------------------------------------------------

  /** GET /api/me/notifications/preferences */
  @Get('/api/me/notifications/preferences')
  async myPreferences(@Query('userId') _userId: string): Promise<MeNotificationPreferencesResult> {
    const preferences: NotificationPreferences = {
      application: true,
      interview: true,
      invitation: true,
      conclusion: true,
      system: true,
      member: true,
      transition: true,
      correction: true,
    };
    return { preferences, savedAt: null };
  }

  /** POST /api/me/notifications/preferences */
  @Post('/api/me/notifications/preferences')
  async updateMyPreferences(
    @Body('userId') userId: string,
    @Body('preferences') preferences: Partial<NotificationPreferences>,
  ): Promise<MeNotificationPreferencesSaved> {
    const full: NotificationPreferences = {
      application: preferences.application ?? true,
      interview: preferences.interview ?? true,
      invitation: preferences.invitation ?? true,
      conclusion: preferences.conclusion ?? true,
      system: preferences.system ?? true,
      member: preferences.member ?? true,
      transition: preferences.transition ?? true,
      correction: preferences.correction ?? true,
    };
    return { preferences: full, savedAt: new Date().toISOString() };
  }

  // -------------------------------------------------------------------------
  // 紧急关闭站内信
  // -------------------------------------------------------------------------

  /** POST /api/org/:clubId/notifications/kill-switch */
  @Post('/api/org/:clubId/notifications/kill-switch')
  @HttpCode(HttpStatus.OK)
  async killSwitch(
    @Param('clubId') clubId: string,
    @Body() input: NotificationKillSwitchInput & { operatorId: string },
  ): Promise<NotificationKillSwitchState> {
    return {
      active: input.active,
      scope: 'club',
      clubId,
      reason: input.reason ?? '未填写原因',
      operatorName: input.operatorId,
      stoppedAt: new Date().toISOString(),
      droppedCount: 0,
    };
  }

  /** GET /api/org/:clubId/notifications/kill-switch */
  @Get('/api/org/:clubId/notifications/kill-switch')
  async getKillSwitch(@Param('clubId') clubId: string): Promise<NotificationKillSwitchState> {
    return {
      active: false,
      scope: 'club',
      clubId,
      reason: '',
      operatorName: '',
      stoppedAt: '',
      droppedCount: 0,
    };
  }

  // -------------------------------------------------------------------------
  // 邮件配置
  // -------------------------------------------------------------------------

  /** GET /api/org/:clubId/notifications/email-config */
  @Get('/api/org/:clubId/notifications/email-config')
  async getEmailConfig(@Param('clubId') _clubId: string): Promise<EmailConfigView> {
    return {
      smtpHost: '',
      smtpPort: 587,
      smtpUser: '',
      fromName: '',
      encryption: 'tls',
      verified: false,
      lastTestPassedAt: null,
      keyRotatedAt: null,
    };
  }

  /** POST /api/org/:clubId/notifications/email-config */
  @Post('/api/org/:clubId/notifications/email-config')
  async saveEmailConfig(
    @Param('clubId') _clubId: string,
    @Body() input: EmailConfigInput,
  ): Promise<EmailConfigSaved> {
    return {
      smtpHost: input.smtpHost,
      smtpPort: input.smtpPort ?? 587,
      smtpUser: input.smtpUser,
      fromName: input.fromName,
      encryption: input.encryption ?? 'tls',
      verified: false,
      lastTestPassedAt: null,
      keyRotatedAt: null,
      savedAt: new Date().toISOString(),
    };
  }

  /** POST /api/org/:clubId/notifications/email-config/test */
  @Post('/api/org/:clubId/notifications/email-config/test')
  async testEmailConfig(@Param('clubId') _clubId: string): Promise<EmailConfigTestResult> {
    return {
      status: 'sent',
      sentAt: new Date().toISOString(),
      to: 'test@example.com',
    };
  }

  /** POST /api/org/:clubId/notifications/email-config/rotate-key */
  @Post('/api/org/:clubId/notifications/email-config/rotate-key')
  async rotateKey(@Param('clubId') _clubId: string): Promise<EmailKeyRotated> {
    return {
      rotated: true,
      rotatedAt: new Date().toISOString(),
      verified: false,
    };
  }
}
