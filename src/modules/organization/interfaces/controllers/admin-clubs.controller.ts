/**
 * 平台管理 · 社团接入与治理控制器（§15.1/15.2）。
 *
 * 仅平台超管（platform:club:manage）：每次请求经 CurrentPermissionsPort 重算
 * （ORG-038），不信任前端角色/作用域。
 */

import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';

import { Actor, type RequestActor } from '../actor';
import type { OnboardingUseCase } from '../../application/commands/onboard-club.use-case';
import type { ClubLifecycleUseCase } from '../../application/commands/club-lifecycle.use-case';
import type {
  AdminClubsQuery,
  GroupDirectoryQuery,
} from '../../application/queries/admin-clubs.query';
import {
  ADMIN_CLUBS_QUERY,
  CLUB_LIFECYCLE_USE_CASE,
  CURRENT_PERMISSIONS_PORT,
  GROUP_DIRECTORY_QUERY,
  ONBOARDING_USE_CASE,
  type CurrentPermissionsPort,
} from '../../application/ports';
import { orgError } from '../../domain/types';
import {
  ConfirmedActionDto,
  ImportMembersDto,
  ReaccessDto,
  RebindDto,
  SuspensionDto,
  WizardCompleteDto,
  WizardCreateDto,
  WizardSaveStepDto,
} from '../dto';

@Controller('admin')
export class AdminClubsController {
  constructor(
    @Inject(ONBOARDING_USE_CASE) private readonly onboarding: OnboardingUseCase,
    @Inject(CLUB_LIFECYCLE_USE_CASE) private readonly lifecycle: ClubLifecycleUseCase,
    @Inject(ADMIN_CLUBS_QUERY) private readonly query: AdminClubsQuery,
    @Inject(GROUP_DIRECTORY_QUERY) private readonly groups: GroupDirectoryQuery,
    @Inject(CURRENT_PERMISSIONS_PORT) private readonly permissions: CurrentPermissionsPort,
  ) {}

  private async assertPlatformClubManage(actor: RequestActor): Promise<void> {
    const isSuper = await this.permissions.isPlatformSuperAdmin(actor.userId);
    if (!isSuper) {
      throw orgError.forbidden(
        '仅平台超级管理员可执行社团接入与治理（ORG-029、platform:club:manage）',
      );
    }
  }

  @Get('clubs')
  async listClubs(@Actor() actor: RequestActor) {
    await this.assertPlatformClubManage(actor);
    return { items: await this.query.list(), nextCursor: null };
  }

  @Get('groups')
  async listGroups(@Actor() actor: RequestActor) {
    await this.assertPlatformClubManage(actor);
    return { items: await this.groups.list() };
  }

  @Get('groups/search')
  async searchGroups(@Actor() actor: RequestActor, @Query('q') q?: string) {
    await this.assertPlatformClubManage(actor);
    return { items: await this.groups.search(q ?? ''), threshold: 3 };
  }

  @Get('groups/:groupId')
  async groupDetail(@Actor() actor: RequestActor, @Param('groupId') groupId: string) {
    await this.assertPlatformClubManage(actor);
    const dir = await this.groups.list();
    const item = dir.find((d) => d.id === groupId) ?? dir.find((d) => d.parentId === groupId);
    if (item === undefined) {
      throw orgError.notVisible(`Group 不存在（${groupId}，IFC-ERR-015）`);
    }
    // 直接复用目录项的稳定 id（owner/name），避免对非复合 groupId 二次拼接产生
    // "owner/undefined" 或与目录 id 不一致（ORG-013/CAS-MAP-003）。
    return { ...item, id: item.id, leaderGroups: [], departments: [], positions: [] };
  }

  @Post('clubs/wizard')
  @HttpCode(201)
  async createWizard(@Actor() actor: RequestActor, @Body() dto: WizardCreateDto) {
    await this.assertPlatformClubManage(actor);
    return this.onboarding.createWizard(
      {
        groupId: dto.groupId,
        name: dto.name,
        description: dto.description ?? '',
        leaderGroupId: dto.leaderGroupId,
        email: dto.email,
        departmentGroupIds: dto.departmentGroupIds ?? [],
        positionGroupIds: dto.positionGroupIds ?? [],
        leaderRoleGroupId: dto.leaderRoleGroupId,
        actor: actor.userId,
        reauthProof: dto.reauthProof,
      },
      new Date(),
    );
  }

