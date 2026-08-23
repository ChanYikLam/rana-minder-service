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
});
