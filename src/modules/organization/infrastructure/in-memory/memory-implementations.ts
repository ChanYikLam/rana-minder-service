/**
 * 组织与授权模块 · 内存实现（端口桩）。
 *
 * 供单测与本地装配使用；真实适配器由对应基础设施模块按 ADR-009（Casdoor）、
 * ADR-014（PG 持久化）、ADR-004（job）接入后替换。
 *
 * 所有实现刻意保持"规则在领域层、存取在此层"：桩只做内存读写与可配置仿真，
 * 不复制转换逻辑。
 */

import type { ClubSpace } from '../../domain/models/club-space';
import type { RelationCommand } from '../../domain/models/relation-command';
import type { AppointmentCommand } from '../../domain/models/appointment-command';
import {
  PermissionCatalog,
  type PermissionTemplate,
  type PositionTemplateBinding,
} from '../../domain/models/permission-template';
import type { GroupStableRef } from '../../domain/types';
import { orgError } from '../../domain/types';
import type {
  CasdoorGroupInfo,
  CasdoorGroupPort,
  CasdoorReadback,
  CasdoorWriteResult,
  ClubStore,
  RelationCommandStore,
  AppointmentCommandStore,
  PermissionTemplateStore,
  GroupMappingRegistry,
  GroupMappingRecord,
  JobSchedulerPort,
  NotificationPort,
  CurrentPermissionsPort,
  ReconcilePort,
  ReconcileAnomalyKind,
  ScheduledTask,
  ScheduledTaskKind,
  ClockPort,
} from '../../application/ports';

// --------------------------------------------------------------------------
// 时钟
// --------------------------------------------------------------------------

export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
}

// --------------------------------------------------------------------------
// ClubStore
// --------------------------------------------------------------------------

export class InMemoryClubStore implements ClubStore {
  private readonly byId = new Map<string, ClubSpace>();

  async save(club: ClubSpace): Promise<void> {
    const existing = this.byId.get(club.id);
    if (existing && club.version < existing.version) {
      // 乐观锁：禁止旧版本覆盖新版本（与 relation/appointment 内存桩的 CAS 语义对齐）
      throw orgError.stateConflict(
        `检测到旧版本写入，拒绝回退覆盖（乐观锁，IFC-ERR-007）${club.id}`,
      );
    }
    this.byId.set(club.id, structuredClone(club));
  }

  async findById(id: string): Promise<ClubSpace | null> {
    const club = this.byId.get(id);
    return club === undefined ? null : structuredClone(club);
  }

  async list(): Promise<ClubSpace[]> {
    return [...this.byId.values()].map((c) => structuredClone(c));
  }

  async findByGroupRef(ref: GroupStableRef): Promise<ClubSpace | null> {
    for (const club of this.byId.values()) {
      if (club.clubGroup?.owner === ref.owner && club.clubGroup.name === ref.name)
        return structuredClone(club);
    }
    return null;
  }
}

// --------------------------------------------------------------------------
// RelationCommandStore
// --------------------------------------------------------------------------

export class InMemoryRelationCommandStore implements RelationCommandStore {
  private readonly byId = new Map<string, RelationCommand>();

  async save(command: RelationCommand): Promise<void> {
    const existing = this.byId.get(command.id);
    if (existing && command.attemptCount < existing.attemptCount) {
      // 乐观锁：禁止旧版本覆盖新版本（SRS-SM-ORG-002 对象/关系版本必须匹配）
      throw orgError.stateConflict(
        `检测到旧版本写入，拒绝回退覆盖（乐观锁，IFC-ERR-007）${command.id}`,
      );
    }
    this.byId.set(command.id, structuredClone(command));
  }

  async findById(id: string): Promise<RelationCommand | null> {
    return this.byId.get(id) ?? null;
  }

  async findByExactIdempotencyKey(
    key: string,
    subjectId: string,
    type: string,
  ): Promise<RelationCommand | null> {
    for (const cmd of this.byId.values()) {
      if (cmd.idempotencyKey === key && cmd.subjectId === subjectId && cmd.type === type)
        return cmd;
    }
    return null;
  }

