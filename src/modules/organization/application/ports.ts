/**
 * 组织与授权模块 · 应用端口（依赖倒置边界）。
 *
 * 外部依赖（Casdoor Group、身份/鉴权、job 调度、通知、PG 持久化、对账）全部
 * 抽象为端口；本次实现以 in-memory 桩落地（infrastructure/in-memory/*），
 * 真实适配器由对应基础设施模块接入（ADR-009、CAS-WR-*、CAS-MAP-*）。
 *
 * 令牌约定：ObjectAuthorizationPort 已由 read-model 定义（拒绝即闭锁）；本模块
 * 同时提供模块内判定端口（CurrentPermissionsPort），为 use case 逐请求重算权限。
 */

import type { ClubSpace, SyncEvent } from '../domain/models/club-space';
import type { RelationCommand } from '../domain/models/relation-command';
import type { AppointmentCommand } from '../domain/models/appointment-command';
import type {
  PermissionTemplate,
  PositionTemplateBinding,
} from '../domain/models/permission-template';
import type { GroupStableRef, GroupPurpose, RelationWriteStep } from '../domain/types';

// --------------------------------------------------------------------------
// 通用
// --------------------------------------------------------------------------

export interface ClockPort {
  now(): Date;
}

// --------------------------------------------------------------------------
// Casdoor Group 端口（CAS-GEN-001/002、CAS-WR-*）
// --------------------------------------------------------------------------

export interface CasdoorGroupInfo {
  readonly stableId: string;
  readonly ref: GroupStableRef;
  readonly displayName: string;
  readonly path: string;
  readonly parentRef: GroupStableRef | null;
  readonly memberIds: readonly string[];
  readonly readable: boolean;
  readonly deleted: boolean;
}

export interface CasdoorWriteResult {
  /** 唯一外部请求号（幂等；CAS-WR-001/002） */
  readonly requestId: string;
  readonly outcome: 'success' | 'failure' | 'unknown';
  readonly error?: string;
}

export interface CasdoorReadback {
  /** 读取时刻的 Group 成员实况（按目标 Group 逐项回读，CAS-WR-006~012） */
  readonly membersByGroup: Readonly<Record<string, readonly string[]>>;
}

export interface CasdoorGroupPort {
  listGroups(purposeHints?: GroupPurpose[]): Promise<CasdoorGroupInfo[]>;
  getGroupByRef(ref: GroupStableRef): Promise<CasdoorGroupInfo | null>;
  getGroupMembers(ref: GroupStableRef): Promise<readonly string[]>;
  /** 写成员（add/remove），返回带外部请求号的结果 */
  writeMembership(input: {
    ref: GroupStableRef;
    subjectId: string;
    action: 'add' | 'remove';
    requestId: string;
  }): Promise<CasdoorWriteResult>;
  /** 写后定向回读（先回读再决定重试，ORG-027） */
  readback(refs: readonly GroupStableRef[]): Promise<CasdoorReadback>;
}

// --------------------------------------------------------------------------
// 本地 Store（聚合持久化端口；IFC-TX-001/002 要求同事务原子提交，由用例编排）
// --------------------------------------------------------------------------

export interface ClubStore {
  save(club: ClubSpace): Promise<void>;
  findById(id: string): Promise<ClubSpace | null>;
  list(): Promise<ClubSpace[]>;
  findByGroupRef(ref: GroupStableRef): Promise<ClubSpace | null>;
}

export interface RelationCommandStore {
  save(command: RelationCommand): Promise<void>;
  findById(id: string): Promise<RelationCommand | null>;
  findByExactIdempotencyKey(
    key: string,
    subjectId: string,
    type: string,
  ): Promise<RelationCommand | null>;
  findByProcessingForSubject(clubId: string, subjectId: string): Promise<RelationCommand | null>;
}

export interface AppointmentCommandStore {
  save(command: AppointmentCommand): Promise<void>;
  findById(id: string): Promise<AppointmentCommand | null>;
  findByRelationCommandId(relationCommandId: string): Promise<AppointmentCommand | null>;
  listByClub(clubId: string): Promise<AppointmentCommand[]>;
}

