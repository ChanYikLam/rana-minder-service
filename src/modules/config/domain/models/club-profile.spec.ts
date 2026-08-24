/**
 * 社团展示资料聚合单元测试（CFG-001，5.5.1）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ClubProfile } from './club-profile';

const NOW = new Date('2026-01-01T00:00:00Z');
const CLUB_ID = 'club-1';

function newProfile(): ClubProfile {
  return ClubProfile.createDefault({ clubId: CLUB_ID, clubName: '旧名称', now: NOW });
}

describe('ClubProfile 初始态（CFG-001）', () => {
  it('createDefault：displayName 取社团名、无历史、revisionNumber=1', () => {
    const snapshot = newProfile().toSnapshot();
    assert.equal(snapshot.clubId, CLUB_ID);
    assert.equal(snapshot.displayName, '旧名称');
    assert.equal(snapshot.logoFileRef, null);
    assert.equal(snapshot.contacts.length, 0);
    assert.equal(snapshot.history.length, 0);
    assert.equal(snapshot.revisionNumber, 1);
    assert.deepEqual(snapshot.updatedAt, NOW);
  });
});

describe('ClubProfile.update 修改留痕（CFG-001 立即生效+历史）', () => {
  it('正常修改：追加历史（含旧值/新值/修改人/onBehalf）且 revisionNumber+1', () => {
    const profile = newProfile();
    const later = new Date('2026-01-02T00:00:00Z');
    const changes = profile.update(
      { displayName: '新名称', intro: '社团简介' },
      { by: 'leader-1', onBehalf: false, now: later },
    );

    const snapshot = profile.toSnapshot();
    assert.equal(snapshot.displayName, '新名称');
    assert.equal(snapshot.revisionNumber, 2);
    assert.equal(snapshot.history.length, 1);
    const entry = snapshot.history[0];
    assert.equal(entry.by, 'leader-1');
    assert.equal(entry.onBehalf, false);
    assert.deepEqual(entry.at, later);
    assert.equal(entry.changes.length, 2);
    assert.deepEqual(
      entry.changes.find((c) => c.field === 'displayName'),
      { field: 'displayName', from: '旧名称', to: '新名称' },
    );
    assert.deepEqual(
      entry.changes.find((c) => c.field === 'intro'),
      { field: 'intro', from: '', to: '社团简介' },
    );
    assert.ok(changes.length === 2);
  });

  it('超管代改：onBehalf=true 落历史', () => {
    const profile = newProfile();
    profile.update({ displayName: '改名' }, { by: 'super-1', onBehalf: true, now: NOW });
    assert.equal(profile.toSnapshot().history[0].onBehalf, true);
  });

  it('空 update：不开新版本、不留痕', () => {
    const profile = newProfile();
    const before = profile.toSnapshot();
    const changes = profile.update({}, { by: 'leader-1', onBehalf: false, now: NOW });
    assert.equal(changes.length, 0);
    assert.deepEqual(profile.toSnapshot(), before);
  });

  it('同值 update 不产生变更', () => {
    const profile = newProfile();
    const changes = profile.update(
      { displayName: '旧名称' },
      { by: 'leader-1', onBehalf: false, now: NOW },
    );
    assert.equal(changes.length, 0);
    assert.equal(profile.revisionNumber, 1);
  });
});

describe('ClubProfile 校验（CFG-001 每个联系方式字段必须选择可见范围）', () => {
  it('displayName 空/纯空白拒绝', () => {
    const profile = newProfile();
    assert.throws(
      () => profile.update({ displayName: '' }, { by: 'x', onBehalf: false, now: NOW }),
      { code: 'CFG_VALIDATION' },
    );
    assert.throws(
      () => profile.update({ displayName: '   ' }, { by: 'x', onBehalf: false, now: NOW }),
      { code: 'CFG_VALIDATION' },
    );
  });

  it('displayName 超 100 字符拒绝', () => {
    const profile = newProfile();
    assert.throws(
      () =>
        profile.update({ displayName: '字'.repeat(101) }, { by: 'x', onBehalf: false, now: NOW }),
      { code: 'CFG_VALIDATION' },
    );
  });

  it('联系方式缺 visibility 拒绝（硬性要求）', () => {
    const profile = newProfile();
    assert.throws(
      () =>
        profile.update(
          {
            contacts: [{ id: 'c1', label: '邮箱', value: 'a@b.c', visibility: undefined as never }],
          },
          { by: 'x', onBehalf: false, now: NOW },
        ),
      { code: 'CFG_VALIDATION' },
    );
  });

  it('visibility 非法值拒绝', () => {
    const profile = newProfile();
    assert.throws(
      () =>
        profile.update(
          {
            contacts: [
              { id: 'c1', label: '邮箱', value: 'a@b.c', visibility: 'EVERYONE' as never },
            ],
          },
          { by: 'x', onBehalf: false, now: NOW },
        ),
      { code: 'CFG_VALIDATION' },
    );
  });

  it('重复 contact.id 拒绝', () => {
    const profile = newProfile();
    assert.throws(
      () =>
        profile.update(
          {
            contacts: [
              { id: 'c1', label: '邮箱', value: 'a@b.c', visibility: 'PUBLIC' },
              { id: 'c1', label: 'QQ', value: '123', visibility: 'MEMBER' },
            ],
          },
          { by: 'x', onBehalf: false, now: NOW },
        ),
      { code: 'CFG_VALIDATION' },
    );
  });

  it('联系方式超 20 个拒绝', () => {
    const profile = newProfile();
    const contacts = Array.from({ length: 21 }, (_, i) => ({
      id: `c${i}`,
      label: `l${i}`,
      value: 'v',
      visibility: 'PUBLIC' as const,
    }));
    assert.throws(() => profile.update({ contacts }, { by: 'x', onBehalf: false, now: NOW }), {
      code: 'CFG_VALIDATION',
    });
  });

  it('合法联系方式更新成功且可见范围保留', () => {
    const profile = newProfile();
    profile.update(
      {
        contacts: [
          { id: 'c1', label: '邮箱', value: 'a@b.c', visibility: 'PUBLIC' },
          { id: 'c2', label: 'QQ群', value: '123456', visibility: 'MEMBER' },
        ],
      },
      { by: 'leader-1', onBehalf: false, now: NOW },
    );
    const snapshot = profile.toSnapshot();
    assert.equal(snapshot.contacts.length, 2);
    assert.equal(snapshot.contacts[0].visibility, 'PUBLIC');
    assert.equal(snapshot.contacts[1].visibility, 'MEMBER');
  });
});

describe('ClubProfile 快照往返', () => {
  it('fromSnapshot(toSnapshot()) 字段全等且后续修改互不影响', () => {
    const profile = newProfile();
    profile.update({ displayName: 'A' }, { by: 'u', onBehalf: false, now: NOW });
    const restored = ClubProfile.fromSnapshot(profile.toSnapshot());
    assert.deepEqual(restored.toSnapshot(), profile.toSnapshot());

    restored.update({ displayName: 'B' }, { by: 'u', onBehalf: false, now: NOW });
    assert.equal(profile.toSnapshot().displayName, 'A');
    assert.equal(restored.toSnapshot().displayName, 'B');
  });
});
