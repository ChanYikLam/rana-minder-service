import { Module } from '@nestjs/common';

import { EnterMembershipCommand } from './application/commands/enter-membership.command';
import { ResolveMemberActivationCommand } from './application/commands/resolve-member-activation.command';
import { CompensateMemberActivationCommand } from './application/commands/compensate-member-activation.command';
import { RequestDepartureCommand } from './application/commands/request-departure.command';
import { WithdrawDepartureCommand } from './application/commands/withdraw-departure.command';
import { ApproveDepartureCommand } from './application/commands/approve-departure.command';
import { RemoveMemberCommand } from './application/commands/remove-member.command';
import { ExecuteDepartureCommand } from './application/commands/execute-departure.command';
import { ReconcileExternalRemovalCommand } from './application/commands/reconcile-external-removal.command';
import { MemberExperienceQuery } from './application/queries/member-experience.query';
import { MembershipPeriodStateMachine } from './domain/state-machines/membership-period.state-machine';
import { MembershipPolicy } from './domain/services/membership-policy';
import { PlannedEndPolicy } from './domain/services/planned-end.policy';
import { MEMBERSHIP_REPOSITORY } from './infrastructure/membership-repository';
import { InMemoryMembershipRepository } from './infrastructure/membership-repository';
import { MEMBERSHIP_CASDOOR_PORT } from './infrastructure/casdoor-group.port';
import { DefaultMembershipCasdoorPort } from './infrastructure/casdoor-group.port';
import {
  InMemoryMembershipAccessPort,
  InMemoryMembershipNotificationPort,
} from './infrastructure/in-memory-stubs';
import { MEMBERSHIP_ACCESS_PORT, MEMBERSHIP_NOTIFICATION_PORT } from './application/ports';

/**
 * 领域模块：成员生命周期 · 成员经历（5.2.1，SRS-SM-MEM-001，IFC-SM-020）。
 *
 * 职责（本任务范围 = MEM-001 成员经历）：进入生效处理、回读确认生效、
 * 失败重试与补偿收口、主动退出审批、管理员移除、退出级联执行与失败恢复、
 * Casdoor 外部直接移除对账、计划结束不自动卸任的展示口径。
 *
 * 核心不变量：
 * - 回读确认前不开放成员权限（成员生效处理中，ORG-027）；
 * - 社团＋用户当前成员唯一；不同入社路径竞争只一个成功；
 * - 历史成员重入必须新建经历段（MEM-013）；接受/退出历史不得删除；
 * - 最后负责人退出/被移除必须先交接或超管紧急处置（ORG-024）；
 * - 计划结束时间不触发自动卸任（MEM-010/012），前台无"已逾期"口径。
 */
@Module({
  providers: [
    // 领域规则（纯规则）
    MembershipPeriodStateMachine,
    MembershipPolicy,
    PlannedEndPolicy,
    // 基础设施端口（生产替换为 PostgreSQL/Casdoor 统一适配实现）
    { provide: MEMBERSHIP_REPOSITORY, useClass: InMemoryMembershipRepository },
    { provide: MEMBERSHIP_CASDOOR_PORT, useClass: DefaultMembershipCasdoorPort },
    // 访问重算（生产绑定组织 CurrentPermissionsPort/Group 映射）与通知事实（IFC-TX-002）
    { provide: MEMBERSHIP_ACCESS_PORT, useClass: InMemoryMembershipAccessPort },
    { provide: MEMBERSHIP_NOTIFICATION_PORT, useClass: InMemoryMembershipNotificationPort },
    // 应用命令与查询
    EnterMembershipCommand,
    ResolveMemberActivationCommand,
    CompensateMemberActivationCommand,
    RequestDepartureCommand,
    WithdrawDepartureCommand,
    ApproveDepartureCommand,
    RemoveMemberCommand,
    ExecuteDepartureCommand,
    ReconcileExternalRemovalCommand,
    MemberExperienceQuery,
  ],
  exports: [
    EnterMembershipCommand,
    ResolveMemberActivationCommand,
    CompensateMemberActivationCommand,
    RequestDepartureCommand,
    WithdrawDepartureCommand,
    ApproveDepartureCommand,
    RemoveMemberCommand,
    ExecuteDepartureCommand,
    ReconcileExternalRemovalCommand,
    MemberExperienceQuery,
    MEMBERSHIP_REPOSITORY,
    MEMBERSHIP_CASDOOR_PORT,
    MEMBERSHIP_ACCESS_PORT,
    MEMBERSHIP_NOTIFICATION_PORT,
  ],
})
export class MembershipModule {}