export interface PermissionTemplateStore {
  save(template: PermissionTemplate): Promise<void>;
  findById(id: string): Promise<PermissionTemplate | null>;
  list(): Promise<PermissionTemplate[]>;
  saveBinding(binding: PositionTemplateBinding): Promise<void>;
  listBindings(clubId?: string): Promise<PositionTemplateBinding[]>;
  removeBinding(clubId: string, positionGroup: GroupStableRef): Promise<void>;
}

// --------------------------------------------------------------------------
// Group 映射注册表（ORG-011/012/013/014/017/018）
//   一个 Group 仅能配置为社团/部门/职位之一；同一 Group 同一时刻最多绑一个社团
// --------------------------------------------------------------------------

export interface GroupMappingRecord {
  readonly ref: GroupStableRef;
  readonly clubId: string;
  readonly purpose: GroupPurpose;
  readonly departmentId: string | null;
  readonly positionId: string | null;
  readonly mappingVersion: number;
}

export interface GroupMappingRegistry {
  save(record: GroupMappingRecord): Promise<void>;
  findByRef(ref: GroupStableRef): Promise<GroupMappingRecord | null>;
  listByClub(clubId: string): Promise<GroupMappingRecord[]>;
  listAll(): Promise<GroupMappingRecord[]>;
}

// --------------------------------------------------------------------------
// 对账端口（周期全量对账检测 Group 删除/移动/失权；ORG-013/026、ADR-009）
// --------------------------------------------------------------------------

export type ReconcileAnomalyKind = 'deleted' | 'moved' | 'no_access';

export interface ReconcilePort {
  /** 对某个社团的映射做全量对账，返回是否检测到异常及类型 */
  reconcileClub(clubId: string): Promise<{
    anomaly: boolean;
    kind: ReconcileAnomalyKind | null;
    readonlyRenamedOnly: boolean;
  }>;
}

// --------------------------------------------------------------------------
// 关系命令审计留痕端口（SRS-SM-ORG-002 状态机 requiredSideEffects 落点；
// ORG-027 审计事实基线：原关系快照 + 每次状态迁移的副作用留痕）
// --------------------------------------------------------------------------

export interface RelationCommandAuditEntry {
  readonly commandId: string;
  readonly clubId: string;
  /** 触发迁移的状态机事件（submit/write_started/readback_confirmed/…） */
  readonly eventType: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  /** 状态机声明的副作用标签（requiredSideEffects 原样逐条落痕） */
  readonly sideEffect: string;
  /** 补偿顺序等结构化补充信息（如 compensate_in_order 的 stepId 序列） */
  readonly detail: Readonly<Record<string, unknown>> | null;
  readonly occurredAt: string;
}

export interface RelationCommandAuditPort {
  /**
   * 同事务语义追加一条审计留痕（append-only；失败须上抛，不得静默丢弃——
   * 审计缺失等同于该状态迁移未留痕，验收口径不通过）。
   */
  record(entry: RelationCommandAuditEntry): Promise<void>;
}

// --------------------------------------------------------------------------
// job 调度端口（ADR-004：持久任务与租约；单执行租约、调度幂等）
// --------------------------------------------------------------------------

export type ScheduledTaskKind =
  'relation_execute' | 'appointment_due' | 'reconcile' | 'deadline_pause';

export interface ScheduledTask {
  readonly taskId: string;
  readonly kind: ScheduledTaskKind;
  readonly refId: string;
  readonly scheduleType: 'immediate' | 'at';
  readonly at: string | null;
  readonly idempotencyKey: string;
  readonly leaseHolder: string | null;
}

export interface JobSchedulerPort {
  enqueue(task: ScheduledTask): Promise<void>;
  /** 单执行租约：只有拿到租约的执行器才能处理（CAS-WR-011） */
  acquireLease(taskId: string, holder: string, now: Date): Promise<boolean>;
  complete(taskId: string): Promise<void>;
  fail(taskId: string, error: string): Promise<void>;
  listDue(now: Date): Promise<ScheduledTask[]>;
}

