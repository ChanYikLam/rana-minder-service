import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
// A4 Group 写链路收口：组织域提供关系观测同步适配（Group 映射 → 观测表）
import { OrganizationModule } from '../organization/module';
import {
  GROUP_MAPPING_REGISTRY,
  MEMBER_GROUP_OBSERVATION_WRITER,
} from '../organization/application/ports';
import { OrgMembershipGroupObservationAdapter } from '../organization/infrastructure/org-membership-group-observation.adapter';
import { ObservabilityModule } from '../../platform/observability/module';
import { MembershipNestController } from './interfaces/nest/membership.nest.controller';
import {
  SUBMIT_DEPARTMENT_APPLICATION_COMMAND,
  DECIDE_DEPARTMENT_APPLICATION_COMMAND,
  EXECUTE_DEPARTMENT_APPLICATION_COMMAND,
  WITHDRAW_DEPARTMENT_APPLICATION_COMMAND,
  MEMBER_EXPERIENCE_QUERY,
  DEPARTMENT_RELATION_QUERY,
} from './tokens';
import { EnterMembershipCommand } from './application/commands/enter-membership.command';
import { ResolveMemberActivationCommand } from './application/commands/resolve-member-activation.command';
import { CompensateMemberActivationCommand } from './application/commands/compensate-member-activation.command';
import { RequestDepartureCommand } from './application/commands/request-departure.command';
import { WithdrawDepartureCommand } from './application/commands/withdraw-departure.command';
import { ApproveDepartureCommand } from './application/commands/approve-departure.command';
import { RemoveMemberCommand } from './application/commands/remove-member.command';
import { ExecuteDepartureCommand } from './application/commands/execute-departure.command';
import { ReconcileExternalRemovalCommand } from './application/commands/reconcile-external-removal.command';
import { ChangeDepartmentRelationCommand } from './application/commands/change-department-relation.command';
import { SettleRelationChangeCommand } from './application/commands/settle-relation-change.command';
import { EndDepartmentRelationCommand } from './application/commands/end-department-relation.command';
import { SettleRelationEndCommand } from './application/commands/settle-relation-end.command';
import { ReconcileExternalRelationCommand } from './application/commands/reconcile-external-relation.command';
import { ResolveRelationAnomalyCommand } from './application/commands/resolve-relation-anomaly.command';
import { SubmitDepartmentApplicationCommand } from './application/commands/submit-department-application.command';
import { WithdrawDepartmentApplicationCommand } from './application/commands/withdraw-department-application.command';
import { DecideDepartmentApplicationCommand } from './application/commands/decide-department-application.command';
import { ExecuteDepartmentApplicationCommand } from './application/commands/execute-department-application.command';
import { MemberExperienceQuery } from './application/queries/member-experience.query';
import { DepartmentRelationQuery } from './application/queries/department-relation.query';
import { MembershipPeriodStateMachine } from './domain/state-machines/membership-period.state-machine';
import { DepartmentRelationStateMachine } from './domain/state-machines/department-relation.state-machine';
import { DepartmentApplicationStateMachine } from './domain/state-machines/department-application.state-machine';
import { MembershipPolicy } from './domain/services/membership-policy';
import { PlannedEndPolicy } from './domain/services/planned-end.policy';
import { RelationChangePolicy } from './domain/services/relation-change.policy';
import { DepartmentApplicationPolicy } from './domain/services/application-policy';
import { MEMBERSHIP_REPOSITORY } from './infrastructure/membership-repository';
import { InMemoryMembershipRepository } from './infrastructure/membership-repository';
import { DEPARTMENT_RELATION_REPOSITORY } from './infrastructure/department-relation-repository';
import { InMemoryDepartmentRelationRepository } from './infrastructure/department-relation-repository';
import { DEPARTMENT_APPLICATION_REPOSITORY } from './infrastructure/department-application-repository';
import { InMemoryDepartmentApplicationRepository } from './infrastructure/department-application-repository';
import { MEMBERSHIP_CASDOOR_PORT } from './infrastructure/casdoor-group.port';
import { DefaultMembershipCasdoorPort } from './infrastructure/casdoor-group.port';
import { RELATION_DIRECTORY_PORT } from './application/relation-ports';
import { InMemoryRelationDirectoryPort } from './infrastructure/in-memory-stubs';
import {
  InMemoryMembershipAccessPort,
  InMemoryMembershipNotificationPort,
} from './infrastructure/in-memory-stubs';
import {
  MEMBERSHIP_ACCESS_PORT,
  MEMBERSHIP_NOTIFICATION_PORT,
  MEMBERSHIP_GROUP_OBSERVATION_PORT,
} from './application/ports';