  async findByProcessingForSubject(
    clubId: string,
    subjectId: string,
  ): Promise<RelationCommand | null> {
    for (const cmd of this.byId.values()) {
      if (
        cmd.clubId === clubId &&
        cmd.subjectId === subjectId &&
        (cmd.status === 'processing' ||
          cmd.status === 'processing_compensating' ||
          cmd.status === 'pending_execution')
      ) {
        return cmd;
      }
    }
    return null;
  }
}

// --------------------------------------------------------------------------
// AppointmentCommandStore
// --------------------------------------------------------------------------

export class InMemoryAppointmentCommandStore implements AppointmentCommandStore {
  private readonly byId = new Map<string, AppointmentCommand>();
  private readonly byClub = new Map<string, AppointmentCommand[]>();

  async save(command: AppointmentCommand): Promise<void> {
    const existing = this.byId.get(command.id);
    if (existing && command.scheduleVersion < existing.scheduleVersion) {
      // 乐观锁：禁止旧版本覆盖新版本（ORG-039 调度版本语义）
      throw orgError.stateConflict(
        `检测到旧版本写入，拒绝回退覆盖（乐观锁，IFC-ERR-007）${command.id}`,
      );
    }
    this.byId.set(command.id, structuredClone(command));
    const list = this.byClub.get(command.clubId) ?? [];
    const idx = list.findIndex((c) => c.id === command.id);
    if (idx >= 0) list[idx] = structuredClone(command);
    else list.push(structuredClone(command));
    this.byClub.set(command.clubId, list);
  }

  async findById(id: string): Promise<AppointmentCommand | null> {
    return this.byId.get(id) ?? null;
  }

  async findByRelationCommandId(relationCommandId: string): Promise<AppointmentCommand | null> {
    for (const cmd of this.byId.values()) {
      if (cmd.relationCommandId === relationCommandId) return cmd;
    }
    return null;
  }

  async listByClub(clubId: string): Promise<AppointmentCommand[]> {
    return this.byClub.get(clubId) ?? [];
  }
}

// --------------------------------------------------------------------------
// PermissionTemplateStore + 模板绑定
// --------------------------------------------------------------------------

export class InMemoryPermissionTemplateStore implements PermissionTemplateStore {
  private readonly byId = new Map<string, PermissionTemplate>();
  private bindings: PositionTemplateBinding[] = [];

  async save(template: PermissionTemplate): Promise<void> {
    this.byId.set(template.id, structuredClone(template));
  }

  async findById(id: string): Promise<PermissionTemplate | null> {
    return this.byId.get(id) ?? null;
  }

  async list(): Promise<PermissionTemplate[]> {
    return [...this.byId.values()];
  }

  async saveBinding(binding: PositionTemplateBinding): Promise<void> {
    this.bindings = [
      ...this.bindings.filter(
        (b) =>
          !(
            b.positionGroup.owner === binding.positionGroup.owner &&
            b.positionGroup.name === binding.positionGroup.name
          ),
      ),
      structuredClone(binding),
    ];
  }

  async listBindings(clubId?: string): Promise<PositionTemplateBinding[]> {
    return this.bindings.filter((b) => clubId === undefined || b.clubId === clubId);
  }

  async removeBinding(clubId: string, positionGroup: GroupStableRef): Promise<void> {
    this.bindings = this.bindings.filter(
      (b) =>
        !(
          b.clubId === clubId &&
          b.positionGroup.owner === positionGroup.owner &&
          b.positionGroup.name === positionGroup.name
        ),
    );
  }
}

// --------------------------------------------------------------------------
// GroupMappingRegistry
// --------------------------------------------------------------------------

export class InMemoryGroupMappingRegistry implements GroupMappingRegistry {
  private records: GroupMappingRecord[] = [];

