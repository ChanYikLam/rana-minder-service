/**
 * 更新社团展示资料命令单元测试（CFG-001，5.5.1）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryClubProfileRepository,
  StubConfigAuthorization,
} from '../testing/config-test-support';
import { DefaultUpdateClubProfileCommand } from './update-club-profile.command';

const NOW = new Date('2026-01-01T00:00:00Z');
const CLUB_ID = 'club-1';
const ACTOR = 'leader-1';

describe('更新社团展示资料命令（CFG-001）', () => {
  let repo: InMemoryClubProfileRepository;
  let auth: StubConfigAuthorization;
  let command: DefaultUpdateClubProfileCommand;

  beforeEach(() => {
    repo = new InMemoryClubProfileRepository();
    auth = new StubConfigAuthorization();
    command = new DefaultUpdateClubProfileCommand(repo, auth);
  });

  it('无权拒绝：授权身份 null → CFG_FORBIDDEN（fail-closed 默认）', async () => {
    await assert.rejects(
      () =>
        command.execute({ clubId: CLUB_ID, actor: ACTOR, now: NOW, patch: { displayName: 'X' } }),
      { code: 'CFG_FORBIDDEN' },
    );
  });

  it('OWNER 修改：立即生效+历史 onBehalf=false+revisionNumber+1', async () => {
    auth.manageRole = 'OWNER';
    const result = await command.execute({
      clubId: CLUB_ID,
      actor: ACTOR,
      now: NOW,
      patch: { displayName: '新名' },
    });

    assert.equal(result.profile.displayName, '新名');
    assert.equal(result.profile.revisionNumber, 2);
    assert.equal(result.profile.history[0].onBehalf, false);
    assert.deepEqual(result.savedAt, NOW);

    const stored = await repo.load(CLUB_ID);
    assert.equal(stored?.displayName, '新名');
  });

  it('PLATFORM 超管代改：onBehalf=true 落历史', async () => {
    auth.manageRole = 'PLATFORM';
    const result = await command.execute({
      clubId: CLUB_ID,
      actor: 'super-1',
      now: NOW,
      patch: { displayName: '代改名' },
    });
    assert.equal(result.profile.history[0].by, 'super-1');
    assert.equal(result.profile.history[0].onBehalf, true);
  });

  it('expectedVersion 不匹配 → CFG_VERSION_CONFLICT（乐观锁）', async () => {
    auth.manageRole = 'OWNER';
    await command.execute({
      clubId: CLUB_ID,
      actor: ACTOR,
      now: NOW,
      patch: { displayName: '第一版' },
    });
    await assert.rejects(
      () =>
        command.execute({
          clubId: CLUB_ID,
          actor: ACTOR,
          now: NOW,
          expectedVersion: 1,
          patch: { displayName: '第二版' },
        }),
      { code: 'CFG_VERSION_CONFLICT' },
    );
  });

  it('expectedVersion 匹配时正常通过', async () => {
    auth.manageRole = 'OWNER';
    const first = await command.execute({
      clubId: CLUB_ID,
      actor: ACTOR,
      now: NOW,
      patch: { displayName: '第一版' },
    });
    const second = await command.execute({
      clubId: CLUB_ID,
      actor: ACTOR,
      now: NOW,
      expectedVersion: first.profile.revisionNumber,
      patch: { displayName: '第二版' },
    });
    assert.equal(second.profile.displayName, '第二版');
  });

  it('资料不存在时自动初始化默认资料再修改', async () => {
    auth.manageRole = 'OWNER';
    const result = await command.execute({
      clubId: CLUB_ID,
      actor: ACTOR,
      now: NOW,
      patch: { intro: '首个简介' },
    });
    assert.equal(result.profile.clubId, CLUB_ID);
    assert.equal(result.profile.intro, '首个简介');
    assert.ok(await repo.load(CLUB_ID));
  });

  it('空 patch：不开新版本、不落库', async () => {
    auth.manageRole = 'OWNER';
    const before = await repo.load(CLUB_ID);
    const result = await command.execute({
      clubId: CLUB_ID,
      actor: ACTOR,
      now: NOW,
      patch: {},
    });
    assert.equal(result.profile.revisionNumber, before?.revisionNumber ?? 1);
    assert.deepEqual(await repo.load(CLUB_ID), before);
  });
});
