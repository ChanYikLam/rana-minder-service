/**
 * 展示可见范围投影策略单元测试（CFG-001，5.5.1）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ClubProfileSnapshot } from '../models/club-profile';
import {
  projectClubProfile,
  projectPublicView,
  PUBLIC_VIEW_ALLOWED_KEYS,
  type AuthenticatedClubProfileView,
  type MemberClubProfileView,
} from './display-visibility-policy';

const NOW = new Date('2026-01-01T00:00:00Z');

function snapshot(): ClubProfileSnapshot {
  return {
    clubId: 'club-1',
    displayName: '展示名',
    logoFileRef: 'file-1',
    intro: '简介',
    recruitmentNote: '招新说明',
    internalNote: '内部说明',
    contacts: [
      { id: 'c1', label: '邮箱', value: 'a@b.c', visibility: 'PUBLIC' },
      { id: 'c2', label: 'QQ群', value: '123', visibility: 'MEMBER' },
    ],
    history: [],
    revisionNumber: 1,
    updatedBy: null,
    updatedAt: NOW,
  };
}

describe('三级可见范围投影（CFG-001）', () => {
  it('ANONYMOUS：仅名称/Logo/简介/公开招新说明，无任何联系方式与内部说明', () => {
    const view = projectClubProfile(snapshot(), 'ANONYMOUS');
    assert.deepEqual(Object.keys(view).sort(), [
      'clubId',
      'displayName',
      'intro',
      'logoFileRef',
      'recruitmentNote',
    ]);
    assert.ok(!('contacts' in view));
    assert.ok(!('internalNote' in view));
  });

  it('AUTHENTICATED：另见主动公开（PUBLIC）联系方式，不见 MEMBER 联系方式与内部说明', () => {
    const view = projectClubProfile(snapshot(), 'AUTHENTICATED') as AuthenticatedClubProfileView;
    assert.equal(view.contacts.length, 1);
    assert.equal(view.contacts[0].id, 'c1');
    assert.ok(!('internalNote' in view));
  });

  it('MEMBER：全部联系方式+内部说明', () => {
    const view = projectClubProfile(snapshot(), 'MEMBER') as MemberClubProfileView;
    assert.equal(view.contacts.length, 2);
    assert.equal(view.internalNote, '内部说明');
  });
});

describe('公开展示页安全不变量（CFG-001：不得含成员名单/部门关系/职位人员）', () => {
  it('快照中的污染字段（成员名单等）结构性不进入公开视图', () => {
    const polluted = {
      ...snapshot(),
      members: ['m1'],
      departments: [{ id: 'd1' }],
    } as unknown as ClubProfileSnapshot;
    const view = projectPublicView(polluted) as unknown as Record<string, unknown>;
    assert.ok(!('members' in view));
    assert.ok(!('departments' in view));
    assert.deepEqual(Object.keys(view).sort(), [...PUBLIC_VIEW_ALLOWED_KEYS].sort());
  });

  it('公开视图顶层键与允许清单完全一致', () => {
    const view = projectPublicView(snapshot());
    assert.deepEqual(Object.keys(view).sort(), [...PUBLIC_VIEW_ALLOWED_KEYS].sort());
  });
});