  async save(record: GroupMappingRecord): Promise<void> {
    const existing = await this.findByRef(record.ref);
    if (existing !== null) {
      this.records = this.records.map((r) =>
        r.ref.owner === record.ref.owner && r.ref.name === record.ref.name ? record : r,
      );
      return;
    }
    this.records.push(structuredClone(record));
  }

  async findByRef(ref: GroupStableRef): Promise<GroupMappingRecord | null> {
    return this.records.find((r) => r.ref.owner === ref.owner && r.ref.name === ref.name) ?? null;
  }

  async listByClub(clubId: string): Promise<GroupMappingRecord[]> {
    return this.records.filter((r) => r.clubId === clubId);
  }

  async listAll(): Promise<GroupMappingRecord[]> {
    return [...this.records];
  }
}

// --------------------------------------------------------------------------
// Casdoor 端口（内存仿真：可配置 group 树、成员、可读性/删除状态）
// --------------------------------------------------------------------------

type MutableCasdoorGroup = {
  stableId: string;
  ref: GroupStableRef;
  displayName: string;
  path: string;
  parentRef: { owner: string; name: string } | null;
  memberIds: string[];
  readable: boolean;
  deleted: boolean;
};

export interface MemoryCasdoorSeed {
  readonly groups: Array<{
    ref: GroupStableRef;
    displayName: string;
    path?: string;
    parentRef?: GroupStableRef | null;
    memberIds?: string[];
    readable?: boolean;
    deleted?: boolean;
  }>;
}

export class InMemoryCasdoorPort implements CasdoorGroupPort {
  private groups: MutableCasdoorGroup[];
  private readonly writeLog: Array<{
    ref: GroupStableRef;
    subjectId: string;
    action: 'add' | 'remove';
    requestId: string;
  }> = [];
  private readonly failingRefs = new Set<string>();
  private requestSeq = 0;

  constructor(seed: MemoryCasdoorSeed) {
    this.groups = seed.groups.map((g, i) => this.normalize(g, i));
  }

  private normalize(g: MemoryCasdoorSeed['groups'][number], index: number): MutableCasdoorGroup {
    return {
      stableId: `g-${index}`,
      ref: { owner: g.ref.owner, name: g.ref.name },
      displayName: g.displayName ?? g.ref.name,
      path: g.path ?? `/${g.ref.owner}/${g.ref.name}`,
      parentRef: g.parentRef ?? null,
      memberIds: g.memberIds ?? [],
      readable: g.readable ?? true,
      deleted: g.deleted ?? false,
    };
  }

  async listGroups(): Promise<CasdoorGroupInfo[]> {
    return this.groups.map((g) => ({ ...g, memberIds: [...g.memberIds] }));
  }

  async getGroupByRef(ref: GroupStableRef): Promise<CasdoorGroupInfo | null> {
    const g = this.groups.find((x) => x.ref.owner === ref.owner && x.ref.name === ref.name);
    return g === undefined ? null : { ...g, memberIds: [...g.memberIds] };
  }

  async getGroupMembers(ref: GroupStableRef): Promise<readonly string[]> {
    const g = await this.getGroupByRef(ref);
    if (g === null) throw new Error(`Group 不存在: ${ref.owner}/${ref.name}`);
    return [...g.memberIds];
  }

  async writeMembership(input: {
    ref: GroupStableRef;
    subjectId: string;
    action: 'add' | 'remove';
    requestId: string;
  }): Promise<CasdoorWriteResult> {
    this.writeLog.push({
      ref: input.ref,
      subjectId: input.subjectId,
      action: input.action,
      requestId: input.requestId,
    });
    this.requestSeq += 1;
    if (this.failingRefs.has(`${input.ref.owner}/${input.ref.name}`)) {
      return { requestId: input.requestId, outcome: 'failure', error: 'simulated write failure' };
    }
    const group = this.groups.find(
      (g) => g.ref.owner === input.ref.owner && g.ref.name === input.ref.name,
    );
    if (group === undefined) {
      return { requestId: input.requestId, outcome: 'failure', error: 'group missing' };
    }
    const members = new Set(group.memberIds);
    if (input.action === 'add') members.add(input.subjectId);
    else members.delete(input.subjectId);
    group.memberIds = [...members];
    return { requestId: input.requestId, outcome: 'success' };
  }