/**
 * 领域模块：成员生命周期（5.2.1~5.2.3；SRS-SM-MEM-001/002/003，
 * IFC-SM-020/021/022）。
 *
 * 职责：
 * - MEM-001 成员经历：进入生效处理、回读确认生效、失败重试与补偿收口、
 *   主动退出审批、管理员移除、退出级联执行与失败恢复、Casdoor 外部直接
 *   移除对账、计划结束不自动卸任的展示口径；
 * - MEM-002 部门/职位关系：加入部门/任命职位/调岗（复合为单一业务命令）
 *   变更处理中→回读确认当前有效→结束处理中→历史结束；部分写入补偿与
 *   同步异常人工修复；外部直接增删对账收敛；独立任期建模（连任新任期）；
 * - MEM-003 部门关系申请：本人提交、角色型待办审批、批准执行与失败重试。
 *
 * 核心不变量：
 * - 回读确认前不开放权限（ORG-027）；复合变更全部确认才生效，不得半完成；
 * - 社团＋用户当前成员唯一；历史段不复活不改写（MEM-013）；
 * - 最后负责人连续性满足（ORG-021~025）；自审排除（ORG-036）；
 * - 计划任期时间绝不驱动自动卸任（MEM-010/012）；连任创建新任期（MEM-014）；
 * - 外部直接增删以 Casdoor 当前值为准、追加外部变更历史、不自动改回（MEM-016）；
 * - 同步异常只能经人工按 Casdoor 当前值修复收口，禁止一键重放（ORG-030/034）。
 */
@Module({
  imports: [IdentityModule, ObservabilityModule, OrganizationModule],
  controllers: [MembershipNestController],
  providers: [
    // ----- 传输层用例 token（复用已有应用层；与类 provider 并存，独立实例）-----
    {
      provide: SUBMIT_DEPARTMENT_APPLICATION_COMMAND,
      useClass: SubmitDepartmentApplicationCommand,
    },
    {
      provide: DECIDE_DEPARTMENT_APPLICATION_COMMAND,
      useClass: DecideDepartmentApplicationCommand,
    },
    {
      provide: EXECUTE_DEPARTMENT_APPLICATION_COMMAND,
      useClass: ExecuteDepartmentApplicationCommand,
    },
    {
      provide: WITHDRAW_DEPARTMENT_APPLICATION_COMMAND,
      useClass: WithdrawDepartmentApplicationCommand,
    },
    { provide: MEMBER_EXPERIENCE_QUERY, useClass: MemberExperienceQuery },
    { provide: DEPARTMENT_RELATION_QUERY, useClass: DepartmentRelationQuery },
    // 领域规则（纯规则）
    MembershipPeriodStateMachine,
    DepartmentRelationStateMachine,
    DepartmentApplicationStateMachine,
    MembershipPolicy,
    PlannedEndPolicy,
    RelationChangePolicy,
    DepartmentApplicationPolicy,
    // 基础设施端口（生产替换为 PostgreSQL/Casdoor 统一适配实现）
    { provide: MEMBERSHIP_REPOSITORY, useClass: InMemoryMembershipRepository },
    { provide: DEPARTMENT_RELATION_REPOSITORY, useClass: InMemoryDepartmentRelationRepository },
    {
      provide: DEPARTMENT_APPLICATION_REPOSITORY,
      useClass: InMemoryDepartmentApplicationRepository,
    },
    { provide: MEMBERSHIP_CASDOOR_PORT, useClass: DefaultMembershipCasdoorPort },
    // A4 Group 写链路收口：激活/补偿确认后同步组织域关系观测（失败不阻断主事务）
    {
      provide: MEMBERSHIP_GROUP_OBSERVATION_PORT,
      useFactory: (registry, writer) => new OrgMembershipGroupObservationAdapter(registry, writer),
      inject: [GROUP_MAPPING_REGISTRY, MEMBER_GROUP_OBSERVATION_WRITER],
    },
    // 访问重算（生产绑定组织 CurrentPermissionsPort/Group 映射）与通知事实（IFC-TX-002）
    { provide: MEMBERSHIP_ACCESS_PORT, useClass: InMemoryMembershipAccessPort },
    { provide: RELATION_DIRECTORY_PORT, useClass: InMemoryRelationDirectoryPort },
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
    ChangeDepartmentRelationCommand,
    SettleRelationChangeCommand,
    EndDepartmentRelationCommand,
    SettleRelationEndCommand,
    ReconcileExternalRelationCommand,
    ResolveRelationAnomalyCommand,
    SubmitDepartmentApplicationCommand,
    WithdrawDepartmentApplicationCommand,
    DecideDepartmentApplicationCommand,
    ExecuteDepartmentApplicationCommand,
    MemberExperienceQuery,
    DepartmentRelationQuery,
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
    ChangeDepartmentRelationCommand,
    SettleRelationChangeCommand,
    EndDepartmentRelationCommand,
    SettleRelationEndCommand,
    ReconcileExternalRelationCommand,
    ResolveRelationAnomalyCommand,
    SubmitDepartmentApplicationCommand,
    WithdrawDepartmentApplicationCommand,
    DecideDepartmentApplicationCommand,
    ExecuteDepartmentApplicationCommand,
    MemberExperienceQuery,
    DepartmentRelationQuery,
    MEMBERSHIP_REPOSITORY,
    DEPARTMENT_RELATION_REPOSITORY,
    DEPARTMENT_APPLICATION_REPOSITORY,
    MEMBERSHIP_CASDOOR_PORT,
    MEMBERSHIP_ACCESS_PORT,
    RELATION_DIRECTORY_PORT,
    MEMBERSHIP_NOTIFICATION_PORT,
  ],
})
export class MembershipModule {}
