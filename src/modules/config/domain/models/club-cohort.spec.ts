/**
 * 社团届次纯领域聚合测试（CFG-003，5.5.3）。
 *
 * 覆盖：创建（两个校验：名称规范化 + 关联已生成系统学年）、
 * 名称空白/超长拒绝、rename 留痕（revisionNumber+1/updatedAt/updatedBy）
 * 且只影响 name 不触碰 academicYearName（换届须新建届次）、
 * 失败校验不落变更、assertSameClub 越社拒绝。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClubCohort, MAX_COHORT_NAME_LENGTH } from './club-cohort';
import { ConfigDomainError } from '../errors';

const KNOWN_YEARS = ['2024-2025', '2025-2026', '2026-2027'];
const NOW = new Date('2026-01-10T08:00:00.000Z');

function createDefaultCohort(): ClubCohort {
  return ClubCohort.create({
    id: 'cohort-1',
    clubId: 'club-1',
    name: '第41届',
    academicYearName: '2025-2026',
    createdBy: 'admin-1',
    now: NOW,
    knownYears: KNOWN_YEARS,
  });
}

/** 断言执行体抛出指定 code 的 ConfigDomainError */
function assertCfgError(run: () => unknown, code: string): void {
  assert.throws(run, (e: Error) => e instanceof ConfigDomainError && e.code === code);
}

describe('ClubCohort.create（CFG-003 届次创建）', () => {
  it('正常创建：字段与留痕初值正确，knownYears 命中通过', () => {
    const cohort = createDefaultCohort();
    const snapshot = cohort.toSnapshot();
    assert.equal(snapshot.id, 'cohort-1');
    assert.equal(snapshot.clubId, 'club-1');
    assert.equal(snapshot.name, '第41届');
    assert.equal(snapshot.academicYearName, '2025-2026');
    assert.equal(snapshot.createdBy, 'admin-1');
    assert.equal(snapshot.revisionNumber, 1);
    assert.equal(snapshot.createdAt.getTime(), NOW.getTime());
    assert.equal(snapshot.updatedAt.getTime(), NOW.getTime());
    assert.equal(snapshot.updatedBy, null);
  });

  it('名称为空白字符串抛 CFG_VALIDATION', () => {
    assertCfgError(
      () =>
        ClubCohort.create({
          id: 'cohort-2',
          clubId: 'club-1',
          name: '   ',
          academicYearName: '2025-2026',
          createdBy: 'admin-1',
          now: NOW,
          knownYears: KNOWN_YEARS,
        }),
      'CFG_VALIDATION',
    );
  });

  it('名称 51 字符超过上限抛 CFG_VALIDATION（50 字符可通过）', () => {
    assertCfgError(
      () =>
        ClubCohort.create({
          id: 'cohort-3',
          clubId: 'club-1',
          name: '届'.repeat(MAX_COHORT_NAME_LENGTH + 1),
          academicYearName: '2025-2026',
          createdBy: 'admin-1',
          now: NOW,
          knownYears: KNOWN_YEARS,
        }),
      'CFG_VALIDATION',
    );
    assert.doesNotThrow(() =>
      ClubCohort.create({
        id: 'cohort-4',
        clubId: 'club-1',
        name: '届'.repeat(MAX_COHORT_NAME_LENGTH),
        academicYearName: '2025-2026',
        createdBy: 'admin-1',
        now: NOW,
        knownYears: KNOWN_YEARS,
      }),
    );
  });

  it('关联不在 knownYears 的系统学年抛 CFG_VALIDATION', () => {
    assertCfgError(
      () =>
        ClubCohort.create({
          id: 'cohort-5',
          clubId: 'club-1',
          name: '第41届',
          academicYearName: '2030-2031',
          createdBy: 'admin-1',
          now: NOW,
          knownYears: KNOWN_YEARS,
        }),
      'CFG_VALIDATION',
    );
  });

  it('名称按 trim 后存储', () => {
    const cohort = ClubCohort.create({
      id: 'cohort-6',
      clubId: 'club-1',
      name: '  第42届  ',
      academicYearName: '2026-2027',
      createdBy: 'admin-1',
      now: NOW,
      knownYears: KNOWN_YEARS,
    });
    assert.equal(cohort.toSnapshot().name, '第42届');
  });
});

describe('ClubCohort.rename（CFG-003 改名留痕）', () => {
  it('改名成功：name 更新、revisionNumber+1、updatedAt 变、操作者记入 updatedBy', () => {
    const cohort = createDefaultCohort();
    const later = new Date(NOW.getTime() + 60_000);
    cohort.rename('第四十一届', { by: 'president-1', now: later });
    const snapshot = cohort.toSnapshot();
    assert.equal(snapshot.name, '第四十一届');
    assert.equal(snapshot.revisionNumber, 2);
    assert.equal(snapshot.updatedAt.getTime(), later.getTime());
    assert.equal(snapshot.updatedBy, 'president-1');
    assert.equal(snapshot.createdAt.getTime(), NOW.getTime());
  });

  it('rename 只影响 name：academicYearName 保持不变（换届须新建届次）', () => {
    const cohort = createDefaultCohort();
    cohort.rename('新叫法', { by: 'president-1', now: new Date(NOW.getTime() + 1) });
    const snapshot = cohort.toSnapshot();
    // 聚合根本不提供修改关联学年的方法；rename 后学年名原样保留
    assert.equal(snapshot.academicYearName, '2025-2026');
    assert.equal(snapshot.id, 'cohort-1');
    assert.equal(snapshot.clubId, 'club-1');
  });

  it('rename 空白名抛 CFG_VALIDATION 且失败不落变更', () => {
    const cohort = createDefaultCohort();
    assertCfgError(() => cohort.rename('   ', { by: 'president-1', now: NOW }), 'CFG_VALIDATION');
    const snapshot = cohort.toSnapshot();
    assert.equal(snapshot.name, '第41届');
    assert.equal(snapshot.revisionNumber, 1);
    assert.equal(snapshot.updatedAt.getTime(), NOW.getTime());
  });
});

describe('ClubCohort.assertSameClub（CFG-003 社团归属）', () => {
  it('届次不属于该社团抛 CFG_FORBIDDEN', () => {
    const cohort = createDefaultCohort();
    assertCfgError(() => cohort.assertSameClub('club-other'), 'CFG_FORBIDDEN');
  });

  it('同社团通过', () => {
    const cohort = createDefaultCohort();
    assert.doesNotThrow(() => cohort.assertSameClub('club-1'));
  });
});

describe('ClubCohort 快照往返（fromSnapshot/toSnapshot）', () => {
  it('快照往返后状态一致', () => {
    const original = createDefaultCohort().toSnapshot();
    const restored = ClubCohort.fromSnapshot(original).toSnapshot();
    assert.deepEqual(restored, original);
  });
});
