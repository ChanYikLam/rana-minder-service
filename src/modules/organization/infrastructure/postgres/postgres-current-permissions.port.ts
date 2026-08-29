/**
 * 组织域权限解析器（Postgres 适配；OR-3、ORG-023/029/035、GOV-007）。
 *
 * 责任：
 * - 实现 CurrentPermissionsPort（per-club/per-dept 逐请求授权）：被
 *   org-context.query 等组织域内部控制面消费；
 * - 实现 OrgSessionAuthzSource（主体全量会话视图）：被 identity session 装配
 *   与 /api/me/clubs 消费（A4 权限接线）。
 *
 * 数据源（fail-closed：任一表无行 = 无权限/无社团工作空间）：
 * 1. org_member_group_current（迁移 20260828110000）——主体当前 Group 关系观测
 *    （权威为 Casdoor 当前值；本地观测由成员生效/对账任务 + 种子写入）；
 * 2. org_position_template_binding（仓储 PERMISSION_TEMPLATE_STORE.listBindings）——
 *    职位 Group → 模板 + 版本；
 * 3. org_permission_template（仓储 PERMISSION_TEMPLATE_STORE.findById）——已发布版
 *    本权限集合（仅 published.permissions 参与有效计算，未发布草稿不生效）；
 * 4. org_club_space（仓储 CLUB_STORE.findById）——社团展示名；
 * 5. 配置 `superAdminUserIds`（casdoor-like：ORG-029/GOV-007 合规）——平台超管
 *    身份不来自 Group 名派生，独立于模板体系。
 *
 * 角色语义映射（OrgSessionClubRole）：模板 ID → 内置模板精确匹配（BUILT_IN 三个
 * 自定义模板的 id 与枚举一一对应）；未匹配的模板按"部门/社团 + 是否为负责人"
 * 退化映射——可扩展（管理端发布自定义模板时同步登记角色映射 TODO）。
 */

import type { DbAdapter, TransactionContext } from '../../../../shared/db-adapter';
import type { ClubSpace } from '../../domain/models/club-space';
import type { PermissionTemplate } from '../../domain/models/permission-template';
import {
  BUILT_IN_TEMPLATES,
  departmentTemplateAllowedPermissions,
} from '../../domain/models/permission-template';
import type {
  CurrentPermissionsPort,
  OrgSessionAuthzSnapshot,
  OrgSessionAuthzSource,
  OrgSessionClubRole,
  OrgSessionClubView,
  PositionTemplateBinding,
} from '../../application/ports';

interface SubjectGroupRow {
  readonly club_id: string;
  readonly department_id: string | null;
  readonly purpose: 'club' | 'department' | 'position';
  readonly group_owner: string;
  readonly group_name: string;
}

const ORG_RLS_SCOPE: { kind: 'unprotected' } = { kind: 'unprotected' };

export interface PostgresCurrentPermissionsPortDeps {
  readonly db: DbAdapter;
  readonly templates: {
    findById(id: string): Promise<PermissionTemplate | null>;
    listBindings(clubId?: string): Promise<readonly PositionTemplateBinding[]>;
  };
  readonly clubs: { findById(id: string): Promise<ClubSpace | null> };
  readonly superAdminUserIds: readonly string[];
}

