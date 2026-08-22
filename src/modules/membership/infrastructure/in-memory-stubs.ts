import { Injectable } from '@nestjs/common';

import type { MembershipAccessPort } from '../application/ports';
import type { MembershipNotificationFact, MembershipNotificationPort } from '../application/ports';

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
