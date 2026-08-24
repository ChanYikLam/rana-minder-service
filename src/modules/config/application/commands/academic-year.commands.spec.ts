/**
 * 学年与届次命令/查询应用层测试（CFG-003，5.5.3；桩端口）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryAcademicYearBoundaryRepository,
  InMemoryCohortRepository,
  RecordingConfigAudit,
  StubClubMembershipPort,
  StubPolicyAuthorization,
} from '../testing/config-test-support';
import {
  CreateCohortCommand,
  GetCurrentAcademicYearQuery,
  ListCohortsQuery,
  RenameCohortCommand,
  UpdateAcademicYearBoundaryCommand,
} from './academic-year.commands';

const NOW = new Date('2026-05-01T00:00:00Z'); // 2026-05-01 属 '2025-2026' 学年（分界 08-01）
const BOUNDARY_CHANGE_AT = new Date('2027-06-01T00:00:00Z'); // 此时 '2025-2026' 已结束
const CLUB = 'club-1';
const SA = 'super-1';
const LEADER = 'leader-1';

describe('学年自动生成与当前学年解析（CFG-003 自动学年）', () => {
  let repo: InMemoryAcademicYearBoundaryRepository;
  let auth: StubPolicyAuthorization;
  let audit: RecordingConfigAudit;

  beforeEach(() => {
    repo = new InMemoryAcademicYearBoundaryRepository();
    auth = new StubPolicyAuthorization();
    audit = new RecordingConfigAudit();
    auth.platformAllowed = true;
  });

  it('未初始化时按默认分界（08-01，上海）解析当前学年', async () => {
    const query = new GetCurrentAcademicYearQuery(repo);
    const result = await query.execute({ now: NOW });
    assert.equal(result.boundary.timeZone, 'Asia/Shanghai');
    assert.equal(result.current.name, '2025-2026');
  });

  it('非超管调整分界规则拒绝', async () => {
    auth.platformAllowed = false;
    const command = new UpdateAcademicYearBoundaryCommand(repo, auth, audit);
    await assert.rejects(
      () =>
        command.execute({
          subjectId: LEADER,
          now: BOUNDARY_CHANGE_AT,
          month: 9,
          day: 1,
          timeZone: 'Asia/Shanghai',
        }),
      { code: 'CFG_FORBIDDEN' },
    );
  });

  it('超管调整未来分界规则：重新生成当前+未来学年并落库留痕', async () => {
    const command = new UpdateAcademicYearBoundaryCommand(repo, auth, audit);
    const result = await command.execute({
      subjectId: SA,
      now: BOUNDARY_CHANGE_AT,
      month: 9,
      day: 1,
      timeZone: 'Asia/Shanghai',
      generateCount: 4,
    });
    // 2027-06-01 属 '2026-2027'（旧分界 08-01）；新分界 09-01 下仍属 '2026-2027'
    assert.equal(result.current.name, '2026-2027');
    assert.equal(result.generatedYears.length, 4);
    const saved = (await repo.load())!;
    assert.equal(saved.boundary.month, 9);
    assert.equal(saved.lastChangedBy, SA);
    assert.ok(saved.generatedYears.length >= 4);

    // CFG-003 分界规则变更审计接缝
    assert.equal(audit.boundaryChanges.length, 1);
    assert.equal(audit.boundaryChanges[0].by, SA);
  });

  it('历史保护：改写已开始学年起止被拒绝；同规则重复提交幂等成功', async () => {
    const command = new UpdateAcademicYearBoundaryCommand(repo, auth, audit);
    // 2026-09-15：'2026-2027' 已于 08-01 开始
    const midCycle = new Date('2026-09-15T00:00:00Z');
    await command.execute({
      subjectId: SA,
      now: midCycle,
      month: 8,
      day: 1,
      timeZone: 'Asia/Shanghai',
      generateCount: 3,
    });

    // 改为 09-01：'2026-2027' 起点变为 2026-09-01，与已开始学年的落定时刻不一致 → 拒绝
    await assert.rejects(
      () =>
        command.execute({
          subjectId: SA,
          now: midCycle,
          month: 9,
          day: 1,
          timeZone: 'Asia/Shanghai',
        }),
      { code: 'CFG_CONFLICT' },
    );

    // 同规则重复提交：无改写 → 幂等成功（校历未变的合规调整）
    await command.execute({
      subjectId: SA,
      now: midCycle,
      month: 8,
      day: 1,
      timeZone: 'Asia/Shanghai',
      generateCount: 3,
    });
    assert.equal((await repo.load())!.boundary.month, 8);
  });

  it('P1 回归：改名规则致已开始学年与新窗口交叠即拒绝（不得静默丢弃）', async () => {
    const command = new UpdateAcademicYearBoundaryCommand(repo, auth, audit);
    // 2026-05-01：'2025-2026' 已开始（08-01 规则）
    await command.execute({
      subjectId: SA,
      now: NOW,
      month: 8,
      day: 1,
      timeZone: 'Asia/Shanghai',
      generateCount: 3,
    });
    const before = (await repo.load())!.generatedYears.map((y) => y.name);
    assert.ok(before.includes('2025-2026'));

    // 改为 01-01：'2025-2026' 与新窗口 '2026-2027'（2026-01-01 起）区间交叠、
    // 名字不同且已开始——必须拒绝而非静默丢弃
    await assert.rejects(
      () =>
        command.execute({
          subjectId: SA,
          now: NOW,
          month: 1,
          day: 1,
          timeZone: 'Asia/Shanghai',
        }),
      { code: 'CFG_CONFLICT' },
    );
    // 存量完好
    const after = (await repo.load())!.generatedYears.map((y) => y.name);
    assert.deepEqual(after, before);
  });

  it('非法分界日（02-29）拒绝', async () => {
    const command = new UpdateAcademicYearBoundaryCommand(repo, auth, audit);
    await assert.rejects(
      () =>
        command.execute({ subjectId: SA, now: NOW, month: 2, day: 29, timeZone: 'Asia/Shanghai' }),
      { code: 'CFG_VALIDATION' },
    );
  });

  it('非法时区拒绝', async () => {
    const command = new UpdateAcademicYearBoundaryCommand(repo, auth, audit);
    await assert.rejects(
      () => command.execute({ subjectId: SA, now: NOW, month: 8, day: 1, timeZone: 'Not/AZone' }),
      { code: 'CFG_VALIDATION' },
    );
  });
});

describe('社团届次维护（CFG-003 社团届次）', () => {
  let cohorts: InMemoryCohortRepository;
  let boundaryRepo: InMemoryAcademicYearBoundaryRepository;
  let auth: StubPolicyAuthorization;
  let membership: StubClubMembershipPort;

  beforeEach(() => {
    cohorts = new InMemoryCohortRepository();
    boundaryRepo = new InMemoryAcademicYearBoundaryRepository();
    auth = new StubPolicyAuthorization();
    membership = new StubClubMembershipPort();
    auth.clubAllowed = true;
  });

  it('无 club:config:manage 拒绝创建', async () => {
    auth.clubAllowed = false;
    const command = new CreateCohortCommand(cohorts, boundaryRepo, auth);
    await assert.rejects(
      () =>
        command.execute({
          clubId: CLUB,
          subjectId: LEADER,
          now: NOW,
          name: '第35届',
          academicYearName: '2025-2026',
        }),
      { code: 'CFG_FORBIDDEN' },
    );
  });

  it('缺省关联当前学年；名称/关联校验生效', async () => {
    const command = new CreateCohortCommand(cohorts, boundaryRepo, auth);
    const created = await command.execute({
      clubId: CLUB,
      subjectId: LEADER,
      now: NOW,
      name: '第三十五届',
    });
    assert.equal(created.academicYearName, '2025-2026');
    assert.equal(created.revisionNumber, 1);

    // 关联未知学年拒绝
    await assert.rejects(
      () =>
        command.execute({
          clubId: CLUB,
          subjectId: LEADER,
          now: NOW,
          name: '另一届',
          academicYearName: '2099-2100',
        }),
      { code: 'CFG_VALIDATION' },
    );

    // 同社团同学年同名重复拒绝
    await assert.rejects(
      () => command.execute({ clubId: CLUB, subjectId: LEADER, now: NOW, name: '第三十五届' }),
      { code: 'CFG_CONFLICT' },
    );
  });

  it('改名：revisionNumber+1、updatedBy 记录、学年关联不可变；他人社团不可见', async () => {
    const create = new CreateCohortCommand(cohorts, boundaryRepo, auth);
    const rename = new RenameCohortCommand(cohorts, auth);

    const created = await create.execute({
      clubId: CLUB,
      subjectId: LEADER,
      now: NOW,
      name: '旧名',
    });
    const renamed = await rename.execute({
      clubId: CLUB,
      cohortId: created.id,
      subjectId: LEADER,
      now: new Date('2026-06-01T00:00:00Z'),
      newName: '新名',
    });
    assert.equal(renamed.name, '新名');
    assert.equal(renamed.revisionNumber, 2);
    assert.equal(renamed.updatedBy, LEADER);
    assert.equal(renamed.academicYearName, created.academicYearName);

    // 跨社团改名 → 视为不存在（作用域隔离，不泄露对象存在性）
    await assert.rejects(
      () =>
        rename.execute({
          clubId: 'club-other',
          cohortId: created.id,
          subjectId: LEADER,
          now: NOW,
          newName: 'X',
        }),
      { code: 'CFG_NOT_FOUND' },
    );

    const list = await new ListCohortsQuery(cohorts, auth, membership).execute({
      clubId: CLUB,
      subjectId: LEADER,
    });
    assert.equal(list.length, 1);
    assert.equal(list[0].name, '新名');
  });
});

describe('ListCohortsQuery 授权矩阵（评审修复：读接口 fail-closed）', () => {
  it('本社团成员/管理者/超管可见，无关主体拒绝', async () => {
    const cohorts = new InMemoryCohortRepository();
    const boundaryRepo = new InMemoryAcademicYearBoundaryRepository();
    const auth = new StubPolicyAuthorization();
    const membership = new StubClubMembershipPort();
    const create = new CreateCohortCommand(cohorts, boundaryRepo, auth);
    auth.clubAllowed = true;
    await create.execute({
      clubId: CLUB,
      subjectId: LEADER,
      now: NOW,
      name: '第三十六届',
      academicYearName: '2025-2026',
    });

    const query = () => new ListCohortsQuery(cohorts, auth, membership);
    // 无关主体拒绝（先关闭种子用的管理者开关）
    auth.clubAllowed = false;
    await assert.rejects(() => query().execute({ clubId: CLUB, subjectId: 'outsider-1' }), {
      code: 'CFG_FORBIDDEN',
    });
    // 本社团成员可见
    membership.memberIds.add('member-1');
    const asMember = await query().execute({ clubId: CLUB, subjectId: 'member-1' });
    assert.equal(asMember.length, 1);
    // 管理者可见（重新开启 club:config:manage）
    auth.clubAllowed = true;
    const asLeader = await query().execute({ clubId: CLUB, subjectId: LEADER });
    assert.equal(asLeader.length, 1);
    // 平台超管可见
    auth.platformAllowed = true;
    const asSuper = await query().execute({ clubId: CLUB, subjectId: SA });
    assert.equal(asSuper.length, 1);
  });
});
