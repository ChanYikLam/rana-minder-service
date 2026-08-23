import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryArchiveRepository } from '../../infrastructure/archive-repository';
import { ArchiveActivityCommand } from './archive-activity.command';
import { ArchiveAccessQuery } from '../queries/archive-access.query';
import { ArchiveAccessPolicy } from '../../domain/services/archive-access-policy';
import { ArchiveKind } from '../../domain/models/archive';

const makeRig = async (
  participants: { clubId: string; enabledAtLock: boolean }[] = [
    { clubId: 'c1', enabledAtLock: true },
    { clubId: 'c2', enabledAtLock: false }, // c2 被紧急停用
  ],
) => {
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

const scopeClub = (clubId: string) => ({ type: 'CLUB' as const, clubId });

describe('5.3.3 归档后的访问（AUD-004）', () => {
  it('自动只读归档：活动完成后归档，原子幂等，只读，参与关系锁定快照', async () => {
    const rig = await makeRig();
    assert.equal(rig.archive.readOnly, true);
    assert.equal(rig.archive.sourceState, 'COMPLETED');
    assert.equal(rig.archive.participants.length, 2);
    // 原子幂等：重复归档返回原记录（不覆盖快照）
    const again = await new ArchiveActivityCommand(rig.repo).execute({
      activityId: 'act-1',
      kind: ArchiveKind.JOINT,
      participants: [{ clubId: 'c1', enabledAtLock: true }],
      sourceState: 'COMPLETED',
    });
    assert.equal(again.version, 1);
    assert.equal(again.participants.length, 2); // 原快照不变
    // 仓储原子：已存在 → 返回原记录（不覆盖快照）
    const existing = await rig.repo.createIfAbsent(rig.archive);
    assert.notEqual(existing, null);
    assert.equal(existing!.participants.length, 2);
  });

  it('评审修复：归档输入校验——空活动 ID/空参与列表拒绝（IFC-ERR-005）', async () => {
    const rig = await makeRig();
    await assert.rejects(
      new ArchiveActivityCommand(rig.repo).execute({
        activityId: '  ',
        kind: ArchiveKind.JOINT,
        participants: [{ clubId: 'c1', enabledAtLock: true }],
        sourceState: 'COMPLETED',
      }),
      /活动 ID 不能为空/,
    );
    await assert.rejects(
      new ArchiveActivityCommand(rig.repo).execute({
        activityId: 'act-2',
        kind: ArchiveKind.JOINT,
        participants: [],
        sourceState: 'COMPLETED',
      }),
      /至少一个参与社团/,
    );
  });

  it('超管：可查看全部归档（ALL），privileged=true（每次特权访问审计）', async () => {
    const rig = await makeRig();
    const result = await rig.query.access({
      activityId: 'act-1',
      context: ctx({ principalId: 'sa', roles: ['SUPER_ADMIN'] }),
      scope: { type: 'ALL' },
    });
    assert.equal(result.decision.allowed, true);
    assert.equal(result.decision.privileged, true);
  });

  it('申请人：仅 SELF 范围；内部评价/纠错/审计拒绝；SELF 只能访问本人记录', async () => {
    const rig = await makeRig();
    // 本人范围（SELF）→ 允许
    const self = await rig.query.access({
      activityId: 'act-1',
      context: ctx({
        principalId: 'stu1',
        roles: ['APPLICANT'],
        isApplicant: true,
        requestedOwnerId: 'stu1',
      }),
      scope: { type: 'SELF' },
      contentKind: 'SELF' as never,
    });
    assert.equal(self.decision.allowed, true);
    // 申请人请求社团范围 → 拒绝
    await assert.rejects(
      rig.query.access({
        activityId: 'act-1',
        context: ctx({ principalId: 'stu1', roles: ['APPLICANT'], isApplicant: true }),
        scope: scopeClub('c1'),
      }),
      /申请人只能访问本人/,
    );
    // 申请人访问内部内容 → 拒绝
    await assert.rejects(
      rig.query.access({
        activityId: 'act-1',
        context: ctx({
          principalId: 'stu1',
          roles: ['APPLICANT'],
          isApplicant: true,
          requestedOwnerId: 'stu1',
        }),
        scope: { type: 'SELF' },
        contentKind: 'INTERNAL' as never,
      }),
      /内部评价/,
    );
    // SELF 但记录归属人非本人 → 拒绝（策略层校验）
    await assert.rejects(
      rig.query.access({
        activityId: 'act-1',
        context: ctx({
          principalId: 'stu1',
          roles: ['APPLICANT'],
          isApplicant: true,
          requestedOwnerId: 'other',
        }),
        scope: { type: 'SELF' },
        contentKind: 'SELF' as never,
      }),
      /只能访问本人的归档记录/,
    );
  });

  it('面试官：结束后失去全部档案访问', async () => {
    const rig = await makeRig();
    await assert.rejects(
      rig.query.access({
        activityId: 'act-1',
        context: ctx({ principalId: 'iv1', roles: ['INTERVIEWER'] }),
        scope: { type: 'ALL' },
      }),
      /面试官结束后/,
    );
  });

  it('现任部门负责人：仅本部门路径（本部门所属社团）；未限定/跨社团/CLUB_HISTORY 拒绝', async () => {
    const rig = await makeRig();
    const ok = await rig.query.access({
      activityId: 'act-1',
      context: ctx({
        principalId: 'd1',
        roles: ['DEPARTMENT_LEADER'],
        departmentId: 'dep-1',
        departmentClubId: 'c1',
      }),
      scope: scopeClub('c1'),
    });
    assert.equal(ok.decision.allowed, true);
    // 未限定社团（ALL）→ 拒绝
    await assert.rejects(
      rig.query.access({
        activityId: 'act-1',
        context: ctx({
          principalId: 'd1',
          roles: ['DEPARTMENT_LEADER'],
          departmentId: 'dep-1',
          departmentClubId: 'c1',
        }),
        scope: { type: 'ALL' },
      }),
      /只能访问本部门路径/,
    );
    // 部门归属社团不匹配（部门属 c2 却请求 c1）→ 拒绝
    await assert.rejects(
      rig.query.access({
        activityId: 'act-1',
        context: ctx({
          principalId: 'd1',
          roles: ['DEPARTMENT_LEADER'],
          departmentId: 'dep-1',
          departmentClubId: 'c2',
        }),
        scope: scopeClub('c1'),
      }),
      /只能访问本部门所属社团/,
    );
    // 部门负责人不得借 CLUB_HISTORY 看全部历史
    await assert.rejects(
      rig.query.access({
        activityId: 'act-1',
        context: ctx({
          principalId: 'd1',
          roles: ['DEPARTMENT_LEADER'],
          departmentId: 'dep-1',
          departmentClubId: 'c1',
        }),
        scope: scopeClub('c1'),
        contentKind: 'CLUB_HISTORY' as never,
      }),
      /仅负责人\/人事可看/,
    );
  });

  it('现任社团负责人/人事：本社团全部历史；跨社团拒绝；停用参与社团停用期间不能查看', async () => {
    const rig = await makeRig();
    // c1（启用）负责人 → 允许
    const ok = await rig.query.access({
      activityId: 'act-1',
      context: ctx({ principalId: 'hr1', roles: ['HR_ADMIN'], clubId: 'c1' }),
      scope: scopeClub('c1'),
    });
    assert.equal(ok.decision.allowed, true);
    // 请求他社团范围（c3 不在参与范围）→ 拒绝
    await assert.rejects(
      rig.query.access({
        activityId: 'act-1',
        context: ctx({ principalId: 'hr1', roles: ['HR_ADMIN'], clubId: 'c1' }),
        scope: scopeClub('c3'),
      }),
      /只能访问本社团历史/,
    );
    // c2 被紧急停用（enabledAtLock=false）→ 停用期间不能查看
    await assert.rejects(
      rig.query.access({
        activityId: 'act-1',
        context: ctx({ principalId: 'hr2', roles: ['HR_ADMIN'], clubId: 'c2' }),
        scope: scopeClub('c2'),
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
        scope: scopeClub('c1'),
      }),
      /当前无归档访问角色/,
    );
  });

  it('联合归档：INTERNAL 仅有权角色可看；负责人访问本人记录（SELF）允许', async () => {
    const rig = await makeRig();
    // c1 负责人看 INTERNAL → 允许
    const internal = await rig.query.access({
      activityId: 'act-1',
      context: ctx({ principalId: 'hr1', roles: ['HR_ADMIN'], clubId: 'c1' }),
      scope: scopeClub('c1'),
      contentKind: 'INTERNAL' as never,
    });
    assert.equal(internal.decision.allowed, true);
    // 负责人访问本人记录（SELF，requestedOwnerId=本人）→ 允许
    const self = await rig.query.access({
      activityId: 'act-1',
      context: ctx({
        principalId: 'hr1',
        roles: ['HR_ADMIN'],
        clubId: 'c1',
        requestedOwnerId: 'hr1',
      }),
      scope: scopeClub('c1'),
      contentKind: 'SELF' as never,
    });
    assert.equal(self.decision.allowed, true);
  });
});
