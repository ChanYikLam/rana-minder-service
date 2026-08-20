/**
 * ORG-001 社团接入命令用例（向导 + 接入时成员导入）。
 *
 * SRS-SM-ORG-001 §4.1；HTTP 端点：§15.1 POST /api/admin/clubs/wizard*、import。
 *
 * 传达语义：接入不新建/改名/删除 Casdoor Group（ORG-001/003/017）；候选必须
 * 人工选择并二次确认；一个 Group 同一时刻只能绑一个社团且只能配一个用途
 * （ORG-004/005/011/012/014）；未启用不产生业务权限（GOV-007）；接入时已有成员
 * 只建立"接入时已存在"当前关系，未知日期不得伪造（ORG-016）。
 */

import { randomUUID } from 'node:crypto';

import type { ClubSpace } from '../../domain/models/club-space';
import { createClubSpace } from '../../domain/models/club-space';
import { ClubOnboardingStateMachine } from '../../domain/state-machines/club-onboarding.state-machine';
import type { GroupStableRef } from '../../domain/types';
import { IdPrefix, orgError } from '../../domain/types';
import {
  CASDOOR_GROUP_PORT,
  CLUB_STORE,
  GROUP_MAPPING_REGISTRY,
  NOTIFICATION_PORT,
  ONBOARDING_USE_CASE,
  type CasdoorGroupPort,
  type ClubStore,
  type GroupMappingRegistry,
  type NotificationPort,
} from '../ports';

export interface WizardCreateInput {
  groupId: string;
  name: string;
  description: string;
  leaderGroupId: string;
  email?: string;
  departmentGroupIds?: string[];
  positionGroupIds?: string[];
  leaderRoleGroupId?: string;
  actor: string;
  reauthProof?: string;
}

export class OnboardingUseCase {
  private readonly stateMachine = new ClubOnboardingStateMachine();

  constructor(
    private readonly clubs: ClubStore,
    private readonly casdoor: CasdoorGroupPort,
    private readonly registry: GroupMappingRegistry,
    private readonly notifications: NotificationPort,
  ) {}

  /** 校验 Group 可读、存在、未被绑定 */
  private async assertGroupAvailable(ref: GroupStableRef): Promise<void> {
    const info = await this.casdoor.getGroupByRef(ref);
    if (info === null || info.deleted || !info.readable) {
      throw orgError.notVisible(`Casdoor Group 不存在或不可读（${ref.owner}/${ref.name}）`);
    }
    const bound = await this.registry.findByRef(ref);
    if (bound !== null) {
      throw orgError.precondition(
        `Group ${ref.owner}/${ref.name} 已配置为${bound.purpose}，不可重复绑定（ORG-011/014）`,
        'duplicateGroupBinding',
      );
    }
  }

  /** 部门/职位 Group 必须是社团 Group 后代（ORG-012/018） */
  private async assertDescendant(
    descendant: GroupStableRef,
    ancestor: GroupStableRef,
  ): Promise<void> {
    const visited = new Set<string>();
    let current: GroupStableRef | null = descendant;
    while (current !== null) {
      const key = `${current.owner}/${current.name}`;
      if (visited.has(key)) {
        throw orgError.precondition(
          `Group 层级存在循环引用（${descendant.owner}/${descendant.name}）`,
        );
      }
      visited.add(key);
      // 当前节点即为祖先（直属）或已匹配
      if (current.owner === ancestor.owner && current.name === ancestor.name) {
        return;
      }
      const info = await this.casdoor.getGroupByRef(current);
      if (info === null) {
        throw orgError.notVisible(`Group 不存在（${current.owner}/${current.name}）`);
      }
      if (info.deleted || !info.readable) {
        throw orgError.notVisible(`Group 不可读（${current.owner}/${current.name}）`);
      }
      current = info.parentRef;
    }
    throw orgError.precondition(
      `职位/部门 Group 必须是社团 Group 的后代或直属（ORG-012/018）：${descendant.owner}/${descendant.name}`,
    );
  }

  async createWizard(input: WizardCreateInput, now: Date): Promise<ClubSpace> {
    if (input.reauthProof === undefined) {
      throw orgError.reauth('社团接入为高风控操作，需重新认证（IFC-ERR-002）');
    }
    const clubRef: GroupStableRef = toStableRef(input.groupId, input.name);
    await this.assertGroupAvailable(clubRef);
    const leaderRef = toStableRef(input.leaderGroupId, input.name);
    await this.assertGroupAvailable(leaderRef);

    const club = createClubSpace({
      id: newId(IdPrefix.CLUB),
      name: input.name,
      description: input.description,
      candidate: clubRef,
      actor: input.actor,
      now,
    });
    // 持久化已校验的负责人组选择，避免后续步骤丢失（ORG-024 负责人连续性依赖它）
    club.leaderGroup = leaderRef;
    const draft = this.stateMachine.transition({
      club,
      event: 'wizard_save_step',
      actor: input.actor,
      now,
      facts: { confirmed: true },
    });
    await this.clubs.save(draft.club);
    return draft.club;
  }