  @Post('clubs/wizard/save-step')
  @HttpCode(200)
  async saveStep(@Actor() actor: RequestActor, @Body() dto: WizardSaveStepDto) {
    await this.assertPlatformClubManage(actor);
    return this.onboarding.saveStep(
      { clubId: dto.clubId, actor: actor.userId, name: dto.name, email: dto.email },
      new Date(),
    );
  }

  @Post('clubs/wizard/complete')
  @HttpCode(200)
  async completeWizard(@Actor() actor: RequestActor, @Body() dto: WizardCompleteDto) {
    await this.assertPlatformClubManage(actor);
    return this.onboarding.complete(
      { clubId: dto.clubId, actor: actor.userId, confirmed: dto.confirmed },
      new Date(),
    );
  }

  @Post('clubs/:clubId/import')
  @HttpCode(200)
  async importMembers(
    @Actor() actor: RequestActor,
    @Param('clubId') clubId: string,
    @Body() dto: ImportMembersDto,
  ) {
    await this.assertPlatformClubManage(actor);
    return this.onboarding.importMembers({
      clubId,
      memberIds: dto.memberIds,
      actor: actor.userId,
      now: new Date(),
    });
  }

  @Post('clubs/:clubId/normal-suspend')
  @HttpCode(200)
  async normalSuspend(
    @Actor() actor: RequestActor,
    @Param('clubId') clubId: string,
    @Body() dto: SuspensionDto,
  ) {
    await this.assertPlatformClubManage(actor);
    return this.lifecycle.normalSuspend({
      clubId,
      reason: dto.reason,
      actor: actor.userId,
      now: new Date(),
    });
  }

  @Post('clubs/:clubId/force-suspend')
  @HttpCode(200)
  async forceSuspend(
    @Actor() actor: RequestActor,
    @Param('clubId') clubId: string,
    @Body() dto: SuspensionDto,
  ) {
    await this.assertPlatformClubManage(actor);
    return this.lifecycle.forceSuspend({
      clubId,
      reason: dto.reason,
      actor: actor.userId,
      confirmed: dto.confirmed ?? false,
      now: new Date(),
    });
  }

  @Post('clubs/:clubId/recover')
  @HttpCode(200)
  async recover(@Actor() actor: RequestActor, @Param('clubId') clubId: string) {
    await this.assertPlatformClubManage(actor);
    return this.lifecycle.recover({ clubId, actor: actor.userId, now: new Date() });
  }

  @Post('clubs/:clubId/repair')
  @HttpCode(200)
  async repair(@Actor() actor: RequestActor, @Param('clubId') clubId: string) {
    await this.assertPlatformClubManage(actor);
    return this.lifecycle.repair({ clubId, actor: actor.userId, now: new Date() });
  }

  @Post('clubs/:clubId/rebind')
  @HttpCode(200)
  async rebind(
    @Actor() actor: RequestActor,
    @Param('clubId') clubId: string,
    @Body() dto: RebindDto,
  ) {
    await this.assertPlatformClubManage(actor);
    return this.lifecycle.rebind({
      clubId,
      groupId: dto.groupId,
      actor: actor.userId,
      confirmed: dto.confirmed,
      now: new Date(),
    });
  }

  @Post('clubs/:clubId/disconnect')
  @HttpCode(200)
  async disconnect(
    @Actor() actor: RequestActor,
    @Param('clubId') clubId: string,
    @Body() dto: ConfirmedActionDto,
  ) {
    await this.assertPlatformClubManage(actor);
    return this.lifecycle.disconnect({
      clubId,
      actor: actor.userId,
      confirmed: dto.confirmed ?? false,
      now: new Date(),
    });
  }

  @Post('clubs/:clubId/reaccess')
  @HttpCode(200)
  async reaccess(
    @Actor() actor: RequestActor,
    @Param('clubId') clubId: string,
    @Body() dto: ReaccessDto,
  ) {
    await this.assertPlatformClubManage(actor);
    return this.lifecycle.reaccess({
      clubId,
      groupId: dto.groupId,
      actor: actor.userId,
      confirmed: dto.confirmed,
      now: new Date(),
    });
  }
}
