/**
 * 查询：社团接入注册表（§15.1 GET /api/admin/clubs）与 Group 目录（§15.2）。
 *
 * 只读查询；不触发写命令（ADR-011 观测正交、IFC-QRY-*）。
 */

import type { ClubSpace } from '../../domain/models/club-space';
import type { GroupStableRef } from '../../domain/types';
import {
  ADMIN_CLUBS_QUERY,
  CLUB_STORE,
  GROUP_DIRECTORY_QUERY,
  GROUP_MAPPING_REGISTRY,
  CASDOOR_GROUP_PORT,
  type ClubStore,
  type GroupMappingRegistry,
  type CasdoorGroupPort,
} from '../ports';

export interface ClubAccessItem {
  clubId: string;
  clubName: string;
  description: string;
  status: ClubSpace['status'];
  groupId: string | null;
  groupName: string | null;
  mappingVersion: number;
  wizardStep: number;
  leaderName: string | null;
  memberCount: number;
  createdAt: string;
  boundAt: string | null;
  importedAt: string | null;
  importedCount: number;
  wizard: {
    selectedGroupId: string | null;
    leaderGroupId: string | null;
    email: string | null;
    deptGroups: string[];
    roleGroups: string[];
    leaderRoleGroup: string | null;
  } | null;
  freezeExtensionMs: number;
  readonly: boolean;
  hasActiveBusiness: boolean;
  syncEvents: ClubSpace['syncEvents'];
}

function toGroupId(ref: GroupStableRef | null): string | null {
  return ref === null ? null : `${ref.owner}/${ref.name}`;
}

export class AdminClubsQuery {
  constructor(
    private readonly clubs: ClubStore,
    private readonly registry: GroupMappingRegistry,
    private readonly casdoor: CasdoorGroupPort,
  ) {}

  async list(): Promise<ClubAccessItem[]> {
    const clubs = await this.clubs.list();
    return Promise.all(clubs.map(async (c) => this.toItem(c)));
  }

  async findById(clubId: string): Promise<ClubAccessItem | null> {
    const club = await this.clubs.findById(clubId);
    return club === null ? null : this.toItem(club);
  }

  private async toItem(c: ClubSpace): Promise<ClubAccessItem> {
    let memberCount = 0;
    if (c.clubGroup !== null) {
      try {
        memberCount = (await this.casdoor.getGroupMembers(c.clubGroup)).length;
      } catch {
        memberCount = 0;
      }
    }
    return {
      clubId: c.id,
      clubName: c.name,
      description: c.description,
      status: c.status,
      groupId: toGroupId(c.clubGroup),
      groupName: c.clubGroup?.name ?? null,
      mappingVersion: c.mappingVersion,
      wizardStep: c.wizardStep,
      leaderName: c.leaderGroup?.name ?? null,
      memberCount,
      createdAt: c.createdAt,
      boundAt: c.boundAt,
      importedAt: c.importedAt,
      importedCount: c.importedCount,
      wizard: {
        selectedGroupId: toGroupId(c.wizardCandidate),
        leaderGroupId: toGroupId(c.leaderGroup),
        email: c.email,
        deptGroups: c.departmentGroups.map((d) => `${d.owner}/${d.name}`),
        roleGroups: c.positionGroups.map((p) => `${p.owner}/${p.name}`),
        leaderRoleGroup: toGroupId(c.leaderRoleGroup),
      },
      freezeExtensionMs: c.freezeExtensionMs,
      readonly: c.readonly,
      hasActiveBusiness: c.activeBusiness,
      syncEvents: c.syncEvents,
    };
  }
}

export interface GroupDirectoryItem {
  id: string;
  name: string;
  stableId: string;
  path: string;
  parentId: string | null;
  purpose: 'club' | 'department' | 'position' | null;
  boundClubId: string | null;
  memberCount: number;
}

export class GroupDirectoryQuery {
  constructor(
    private readonly casdoor: CasdoorGroupPort,
    private readonly registry: GroupMappingRegistry,
  ) {}

  async list(): Promise<GroupDirectoryItem[]> {
    const infos = await this.casdoor.listGroups();
    const records = await this.registry.listAll();
    return Promise.all(
      infos.map(async (info) => {
        const record = records.find(
          (r) => r.ref.owner === info.ref.owner && r.ref.name === info.ref.name,
        );
        return {
          id: `${info.ref.owner}/${info.ref.name}`,
          name: info.displayName,
          stableId: info.stableId,
          path: info.path,
          parentId: info.parentRef ? `${info.parentRef.owner}/${info.parentRef.name}` : null,
          purpose: record?.purpose ?? null,
          boundClubId: record?.clubId ?? null,
          memberCount: info.memberIds.length,
        };
      }),
    );
  }

  async search(q: string): Promise<GroupDirectoryItem[]> {
    const all = await this.list();
    const needle = q.trim();
    if (needle === '') return all;
    const exact = all.filter((i) => i.name === needle || i.stableId === needle);
    const substring = all.filter((i) => !exact.includes(i) && i.name.includes(needle));
    const fuzzy = all.filter(
      (i) => !exact.includes(i) && !substring.includes(i) && i.name.includes(needle[0] ?? ''),
    );
    return [...exact, ...substring].concat(fuzzy.slice(0, 5));
  }
}

export const adminClubsQueryProvider = {
  provide: ADMIN_CLUBS_QUERY,
  useFactory: (clubs: ClubStore, registry: GroupMappingRegistry, casdoor: CasdoorGroupPort) =>
    new AdminClubsQuery(clubs, registry, casdoor),
  inject: [CLUB_STORE, GROUP_MAPPING_REGISTRY, CASDOOR_GROUP_PORT],
};

export const groupDirectoryQueryProvider = {
  provide: GROUP_DIRECTORY_QUERY,
  useFactory: (casdoor: CasdoorGroupPort, registry: GroupMappingRegistry) =>
    new GroupDirectoryQuery(casdoor, registry),
  inject: [CASDOOR_GROUP_PORT, GROUP_MAPPING_REGISTRY],
};
