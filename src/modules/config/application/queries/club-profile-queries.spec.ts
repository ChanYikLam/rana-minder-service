/**
 * 展示资料查询单元测试（CFG-001，5.5.1）：公开投影三档作用域 + 管理端视图。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryClubProfileRepository,
  StubClubAccessInfoPort,
  StubClubMembershipPort,
  StubConfigAuthorization,
} from '../testing/config-test-support';
import { ClubProfile } from '../../domain/models/club-profile';
import type { ClubProfileSnapshot } from '../../domain/models/club-profile';
import { DefaultGetPublicClubProfileQuery } from './get-public-club-profile.query';
import { DefaultGetClubProfileQuery } from './get-club-profile.query';

const NOW = new Date('2026-01-01T00:00:00Z');
const CLUB_ID = 'club-1';

function seedSnapshot(): ClubProfileSnapshot {
  const profile = ClubProfile.createDefault({ clubId: CLUB_ID, clubName: '旧名', now: NOW });
  profile.update(
    {
      intro: '简介',
      internalNote: '内部说明',
      contacts: [
        { id: 'c1', label: '邮箱', value: 'a@b.c', visibility: 'PUBLIC' },
        { id: 'c2', label: 'QQ群', value: '123', visibility: 'MEMBER' },
      ],
    },
    { by: 'leader-1', onBehalf: false, now: NOW },
  );
  return profile.toSnapshot();
}

describe('公开展示资料查询（CFG-001 三级可见范围）', () => {
  let repo: InMemoryClubProfileRepository;
  let membership: StubClubMembershipPort;
  let query: DefaultGetPublicClubProfileQuery;

  beforeEach(() => {
    repo = new InMemoryClubProfileRepository();
    membership = new StubClubMembershipPort();
    query = new DefaultGetPublicClubProfileQuery(repo, membership);
  });

  it('未登录（viewerSubjectId=null）→ ANONYMOUS 投影：无任何联系方式', async () => {
    await repo.save(seedSnapshot());
    const view = await query.execute({ clubId: CLUB_ID, viewerSubjectId: null });
    assert.ok(!('contacts' in view));
    assert.equal(view.intro, '简介');
  });

  it('有效登录非成员 → AUTHENTICATED：仅 PUBLIC 联系方式', async () => {
    await repo.save(seedSnapshot());
    const view = await query.execute({ clubId: CLUB_ID, viewerSubjectId: 'student-1' });
    assert.ok('contacts' in view);
    assert.equal(view.contacts.length, 1);
    assert.equal(view.contacts[0].visibility, 'PUBLIC');
  });

  it('本社团成员 → MEMBER：全部联系方式+内部说明', async () => {
    await repo.save(seedSnapshot());
    membership.memberIds.add('member-1');
    const view = await query.execute({ clubId: CLUB_ID, viewerSubjectId: 'member-1' });
    assert.ok('contacts' in view);
    assert.equal(view.contacts.length, 2);
    assert.ok('internalNote' in view && view.internalNote === '内部说明');
  });

  it('资料不存在 → CFG_NOT_FOUND（公开端点不自动初始化）', async () => {
    await assert.rejects(() => query.execute({ clubId: 'ghost', viewerSubjectId: null }), {
      code: 'CFG_NOT_FOUND',
    });
  });
});

describe('管理端展示资料查询（CFG-001）', () => {
  let repo: InMemoryClubProfileRepository;
  let auth: StubConfigAuthorization;
  let accessInfo: StubClubAccessInfoPort;
  let query: DefaultGetClubProfileQuery;

  beforeEach(() => {
    repo = new InMemoryClubProfileRepository();
    auth = new StubConfigAuthorization();
    accessInfo = new StubClubAccessInfoPort();
    query = new DefaultGetClubProfileQuery(repo, auth, accessInfo);
  });

  it('无权拒绝 → CFG_FORBIDDEN', async () => {
    await assert.rejects(() => query.execute({ clubId: CLUB_ID, actor: 'x' }), {
      code: 'CFG_FORBIDDEN',
    });
  });

  it('有权返回完整快照+accessInfo 回显（展示名↔Group 名对应关系）', async () => {
    await repo.save(seedSnapshot());
    auth.manageRole = 'PLATFORM';
    accessInfo.info = { casdoorGroupId: 'g-1', casdoorGroupName: 'grp-old-name' };
    const result = await query.execute({ clubId: CLUB_ID, actor: 'super-1' });
    assert.equal(result.profile.history.length, 1);
    assert.deepEqual(result.accessInfo, {
      casdoorGroupId: 'g-1',
      casdoorGroupName: 'grp-old-name',
    });
  });

  it('接入信息未接线时 accessInfo 为 null', async () => {
    await repo.save(seedSnapshot());
    auth.manageRole = 'OWNER';
    const result = await query.execute({ clubId: CLUB_ID, actor: 'leader-1' });
    assert.equal(result.accessInfo, null);
  });

  it('不存在时自动初始化默认资料并保存（后台首屏配置场景）', async () => {
    auth.manageRole = 'OWNER';
    const result = await query.execute({ clubId: CLUB_ID, actor: 'leader-1' });
    assert.equal(result.profile.revisionNumber, 1);
    assert.ok(await repo.load(CLUB_ID));
  });
});
