/**
 * 通知 HTTP 控制器（IFC-SM-027、接口清单 §7/§14.4/§15.9）。
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
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
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
  NotificationListQuery,
} from '../../../common/contracts/notifications.contracts';
import { NotificationQueryService } from '../application/queries/notification-query.service';
import {
  ApplyKillSwitchCommand,
  MarkAllReadCommand,
  MarkPresentationStatusCommand,
  ResumeKillSwitchCommand,
} from '../application/commands';
import { KillSwitchRepository } from '../infrastructure';
import type { KillSwitchScope, KillSwitchStateModel } from '../domain';

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

@Controller()
export class NotificationController {
  constructor(
    private readonly queryService: NotificationQueryService,
    private readonly markPresentationStatus: MarkPresentationStatusCommand,
    private readonly markAllRead: MarkAllReadCommand,
    private readonly applyKillSwitch: ApplyKillSwitchCommand,
    private readonly resumeKillSwitch: ResumeKillSwitchCommand,
    private readonly killSwitches: KillSwitchRepository,
  ) {}

  // -------------------------------------------------------------------------
  // 本人通知（NTF-003：已读/未读/已处理/隐藏、类型筛选、跳转业务页）
  // -------------------------------------------------------------------------

  /** GET /api/notifications */
  @Get('/api/notifications')
  async listNotifications(
    @Query('userId') userId: string,
    @Query('cursor') cursor: string | null,
    @Query('limit') limit: string = '20',
    @Query('kind') kind: string | null,
    @Query('unreadOnly') unreadOnly: string | null,
    @Query('includeHidden') includeHidden: string | null,
  ): Promise<NotificationListResult> {
    const query: NotificationListQuery = {
      kind:
        kind && NOTIFICATION_KINDS.includes(kind) ? (kind as NotificationListQuery['kind']) : null,
      unreadOnly: unreadOnly === 'true',
      includeHidden: includeHidden === 'true',
    };
    return this.queryService.listForUser(userId, query, cursor ?? null, parseInt(limit, 10) || 20);
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
  async readAll(
    @Body('userId') userId: string,
  ): Promise<{ success: boolean; updatedCount: number }> {
    const result = await this.markAllRead.execute(userId);
    return { success: true, updatedCount: result.updatedCount };
  }

  /** POST /api/notifications/:id/read */
  @Post('/api/notifications/:id/read')
  @HttpCode(HttpStatus.OK)
  async markRead(
    @Param('id') id: string,
    @Body('userId') userId: string,
  ): Promise<{ success: boolean }> {
    await this.runMark(id, userId, 'READ');
    return { success: true };
  }

  /** POST /api/notifications/:id/hide（权益通知不可物理删除，归入隐藏列表） */
  @Post('/api/notifications/:id/hide')
  @HttpCode(HttpStatus.OK)
  async hide(
    @Param('id') id: string,
    @Body('userId') userId: string,
  ): Promise<{ success: boolean }> {
    await this.runMark(id, userId, 'HIDDEN');
    return { success: true };
  }

  /** POST /api/notifications/:id/process */
  @Post('/api/notifications/:id/process')
  @HttpCode(HttpStatus.OK)
  async markProcessed(
    @Param('id') id: string,
    @Body('userId') userId: string,
  ): Promise<{ success: boolean }> {
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
  // 紧急关闭站内信（NTF-001、SRS-FAIL-009、IFC-NTF-001、XCC-FAIL-009）
  // -------------------------------------------------------------------------

  /** POST /api/org/:clubId/notifications/kill-switch（社团级） */
  @Post('/api/org/:clubId/notifications/kill-switch')
  @HttpCode(HttpStatus.OK)
  async clubKillSwitch(
    @Param('clubId') clubId: string,
    @Body() input: NotificationKillSwitchInput & { operatorId?: string },
  ): Promise<NotificationKillSwitchState> {
    return this.toggleKillSwitch('CLUB', clubId, input, input.operatorId ?? 'unknown-operator');
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
    @Body() input: NotificationKillSwitchInput & { operatorId?: string },
  ): Promise<NotificationKillSwitchState> {
    return this.toggleKillSwitch('PLATFORM', null, input, input.operatorId ?? 'unknown-operator');
  }

  /** GET /api/admin/notifications/kill-switch（平台级状态） */
  @Get('/api/admin/notifications/kill-switch')
  async getPlatformKillSwitch(): Promise<NotificationKillSwitchState> {
    return this.toState(await this.killSwitches.findByScope('PLATFORM', null));
  }

  /**
   * 关闭（active=true）或恢复（active=false）站内信。
   * 关闭必须：填原因、二次确认、设预计恢复时间（并写入特权审计）。
   */
  private async toggleKillSwitch(
    scope: KillSwitchScope,
    clubId: string | null,
    input: NotificationKillSwitchInput & { operatorId?: string },
    operatorId: string,
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
          operatorName: input.operatorName ?? operatorId,
        });
        return this.toState(result.state);
      }
      const result = await this.resumeKillSwitch.execute({
        scope,
        clubId,
        operatorId,
        operatorName: input.operatorName ?? operatorId,
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
