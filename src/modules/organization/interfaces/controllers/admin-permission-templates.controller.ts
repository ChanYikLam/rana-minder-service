/**
 * 平台管理 · 权限模板控制器（§15.3）。
 *
 * 仅平台超管（platform:config:manage）；发布为高风控命令（重新认证 + 差异预览 +
 * 二次确认 + 原因，IFC-ERR-002/008）。
 */

import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';

import { Actor, type RequestActor } from '../actor';
import type { PermissionTemplateQuery } from '../../application/queries/permission-template.query';
import type { PermissionTemplateCommand } from '../../application/commands/permission-template.command';
import {
  CURRENT_PERMISSIONS_PORT,
  PERMISSION_TEMPLATE_COMMAND,
  PERMISSION_TEMPLATE_QUERY,
  type CurrentPermissionsPort,
} from '../../application/ports';
import { orgError } from '../../domain/types';
import { TemplateCreateDto, TemplatePublishDto, TemplateSaveDraftDto } from '../dto';

@Controller('admin/config/permission-templates')
export class AdminPermissionTemplatesController {
  constructor(
    @Inject(PERMISSION_TEMPLATE_QUERY) private readonly query: PermissionTemplateQuery,
    @Inject(PERMISSION_TEMPLATE_COMMAND) private readonly command: PermissionTemplateCommand,
    @Inject(CURRENT_PERMISSIONS_PORT) private readonly permissions: CurrentPermissionsPort,
  ) {}

  private async assertPlatformConfigManage(actor: RequestActor): Promise<void> {
    const isSuper = await this.permissions.isPlatformSuperAdmin(actor.userId);
    if (!isSuper) {
      throw orgError.forbidden(
        '仅平台超级管理员可在固定权限项目录内配置模板/映射（ORG-035、platform:config:manage）',
      );
    }
  }

  @Get()
  async list(@Actor() actor: RequestActor) {
    await this.assertPlatformConfigManage(actor);
    return { items: await this.query.list() };
  }

  @Post()
  @HttpCode(201)
  async create(@Actor() actor: RequestActor, @Body() dto: TemplateCreateDto) {
    await this.assertPlatformConfigManage(actor);
    return this.command.create({ name: dto.name, permissions: dto.permissions });
  }

  @Post(':templateId/save')
  @HttpCode(200)
  async saveDraft(
    @Actor() actor: RequestActor,
    @Param('templateId') templateId: string,
    @Body() dto: TemplateSaveDraftDto,
  ) {
    await this.assertPlatformConfigManage(actor);
    return this.command.saveDraft({ templateId, name: dto.name, permissions: dto.permissions });
  }

  @Get(':templateId/diff')
  async diff(@Actor() actor: RequestActor, @Param('templateId') templateId: string) {
    await this.assertPlatformConfigManage(actor);
    return this.query.diff({ templateId });
  }

  @Post(':templateId/publish')
  @HttpCode(200)
  async publish(
    @Actor() actor: RequestActor,
    @Param('templateId') templateId: string,
    @Body() dto: TemplatePublishDto,
  ) {
    await this.assertPlatformConfigManage(actor);
    return this.command.publish({
      templateId,
      reauthProof: dto.reauthProof,
      previewVersion: dto.previewVersion,
      reason: dto.reason,
    });
  }
}