  async readback(refs: readonly GroupStableRef[]): Promise<CasdoorReadback> {
    const membersByGroup: Record<string, readonly string[]> = {};
    for (const ref of refs) {
      const g = this.groups.find((x) => x.ref.owner === ref.owner && x.ref.name === ref.name);
      membersByGroup[`${ref.owner}/${ref.name}`] = g === undefined ? [] : [...g.memberIds];
    }
    return { membersByGroup };
  }

  /** 测试辅助：把某 Group 标记为不可读/删除/失权 */
  async simulateAnomaly(ref: GroupStableRef, kind: 'deleted' | 'no_access'): Promise<void> {
    const g = this.groups.find((x) => x.ref.owner === ref.owner && x.ref.name === ref.name);
    if (g === undefined) return;
    if (kind === 'deleted') g.deleted = true;
    else if (kind === 'no_access') g.readable = false;
    this.failingRefs.add(`${ref.owner}/${ref.name}`);
  }
}

// --------------------------------------------------------------------------
// 对账端口
// --------------------------------------------------------------------------

export interface MemoryReconcileConfig {
  readonly anomalies: Map<string, ReconcileAnomalyKind>;
  readonly renamedOnly: Set<string>;
}

export class InMemoryReconcilePort implements ReconcilePort {
  constructor(private readonly config: MemoryReconcileConfig) {}

  async reconcileClub(clubId: string): Promise<{
    anomaly: boolean;
    kind: ReconcileAnomalyKind | null;
    readonlyRenamedOnly: boolean;
  }> {
    const kind = this.config.anomalies.get(clubId) ?? null;
    return {
      anomaly: kind != null,
      kind,
      readonlyRenamedOnly: this.config.renamedOnly.has(clubId),
    };
  }
}

// --------------------------------------------------------------------------
// Job 调度器（内存：任务保存/租约/到期）
// --------------------------------------------------------------------------

type MutableScheduledTask = {
  taskId: string;
  kind: ScheduledTaskKind;
  refId: string;
  scheduleType: 'immediate' | 'at';
  at: string | null;
  idempotencyKey: string;
  leaseHolder: string | null;
};

export class InMemoryJobScheduler implements JobSchedulerPort {
  private tasks: MutableScheduledTask[] = [];

  async enqueue(task: ScheduledTask): Promise<void> {
    const existing = this.tasks.find((t) => t.idempotencyKey === task.idempotencyKey);
    if (existing !== undefined) return; // 调度幂等
    this.tasks.push({ ...task });
  }

  async acquireLease(taskId: string, holder: string, now: Date): Promise<boolean> {
    const task = this.tasks.find((t) => t.taskId === taskId);
    if (task === undefined) return false;
    if (task.leaseHolder !== null && task.leaseHolder !== holder) return false;
    if (task.at !== null && Date.parse(task.at) > now.getTime()) return false;
    task.leaseHolder = holder;
    return true;
  }

  async complete(taskId: string): Promise<void> {
    this.tasks = this.tasks.filter((t) => t.taskId !== taskId);
  }

  async fail(taskId: string, _error: string): Promise<void> {
    const task = this.tasks.find((t) => t.taskId === taskId);
    if (task !== undefined) task.leaseHolder = null;
  }

  async listDue(now: Date): Promise<ScheduledTask[]> {
    return this.tasks.filter((t) => t.at === null || Date.parse(t.at) <= now.getTime());
  }
}

// --------------------------------------------------------------------------
// 通知端口（内存：仅记录）
// --------------------------------------------------------------------------

export class InMemoryNotificationPort implements NotificationPort {
  readonly facts: Array<{
    kind: string;
    toUserIds: readonly string[];
    clubId: string | null;
    title: string;
    body: string;
    dedupKey: string;
  }> = [];

