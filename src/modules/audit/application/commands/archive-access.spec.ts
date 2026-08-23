import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryArchiveRepository } from '../../infrastructure/archive-repository';
import { ArchiveActivityCommand } from './archive-activity.command';
import { ArchiveAccessQuery } from '../queries/archive-access.query';
import { ArchiveAccessPolicy } from '../../domain/services/archive-access-policy';
import { ArchiveKind } from '../../domain/models/archive';
import type { ArchiveRecord } from '../../domain/models/archive';

const makeRig = async (participants: { clubId: string; enabledAtLock: boolean }[] = [
  { clubId: 'c1', enabledAtLock: true },
  { clubId: 'c2', enabledAtLock: false }, // c2 被紧急停用
]) => {
  const repo = new InMemoryArchiveRepository();
  const policy = new ArchiveAccessPolicy();
  const command = new ArchiveActivityCommand(repo);
  const query = new ArchiveAccessQuery(repo, policy);
  const archive = await command.execute({
    activityId: 'act-1',
    kind: ArchiveKind.JOINT,
    participants,
    sourceState: 'COMPLETED',
  });
  return { repo, query, archive };
};

const ctx = (overrides: Record<string, unknown>) => ({
  principalId: 'p1',
  roles: [],
  ...overrides,
});

describe('5.3.3 归档后的访问（AUD-004）', () => {
  it('自动只读归档：活动完成后归档，幂等，只读，参与关系锁定快照', async () => {
    const rig = await makeRig();
    assert.equal(rig.archive.readOnly, true);
    assert.equal(rig.archive.sourceState, 'COMPLETED');
    assert.equal(rig.archive.participants.length, 2);
    // 幂等：重复归档返回原记录
    const again = await new ArchiveActivityCommand(rig.repo).execute({
      activityId: 'act-1',
      kind: ArchiveKind.JOINT,
      participants: [{ clubId: 'c1', enabledAtLock: true }],
      sourceState: 'COMPLETED',
    });
    assert.equal(again.version, 1);
    assert.equal(again.participants.length, 2); // 原快照不变
  });

  it('超管：可查看全部归档，privileged=true（每次特权访问审计）', async () => {
    const rig = await makeRig();
    const result = await rig.query.access({
      activityId: 'act-1',
      context: ctx({ principalId: 'sa', roles: ['SUPER_ADMIN'] }),
      requesterClubId: null,
    });
    assert.equal(result.decision.allowed, true);
    assert.equal(result.decision.privileged, true);
  });

  it('申请人：只看自己范围；内部评价/纠错/审计拒绝', async () => {
    const rig = await makeRig();
    // 本人范围（requesterClubId=null 且 isApplicant）→ 允许
    const self = await rig.query.access({
      activityId: 'act-1',
      context: ctx({ principalId: 'stu1', roles: ['APPLICANT'], isApplicant: true }),
      requesterClubId: null,
      contentKind: 'SELF' as never,
    });
    assert.equal(self.decision.allowed, true);
    // 申请人访问内部内容 → 拒绝
    await assert.rejects(
      rig.query.access({
        activityId: 'act-1',
        context: ctx({ principalId: 'stu1', roles: ['APPLICANT'], isApplicant: true }),
        requesterClubId: null,
        contentKind: 'INTERNAL' as never,
      }),
      /内部评价/,
    );
  });

  it('面试官：结束后失去全部档案访问', async () => {
    const rig = await makeRig();
    await assert.rejects(
      rig.query.access({
        activityId: 'act-1',
        context: ctx({ principalId: 'iv1', roles: ['INTERVIEWER'] }),
        requesterClubId: null,
      }),
      /面试官结束后/,
    );
  });

  it('现任部门负责人：仅本部门路径；未限定范围/缺部门 → 拒绝', async () => {
    const rig = await makeRig();
    const ok = await rig.query.access({
      activityId: 'act-1',
      context: ctx({ principalId: 'd1', roles: ['DEPARTMENT_LEADER'], departmentId: 'dep-1' }),
      requesterClubId: 'c1',
    });
    assert.equal(ok.decision.allowed, true);
    // 未限定社团范围 → 拒绝
    await assert.rejects(
      rig.query.access({
        activityId: 'act-1',
        context: ctx({ principalId: 'd1', roles: ['DEPARTMENT_LEADER'], departmentId: 'dep-1' }),
        requesterClubId: null,
      }),
      /只能访问本部门路径/,
    );
  });

  it('现任社团负责人/人事：本社团全部历史；跨社团拒绝；停用参与社团停用期间不能查看', async () => {
    const rig = await makeRig();
    // c1（启用）负责人 → 允许
    const ok = await rig.query.access({
      activityId: 'act-1',
      context: ctx({ principalId: 'hr1', roles: ['HR_ADMIN'], clubId: 'c1' }),
      requesterClubId: 'c1',
    });
    assert.equal(ok.decision.allowed, true);
    // c3 不在参与范围 → 拒绝
    await assert.rejects(
      rig.query.access({
        activityId: 'act-1',
        context: ctx({ principalId: 'hr3', roles: ['HR_ADMIN'], clubId: 'c3' }),
        requesterClubId: 'c3',
      }),
      /不在该归档参与范围/,
    );
    // c2 被紧急停用（enabledAtLock=false）→ 停用期间不能查看
    await assert.rejects(
      rig.query.access({
        activityId: 'act-1',
        context: ctx({ principalId: 'hr2', roles: ['HR_ADMIN'], clubId: 'c2' }),
        requesterClubId: 'c2',
      }),
      /停用期间不能查看/,
    );
  });

  it('历史负责人/离任成员：不保留访问权（按当前角色重新鉴权）', async () => {
    const rig = await makeRig();
    await assert.rejects(
      rig.query.access({
        activityId: 'act-1',
        context: ctx({ principalId: 'ex-leader', roles: ['MEMBER'] }), // 已离任，仅普通成员角色
        requesterClubId: 'c1',
      }),
      /当前无归档访问角色/,
    );
  });

  it('联合归档：按首次公布锁定参与关系与启用状态；INTERNAL 仅有权角色可看', async () => {
    const rig = await makeRig();
    // c1 负责人看 INTERNAL → 允许
    const internal = await rig.query.access({
      activityId: 'act-1',
      context: ctx({ principalId: 'hr1', roles: ['HR_ADMIN'], clubId: 'c1' }),
      requesterClubId: 'c1',
      contentKind: 'INTERNAL' as never,
    });
    assert.equal(internal.decision.allowed, true);
  });

  it('审查修复：部门负责人兼面试官 → 按部门负责人放行（面试官拒绝不误伤）', async () => {
    const rig = await makeRig();
    const ok = await rig.query.access({
      activityId: 'act-1',
      context: ctx({
        principalId: 'd1',
        roles: ['DEPARTMENT_LEADER', 'INTERVIEWER'],
        departmentId: 'dep-1',
      }),
      requesterClubId: 'c1',
    });
    assert.equal(ok.decision.allowed, true);
  });

  it('审查修复：负责人访问本人记录（SELF）→ 允许（本人记录不限角色）', async () => {
    const rig = await makeRig();
    const ok = await rig.query.access({
      activityId: 'act-1',
      context: ctx({ principalId: 'hr1', roles: ['HR_ADMIN'], clubId: 'c1' }),
      requesterClubId: 'c1',
      contentKind: 'SELF' as never,
    });
    assert.equal(ok.decision.allowed, true);
  });

  it('评审修复：部门负责人不得借 CLUB_HISTORY 看本社团全部历史（仅负责人/人事）', async () => {
    const rig = await makeRig();
    await assert.rejects(
      rig.query.access({
        activityId: 'act-1',
        context: ctx({
          principalId: 'd1',
          roles: ['DEPARTMENT_LEADER'],
          departmentId: 'dep-1',
          departmentClubId: 'c1',
        }),
        requesterClubId: 'c1',
        contentKind: 'CLUB_HISTORY' as never,
      }),
      /仅负责人\/人事可看/,
    );
  });

  it('评审修复：部门负责人跨社团访问（部门归属社团不匹配）→ 拒绝', async () => {
    const rig = await makeRig();
    await assert.rejects(
      rig.query.access({
        activityId: 'act-1',
        context: ctx({
          principalId: 'd1',
          roles: ['DEPARTMENT_LEADER'],
          departmentId: 'dep-1',
          departmentClubId: 'c2', // 部门属于 c2，却请求 c1 归档
        }),
        requesterClubId: 'c1',
      }),
      /只能访问本部门所属社团/,
    );
  });
});