  async saveStep(
    input: { clubId: string; actor: string; name?: string; email?: string },
    now: Date,
  ): Promise<ClubSpace> {
    const club = await this.requireClub(input.clubId);
    const draft = this.stateMachine.transition({
      club,
      event: 'wizard_save_step',
      actor: input.actor,
      now,
      facts: {},
    });
    if (input.name !== undefined) draft.club.name = input.name;
    if (input.email !== undefined) draft.club.email = input.email;
    await this.clubs.save(draft.club);
    return draft.club;
  }

  async complete(
    input: { clubId: string; actor: string; confirmed: boolean },
    now: Date,
  ): Promise<ClubSpace> {
    const club = await this.requireClub(input.clubId);
    if (club.wizardCandidate === null) {
      throw orgError.precondition('向导未选择社团 Group（ORG-005）');
    }

    // 负责人连续性：负责人职位 Group 必须至少一名有效成员（ORG-024）
    const leaderGroup =
      club.leaderGroup ?? toStableRef(club.wizardCandidate.name, club.wizardCandidate.owner);
    const leaders = await this.casdoor.getGroupMembers(leaderGroup);
    const leaderContinuityOk = leaders.length > 0;

    // 映射唯一性复核（并发保护由 version 竞争承担；此处校验 Group 未被他社团占用）
    await this.assertGroupAvailable(club.wizardCandidate);

    const result = this.stateMachine.transition({
      club,
      event: 'wizard_complete',
      actor: input.actor,
      now,
      facts: { confirmed: input.confirmed, leaderContinuityOk },
    });
    await this.registerMappings(result.club, now);
    await this.clubs.save(result.club);
    await this.notifications.save({
      kind: 'system',
      toUserIds: leaders,
      clubId: club.id,
      title: '社团已启用',
      body: `社团「${result.club.name}」完成接入并启用`,
      dedupKey: `club-enabled:${club.id}`,
    });
    return result.club;
  }

  async importMembers(input: {
    clubId: string;
    memberIds: string[];
    actor: string;
    now: Date;
  }): Promise<ClubSpace> {
    const club = await this.requireClub(input.clubId);
    if (club.status !== 'wizard_pending' && club.status !== 'enabled') {
      throw orgError.stateConflict(`状态 ${club.status} 不允许导入成员（IFC-ERR-007）`);
    }
    if (club.clubGroup === null) throw orgError.precondition('社团尚未绑定 Group，无法导入');
    const members = await this.casdoor.getGroupMembers(club.clubGroup);
    const invalid = input.memberIds.filter((id) => !members.includes(id));
    if (invalid.length > 0) {
      throw orgError.validation(`以下成员不在 Group 内：${invalid.join(', ')}`);
    }
    const updated: ClubSpace = {
      ...club,
      importedAt: input.now.toISOString(),
      importedCount: club.importedCount + input.memberIds.length,
      syncEvents: [
        ...club.syncEvents,
        {
          id: newId(IdPrefix.GROUP_EVENT),
          kind: 'import',
          at: input.now.toISOString(),
          note: '接入时既有成员同步为当前关系（未知历史日期不伪造，ORG-016）',
          actor: input.actor,
        },
      ],
      version: club.version + 1,
    };
    await this.clubs.save(updated);
    return updated;
  }

  private async registerMappings(club: ClubSpace, now: Date): Promise<void> {
    if (club.clubGroup === null) throw orgError.precondition('社团未绑定 Group，无法登记映射');
    await this.registry.save({
      ref: club.clubGroup,
      clubId: club.id,
      purpose: 'club',
      departmentId: null,
      positionId: null,
      mappingVersion: club.mappingVersion,
    });

    for (const dep of club.departmentGroups) {
      await this.assertDescendant(dep, club.clubGroup);
      await this.registry.save({
        ref: dep,
        clubId: club.id,
        purpose: 'department',
        departmentId: newId(IdPrefix.DEPARTMENT),
        positionId: null,
        mappingVersion: club.mappingVersion,
      });
    }

    for (const pos of club.positionGroups) {
      await this.assertDescendant(pos, club.clubGroup);
      await this.registry.save({
        ref: pos,
        clubId: club.id,
        purpose: 'position',
        departmentId: null,
        positionId: newId(IdPrefix.POSITION),
        mappingVersion: club.mappingVersion,
      });
    }
    void now;
  }

  private async requireClub(clubId: string): Promise<ClubSpace> {
    const club = await this.clubs.findById(clubId);
    if (club === null) throw orgError.notVisible(`社团空间不存在（${clubId}）`);
    return club;
  }
}

function toStableRef(ownerOrName: string, other: string): GroupStableRef {
  // 骨架阶段约定：groupId 直接承载 owner+name 定位元组（CAS-MAP-003）
  const isComposite = ownerOrName.includes('/');
  if (isComposite) {
    const [owner, name] = ownerOrName.split('/');
    return { owner, name };
  }
  return { owner: other, name: ownerOrName };
}

function newId(prefix: IdPrefix): string {
  return `${prefix}-${randomUUID()}`;
}

export const onboardingProvider = {
  provide: ONBOARDING_USE_CASE,
  useFactory: (
    clubs: ClubStore,
    casdoor: CasdoorGroupPort,
    registry: GroupMappingRegistry,
    notifications: NotificationPort,
  ) => new OnboardingUseCase(clubs, casdoor, registry, notifications),
  inject: [CLUB_STORE, CASDOOR_GROUP_PORT, GROUP_MAPPING_REGISTRY, NOTIFICATION_PORT],
};
