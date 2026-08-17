import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClubDirectoryRule } from './find-club';
import { ActivityDirectoryRule } from './find-activity';
import type { AuthoritativeSnapshot } from '../../contracts';

const clubScope = { kind: 'CLUB', clubId: 'c1' } as const;

const snapshot = (objectType: 'CLUB' | 'ACTIVITY', view: unknown): AuthoritativeSnapshot => ({
  objectType,
  objectId: 'id-1',
  version: 2,
  scope: clubScope as never,
  view,
  changedAt: '2026-08-17T00:00:00.000Z',
});

describe('ClubDirectoryRule（C6.1 找社团）', () => {
  const rule = new ClubDirectoryRule();

  it('发布且通道开放 → 生成条目', () => {
    const items = rule.derive(
      snapshot('CLUB', {
        objectType: 'CLUB',
        displayName: '篮球社',
        summary: '打篮球',
        published: true,
        channelOpen: true,
        paused: false,
        terminated: false,
      }),
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].name, '篮球社');
    assert.equal(items[0].objectType, 'CLUB');
  });

  it('未发布/暂停/终态/通道关闭 → 不进入公开结果（C6.8）', () => {
    assert.equal(
      rule.derive(snapshot('CLUB', { objectType: 'CLUB', displayName: 'x', published: false, channelOpen: true, paused: false, terminated: false })).length,
      0,
    );
    assert.equal(
      rule.derive(snapshot('CLUB', { objectType: 'CLUB', displayName: 'x', published: true, channelOpen: true, paused: true, terminated: false })).length,
      0,
    );
    assert.equal(
      rule.derive(snapshot('CLUB', { objectType: 'CLUB', displayName: 'x', published: true, channelOpen: false, paused: false, terminated: false })).length,
      0,
    );
  });

  it('非 CLUB 快照 → 空', () => {
    assert.equal(
      rule.derive(snapshot('ACTIVITY', { objectType: 'ACTIVITY', displayName: 'x', published: true, channelOpen: true, paused: false, terminated: false })).length,
      0,
    );
  });
});

describe('ActivityDirectoryRule（C6.2 找活动）', () => {
  const rule = new ActivityDirectoryRule();

  it('发布且通道开放 → 生成条目（含活动类型与截止）', () => {
    const items = rule.derive(
      snapshot('ACTIVITY', {
        objectType: 'ACTIVITY',
        displayName: '联合招新会',
        summary: 's',
        deadlineAt: '2026-08-20T10:00:00Z',
        activityType: 'JOINT_ACTIVITY',
        published: true,
        channelOpen: true,
        paused: false,
        terminated: false,
      }),
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].activityType, 'JOINT_ACTIVITY');
    assert.equal(items[0].deadlineAt, '2026-08-20T10:00:00Z');
  });

  it('首次公布为空字符串的联合活动 → 不进入公开结果（C6.8）', () => {
    assert.equal(
      rule.derive(
        snapshot('ACTIVITY', {
          objectType: 'ACTIVITY',
          displayName: 'x',
          firstPublishedAt: '',
          published: true,
          channelOpen: true,
          paused: false,
          terminated: false,
        }),
      ).length,
      0,
    );
  });

  it('未提供 firstPublishedAt（普通招新）→ 发布后即可进入（C6.8）', () => {
    const items = rule.derive(
      snapshot('ACTIVITY', {
        objectType: 'ACTIVITY',
        displayName: '普通招新',
        published: true,
        channelOpen: true,
        paused: false,
        terminated: false,
      }),
    );
    assert.equal(items.length, 1);
  });
});
