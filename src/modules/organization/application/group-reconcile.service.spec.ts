/**
 * GroupReconcileService：真实对账检测（删除/失权/移动）——#68 验收第 3 条。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryCasdoorPort,
  InMemoryClubStore,
  InMemoryGroupMappingRegistry,
} from '../infrastructure/in-memory/memory-implementations';
import { createClubSpace } from '../domain/models/club-space';
import type { CasdoorGroupInfo } from './ports';
import { GroupReconcileService } from './group-reconcile.service';

async function setup() {
  const casdoor = new InMemoryCasdoorPort({
    groups: [
      {
        ref: { owner: 'club-acm', name: 'ACM社团' },
        displayName: 'ACM社团',
        parentRef: null,
        memberIds: ['u_a'],
      },
      {
        ref: { owner: 'club-acm', name: '宣传部' },
        displayName: '宣传部',
        parentRef: { owner: 'club-acm', name: 'ACM社团' },
        memberIds: [],
      },
    ],
  });
  const clubs = new InMemoryClubStore();
  const registry = new InMemoryGroupMappingRegistry();
  await registry.save({
    ref: { owner: 'club-acm', name: '宣传部' },
    clubId: 'club-1',
    purpose: 'department',
    departmentId: null,
    positionId: null,
    mappingVersion: 1,
  });
  const club = createClubSpace({
    id: 'club-1',
    name: 'ACM社团',
    description: '',
    candidate: { owner: 'club-acm', name: 'ACM社团' },
    actor: 'u_root',
    now: new Date('2026-08-01T00:00:00.000Z'),
  });
  club.status = 'enabled';
  club.clubGroup = { owner: 'club-acm', name: 'ACM社团' };
  club.leaderGroup = null;
  await clubs.save(club);

  const service = new GroupReconcileService({ clubs, casdoor, registry });
  return { casdoor, service };
}

describe('GroupReconcileService（真实检测语义，#68 验收）', () => {
  it('正常状态：无异常', async () => {
    const { service } = await setup();
    const r = await service.reconcileClub('club-1');
    assert.deepEqual(r, { anomaly: false, kind: null, readonlyRenamedOnly: false });
  });

  it('Group 被删除 → anomaly=deleted（ORG-013/026）', async () => {
    const { casdoor, service } = await setup();
    await casdoor.simulateAnomaly({ owner: 'club-acm', name: 'ACM社团' }, 'deleted');
    const r = await service.reconcileClub('club-1');
    assert.equal(r.anomaly, true);
    assert.equal(r.kind, 'deleted');
  });

  it('Group 失去可读性（凭据失权）→ anomaly=no_access', async () => {
    const { casdoor, service } = await setup();
    await casdoor.simulateAnomaly({ owner: 'club-acm', name: 'ACM社团' }, 'no_access');
    const r = await service.reconcileClub('club-1');
    assert.equal(r.anomaly, true);
    assert.equal(r.kind, 'no_access');
  });

  it('Group 父级变化且提供了父级基线 → anomaly=moved', async () => {
    const { service } = await setup();
    service.setParentBaselines([
      {
        owner: 'club-acm',
        name: 'ACM社团',
        parentOwner: 'platform-root',
        parentName: '平台根',
      },
    ]);
    // 实际 parentRef=null ≠ 基线 platform-root/平台根 → moved
    const r = await service.reconcileClub('club-1');
    assert.equal(r.anomaly, true);
    assert.equal(r.kind, 'moved');
  });

  it('未提供父级基线时不误报 moved', async () => {
    const { service } = await setup();
    const r = await service.reconcileClub('club-1');
    assert.equal(r.kind, null);
  });

  it('社团不存在 → deleted（防御分支）', async () => {
    const { service } = await setup();
    const r = await service.reconcileClub('ghost');
    assert.equal(r.kind, 'deleted');
  });

  it('仅改名：注册 ref 失联但同 stableId 存活 Group 在新 ref 下 → renamedOnly 且不报异常（ORG-026）', async () => {
    const { casdoor, service } = await setup();
    // 基线携带绑定时的 stableId（g-0 = ACM社团）
    service.setParentBaselines([
      {
        owner: 'club-acm',
        name: 'ACM社团',
        parentOwner: null,
        parentName: null,
        stableId: 'g-0',
      },
    ]);
    // 模拟改名：旧 ref 查不到，但目录中同 stableId Group 以新名存活
    const renamedDirectory: CasdoorGroupInfo[] = [
      {
        stableId: 'g-0',
        ref: { owner: 'club-acm', name: 'ACM社团（新名）' },
        displayName: 'ACM社团（新名）',
        path: '/club-acm/ACM社团（新名）',
        parentRef: null,
        memberIds: ['u_a'],
        readable: true,
        deleted: false,
      },
      {
        stableId: 'g-1',
        ref: { owner: 'club-acm', name: '宣传部' },
        displayName: '宣传部',
        path: '/club-acm/宣传部',
        parentRef: { owner: 'club-acm', name: 'ACM社团（新名）' },
        memberIds: [],
        readable: true,
        deleted: false,
      },
    ];
    const spy = casdoor as unknown as { listGroups(): Promise<CasdoorGroupInfo[]> };
    spy.listGroups = async () => renamedDirectory;
    await casdoor.simulateAnomaly({ owner: 'club-acm', name: 'ACM社团' }, 'deleted');

    const r = await service.reconcileClub('club-1');
    assert.deepEqual(r, { anomaly: false, kind: null, readonlyRenamedOnly: true });
  });

  it('仅改名不短路：同 club 其他 Group 真删除时仍优先报 deleted', async () => {
    const { casdoor, service } = await setup();
    service.setParentBaselines([
      { owner: 'club-acm', name: 'ACM社团', parentOwner: null, parentName: null, stableId: 'g-0' },
      { owner: 'club-acm', name: '宣传部', parentOwner: null, parentName: null, stableId: 'g-1' },
    ]);
    const spy = casdoor as unknown as { listGroups(): Promise<CasdoorGroupInfo[]> };
    spy.listGroups = async () => [
      {
        stableId: 'g-0',
        ref: { owner: 'club-acm', name: 'ACM社团（新名）' },
        displayName: 'ACM社团（新名）',
        path: '/x',
        parentRef: null,
        memberIds: [],
        readable: true,
        deleted: false,
      },
    ];
    // ACM社团 → 仅改名；宣传部 → 彻底消失（目录中也无 g-1）
    await casdoor.simulateAnomaly({ owner: 'club-acm', name: 'ACM社团' }, 'deleted');
    await casdoor.simulateAnomaly({ owner: 'club-acm', name: '宣传部' }, 'deleted');

    const r = await service.reconcileClub('club-1');
    assert.equal(r.anomaly, true);
    assert.equal(r.kind, 'deleted');
    assert.equal(r.readonlyRenamedOnly, false);
  });

  it('基线未提供 stableId：ref 失联保守回落 deleted（不吞异常）', async () => {
    const { casdoor, service } = await setup();
    service.setParentBaselines([
      { owner: 'club-acm', name: 'ACM社团', parentOwner: null, parentName: null },
    ]);
    await casdoor.simulateAnomaly({ owner: 'club-acm', name: 'ACM社团' }, 'deleted');
    const r = await service.reconcileClub('club-1');
    assert.equal(r.anomaly, true);
    assert.equal(r.kind, 'deleted');
    assert.equal(r.readonlyRenamedOnly, false);
  });

  it('多 Group 同时仅改名：listGroups 全量目录仅拉取一次（同轮对账复用）', async () => {
    const { casdoor, service } = await setup();
    let listCalls = 0;
    const spy = casdoor as unknown as { listGroups(): Promise<CasdoorGroupInfo[]> };
    spy.listGroups = async () => {
      listCalls += 1;
      return [
        {
          stableId: 'g-0',
          ref: { owner: 'club-acm', name: 'ACM社团（新名）' },
          displayName: 'ACM社团（新名）',
          path: '/x',
          parentRef: null,
          memberIds: [],
          readable: true,
          deleted: false,
        },
        {
          stableId: 'g-1',
          ref: { owner: 'club-acm', name: '宣传部（新名）' },
          displayName: '宣传部（新名）',
          path: '/y',
          parentRef: { owner: 'club-acm', name: 'ACM社团（新名）' },
          memberIds: [],
          readable: true,
          deleted: false,
        },
      ];
    };
    service.setParentBaselines([
      { owner: 'club-acm', name: 'ACM社团', parentOwner: null, parentName: null, stableId: 'g-0' },
      { owner: 'club-acm', name: '宣传部', parentOwner: null, parentName: null, stableId: 'g-1' },
    ]);
    await casdoor.simulateAnomaly({ owner: 'club-acm', name: 'ACM社团' }, 'deleted');
    await casdoor.simulateAnomaly({ owner: 'club-acm', name: '宣传部' }, 'deleted');

    const r = await service.reconcileClub('club-1');
    assert.deepEqual(r, { anomaly: false, kind: null, readonlyRenamedOnly: true });
    assert.equal(listCalls, 1); // 两个失联 ref 共享一次目录拉取
  });
});