// --------------------------------------------------------------------------
// 通知端口（IFC-TX-002：涉及权益的转换同事务保存通知事实）
// --------------------------------------------------------------------------

export interface NotificationFact {
  readonly kind: string;
  readonly toUserIds: readonly string[];
  readonly clubId: string | null;
  readonly title: string;
  readonly body: string;
  readonly dedupKey: string;
}

export interface NotificationPort {
  /** 同事务保存通知事实（失败不阻断主事务，但必须留痕） */
  save(fact: NotificationFact): Promise<void>;
}

// --------------------------------------------------------------------------
// 当前权限端口（ORG-038：逐请求重算，不信任前端角色/作用域）
// --------------------------------------------------------------------------

export interface CurrentPermissionsPort {
  /** 主体在某社团的当前有效权限（跨社团隔离；ORG-023） */
  effectiveForClub(userId: string, clubId: string): Promise<readonly string[]>;
  /** 主体在某部门的当前有效权限（ORG-035 部门受限范围；departmentId 为全局稳定标识） */
  effectiveForDepartment(userId: string, departmentId: string): Promise<readonly string[]>;
  /** 主体是否平台超级管理员（ORG-029） */
  isPlatformSuperAdmin(userId: string): Promise<boolean>;
  /** 主体在某社团的主角色（职位 Group 名），无则空串（GOV-007：角色由 Group 名派生仅限内存桩） */
  primaryRoleAt(userId: string, clubId: string): Promise<string>;
}

/**
 * 主体在会话层面的授权视图（identity 会话装配的组合点数据源；A4 接线）。
 *
 * 与 CurrentPermissionsPort 的区别：CurrentPermissionsPort 是 per-club/per-dept
 * 元数据逐请求授权查询（被 org-context.query 等内部控制面消费）；本接口面向
 * 会话装配一次性返回"主体所有有效社团工作空间 + 平台超管标记"，被 identity
 * sessionContractFromViews 调用以填充 session.permissions / session.workspace /
 * /api/me/clubs。两者可由同一适配器实现但语义与消费方分离（评审独立）。
 */
export type OrgSessionClubRole =
  /** 社团负责人（PTPL-BUILTIN-LEADER） */
  | 'club_leader'
  /** 人事管理员（PTPL-BUILTIN-PERSONNEL） */
  | 'hr'
  /** 部门负责人（PTPL-BUILTIN-DEPT-HEAD） */
  | 'department_leader'
  /** 仅社团普通成员（无职位模板绑定） */
  | 'member';

export interface OrgSessionClubView {
  readonly clubId: string;
  readonly clubName: string;
  readonly role: OrgSessionClubRole;
  /** 已发布模板权限 ∪（社团层 + 部门层，去重） */
  readonly permissions: readonly string[];
}

export interface OrgSessionAuthzSnapshot {
  /** ORG-029：平台超管身份（配置允许清单，无视社团权限集合） */
  readonly platformSuperAdmin: boolean;
  /**
   * 主体当前有效社团工作空间（含角色 + 权限集合）；超管此处为空——
   * 平台超管不混入社团工作空间（ORG-023 跨空间隔离）。
   */
  readonly clubs: readonly OrgSessionClubView[];
}

/**
 * 会话授权视图源端口（org 提供；identity 通过 SESSION_AUTHZ_PORT 适配消费）。
 * identity 不直接依赖 organization 模块内部符号，仅依赖本端口契约。
 */
export interface OrgSessionAuthzSource {
  describeForSubject(subjectId: string): Promise<OrgSessionAuthzSnapshot>;
}

/** 平台超管会话层权限集（前端 hasPermission('platform:*')） */
export const PLATFORM_SUPER_ADMIN_SESSION_PERMISSIONS = [
  'platform:club:manage',
  'platform:config:manage',
  'platform:delete:execute',
  'platform:export:execute',
  'platform:audit:view',
] as const;

// --------------------------------------------------------------------------
// 受控批量端口（ORG-004 属平台模块；平台 batch 执行器经此端口驱动）
// --------------------------------------------------------------------------