export class PostgresCurrentPermissionsPort
  implements CurrentPermissionsPort, OrgSessionAuthzSource
{
  constructor(private readonly deps: PostgresCurrentPermissionsPortDeps) {}

  // ============ OrgSessionAuthzSource（identity 会话装配的组合点） ============

  async describeForSubject(subjectId: string): Promise<OrgSessionAuthzSnapshot> {
    const isSuperAdmin = this.deps.superAdminUserIds.includes(subjectId);
    const groups = await this.loadSubjectGroups(subjectId);
    const bindings = await this.deps.templates.listBindings();
    const clubs = await this.aggregateClubs(groups, bindings);
    return { platformSuperAdmin: isSuperAdmin, clubs };
  }

  // ============ CurrentPermissionsPort（组织域内部控制面） ============

  async isPlatformSuperAdmin(userId: string): Promise<boolean> {
    return this.deps.superAdminUserIds.includes(userId);
  }

  async effectiveForClub(userId: string, clubId: string): Promise<readonly string[]> {
    const perms = await this.permissionsForClub(userId, clubId);
    return perms;
  }

  async effectiveForDepartment(userId: string, departmentId: string): Promise<readonly string[]> {
    const perms = await this.permissionsForDepartment(userId, departmentId);
    return perms;
  }

  /** GOV-007 兼容返回：模板 id 原始字符串（供内存桩与本适配器共享语义）。 */
  async primaryRoleAt(userId: string, clubId: string): Promise<string> {
    const groups = await this.loadSubjectGroups(userId);
    const positionGroups = groups.filter((g) => g.club_id === clubId && g.purpose === 'position');
    if (positionGroups.length === 0) return '';
    const bindings = await this.deps.templates.listBindings(clubId);
    for (const position of positionGroups) {
      const binding = bindings.find(
        (b) =>
          b.positionGroup.owner === position.group_owner &&
          b.positionGroup.name === position.group_name,
      );
      if (binding !== undefined) return binding.templateId;
    }
    return '';
  }

  // ============ 内部 ============

  private async loadSubjectGroups(subjectId: string): Promise<readonly SubjectGroupRow[]> {
    let rows: SubjectGroupRow[] = [];
    let tx: TransactionContext | null = null;
    try {
      tx = await this.deps.db.beginTransaction();
      await this.deps.db.setRlsContext(tx, ORG_RLS_SCOPE);
      const result = await this.deps.db.query<SubjectGroupRow>(
        tx,
        `SELECT club_id, department_id, purpose, group_owner, group_name
           FROM org_member_group_current
          WHERE subject_id = $1`,
        [subjectId],
      );
      rows = result;
      await this.deps.db.commit(tx);
    } catch (error) {
      if (tx !== null) {
        await this.deps.db.rollback(tx).catch(() => undefined);
      }
      throw error;
    } finally {
      if (tx !== null) {
        await this.deps.db.clearRlsContext(tx).catch(() => undefined);
      }
    }
    return rows;
  }

  /** 聚合主体的社团工作空间视图（含角色语义与去重权限集）。 */
  private async aggregateClubs(
    groups: readonly SubjectGroupRow[],
    bindings: readonly PositionTemplateBinding[],
  ): Promise<readonly OrgSessionClubView[]> {
    if (groups.length === 0) return [];

    const clubIds = [...uniqueClubs(groups)].sort();
    const clubNames = await this.loadClubNames(clubIds);

    const result: OrgSessionClubView[] = [];
    for (const clubId of clubIds) {
      const clubGroups = groups.filter((g) => g.club_id === clubId);
      const role = await this.resolveRole(clubGroups, bindings, clubId);
      const permissions = await this.permissionsForClubGroups(clubGroups, bindings);
      const clubName = clubNames.get(clubId) ?? clubId;
      result.push({ clubId, clubName, role, permissions });
    }
    return result;
  }

  /** 在社团范围内解析职位 → 模板 id → 角色语义枚举；退化为 member。 */
  private async resolveRole(
    clubGroups: readonly SubjectGroupRow[],
    bindings: readonly PositionTemplateBinding[],
    clubId: string,
  ): Promise<OrgSessionClubRole> {
    const positionGroups = clubGroups.filter((g) => g.purpose === 'position');
    for (const position of positionGroups) {
      const binding = bindings.find(
        (b) =>
          b.clubId === clubId &&
          b.positionGroup.owner === position.group_owner &&
          b.positionGroup.name === position.group_name,
      );
      if (binding === undefined) continue;
      if (binding.templateId === BUILT_IN_TEMPLATES.LEADER.id) return 'club_leader';
      if (binding.templateId === BUILT_IN_TEMPLATES.PERSONNEL.id) return 'hr';
      if (binding.templateId === BUILT_IN_TEMPLATES.DEPARTMENT_HEAD.id) {
        return 'department_leader';
      }
      // 自定义模板（社团级）：默认视为负责人级权限范围 → club_leader；
      // TODO: 管理端发布自定义模板时同步登记角色映射
      return 'club_leader';
    }
    // 无职位绑定：仅社团层成员（member）
    return 'member';
  }

  private async permissionsForClubGroups(
    clubGroups: readonly SubjectGroupRow[],
    bindings: readonly PositionTemplateBinding[],
  ): Promise<readonly string[]> {
    const perms = new Set<string>();
    for (const group of clubGroups) {
      if (group.purpose !== 'position') continue;
      const binding = bindings.find(
        (b) =>
          b.positionGroup.owner === group.group_owner && b.positionGroup.name === group.group_name,
      );
      if (binding === undefined) continue;
      const template = await this.deps.templates.findById(binding.templateId);
      if (template === null || template.published === null) continue;
      const isDepartmentScope = template.scopeClass === 'department';
      const raw = template.published.permissions;
      // 部门级模板经 ORG-035 受限范围过滤（与 BUILT_IN 复用同一逻辑）
      const effective = isDepartmentScope ? departmentTemplateAllowedPermissions(raw) : raw;
      for (const p of effective) perms.add(p);
    }
    return [...perms];
  }

  private async permissionsForClub(userId: string, clubId: string): Promise<readonly string[]> {
    const groups = await this.loadSubjectGroups(userId);
    const clubGroups = groups.filter((g) => g.club_id === clubId);
    const bindings = await this.deps.templates.listBindings(clubId);
    return this.permissionsForClubGroups(clubGroups, bindings);
  }

  private async permissionsForDepartment(
    userId: string,
    departmentId: string,
  ): Promise<readonly string[]> {
    const groups = await this.loadSubjectGroups(userId);
    const departmentPositions = groups.filter(
      (g) => g.purpose === 'position' && g.department_id === departmentId,
    );
    const bindings = await this.deps.templates.listBindings();
    const perms = new Set<string>();
    for (const position of departmentPositions) {
      const binding = bindings.find(
        (b) =>
          b.positionGroup.owner === position.group_owner &&
          b.positionGroup.name === position.group_name,
      );
      if (binding === undefined) continue;
      const template = await this.deps.templates.findById(binding.templateId);
      if (template === null || template.published === null) continue;
      // effectiveForDepartment 必走部门受限范围（ORG-035）
      const effective =
        template.scopeClass === 'department'
          ? departmentTemplateAllowedPermissions(template.published.permissions)
          : template.published.permissions;
      for (const p of effective) perms.add(p);
    }
    return [...perms];
  }

  private async loadClubNames(clubIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const map = new Map<string, string>();
    for (const id of clubIds) {
      const club = await this.deps.clubs.findById(id);
      map.set(id, club?.name ?? id);
    }
    return map;
  }
}

function uniqueClubs(groups: readonly SubjectGroupRow[]): readonly string[] {
  const set = new Set<string>();
  for (const g of groups) set.add(g.club_id);
  return [...set];
}
