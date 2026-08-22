/**
 * InMemoryStatisticsSource 单测：种子与克隆隔离、缺失数据 null/空。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryStatisticsSource } from './in-memory-statistics-source';
import type { MembershipFact } from '../domain/models/statistics-specification';

describe('InMemoryStatisticsSource', () => {
  it('未种子社团 → loadClubProfile null', async () => {
    const source = new InMemoryStatisticsSource();
    assert.equal(await source.loadClubProfile('nonexistent'), null);
  });

  it('种子并读取社团基本信息', async () => {
    const source = new InMemoryStatisticsSource();
    source.seedClubProfile({ clubId: 'club-1', forcedSuspension: false });
    const profile = await source.loadClubProfile('club-1');
    assert.ok(profile);
    assert.equal(profile.clubId, 'club-1');
    assert.equal(profile.forcedSuspension, false);
  });

  it('未种子成员 → 空数组', async () => {
    const source = new InMemoryStatisticsSource();
    const facts = await source.loadMembershipFacts('club-1');
    assert.equal(facts.length, 0);
  });

  it('种子后返回克隆（外部修改不影响源）', async () => {
    const source = new InMemoryStatisticsSource();
    const fact: MembershipFact = {
      userId: 'u1', studentNo: 'S001', departmentId: 'dept-a',
      departmentName: '技术部', positionId: null, academicYear: '2025-2026',
    };
    source.seedMembershipFacts('club-1', [fact]);

    const loaded = await source.loadMembershipFacts('club-1');
    assert.equal(loaded.length, 1);
    // 验证克隆——外部不可变（通过类型断言绕过只读限制做运行时验证）
    const mutable = loaded as unknown as Array<{ userId: string }>;
    mutable[0].userId = 'modified';
    const loadedAgain = await source.loadMembershipFacts('club-1');
    assert.equal(loadedAgain[0].userId, 'u1');
  });

  it('种子后 reset → 清空', async () => {
    const source = new InMemoryStatisticsSource();
    source.seedClubProfile({ clubId: 'test', forcedSuspension: false });
    source.reset();
    assert.equal(await source.loadClubProfile('test'), null);
  });

  it('普通招新活动不存在 → null', async () => {
    const source = new InMemoryStatisticsSource();
    assert.equal(await source.loadNormalActivity('no-such'), null);
  });

  it('联合活动不存在 → null', async () => {
    const source = new InMemoryStatisticsSource();
    assert.equal(await source.loadJointActivity('no-such'), null);
  });

  it('种子联合活动并读取', async () => {
    const source = new InMemoryStatisticsSource();
    source.seedJointActivity({ jointActivityId: 'joint-A', participantClubIds: ['c1', 'c2'] });
    const ref = await source.loadJointActivity('joint-A');
    assert.ok(ref);
    assert.equal(ref.jointActivityId, 'joint-A');
    assert.deepEqual(ref.participantClubIds, ['c1', 'c2']);
  });

  it('读取全平台数据', async () => {
    const source = new InMemoryStatisticsSource();
    const m: MembershipFact = { userId: 'u1', studentNo: 'S001', departmentId: null, departmentName: null, positionId: null, academicYear: '2025-2026' };
    source.seedPlatformMembershipFacts([m]);
    const loaded = await source.loadPlatformMembershipFacts();
    assert.equal(loaded.length, 1);
  });
});
