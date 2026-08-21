/**
 * 领域模块 · 组织与授权（ADR-002 §2.1；SRS-SM-ORG-001~004）。
 *
 * 装配策略（端口 + 内存桩）：
 * - 外部依赖全部经 application/ports 注入；本次以 infrastructure/in-memory
 *   提供可配置桩，真实适配器由对应基础设施模块替换（ADR-009/014/004）。
 * - 状态机/领域服务为纯规则，保持不可变（与 observability 惯例一致）。
 * - 控制器按接口契约 §15.1/15.2/15.3 与 org 域路由挂载。
 */

import { Module } from '@nestjs/common';

import { AdminClubsQuery } from './application/queries/admin-clubs.query';
import { GroupDirectoryQuery } from './application/queries/admin-clubs.query';
import { PermissionTemplateQuery } from './application/queries/permission-template.query';
import { OrgContextQuery } from './application/queries/org-context.query';

import { appointmentCommandProvider } from './application/commands/appointment-command.use-case';
import { onboardingProvider } from './application/commands/onboard-club.use-case';
import { clubLifecycleProvider } from './application/commands/club-lifecycle.use-case';
import { relationCommandProvider } from './application/commands/relation-command.use-case';
import { permissionTemplateCommandProvider } from './application/commands/permission-template.command';
import { controlledBatchProvider } from './application/commands/controlled-batch.use-case';

import {
  CASDOOR_GROUP_PORT,
  CLOCK,
  CLUB_STORE,
  CURRENT_PERMISSIONS_PORT,
  JOB_SCHEDULER,
  NOTIFICATION_PORT,
  RECONCILE_PORT,
  GROUP_MAPPING_REGISTRY,
  PERMISSION_TEMPLATE_STORE,
  RELATION_COMMAND_STORE,
  APPOINTMENT_COMMAND_STORE,
  ADMIN_CLUBS_QUERY,
  GROUP_DIRECTORY_QUERY,
  PERMISSION_TEMPLATE_QUERY,
  ORG_CONTEXT_QUERY,
} from './application/ports';

import {
  InMemoryCasdoorPort,
  InMemoryClubStore,
  InMemoryRelationCommandStore,
  InMemoryAppointmentCommandStore,
  InMemoryPermissionTemplateStore,
  InMemoryGroupMappingRegistry,
  InMemoryReconcilePort,
  InMemoryJobScheduler,
  InMemoryNotificationPort,
  MemoryCurrentPermissionsPort,
  SystemClock,
} from './infrastructure/in-memory/memory-implementations';
import type {
  MemoryCasdoorSeed,
  MemoryReconcileConfig,
} from './infrastructure/in-memory/memory-implementations';
import type {
  CasdoorGroupPort,
  ClubStore,
  CurrentPermissionsPort,
  GroupMappingRegistry,
  PermissionTemplateStore,
} from './application/ports';

import { AdminClubsController } from './interfaces/controllers/admin-clubs.controller';
import { AdminPermissionTemplatesController } from './interfaces/controllers/admin-permission-templates.controller';
import { OrgWorkspaceController } from './interfaces/controllers/org-workspace.controller';

