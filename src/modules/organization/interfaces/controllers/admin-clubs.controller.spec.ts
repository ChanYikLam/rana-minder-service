import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AdminClubsController } from './admin-clubs.controller';
import { OrgDomainError } from '../../domain/types';
import type { OnboardingUseCase } from '../../application/commands/onboard-club.use-case';
import type { ClubLifecycleUseCase } from '../../application/commands/club-lifecycle.use-case';
import type {
  AdminClubsQuery,
  GroupDirectoryQuery,
} from '../../application/queries/admin-clubs.query';
import type { CurrentPermissionsPort } from '../../application/ports';
import type { RequestActor } from '../actor';

const actor: RequestActor = { userId: 'u_root' };

interface CallLog {
  listClubs: unknown[];
  listGroups: unknown[];
  searchGroups: unknown[];
  groupDetail: unknown[];
  createWizard: unknown[];
  saveStep: unknown[];
  completeWizard: unknown[];
  importMembers: unknown[];
  normalSuspend: unknown[];
  forceSuspend: unknown[];
  recover: unknown[];
  repair: unknown[];
  rebind: unknown[];
  disconnect: unknown[];
  reaccess: unknown[];
  isPlatformSuperAdmin: unknown[];
}

function setup(options: { superAdmin?: boolean } = {}): {
  controller: AdminClubsController;
  log: CallLog;
} {
  const log: CallLog = {
    listClubs: [],
    listGroups: [],
    searchGroups: [],
    groupDetail: [],
    createWizard: [],
    saveStep: [],
    completeWizard: [],
    importMembers: [],
    normalSuspend: [],
    forceSuspend: [],
    recover: [],
    repair: [],
    rebind: [],
    disconnect: [],
    reaccess: [],
    isPlatformSuperAdmin: [],
  };

  const onboarding = {
    createWizard: async (input: unknown) => {
      log.createWizard.push(input);
      return { id: 'club-1' };
    },
    saveStep: async (input: unknown) => {
      log.saveStep.push(input);
      return { id: 'club-1' };
    },
    complete: async (input: unknown) => {
      log.completeWizard.push(input);
      return { id: 'club-1' };
    },
    importMembers: async (input: { memberIds: string[] }) => {
      log.importMembers.push(input);
      return { importedCount: input.memberIds.length };
    },
  } as unknown as OnboardingUseCase;

  const lifecycle = {
    normalSuspend: async (input: unknown) => {
      log.normalSuspend.push(input);
      return { id: 'club-1' };
    },
    forceSuspend: async (input: unknown) => {
      log.forceSuspend.push(input);
      return { id: 'club-1' };
    },
    recover: async (input: unknown) => {
      log.recover.push(input);
      return { id: 'club-1' };
    },
    repair: async (input: unknown) => {
      log.repair.push(input);
      return { id: 'club-1' };
    },
    rebind: async (input: unknown) => {
      log.rebind.push(input);
      return { id: 'club-1' };
    },
    disconnect: async (input: unknown) => {
      log.disconnect.push(input);
      return { id: 'club-1' };
    },
    reaccess: async (input: unknown) => {
      log.reaccess.push(input);
      return { id: 'club-1' };
    },
  } as unknown as ClubLifecycleUseCase;

  const adminClubsQuery = {
    list: async () => {
      log.listClubs.push({});
      return [];
    },
  } as unknown as AdminClubsQuery;

  const groupDirectory = {
    list: async () => {
      log.listGroups.push({});
      return [
        { id: 'g-1', name: 'ACM', leaderGroups: ['g-leader'], departments: ['g-dept'] },
        { id: 'g-2', name: 'Robotics', leaderGroups: [], departments: [] },
      ];
    },
    search: async (q: string) => {
      log.searchGroups.push({ q });
      return [];
    },
  } as unknown as GroupDirectoryQuery;

  const permissions = {
    isPlatformSuperAdmin: async (userId: string) => {
      log.isPlatformSuperAdmin.push({ userId });
      return options.superAdmin ?? false;
    },
  } as unknown as CurrentPermissionsPort;

  const controller = new AdminClubsController(
    onboarding,
    lifecycle,
    adminClubsQuery,
    groupDirectory,
    permissions,
  );

  return { controller, log };
}

