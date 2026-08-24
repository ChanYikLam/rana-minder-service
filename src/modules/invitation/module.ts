import { Module } from '@nestjs/common';

import { DB_ADAPTER } from '../../adapters/tokens';
import { CreateInvitationCommand } from './application/commands/create-invitation.command';
import { AcceptInvitationCommand } from './application/commands/accept-invitation.command';
import { RejectInvitationCommand } from './application/commands/reject-invitation.command';
import { WithdrawInvitationCommand } from './application/commands/withdraw-invitation.command';
import { ExpireInvitationCommand } from './application/commands/expire-invitation.command';
import { ForceInvalidateInvitationCommand } from './application/commands/force-invalidate.command';
import { ReissueInvitationCommand } from './application/commands/reissue-invitation.command';
import { ResolveActivationCommand } from './application/commands/resolve-activation.command';
import { InvitationStatusQuery } from './application/queries/invitation-status.query';
import { CreateRoutineInvitationCommand } from './application/commands/create-routine-invitation.command';
import { AcceptRoutineInvitationCommand } from './application/commands/accept-routine-invitation.command';
import { RejectRoutineInvitationCommand } from './application/commands/routine-reject-withdraw.command';
import { WithdrawRoutineInvitationCommand } from './application/commands/routine-reject-withdraw.command';
import { ExpireRoutineInvitationCommand } from './application/commands/expire-routine-invitation.command';
import { ReissueRoutineInvitationCommand } from './application/commands/reissue-routine-invitation.command';
import { ResolveRoutineActivationCommand } from './application/commands/resolve-routine-activation.command';
import { RoutineInvitationStatusQuery } from './application/queries/routine-status.query';
import { InvitationStateMachine } from './domain/state-machines/invitation-state-machine';
import { RoutineInvitationStateMachine } from './domain/state-machines/routine-invitation-state-machine';
import { InvitationPolicy } from './domain/services/invitation-policy';
import { INVITATION_REPOSITORY } from './infrastructure/invitation-repository';
import { ROUTINE_INVITATION_REPOSITORY } from './infrastructure/routine-invitation-repository';
import { PostgresInvitationRepository } from './infrastructure/postgres-invitation.repository';
import { PostgresRoutineInvitationRepository } from './infrastructure/postgres-invitation.repository';
import { CASDOOR_RELATION_PORT } from './infrastructure/casdoor-relation-port';
import { OrgBackedCasdoorRelationPort } from './infrastructure/org-backed-casdoor-relation';
import { OrganizationModule } from '../organization/module';
import { GROUP_MAPPING_REGISTRY } from '../organization/application/ports';
import { CasdoorModule } from '../../platform/casdoor/module';
import { IdentityModule } from '../identity/identity.module';
import { AUTH_SESSION_PROVIDER } from '../identity/tokens';
import { adaptSessionProvider } from '../../shared/adapt-session-provider';
import { INVITATION_AUTH_SESSION_PROVIDER } from './interfaces/nest/invitation-auth-session';
import { InvitationAuthGuard } from './interfaces/nest/invitation-auth.guard';
import { InvitationNestController } from './interfaces/nest/invitation.nest.controller';
import { CASDOOR_WRITE_PORT } from '../../platform/casdoor/contracts/ports';

/**
 * 领域模块：邀请与成员激活（4.5，SRS-SM-INV-001、SRS-SM-MEM-004）。
 *
 * 职责：普通录取/联合/常规入社邀请的创建、接受、拒绝、撤回、重发、
 * 过期、强制失效与成员身份生效编排。
 *
 * 核心不变量（REC-024~028、JNT-013~018、MEM-018）：
 * - 已接受不可逆；接受与撤回/过期/强制失效单胜者竞争；
 * - Casdoor 写后定向读回确认前不开放成员权限（成员身份生效处理中）；
 * - 常规入社整体接受不可拆分；社团及可选部门全部回读确认才已生效；
 * - 只确认部分关系不得成功（组合补偿）；无法确认且无法补偿→高优先级同步异常；
 * - 重发 = 全新邀请对象，旧邀请不修改保留；接受和退出历史不得删除。
 */
@Module({
  imports: [OrganizationModule, CasdoorModule, IdentityModule],
  controllers: [InvitationNestController],
  providers: [
    // 领域规则（纯规则）
    InvitationStateMachine,
    RoutineInvitationStateMachine,
    InvitationPolicy,
    // 基础设施端口（生产替换为 PostgreSQL/Casdoor 适配实现）
    // 基础设施端口（PostgreSQL；列与迁移 20260822100000 对齐；DB 未连接时 fail-closed）
    {
      provide: INVITATION_REPOSITORY,
      useFactory: (db) => new PostgresInvitationRepository(db),
      inject: [DB_ADAPTER],
    },
    {
      provide: ROUTINE_INVITATION_REPOSITORY,
      useFactory: (db) => new PostgresRoutineInvitationRepository(db),
      inject: [DB_ADAPTER],
    },
    {
      provide: CASDOOR_RELATION_PORT,
      useFactory: (mappings, casdoor) => new OrgBackedCasdoorRelationPort(mappings, casdoor),
      inject: [GROUP_MAPPING_REGISTRY, CASDOOR_WRITE_PORT],
    },
    // ----- 会话（转发 identity OIDC；endpoint 为空时整体 fail-closed）-----
    {
      provide: INVITATION_AUTH_SESSION_PROVIDER,
      useFactory: (identitySession) => adaptSessionProvider(identitySession),
      inject: [AUTH_SESSION_PROVIDER],
    },
    InvitationAuthGuard,
    // 应用命令与查询
    CreateInvitationCommand,
    AcceptInvitationCommand,
    RejectInvitationCommand,
    WithdrawInvitationCommand,
    ExpireInvitationCommand,
    ForceInvalidateInvitationCommand,
    ReissueInvitationCommand,
    ResolveActivationCommand,
    InvitationStatusQuery,
    CreateRoutineInvitationCommand,
    AcceptRoutineInvitationCommand,
    RejectRoutineInvitationCommand,
    WithdrawRoutineInvitationCommand,
    ExpireRoutineInvitationCommand,
    ReissueRoutineInvitationCommand,
    ResolveRoutineActivationCommand,
    RoutineInvitationStatusQuery,
  ],
  exports: [
    CreateInvitationCommand,
    AcceptInvitationCommand,
    RejectInvitationCommand,
    WithdrawInvitationCommand,
    ExpireInvitationCommand,
    ForceInvalidateInvitationCommand,
    ReissueInvitationCommand,
    ResolveActivationCommand,
    InvitationStatusQuery,
    CreateRoutineInvitationCommand,
    AcceptRoutineInvitationCommand,
    RejectRoutineInvitationCommand,
    WithdrawRoutineInvitationCommand,
    ExpireRoutineInvitationCommand,
    ReissueRoutineInvitationCommand,
    ResolveRoutineActivationCommand,
    RoutineInvitationStatusQuery,
    INVITATION_REPOSITORY,
    ROUTINE_INVITATION_REPOSITORY,
    CASDOOR_RELATION_PORT,
  ],
})
export class InvitationModule {}