@Module({
  imports: [],
  controllers: [AdminClubsController, AdminPermissionTemplatesController, OrgWorkspaceController],
  providers: [
    {
      provide: CLOCK,
      useFactory: () => new SystemClock(),
    },
    {
      provide: CASDOOR_GROUP_PORT,
      useFactory: () =>
        new InMemoryCasdoorPort({
          groups: [
            {
              ref: { owner: 'builtin', name: '平台超管' },
              displayName: '平台超管',
              parentRef: null,
              memberIds: ['u_root'],
            },
            {
              ref: { owner: 'club-acm', name: 'ACM社团' },
              displayName: 'ACM社团',
              memberIds: ['u_a', 'u_b', 'u_c'],
            },
            {
              ref: { owner: 'club-acm', name: '负责人组' },
              displayName: '负责人组',
              parentRef: { owner: 'club-acm', name: 'ACM社团' },
              memberIds: ['u_a'],
            },
            {
              ref: { owner: 'club-acm', name: '人事组' },
              displayName: '人事组',
              parentRef: { owner: 'club-acm', name: 'ACM社团' },
              memberIds: ['u_b'],
            },
            {
              ref: { owner: 'club-acm', name: '宣传部' },
              displayName: '宣传部',
              parentRef: { owner: 'club-acm', name: 'ACM社团' },
              memberIds: ['u_c'],
            },
          ],
        } satisfies MemoryCasdoorSeed),
    },
    {
      provide: CLUB_STORE,
      useFactory: () => new InMemoryClubStore(),
    },
    {
      provide: RELATION_COMMAND_STORE,
      useFactory: () => new InMemoryRelationCommandStore(),
    },
    {
      provide: APPOINTMENT_COMMAND_STORE,
      useFactory: () => new InMemoryAppointmentCommandStore(),
    },
    {
      provide: PERMISSION_TEMPLATE_STORE,
      useFactory: () => new InMemoryPermissionTemplateStore(),
    },
    {
      provide: GROUP_MAPPING_REGISTRY,
      useFactory: () => new InMemoryGroupMappingRegistry(),
    },
    {
      provide: RECONCILE_PORT,
      useFactory: () =>
        new InMemoryReconcilePort({
          anomalies: new Map(),
          renamedOnly: new Set(),
        } satisfies MemoryReconcileConfig),
    },
    {
      provide: JOB_SCHEDULER,
      useFactory: () => new InMemoryJobScheduler(),
    },
    {
      provide: NOTIFICATION_PORT,
      useFactory: () => new InMemoryNotificationPort(),
    },
    {
      provide: CURRENT_PERMISSIONS_PORT,
      useFactory: () =>
        new MemoryCurrentPermissionsPort({
          superAdminUsers: ['u_root'],
          userId: 'u_root',
          clubPermissions: new Map([['club-acm-1', ['club:member:manage']]]),
          positionGroupMemberships: new Map([
            [
              'u_a',
              [
                {
                  group: { owner: 'club-acm', name: '负责人组' },
                  clubId: 'club-acm-1',
                  departmentId: null,
                },
              ],
            ],
            [
              'u_b',
              [
                {
                  group: { owner: 'club-acm', name: '人事组' },
                  clubId: 'club-acm-1',
                  departmentId: null,
                },
              ],
            ],
            [
              'u_c',
              [
                {
                  group: { owner: 'club-acm', name: '宣传部' },
                  clubId: 'club-acm-1',
                  departmentId: 'dept-pr',
                },
              ],
            ],
          ]),
        }),
    },
    onboardingProvider,
    clubLifecycleProvider,
    relationCommandProvider,
    appointmentCommandProvider,
    permissionTemplateCommandProvider,
    controlledBatchProvider,
    {
      provide: ADMIN_CLUBS_QUERY,
      useFactory: (clubs: ClubStore, registry: GroupMappingRegistry, casdoor: CasdoorGroupPort) =>
        new AdminClubsQuery(clubs, registry, casdoor),
      inject: [CLUB_STORE, GROUP_MAPPING_REGISTRY, CASDOOR_GROUP_PORT],
    },
    {
      provide: GROUP_DIRECTORY_QUERY,
      useFactory: (casdoor: CasdoorGroupPort, registry: GroupMappingRegistry) =>
        new GroupDirectoryQuery(casdoor, registry),
      inject: [CASDOOR_GROUP_PORT, GROUP_MAPPING_REGISTRY],
    },
    {
      provide: PERMISSION_TEMPLATE_QUERY,
      useFactory: (store: PermissionTemplateStore) => new PermissionTemplateQuery(store),
      inject: [PERMISSION_TEMPLATE_STORE],
    },
    {
      provide: ORG_CONTEXT_QUERY,
      useFactory: (clubs: ClubStore, permissions: CurrentPermissionsPort) =>
        new OrgContextQuery(clubs, permissions),
      inject: [CLUB_STORE, CURRENT_PERMISSIONS_PORT],
    },
  ],
  exports: [
    CLOCK,
    CASDOOR_GROUP_PORT,
    CLUB_STORE,
    CURRENT_PERMISSIONS_PORT,
    JOB_SCHEDULER,
    NOTIFICATION_PORT,
    GROUP_MAPPING_REGISTRY,
    PERMISSION_TEMPLATE_STORE,
  ],
})
export class OrganizationModule {}
