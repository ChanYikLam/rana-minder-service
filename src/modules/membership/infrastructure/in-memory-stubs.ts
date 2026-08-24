import { Injectable } from '@nestjs/common';

import type { MembershipAccessPort } from '../application/ports';
import type { MembershipNotificationFact, MembershipNotificationPort } from '../application/ports';
import type { RelationDirectoryPort } from '../application/relation-ports';

/**
 * 进程内访问重算桩（开发期占位）。
 * 生产实现绑定组织模块 CurrentPermissionsPort（effectiveForClub/primaryRoleAt/
 * isPlatformSuperAdmin）与 Group 映射注册表，按 Casdoor 当前关系回读。
 * seed 支持测试与开发期固定角色场景；未命中主体返回空角色/无负责人。
 */
@Injectable()
export class InMemoryMembershipAccessPort implements MembershipAccessPort {
  private readonly operatorRoles = new Map<string, readonly string[]>(); // key: clubId|userId
  private readonly subjectRoles = new Map<string, string>(); // key: clubId|userId
  private readonly owners = new Map<string, readonly string[]>(); // key: clubId
  private readonly superAdmins = new Set<string>();

  seedOperator(clubId: string, userId: string, roles: readonly string[]): void {
    this.operatorRoles.set(clubId + '|' + userId, roles);
  }
  seedSubjectRole(clubId: string, userId: string, role: string): void {
    this.subjectRoles.set(clubId + '|' + userId, role);
  }
  seedOwners(clubId: string, ownerIds: readonly string[]): void {
    this.owners.set(clubId, ownerIds);
  }
  seedSuperAdmin(userId: string): void {
    this.superAdmins.add(userId);
  }

  async operatorRolesAt(clubId: string, userId: string): Promise<readonly string[]> {
    return this.operatorRoles.get(clubId + '|' + userId) ?? [];
  }
  async subjectPrimaryRoleAt(clubId: string, userId: string): Promise<string> {
    return this.subjectRoles.get(clubId + '|' + userId) ?? '';
  }
  async currentOwnerIds(clubId: string): Promise<readonly string[]> {
    return this.owners.get(clubId) ?? [];
  }
  async isPlatformSuperAdmin(userId: string): Promise<boolean> {
    return this.superAdmins.has(userId);
  }
}

/** 进程内通知事实收集桩（开发期占位；生产由 NTF 模块适配投递） */
@Injectable()
export class InMemoryMembershipNotificationPort implements MembershipNotificationPort {
  private readonly facts: MembershipNotificationFact[] = [];
  private readonly seenDedupKeys = new Set<string>();

  async save(fact: MembershipNotificationFact): Promise<void> {
    // 模拟生产去重语义：同 dedupKey 只保存一次，通知不重复泛滥
    if (this.seenDedupKeys.has(fact.dedupKey)) return;
    this.seenDedupKeys.add(fact.dedupKey);
    this.facts.push(fact);
  }

  async list(): Promise<MembershipNotificationFact[]> {
    return [...this.facts];
  }
}

/**
 * 进程内关系目录桩（开发期占位；MEM-002/003 层级与审批人解析的数据源）。
 * 生产实现绑定 organization Group 映射注册表 + Casdoor 成员回读（GOV-007）。
 * seed 支持测试固定目录场景。
 */
@Injectable()
export class InMemoryRelationDirectoryPort implements RelationDirectoryPort {
  private readonly memberDepartments = new Map<string, readonly string[]>(); // key: clubId|subjectId
  private readonly memberPositions = new Map<string, readonly string[]>(); // key: clubId|subjectId
  private readonly activeDepts = new Set<string>(); // key: clubId|deptId
  private readonly activePositions = new Map<string, 'NORMAL' | 'LEADER'>(); // key: clubId|posId
  private readonly deptLeaders = new Map<string, readonly string[]>(); // key: clubId|deptId

  seedMemberDepartments(clubId: string, subjectId: string, deptIds: readonly string[]): void {
    this.memberDepartments.set(clubId + '|' + subjectId, deptIds);
    for (const d of deptIds) this.activeDepts.add(clubId + '|' + d);
  }
  seedMemberPositions(clubId: string, subjectId: string, posIds: readonly string[]): void {
    this.memberPositions.set(clubId + '|' + subjectId, posIds);
    for (const p of posIds) {
      if (!this.activePositions.has(clubId + '|' + p)) {
        this.activePositions.set(clubId + '|' + p, 'NORMAL');
      }
    }
  }
  seedDepartmentActive(clubId: string, deptId: string): void {
    this.activeDepts.add(clubId + '|' + deptId);
  }
  seedPosition(clubId: string, posId: string, scope: 'NORMAL' | 'LEADER'): void {
    this.activePositions.set(clubId + '|' + posId, scope);
  }
  seedDepartmentLeaders(clubId: string, deptId: string, leaderIds: readonly string[]): void {
    this.deptLeaders.set(clubId + '|' + deptId, leaderIds);
  }

  async currentDepartmentIds(clubId: string, subjectId: string): Promise<readonly string[]> {
    return this.memberDepartments.get(clubId + '|' + subjectId) ?? [];
  }
  async currentPositionIds(clubId: string, subjectId: string): Promise<readonly string[]> {
    return this.memberPositions.get(clubId + '|' + subjectId) ?? [];
  }
  async departmentActive(clubId: string, deptId: string): Promise<boolean> {
    return this.activeDepts.has(clubId + '|' + deptId);
  }
  async positionActive(clubId: string, posId: string): Promise<boolean> {
    return this.activePositions.has(clubId + '|' + posId);
  }
  async departmentLeaderIds(clubId: string, deptId: string): Promise<readonly string[]> {
    return this.deptLeaders.get(clubId + '|' + deptId) ?? [];
  }
  async positionScope(clubId: string, posId: string): Promise<'NORMAL' | 'LEADER'> {
    return this.activePositions.get(clubId + '|' + posId) ?? 'NORMAL';
  }
  async operatorLeadsDepartment(
    clubId: string,
    deptId: string,
    operatorId: string,
  ): Promise<boolean> {
    const leaders = await this.departmentLeaderIds(clubId, deptId);
    return leaders.includes(operatorId);
  }
}
