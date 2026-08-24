/**
 * 平台/社团策略默认值与活动快照单元测试（CFG-002，5.5.2）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  POLICY_REGISTRY,
  POLICY_KEYS,
  ScopedPolicyTable,
  amendActivitySnapshot,
} from './scoped-policy';

const NOW = new Date('2026-01-01T00:00:00Z');
const LATER = new Date('2026-01-02T00:00:00Z');
const CLUB_A = 'club-a';
const CLUB_B = 'club-b';

describe('策略注册表（CFG-002 硬边界冻结）', () => {
  it('四键齐备且出厂默认值落在硬边界内', () => {
    assert.deepEqual(POLICY_KEYS, [
      'INVITATION_VALID_DAYS',
      'CONFIRM_DEADLINE_HOURS',
      'PROFILE_SUPPLEMENT_DEADLINE_DAYS',
      'EXPORT_FILE_RETENTION_DAYS',
    ]);
    for (const key of POLICY_KEYS) {
      const def = POLICY_REGISTRY[key];
      assert.ok(def.platformDefault >= def.hardMin && def.platformDefault <= def.hardMax);
      assert.equal(def.affectsStudentRights, true);
    }
  });
});

describe('ScopedPolicyTable 平台层（CFG-002 默认值与允许范围）', () => {
  it('createDefault 后 resolve 返回平台默认值', () => {
    const table = ScopedPolicyTable.createDefault();
    for (const key of POLICY_KEYS) {
      assert.equal(table.resolve(CLUB_A, key), POLICY_REGISTRY[key].platformDefault);
    }
  });

  it('setPlatform 越界拒绝：allowedMin<hardMin / allowedMax>hardMax / min>max / default 出允许范围', () => {
    const table = ScopedPolicyTable.createDefault();
    const key = 'INVITATION_VALID_DAYS' as const;
    assert.throws(
      () =>
        table.setPlatform(
          key,
          { defaultValue: 7, allowedMin: 0, allowedMax: 90 },
          { by: 'sa', now: NOW },
        ),
      { code: 'CFG_VALIDATION' },
    );
    assert.throws(
      () =>
        table.setPlatform(
          key,
          { defaultValue: 7, allowedMin: 1, allowedMax: 91 },
          { by: 'sa', now: NOW },
        ),
      { code: 'CFG_VALIDATION' },
    );
    assert.throws(
      () =>
        table.setPlatform(
          key,
          { defaultValue: 7, allowedMin: 50, allowedMax: 10 },
          { by: 'sa', now: NOW },
        ),
      { code: 'CFG_VALIDATION' },
    );
    assert.throws(
      () =>
        table.setPlatform(
          key,
          { defaultValue: 100, allowedMin: 1, allowedMax: 90 },
          { by: 'sa', now: NOW },
        ),
      { code: 'CFG_VALIDATION' },
    );
  });

  it('setPlatform 合法修改：resolve 生效+留痕含旧值/新值/by/effectiveAt；同值重设不追加', () => {
    const table = ScopedPolicyTable.createDefault();
    table.setPlatform(
      'INVITATION_VALID_DAYS',
      { defaultValue: 14, allowedMin: 3, allowedMax: 60 },
      { by: 'super-1', now: NOW },
    );
    assert.equal(table.resolve(CLUB_A, 'INVITATION_VALID_DAYS'), 14);

    const records = table.changes;
    assert.equal(records.length, 1);
    assert.equal(records[0].scope, 'PLATFORM');
    assert.equal(records[0].oldValue, 7);
    assert.equal(records[0].newValue, 14);
    assert.equal(records[0].by, 'super-1');
    assert.deepEqual(records[0].effectiveAt, NOW);

    table.setPlatform(
      'INVITATION_VALID_DAYS',
      { defaultValue: 14, allowedMin: 3, allowedMax: 60 },
      { by: 'super-1', now: LATER },
    );
    assert.equal(table.changes.length, 1);
  });
});

describe('ScopedPolicyTable 社团层（CFG-002 社团默认值限允许范围）', () => {
  function newTable(): ScopedPolicyTable {
    return ScopedPolicyTable.createDefault();
  }

  it('社团值超平台允许范围拒绝；范围内成功且 resolve 社团优先', () => {
    const table = newTable();
    // 平台允许范围收窄到 3..30，平台默认 14
    table.setPlatform(
      'INVITATION_VALID_DAYS',
      { defaultValue: 14, allowedMin: 3, allowedMax: 30 },
      { by: 'sa', now: NOW },
    );
    assert.throws(
      () => table.setClub(CLUB_A, 'INVITATION_VALID_DAYS', 2, { by: 'leader', now: NOW }),
      { code: 'CFG_VALIDATION' },
    );
    table.setClub(CLUB_A, 'INVITATION_VALID_DAYS', 21, { by: 'leader', now: NOW });
    assert.equal(table.resolve(CLUB_A, 'INVITATION_VALID_DAYS'), 21);
  });

  it('不同社团互不影响；未设覆盖的社团回落平台默认', () => {
    const table = newTable();
    table.setClub(CLUB_A, 'CONFIRM_DEADLINE_HOURS', 72, { by: 'leader-a', now: NOW });
    assert.equal(table.resolve(CLUB_A, 'CONFIRM_DEADLINE_HOURS'), 72);
    assert.equal(table.resolve(CLUB_B, 'CONFIRM_DEADLINE_HOURS'), 48);
  });

  it('留痕旧值正确：首次设置 oldValue=当时生效的平台默认值（回归：变更前捕获）', () => {
    const table = newTable();
    table.setClub(CLUB_A, 'INVITATION_VALID_DAYS', 10, { by: 'leader', now: NOW });
    const record = table.changes.find((r) => r.scope === 'CLUB');
    assert.ok(record);
    assert.equal(record.oldValue, 7);
    assert.equal(record.newValue, 10);

    table.setClub(CLUB_A, 'INVITATION_VALID_DAYS', 12, { by: 'leader', now: LATER });
    const second = table.changes.filter((r) => r.scope === 'CLUB')[1];
    assert.equal(second.oldValue, 10);
    assert.equal(second.newValue, 12);
  });

  it('同值重复设置不追加留痕', () => {
    const table = newTable();
    table.setClub(CLUB_A, 'INVITATION_VALID_DAYS', 10, { by: 'leader', now: NOW });
    table.setClub(CLUB_A, 'INVITATION_VALID_DAYS', 10, { by: 'leader', now: LATER });
    assert.equal(table.changes.filter((r) => r.scope === 'CLUB').length, 1);
  });

  it('listPlatformEntries/listClubEntries 按注册表顺序返回', () => {
    const table = newTable();
    table.setClub(CLUB_A, 'EXPORT_FILE_RETENTION_DAYS', 45, { by: 'leader', now: NOW });
    const clubEntries = table.listClubEntries(CLUB_A);
    assert.equal(clubEntries.length, 1);
    assert.equal(clubEntries[0].key, 'EXPORT_FILE_RETENTION_DAYS');
    assert.equal(table.listPlatformEntries().length, POLICY_KEYS.length);
  });
});

describe('活动配置快照（CFG-002 发布时冻结）', () => {
  function seededTable(): ScopedPolicyTable {
    const table = ScopedPolicyTable.createDefault();
    table.setClub(CLUB_A, 'INVITATION_VALID_DAYS', 21, { by: 'leader', now: NOW });
    return table;
  }

  it('快照=冻结时刻逐键 resolve 结果', () => {
    const table = seededTable();
    const snap = table.freezeActivitySnapshot('act-1', CLUB_A, { by: 'leader', now: NOW });
    assert.equal(snap.values.INVITATION_VALID_DAYS, 21);
    assert.equal(snap.values.CONFIRM_DEADLINE_HOURS, 48);
    assert.equal(snap.revisionNumber, 1);
    assert.equal(snap.amendments.length, 0);
  });

  it('冻结后平台/社团默认值变化不影响快照（已发布活动不受后续变化影响）', () => {
    const table = seededTable();
    const snap = table.freezeActivitySnapshot('act-1', CLUB_A, { by: 'leader', now: NOW });
    table.setPlatform(
      'INVITATION_VALID_DAYS',
      { defaultValue: 60, allowedMin: 1, allowedMax: 90 },
      { by: 'sa', now: LATER },
    );
    table.setClub(CLUB_A, 'INVITATION_VALID_DAYS', 5, { by: 'leader', now: LATER });
    assert.equal(snap.values.INVITATION_VALID_DAYS, 21);
  });

  it('amendActivitySnapshot：业务不允许 → CFG_CONFLICT', () => {
    const table = seededTable();
    const snap = table.freezeActivitySnapshot('act-1', CLUB_A, { by: 'leader', now: NOW });
    assert.throws(
      () =>
        amendActivitySnapshot(snap, 'INVITATION_VALID_DAYS', 30, {
          by: 'leader',
          now: LATER,
          businessAllows: false,
        }),
      { code: 'CFG_CONFLICT' },
    );
  });

  it('amendActivitySnapshot：允许时不可变更新（values/amendments/revisionNumber），入参不被修改', () => {
    const table = seededTable();
    const snap = table.freezeActivitySnapshot('act-1', CLUB_A, { by: 'leader', now: NOW });
    const before = JSON.stringify(snap);
    const amended = amendActivitySnapshot(snap, 'INVITATION_VALID_DAYS', 30, {
      by: 'leader',
      now: LATER,
      businessAllows: true,
    });

    assert.equal(amended.values.INVITATION_VALID_DAYS, 30);
    assert.equal(amended.revisionNumber, 2);
    assert.equal(amended.amendments.length, 1);
    assert.equal(amended.amendments[0].oldValue, 21);
    assert.equal(amended.amendments[0].newValue, 30);
    assert.deepEqual(JSON.parse(JSON.stringify(snap)), JSON.parse(before));
  });

  it('amendActivitySnapshot：越出平台允许范围拒绝（platformRange 优先于硬边界）', () => {
    const table = seededTable();
    const snap = table.freezeActivitySnapshot('act-1', CLUB_A, { by: 'leader', now: NOW });
    assert.throws(
      () =>
        amendActivitySnapshot(snap, 'INVITATION_VALID_DAYS', 31, {
          by: 'leader',
          now: LATER,
          businessAllows: true,
          platformRange: { min: 3, max: 30 },
        }),
      { code: 'CFG_VALIDATION' },
    );
  });
});

describe('快照往返（toSnapshot/fromSnapshot）', () => {
  it('往返后 resolve 与留痕行为一致', () => {
    const table = ScopedPolicyTable.createDefault();
    table.setPlatform(
      'INVITATION_VALID_DAYS',
      { defaultValue: 14, allowedMin: 3, allowedMax: 60 },
      { by: 'sa', now: NOW },
    );
    table.setClub(CLUB_A, 'INVITATION_VALID_DAYS', 20, { by: 'leader', now: NOW });
    const restored = ScopedPolicyTable.fromSnapshot(table.toSnapshot());

    assert.equal(restored.resolve(CLUB_A, 'INVITATION_VALID_DAYS'), 20);
    assert.equal(restored.resolve(CLUB_B, 'INVITATION_VALID_DAYS'), 14);
    assert.equal(restored.changes.length, table.changes.length);
  });

  it('fromSnapshot 拒绝损坏数据：缺平台条目/社团值越界', () => {
    const snapshot = ScopedPolicyTable.createDefault().toSnapshot();
    const brokenPlatform = {
      ...snapshot,
      platform: Object.fromEntries(Object.entries(snapshot.platform).slice(1)),
    };
    assert.throws(() => ScopedPolicyTable.fromSnapshot(brokenPlatform as never), {
      code: 'CFG_VALIDATION',
    });

    const ok = ScopedPolicyTable.createDefault().toSnapshot();
    const brokenClub = {
      ...ok,
      clubs: {
        'club-x': [{ key: 'INVITATION_VALID_DAYS', value: 9999, updatedBy: 'x', updatedAt: NOW }],
      },
    };
    assert.throws(() => ScopedPolicyTable.fromSnapshot(brokenClub as never), {
      code: 'CFG_VALIDATION',
    });
  });
});