// -----------------------------------------------------------------------------
// §15.1 社团接入与治理 —— 所有端点执行平台超管前置（platform:club:manage）
// -----------------------------------------------------------------------------

describe('AdminClubsController §15.1 平台超管前置（platform:club:manage）', () => {
  it('非平台超管调用任一端点均被拒绝（任意社团数据不可枚举）', async () => {
    const { controller, log } = setup({ superAdmin: false });
    const allCalls = [
      () => controller.listClubs(actor),
      () => controller.listGroups(actor),
      () => controller.searchGroups(actor, 'acm'),
      () => controller.groupDetail(actor, 'g-1'),
      () =>
        controller.createWizard(actor, {
          groupId: 'g-1',
          name: 'ACM',
          leaderGroupId: 'g-leader',
        } as never),
      () => controller.saveStep(actor, { clubId: 'club-1' } as never),
      () => controller.completeWizard(actor, { clubId: 'club-1', confirmed: true } as never),
      () => controller.importMembers(actor, 'club-1', { memberIds: ['u_x'] } as never),
      () => controller.normalSuspend(actor, 'club-1', { reason: 'r' } as never),
      () => controller.forceSuspend(actor, 'club-1', { reason: 'r' } as never),
      () => controller.recover(actor, 'club-1'),
      () => controller.repair(actor, 'club-1'),
      () => controller.rebind(actor, 'club-1', { groupId: 'g-2', confirmed: true } as never),
      () => controller.disconnect(actor, 'club-1', { confirmed: true } as never),
      () => controller.reaccess(actor, 'club-1', { groupId: 'g-2', confirmed: true } as never),
    ];
    for (const fn of allCalls) {
      await assert.rejects(
        fn,
        (err: unknown) => err instanceof OrgDomainError && err.code === 'IFC-ERR-FORBIDDEN',
      );
    }
    // 所有委托方法均未被调用
    assert.equal(log.listClubs.length, 0);
    assert.equal(log.listGroups.length, 0);
    assert.equal(log.createWizard.length, 0);
    assert.equal(log.saveStep.length, 0);
    assert.equal(log.completeWizard.length, 0);
    assert.equal(log.importMembers.length, 0);
    assert.equal(log.normalSuspend.length, 0);
    assert.equal(log.forceSuspend.length, 0);
    assert.equal(log.recover.length, 0);
    assert.equal(log.repair.length, 0);
    assert.equal(log.rebind.length, 0);
    assert.equal(log.disconnect.length, 0);
    assert.equal(log.reaccess.length, 0);
  });
});

