/**
 * 内存映射存储（开发桩）。
 */

import type {
  GroupMapping,
  GroupStableRef,
  OrganizationMapping,
  SubjectGroupRelation,
  SubjectMapping,
} from '../contracts/types';
import { groupRefKey } from '../contracts/types';
import type { MappingStore } from '../contracts/ports';

export class InMemoryMappingStore implements MappingStore {
  private readonly subjects = new Map<string, SubjectMapping>();
  private readonly subjectsByExternal = new Map<string, string>();
  private readonly organizations = new Map<string, OrganizationMapping>();
  private readonly groupsByLocal = new Map<string, GroupMapping>();
  private readonly groupsByExternal = new Map<string, string>();
  private readonly relations = new Map<string, SubjectGroupRelation[]>();

  async saveSubjectMapping(mapping: SubjectMapping): Promise<void> {
    const existing = this.subjects.get(mapping.localSubjectId);
    if (existing && existing.externalSubjectId !== mapping.externalSubjectId) {
      const prevLocal = this.subjectsByExternal.get(existing.externalSubjectId);
      if (prevLocal === mapping.localSubjectId) {
        this.subjectsByExternal.delete(existing.externalSubjectId);
      }
    }
    this.subjects.set(mapping.localSubjectId, mapping);
    this.subjectsByExternal.set(mapping.externalSubjectId, mapping.localSubjectId);
  }

  async findSubjectMapping(localSubjectId: string): Promise<SubjectMapping | null> {
    return this.subjects.get(localSubjectId) ?? null;
  }

  async findSubjectMappingByExternal(externalSubjectId: string): Promise<SubjectMapping | null> {
    const local = this.subjectsByExternal.get(externalSubjectId);
    return local ? (this.subjects.get(local) ?? null) : null;
  }

  async listSubjectMappings(): Promise<SubjectMapping[]> {
    return [...this.subjects.values()];
  }

  async saveOrganizationMapping(mapping: OrganizationMapping): Promise<void> {
    this.organizations.set(mapping.localPlatformId, mapping);
  }

  async findOrganizationMapping(localPlatformId: string): Promise<OrganizationMapping | null> {
    return this.organizations.get(localPlatformId) ?? null;
  }

  async saveGroupMapping(mapping: GroupMapping): Promise<void> {
    const existing = this.groupsByLocal.get(mapping.localObjectRef);
    if (existing && groupRefKey(existing.externalRef) !== groupRefKey(mapping.externalRef)) {
      const prevLocal = this.groupsByExternal.get(groupRefKey(existing.externalRef));
      if (prevLocal === mapping.localObjectRef) {
        this.groupsByExternal.delete(groupRefKey(existing.externalRef));
      }
    }
    this.groupsByLocal.set(mapping.localObjectRef, mapping);
    this.groupsByExternal.set(groupRefKey(mapping.externalRef), mapping.localObjectRef);
  }

  async findGroupMappingByLocal(localObjectRef: string): Promise<GroupMapping | null> {
    return this.groupsByLocal.get(localObjectRef) ?? null;
  }

  async findGroupMappingByExternal(ref: GroupStableRef): Promise<GroupMapping | null> {
    const local = this.groupsByExternal.get(groupRefKey(ref));
    return local ? (this.groupsByLocal.get(local) ?? null) : null;
  }

  async listGroupMappings(): Promise<GroupMapping[]> {
    return [...this.groupsByLocal.values()];
  }

  async saveRelation(relation: SubjectGroupRelation): Promise<void> {
    const list = this.relations.get(relation.localSubjectId) ?? [];
    const index = list.findIndex((r) => groupRefKey(r.groupRef) === groupRefKey(relation.groupRef));
    if (index >= 0) list[index] = relation;
    else list.push(relation);
    this.relations.set(relation.localSubjectId, list);
  }

  async listRelationsBySubject(localSubjectId: string): Promise<SubjectGroupRelation[]> {
    return [...(this.relations.get(localSubjectId) ?? [])];
  }

  async listAllRelations(): Promise<SubjectGroupRelation[]> {
    return [...this.relations.values()].flat();
  }
}