  async save(fact: {
    kind: string;
    toUserIds: readonly string[];
    clubId: string | null;
    title: string;
    body: string;
    dedupKey: string;
  }): Promise<void> {
    if (this.facts.some((f) => f.dedupKey === fact.dedupKey)) return; // 去重
    this.facts.push({ ...fact, toUserIds: [...fact.toUserIds] });
  }

  async has(title: string): Promise<boolean> {
    return this.facts.some((f) => f.title === title);
  }
}

// --------------------------------------------------------------------------
// 当前权限端口（内存：可配置；默认超管映射为独立 Group，ORG-029）
// --------------------------------------------------------------------------

export interface MemoryPermissionConfig {
  readonly superAdminUsers: readonly string[];
  readonly userId: string;
  readonly clubPermissions: Map<string, string[]>;
  readonly positionGroupMemberships: Map<
    string,
    Array<{ group: GroupStableRef; clubId: string; departmentId: string | null }>
  >;
}

export class MemoryCurrentPermissionsPort implements CurrentPermissionsPort {
  constructor(private readonly config: MemoryPermissionConfig) {
    // 门禁隔离：本桩按 Group 名子串（leader/负责人/personnel/人事/dept…）派生权限，
    // 违反 GOV-007「Group 名称不得授权」。它仅供开发/单测装配，生产环境一律拒绝
    // 装配；真实鉴权须由基于 PermissionCalculator（职位 Group → 已发布模板映射 +
    // 业务临时授权）的适配器实现。
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(
        'MemoryCurrentPermissionsPort 为 Group 名派生的开发桩，违反 GOV-007，禁止用于生产装配',
      );
    }
  }

  async effectiveForClub(userId: string, clubId: string): Promise<string[]> {
    const direct = this.config.clubPermissions.get(clubId) ?? [];
    // 平台超管不得混入社团工作空间权限（ORG-023 跨社团隔离）：
    // 超管仅保留直接授予的社团权限，不因超管身份获得任何职位/空间派生权限
    const isSuperAdmin = this.config.superAdminUsers.includes(userId);
    const byPosition = isSuperAdmin
      ? []
      : this.positionPermissions(userId)
          .filter((p) => p.clubId === clubId)
          .map((p) => p.permission);
    return [...new Set<string>([...direct, ...byPosition])];
  }

  async isPlatformSuperAdmin(userId: string): Promise<boolean> {
    return this.config.superAdminUsers.includes(userId);
  }

  async primaryRoleAt(userId: string, clubId: string): Promise<string> {
    const memberships = this.config.positionGroupMemberships.get(userId) ?? [];
    const first = memberships.find((m) => m.clubId === clubId);
    return first === undefined ? '' : `${first.group.owner}/${first.group.name}`;
  }

  private positionPermissions(userId: string): Array<{ clubId: string; permission: string }> {
    const memberships = this.config.positionGroupMemberships.get(userId) ?? [];
    const out: Array<{ clubId: string; permission: string }> = [];
    for (const m of memberships) {
      if (m.group.name.includes('leader') || m.group.name.includes('负责人')) {
        out.push({ clubId: m.clubId, permission: PermissionCatalog.CLUB_TRANSITION_MANAGE });
        out.push({ clubId: m.clubId, permission: PermissionCatalog.CLUB_CONFIG_MANAGE });
      }
      if (m.group.name.includes('personnel') || m.group.name.includes('人事')) {
        out.push({ clubId: m.clubId, permission: PermissionCatalog.CLUB_APPOINTMENT_MANAGE });
        out.push({ clubId: m.clubId, permission: PermissionCatalog.CLUB_MEMBER_MANAGE });
      }
      if (m.group.name.includes('dept') || m.group.name.includes('部门负责人')) {
        out.push({ clubId: m.clubId, permission: PermissionCatalog.CLUB_MEMBER_MANAGE });
      }
    }
    return out;
  }
}