describe('AdminClubsController §15.1 全部端点（已通过前置）', () => {
  it('listClubs / listGroups / searchGroups / groupDetail 透传查询', async () => {
    const { controller, log } = setup({ superAdmin: true });
    const clubs = await controller.listClubs(actor);
    assert.deepEqual(clubs, { items: [], nextCursor: null });
    const groups = await controller.listGroups(actor);
    assert.equal(groups.items.length, 2);
    await controller.searchGroups(actor, 'acm');
    assert.equal((log.searchGroups[0] as { q: string }).q, 'acm');
    const detail = await controller.groupDetail(actor, 'g-1');
    assert.equal(detail.id, 'g-1');
  });

  it('groupDetail：未知 groupId → 404 IFC-ERR-015（不暴露内部结构）', async () => {
    const { controller } = setup({ superAdmin: true });
    await assert.rejects(
      () => controller.groupDetail(actor, 'unknown'),
      (err: unknown) => err instanceof OrgDomainError && err.code === 'IFC-ERR-015',
    );
  });

  it('createWizard：URL :groupId 无关，DTO 字段全字段透传', async () => {
    const { controller, log } = setup({ superAdmin: true });
    await controller.createWizard(actor, {
      groupId: 'g-1',
      name: 'ACM',
      description: 'desc',
      leaderGroupId: 'g-leader',
      email: 'a@x.com',
      departmentGroupIds: ['g-dept'],
      positionGroupIds: ['g-pos'],
      leaderRoleGroupId: 'g-role',
      reauthProof: 'p-1',
    } as never);
    const input = log.createWizard[0] as Record<string, unknown>;
    assert.equal(input['groupId'], 'g-1');
    assert.equal(input['name'], 'ACM');
    assert.equal(input['leaderGroupId'], 'g-leader');
    assert.equal(input['actor'], 'u_root');
    assert.equal(input['reauthProof'], 'p-1');
  });

  it('saveStep / completeWizard：URL 与 DTO 字段透传', async () => {
    const { controller, log } = setup({ superAdmin: true });
    await controller.saveStep(actor, {
      clubId: 'club-1',
      name: 'new name',
      email: 'a@x.com',
    } as never);
    const saveInput = log.saveStep[0] as Record<string, unknown>;
    assert.equal(saveInput['clubId'], 'club-1');
    assert.equal(saveInput['actor'], 'u_root');

    await controller.completeWizard(actor, { clubId: 'club-1', confirmed: true } as never);
    const completeInput = log.completeWizard[0] as Record<string, unknown>;
    assert.equal(completeInput['clubId'], 'club-1');
    assert.equal(completeInput['confirmed'], true);
  });

  it('importMembers：URL :clubId 透传，memberIds 来自 DTO', async () => {
    const { controller, log } = setup({ superAdmin: true });
    await controller.importMembers(actor, 'club-1', { memberIds: ['u_a', 'u_b'] } as never);
    const input = log.importMembers[0] as Record<string, unknown>;
    assert.equal(input['clubId'], 'club-1');
    assert.deepEqual(input['memberIds'], ['u_a', 'u_b']);
    assert.equal(input['actor'], 'u_root');
  });

  it('normalSuspend / forceSuspend：URL :clubId 透传，reason 来自 DTO', async () => {
    const { controller, log } = setup({ superAdmin: true });
    await controller.normalSuspend(actor, 'club-1', { reason: '审计问题' } as never);
    const normal = log.normalSuspend[0] as Record<string, unknown>;
    assert.equal(normal['clubId'], 'club-1');
    assert.equal(normal['reason'], '审计问题');

    await controller.forceSuspend(actor, 'club-1', { reason: '紧急', confirmed: true } as never);
    const force = log.forceSuspend[0] as Record<string, unknown>;
    assert.equal(force['clubId'], 'club-1');
    assert.equal(force['reason'], '紧急');
    assert.equal(force['confirmed'], true);
  });

  it('recover / repair：URL :clubId 透传', async () => {
    const { controller, log } = setup({ superAdmin: true });
    await controller.recover(actor, 'club-1');
    assert.equal((log.recover[0] as Record<string, unknown>)['clubId'], 'club-1');
    await controller.repair(actor, 'club-1');
    assert.equal((log.repair[0] as Record<string, unknown>)['clubId'], 'club-1');
  });

  it('rebind / disconnect / reaccess：URL :clubId 透传，groupId 与 confirmed 来自 DTO', async () => {
    const { controller, log } = setup({ superAdmin: true });
    await controller.rebind(actor, 'club-1', { groupId: 'g-2', confirmed: true } as never);
    assert.equal((log.rebind[0] as Record<string, unknown>)['clubId'], 'club-1');
    assert.equal((log.rebind[0] as Record<string, unknown>)['groupId'], 'g-2');

    await controller.disconnect(actor, 'club-1', { confirmed: true } as never);
    assert.equal((log.disconnect[0] as Record<string, unknown>)['clubId'], 'club-1');
    assert.equal((log.disconnect[0] as Record<string, unknown>)['confirmed'], true);

    await controller.reaccess(actor, 'club-1', { groupId: 'g-2', confirmed: true } as never);
    assert.equal((log.reaccess[0] as Record<string, unknown>)['clubId'], 'club-1');
    assert.equal((log.reaccess[0] as Record<string, unknown>)['groupId'], 'g-2');
  });
});