export interface ControlledBatchPort {
  /** 平台侧批量执行器接入点：执行一个批次阶段，并消费该阶段声明的副作用标签 */
  execute(
    batchId: string,
    phase: string,
    requiredSideEffects?: readonly string[],
  ): Promise<{ ok: boolean; error?: string }>;
}

// --------------------------------------------------------------------------
// DI 令牌（Symbol；与 read-model/observability 同一约定）
// --------------------------------------------------------------------------

export const CLOCK = Symbol('ORG_CLOCK');
export const CASDOOR_GROUP_PORT = Symbol('ORG_CASDOOR_GROUP_PORT');
export const CLUB_STORE = Symbol('ORG_CLUB_STORE');
export const RELATION_COMMAND_STORE = Symbol('ORG_RELATION_COMMAND_STORE');
export const RELATION_COMMAND_AUDIT_PORT = Symbol('ORG_RELATION_COMMAND_AUDIT_PORT');
export const APPOINTMENT_COMMAND_STORE = Symbol('ORG_APPOINTMENT_COMMAND_STORE');
export const PERMISSION_TEMPLATE_STORE = Symbol('ORG_PERMISSION_TEMPLATE_STORE');
export const GROUP_MAPPING_REGISTRY = Symbol('ORG_GROUP_MAPPING_REGISTRY');
export const RECONCILE_PORT = Symbol('ORG_RECONCILE_PORT');
export const JOB_SCHEDULER = Symbol('ORG_JOB_SCHEDULER');
export const NOTIFICATION_PORT = Symbol('ORG_NOTIFICATION_PORT');
export const CURRENT_PERMISSIONS_PORT = Symbol('ORG_CURRENT_PERMISSIONS_PORT');
export const CONTROLLED_BATCH_PORT = Symbol('ORG_CONTROLLED_BATCH_PORT');
/**
 * 会话授权视图源（A4 接线；identity 通过 SESSION_AUTHZ_PORT 适配消费本端口）。
 */
export const ORG_SESSION_AUTHZ_SOURCE = Symbol('ORG_SESSION_AUTHZ_SOURCE');

// 用例令牌
export const ONBOARDING_USE_CASE = Symbol('ORG_ONBOARDING_USE_CASE');
export const CLUB_LIFECYCLE_USE_CASE = Symbol('ORG_CLUB_LIFECYCLE_USE_CASE');
export const RELATION_COMMAND_USE_CASE = Symbol('ORG_RELATION_COMMAND_USE_CASE');
export const APPOINTMENT_COMMAND_USE_CASE = Symbol('ORG_APPOINTMENT_COMMAND_USE_CASE');
export const ADMIN_CLUBS_QUERY = Symbol('ORG_ADMIN_CLUBS_QUERY');
export const GROUP_DIRECTORY_QUERY = Symbol('ORG_GROUP_DIRECTORY_QUERY');
export const PERMISSION_TEMPLATE_QUERY = Symbol('ORG_PERMISSION_TEMPLATE_QUERY');
export const PERMISSION_TEMPLATE_COMMAND = Symbol('ORG_PERMISSION_TEMPLATE_COMMAND');
export const ORG_CONTEXT_QUERY = Symbol('ORG_ORG_CONTEXT_QUERY');

// 事件类型（跨组件消费；后续 notification/audit 模块订阅）
export interface OrgEventEnvelope {
  readonly type: string;
  readonly clubId: string | null;
  readonly aggregateId: string;
  readonly at: string;
  readonly payload: unknown;
  readonly syncEvents: SyncEvent[];
}

export type { RelationWriteStep };
// 重导出领域类型，供 organization 模块外部（identity/adapters/...）以本文件为
// 唯一交互入口使用，避免在多个模块入口散落引用 domain/ 子路径。
export type { GroupStableRef } from '../domain/types';
export { BUILT_IN_TEMPLATES } from '../domain/models/permission-template';
export type { PositionTemplateBinding } from '../domain/models/permission-template';
