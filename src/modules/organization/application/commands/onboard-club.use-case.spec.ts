import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { OnboardingUseCase } from './onboard-club.use-case';
import {
  InMemoryCasdoorPort,
  InMemoryClubStore,
  InMemoryGroupMappingRegistry,
  InMemoryNotificationPort,
} from '../../infrastructure/in-memory/memory-implementations';

function buildHarness() {
  const casdoor = new InMemoryCasdoorPort({
    groups: [
      {
        ref: { owner: 'club-acm', name: 'ACM社团' },
        displayName: 'ACM社团',
        parentRef: null,
        memberIds: ['u_a', 'u_b', 'u_c'],
      },
      {
        ref: { owner: 'club-acm', name: '负责人组' },
        displayName: '负责人组',
        parentRef: { owner: 'club-acm', name: 'ACM社团' },
        memberIds: ['u_a'],
      },
      {
        ref: { owner: 'club-web', name: 'Web社团' },
        displayName: 'Web社团',
        parentRef: null,
        memberIds: ['u_w'],
      },
    ],
  });
  const clubs = new InMemoryClubStore();
  const registry = new InMemoryGroupMappingRegistry();
  const notifications = new InMemoryNotificationPort();
  const useCase = new OnboardingUseCase(clubs, casdoor, registry, notifications);
  return { casdoor, clubs, registry, notifications, useCase };
}

describe('OnboardingUseCase', () => {
  let h: ReturnType<typeof buildHarness>;

  beforeEach(() => {
    h = buildHarness();
  });

  it('createWizard：缺重新认证 → 拒绝（IFC-ERR-002）', async () => {
    await assert.rejects(
      h.useCase.createWizard(
        {
          groupId: 'club-acm/ACM社团',
          name: 'ACM社团',
          description: '',
          leaderGroupId: 'club-acm/负责人组',
          actor: 'u_root',
        },
        new Date(),
      ),
      (e: Error) => e.message.includes('重新认证'),
    );
  });

  it('createWizard：候选 Group 不存在/不可读 → 拒绝（IFC-ERR-015）', async () => {
    await assert.rejects(
      h.useCase.createWizard(
        {
          groupId: 'club-ghost/NoSuch',
          name: '幽灵',
          description: '',
          leaderGroupId: 'club-acm/负责人组',
          actor: 'u_root',
          reauthProof: 'x',
        },
        new Date(),
      ),
      (e: Error) => e.message.includes('不存在或不可读'),
    );
  });

  it('完整向导：createWizard → saveStep → complete 启用并登记映射', async () => {
    const club = await h.useCase.createWizard(
      {
        groupId: 'club-acm/ACM社团',
        name: 'ACM社团',
        description: '算法竞赛',
        leaderGroupId: 'club-acm/负责人组',
        actor: 'u_root',
        reauthProof: 'token',
      },
      new Date('2026-08-01T00:00:00.000Z'),
    );
    assert.equal(club.status, 'wizard_pending');
    assert.equal(club.wizardStep, 2);
    assert.deepEqual(club.wizardCandidate, { owner: 'club-acm', name: 'ACM社团' });

    const stepped = await h.useCase.saveStep(
      { clubId: club.id, actor: 'u_root', name: 'ACM社团', email: 'acm@ruc.example' },
      new Date('2026-08-01T00:01:00.000Z'),
    );
    assert.equal(stepped.wizardStep, 3);
    assert.equal(stepped.email, 'acm@ruc.example');

    const enabled = await h.useCase.complete(
      { clubId: club.id, actor: 'u_root', confirmed: true },
      new Date('2026-08-01T00:02:00.000Z'),
    );
    assert.equal(enabled.status, 'enabled');
    assert.equal(enabled.readonly, false);
    assert.deepEqual(enabled.clubGroup, { owner: 'club-acm', name: 'ACM社团' });

    const mapping = await h.registry.findByRef({ owner: 'club-acm', name: 'ACM社团' });
    assert.ok(mapping);
    assert.equal(mapping.purpose, 'club');
    assert.equal(mapping.clubId, club.id);

    const hasNotify = await h.notifications.has('社团已启用');
    assert.equal(hasNotify, true);
  });

  it('complete：未确认 → 拒绝（高风控二次确认）', async () => {
    const club = await h.useCase.createWizard(
      {
        groupId: 'club-web/Web社团',
        name: 'Web社团',
        description: '',
        leaderGroupId: 'club-web/Web社团',
        actor: 'u_root',
        reauthProof: 'token',
      },
      new Date(),
    );
    await assert.rejects(
      h.useCase.complete({ clubId: club.id, actor: 'u_root', confirmed: false }, new Date()),
      (e: Error) => e.message.includes('二次确认'),
    );
  });

  it('一个 Group 同一时刻只能绑一个社团（ORG-004/011/014）', async () => {
    await h.useCase.createWizard(
      {
        groupId: 'club-acm/ACM社团',
        name: 'ACM社团',
        description: '',
        leaderGroupId: 'club-acm/负责人组',
        actor: 'u_root',
        reauthProof: 't',
      },
      new Date(),
    );
    const club = (await h.clubs.list())[0];
    assert.ok(club);
    await h.useCase.complete({ clubId: club.id, actor: 'u_root', confirmed: true }, new Date());
    await assert.rejects(
      h.useCase.createWizard(
        {
          groupId: 'club-acm/ACM社团',
          name: '二次绑定',
          description: '',
          leaderGroupId: 'club-acm/负责人组',
          actor: 'u_root',
          reauthProof: 't',
        },
        new Date(),
      ),
      (e: Error) => e.message.includes('重复绑定'),
    );
  });

  it('importMembers：成员必须已在 Group 内（ORG-016 不伪造历史）', async () => {
    const club = await h.useCase.createWizard(
      {
        groupId: 'club-acm/ACM社团',
        name: 'ACM社团',
        description: '',
        leaderGroupId: 'club-acm/负责人组',
        actor: 'u_root',
        reauthProof: 't',
      },
      new Date(),
    );
    await h.useCase.complete({ clubId: club.id, actor: 'u_root', confirmed: true }, new Date());
    const imported = await h.useCase.importMembers({
      clubId: club.id,
      memberIds: ['u_a', 'u_b'],
      actor: 'u_root',
      now: new Date(),
    });
    assert.equal(imported.importedCount, 2);
    assert.equal(imported.importedAt !== null, true);

    await assert.rejects(
      h.useCase.importMembers({
        clubId: club.id,
        memberIds: ['u_outsider'],
        actor: 'u_root',
        now: new Date(),
      }),
      (e: Error) => e.message.includes('不在 Group 内'),
    );
  });
});
