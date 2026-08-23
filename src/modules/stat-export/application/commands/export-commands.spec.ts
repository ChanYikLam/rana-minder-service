/**
 * 导出命令与权限单测（5.4.2，覆盖 P1/P2/P3/P4 验收点）。
 *
 * 验收点覆盖：
 * - P1：5 类导出者端口解析 + 权限收敛（interviewer 禁批量、member 仅个人副本）；
 * - P2：申请幂等回放、快照冻结、越权/停用/联合失效拒绝（IFC-ERR-002/003/004/005/006/009/011/015）；
 * - P3：失败重试沿用原快照、非失败/非申请方/版本竞争拒绝（IFC-ERR-002/007/008）；
 * - P4：提前删除仅本人/授权者、正式删除清单联动失效（AUD-009）、参与社团停用失效（JNT-023）；
 * - JNT-023：联合导出仅限参与社团负责人/人事，快照含来源标注；紧急停用后不能新建/下载、
 *   已有未过期链接立即失效。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { StatisticsSpecification } from '../../domain/models/statistics-specification';
import { ExportTaskAggregate } from '../../domain/models/export-task';
import { ExportTaskStatus } from '../../domain/state-machines/export-task.state-machine';
import { ExportError } from '../errors';
import { platformSuperAdminPrincipal, clubLeaderPrincipal } from '../export-authorization.policy';
import type { ExportPrincipal } from '../ports/export-authorization.port';
import {
  MemoryExportAuthorizationPort,
  InMemoryExportAuditPort,
  MemoryExportSafetySwitchPort,
  MemoryExportReauthPort,
  type MemoryExportAuthorizationSeed,
} from '../../infrastructure/memory-export-access';
import { InMemoryExportFactSource } from '../../infrastructure/in-memory-export-fact-source';
import { InMemoryExportTaskRepository } from '../../infrastructure/in-memory-export-repository';
import { InMemoryExportIdempotency } from '../../infrastructure/in-memory-export-idempotency';
import type { ExportApplyIdempotencyPort } from '../ports/export-idempotency.port';
import { ExportApplyCommand, applyIdempotencyHash } from './export-apply.command';
import { ExportRetryCommand } from './export-retry.command';
import { ExportDeleteCommand } from './export-delete.command';
import type { ExportTaskRepository } from '../ports/export-repository.port';

const SPEC = new StatisticsSpecification();

interface Harness {
  authz: MemoryExportAuthorizationPort;
  audit: InMemoryExportAuditPort;
  facts: InMemoryExportFactSource;
  repo: InMemoryExportTaskRepository;
  idem: InMemoryExportIdempotency;
  apply: ExportApplyCommand;
  retry: ExportRetryCommand;
  del: ExportDeleteCommand;
  safety: MemoryExportSafetySwitchPort;
  reauth: MemoryExportReauthPort;
}

function makeHarness(seed: MemoryExportAuthorizationSeed): Harness {
  const authz = new MemoryExportAuthorizationPort(seed);
  const audit = new InMemoryExportAuditPort();
  const facts = new InMemoryExportFactSource();
  const repo = new InMemoryExportTaskRepository();
  const idem = new InMemoryExportIdempotency();
  const safety = new MemoryExportSafetySwitchPort();
  const reauth = new MemoryExportReauthPort();
  const apply = new ExportApplyCommand(SPEC, authz, audit, safety, reauth, facts, repo, idem);
  const retry = new ExportRetryCommand(safety, audit, repo, facts, reauth);
  const del = new ExportDeleteCommand(safety, audit, repo);
  return { authz, audit, facts, repo, idem, apply, retry, del, safety, reauth };
}

function makeHarnessWithRepo(
  seed: MemoryExportAuthorizationSeed,
  repo: ExportTaskRepository,
): Harness {
  const authz = new MemoryExportAuthorizationPort(seed);
  const audit = new InMemoryExportAuditPort();
  const facts = new InMemoryExportFactSource();
  const idem = new InMemoryExportIdempotency();
  const safety = new MemoryExportSafetySwitchPort();
  const reauth = new MemoryExportReauthPort();
  const apply = new ExportApplyCommand(SPEC, authz, audit, safety, reauth, facts, repo, idem);
  const retry = new ExportRetryCommand(safety, audit, repo, facts, reauth);
  const del = new ExportDeleteCommand(safety, audit, repo);
  return {
    authz,
    audit,
    facts,
    repo: repo as InMemoryExportTaskRepository,
    idem,
    apply,
    retry,
    del,
    safety,
    reauth,
  };
}

const memberPrincipal: ExportPrincipal = {
  userId: 'member-1',
  kind: 'member_applicant',
  clubScopes: [],
};
const interviewerPrincipal: ExportPrincipal = {
  userId: 'iv-1',
  kind: 'interviewer',
  clubScopes: [],
};

/** 将一个已 apply 的任务推进到可下载并落库 */
async function makeDownloadable(
  h: Harness,
  task: ExportTaskAggregate,
): Promise<ExportTaskAggregate> {
  task.claimGeneration('worker-1', 60 * 1000, new Date());
  task.markGenerationSucceeded({
    fileRef: 'fs://exp/1',
    fileHash: 'abc123',
    fileSize: 42,
    now: new Date(),
  });
  await h.repo.save(task);
  return task;
}

// ---------------------------------------------------------------------------
// P1 授权端口与权限收敛
// ---------------------------------------------------------------------------

describe('P1 授权端口与权限收敛', () => {
  it('5 类导出者分类解析正确', async () => {
    const authz = new MemoryExportAuthorizationPort({
      superAdminUserIds: ['super'],
      kinds: { iv: 'interviewer', dep: 'department_leader', hr: 'club_leader_hr' },
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    assert.equal((await authz.resolveExportPrincipal('super')).kind, 'platform_super_admin');
    assert.equal((await authz.resolveExportPrincipal('iv')).kind, 'interviewer');
    assert.equal((await authz.resolveExportPrincipal('dep')).kind, 'department_leader');
    assert.equal((await authz.resolveExportPrincipal('hr')).kind, 'club_leader_hr');
    assert.equal((await authz.resolveExportPrincipal('bob')).kind, 'member_applicant');
  });

  it('普通面试官请求批量导出被拒（EXP-003，IFC-ERR-003）', async () => {
    const h = makeHarness({});
    await assert.rejects(
      h.apply.execute({
        principal: interviewerPrincipal,
        request: { kind: 'club', clubId: 'C1' },
      }),
      (e: ExportError) => e.code === 'IFC-ERR-003',
    );
  });

  it('普通成员/申请人请求批量导出被拒（EXP-003，IFC-ERR-003）', async () => {
    const h = makeHarness({});
    await assert.rejects(
      h.apply.execute({ principal: memberPrincipal, request: { kind: 'club', clubId: 'C1' } }),
      (e: ExportError) => e.code === 'IFC-ERR-003',
    );
  });

  it('部门负责人导出本社团被拒（IFC-ERR-004）', async () => {
    const h = makeHarness({
      kinds: { dep: 'department_leader' },
      clubScopes: {
        dep: [{ clubId: 'C1', level: 'department', departmentIds: ['D1'] }],
      },
    });
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    await assert.rejects(
      h.apply.execute({
        principal: {
          userId: 'dep',
          kind: 'department_leader',
          clubScopes: [{ clubId: 'C1', level: 'department', departmentIds: ['D1'] }],
        },
        request: { kind: 'club', clubId: 'C1' },
      }),
      (e: ExportError) => e.code === 'IFC-ERR-004',
    );
  });

  it('普通成员仅可导出本人个人副本（target=他人 → IFC-ERR-003）', async () => {
    const h = makeHarness({});
    await assert.rejects(
      h.apply.execute({
        principal: memberPrincipal,
        request: { kind: 'personal', targetUserId: 'other' },
      }),
      (e: ExportError) => e.code === 'IFC-ERR-003',
    );
  });
});

// ---------------------------------------------------------------------------
// P2 导出申请（幂等/快照/越权/停用/联合失效）
// ---------------------------------------------------------------------------

describe('P2 导出申请（幂等/快照/越权/停用/联合失效）', () => {
  it('社团负责人可申请本社团导出，快照冻结默认全字段', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    const res = await h.apply.execute({
      principal: clubLeaderPrincipal('hr', 'C1'),
      request: { kind: 'club', clubId: 'C1' },
    });
    assert.equal(res.task.status, ExportTaskStatus.PENDING_GENERATION);
    assert.equal(res.task.snapshot.data.scope.clubId, 'C1');
    assert.ok(res.task.snapshot.data.datasets.length > 0);
  });

  it('批量导出 includeFiles=true → 显式拒绝（IFC-ERR-005）', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    await assert.rejects(
      h.apply.execute({
        principal: clubLeaderPrincipal('hr', 'C1'),
        request: { kind: 'club', clubId: 'C1', includeFiles: true },
      }),
      (e: ExportError) => e.code === 'IFC-ERR-005',
    );
  });

  it('申请幂等：同 key 语义一致 → 回放同一任务', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    const input = {
      principal: clubLeaderPrincipal('hr', 'C1'),
      idempotencyKey: 'k1',
      request: { kind: 'club' as const, clubId: 'C1' },
    };
    const a = await h.apply.execute(input);
    const b = await h.apply.execute(input);
    assert.equal(a.replayed, false);
    assert.equal(b.replayed, true);
    assert.equal(a.task.id, b.task.id);
    // 首次创建 + 回放均须留 export_apply 审计
    const applyAudits = h.audit.findBy('export_apply');
    assert.equal(applyAudits.length, 2);
    assert.equal(applyAudits[1].exportId, a.task.id);
  });

  it('申请幂等：同 key 语义不一致 → 冲突（IFC-ERR-009）', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    const base = { principal: clubLeaderPrincipal('hr', 'C1'), idempotencyKey: 'k1' };
    await h.apply.execute({ ...base, request: { kind: 'club', clubId: 'C1' } });
    await assert.rejects(
      h.apply.execute({ ...base, request: { kind: 'club', clubId: 'C2' } }),
      (e: ExportError) => e.code === 'IFC-ERR-009',
    );
  });

  it('申请幂等：回放恢复 rejectedFields（越权字段剔除清单与首次一致）', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    const input = {
      principal: clubLeaderPrincipal('hr', 'C1'),
      idempotencyKey: 'k-rejected',
      request: {
        kind: 'club' as const,
        clubId: 'C1',
        datasets: ['club_summary'] as const,
        // phone 属 NEVER_EXPORT（EXP-002），首次创建即被剔除
        fields: { club_summary: ['memberCount', 'phone'] },
      },
    };
    const a = await h.apply.execute(input);
    const b = await h.apply.execute(input);
    assert.equal(a.replayed, false);
    assert.equal(b.replayed, true);
    // 回放应恢复与首次创建一致的越权字段剔除清单
    assert.deepEqual(b.rejectedFields, a.rejectedFields);
    assert.ok(b.rejectedFields.includes('phone'));
  });

  it('申请幂等：落库失败时回滚幂等槽位，避免槽位毒化', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    // 包装仓储：首次 save 抛非版本冲突的持久化异常
    let failedOnce = false;
    const failingRepo = Object.assign(Object.create(h.repo), {
      save: (agg: ExportTaskAggregate, opts?: { expectedRevision?: number }) => {
        if (!failedOnce) {
          failedOnce = true;
          return Promise.reject(new Error('disk full'));
        }
        return h.repo.save(agg, opts);
      },
    }) as InMemoryExportTaskRepository;
    const apply = new ExportApplyCommand(
      SPEC,
      h.authz,
      h.audit,
      h.safety,
      h.reauth,
      h.facts,
      failingRepo,
      h.idem,
    );
    const input = {
      principal: clubLeaderPrincipal('hr', 'C1'),
      idempotencyKey: 'k-poison',
      request: { kind: 'club' as const, clubId: 'C1' },
    };
    // 首次落库失败 → 应抛出，且幂等槽位被回滚
    await assert.rejects(apply.execute(input), /disk full/);
    assert.equal(await h.idem.taskIdForKey('k-poison'), null);
    // 再次申请同 key 应能正常创建（不命中毒化槽位）
    const ok = await apply.execute(input);
    assert.equal(ok.replayed, false);
  });

  it('申请幂等：replayed 命中但任务未落库 → 抛清晰状态冲突（不永久毒化/不回放幽灵任务）', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    // 模拟瞬态竞态：幂等槽位已被领取（claim=replayed）但任务尚未/未能落库（仓库中不存在）。
    // 并发下"幂等槽位领取 + 任务落库"非同一事务时可能出现该窗口（评审 warning#2）；
    // 当前实现对"回放命中但任务不存在"抛清晰 IFC-ERR-007，避免静默返回幽灵任务或永久毒化。
    const ghostIdem: ExportApplyIdempotencyPort = {
      async claim() {
        return { status: 'replayed', taskId: 'ghost-task-not-in-repo' };
      },
      async taskIdForKey() {
        return 'ghost-task-not-in-repo';
      },
      async hashForKey() {
        return null;
      },
      async release() {
        /* 无槽位变更 */
      },
    };
    const apply = new ExportApplyCommand(
      SPEC,
      h.authz,
      h.audit,
      h.safety,
      h.reauth,
      h.facts,
      h.repo,
      ghostIdem,
    );
    await assert.rejects(
      apply.execute({
        principal: clubLeaderPrincipal('hr', 'C1'),
        idempotencyKey: 'k-ghost',
        request: { kind: 'club' as const, clubId: 'C1' },
      }),
      (e: ExportError) =>
        e.code === 'IFC-ERR-007' && e.message.includes('幂等命中但任务不存在'),
    );
  });

  it('社团强制停用 → 拒绝新建导出（JNT-023，IFC-ERR-006）', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: true });
    await assert.rejects(
      h.apply.execute({
        principal: clubLeaderPrincipal('hr', 'C1'),
        request: { kind: 'club', clubId: 'C1' },
      }),
      (e: ExportError) => e.code === 'IFC-ERR-006',
    );
  });

  it('安全开关关闭 → 拒绝申请（GOV-004，IFC-ERR-011）', async () => {
    const h = makeHarness({});
    h.safety.setAllowed(false);
    await assert.rejects(
      h.apply.execute({
        principal: interviewerPrincipal,
        request: { kind: 'club', clubId: 'C1' },
      }),
      (e: ExportError) => e.code === 'IFC-ERR-011',
    );
  });

  it('超管特权导出须用途 + 实时重新认证（IFC-ERR-002）', async () => {
    const h = makeHarness({ superAdminUserIds: ['super'] });
    h.reauth.recordReauth('super');
    // 未填用途 → 422 IFC-ERR-005
    await assert.rejects(
      h.apply.execute({
        principal: platformSuperAdminPrincipal('super'),
        request: { kind: 'platform' },
      }),
      (e: ExportError) => e.code === 'IFC-ERR-005',
    );
    // 未重新认证 → 401 IFC-ERR-002
    const h2 = makeHarness({ superAdminUserIds: ['super'] });
    await assert.rejects(
      h2.apply.execute({
        principal: platformSuperAdminPrincipal('super'),
        request: { kind: 'platform', purpose: '审计' },
      }),
      (e: ExportError) => e.code === 'IFC-ERR-002',
    );
    // 满足条件 → 成功且留特权审计
    const ok = await h.apply.execute({
      principal: platformSuperAdminPrincipal('super'),
      request: { kind: 'platform', purpose: '审计' },
    });
    assert.equal(ok.task.snapshot.data.scope.kind, 'platform');
    assert.equal(h.audit.findBy('export_apply')[0].privileged, true);
  });

  it('部门负责人代申请个人副本：target 不在本部门范围内被拒（EXP-003）', async () => {
    const h = makeHarness({
      kinds: { dep: 'department_leader' },
      clubScopes: {
        dep: [{ clubId: 'C1', level: 'department', departmentIds: ['D1'] }],
      },
    });
    h.facts.seedDepartmentMembers('C1', 'D1', ['member-in']);
    h.facts.seedDepartmentApplicants('C1', 'D1', ['applicant-in']);
    const depPrincipal: ExportPrincipal = {
      userId: 'dep',
      kind: 'department_leader',
      clubScopes: [{ clubId: 'C1', level: 'department', departmentIds: ['D1'] }],
    };
    await assert.rejects(
      h.apply.execute({
        principal: depPrincipal,
        request: {
          kind: 'personal',
          targetUserId: 'outsider',
          clubId: 'C1',
          departmentId: 'D1',
        },
      }),
      (e: ExportError) => e.code === 'IFC-ERR-003',
    );
    const ok = await h.apply.execute({
      principal: depPrincipal,
      request: {
        kind: 'personal',
        targetUserId: 'member-in',
        clubId: 'C1',
        departmentId: 'D1',
      },
    });
    assert.equal(ok.task.snapshot.data.scope.kind, 'personal');
    assert.equal(ok.task.snapshot.data.personalTargetUserId, 'member-in');
  });

  it('社团负责人代申请个人副本：target 不在本社团成员范围内被拒（EXP-003）', async () => {
    const h = makeHarness({
      kinds: { hr: 'club_leader_hr' },
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedClubMembers('C1', ['member-in']);
    const hrPrincipal: ExportPrincipal = {
      userId: 'hr',
      kind: 'club_leader_hr',
      clubScopes: [{ clubId: 'C1', level: 'club', departmentIds: [] }],
    };
    await assert.rejects(
      h.apply.execute({
        principal: hrPrincipal,
        request: { kind: 'personal', targetUserId: 'outsider', clubId: 'C1' },
      }),
      (e: ExportError) => e.code === 'IFC-ERR-003',
    );
    const ok = await h.apply.execute({
      principal: hrPrincipal,
      request: { kind: 'personal', targetUserId: 'member-in', clubId: 'C1' },
    });
    assert.equal(ok.task.snapshot.data.scope.kind, 'personal');
    assert.equal(ok.task.snapshot.data.personalTargetUserId, 'member-in');
  });
});

// ---------------------------------------------------------------------------
// JNT-023 联合导出边界
// ---------------------------------------------------------------------------

describe('JNT-023 联合导出边界', () => {
  it('联合导出仅限参与社团负责人/人事；快照含来源标注；部门负责人被拒', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedParticipantClubs('J1', ['C1', 'C2']);
    h.facts.seedJointAnnotations('J1', [
      {
        jointActivityId: 'J1',
        sourceClubId: 'C2',
        sourceClubName: 'C2',
        recorderUserId: 'r2',
        recorderName: '记录员2',
      },
    ]);
    const res = await h.apply.execute({
      principal: clubLeaderPrincipal('hr', 'C1'),
      request: { kind: 'joint', jointActivityId: 'J1', clubId: 'C1' },
    });
    assert.equal(res.task.snapshot.data.scope.kind, 'joint');
    // 联合导出快照须含来源标注（他社评分/评语逐条标注来源社团与记录人）
    assert.equal(res.task.snapshot.data.jointAnnotations[0].sourceClubId, 'C2');
    assert.equal(res.task.snapshot.data.jointAnnotations[0].recorderUserId, 'r2');

    // 非参与社团负责人 → 拒绝
    const h2 = makeHarness({
      clubScopes: { hr: [{ clubId: 'C9', level: 'club', departmentIds: [] }] },
    });
    h2.facts.seedParticipantClubs('J1', ['C1', 'C2']);
    await assert.rejects(
      h2.apply.execute({
        principal: clubLeaderPrincipal('hr', 'C9'),
        request: { kind: 'joint', jointActivityId: 'J1', clubId: 'C9' },
      }),
      (e: ExportError) => e.code === 'IFC-ERR-003',
    );
  });

  it('部门负责人对联合导出一律拒绝（JNT-023）', async () => {
    const h = makeHarness({
      kinds: { dep: 'department_leader' },
      clubScopes: {
        dep: [{ clubId: 'C1', level: 'department', departmentIds: ['D1'] }],
      },
    });
    h.facts.seedParticipantClubs('J1', ['C1', 'C2']);
    await assert.rejects(
      h.apply.execute({
        principal: {
          userId: 'dep',
          kind: 'department_leader',
          clubScopes: [{ clubId: 'C1', level: 'department', departmentIds: ['D1'] }],
        },
        request: { kind: 'joint', jointActivityId: 'J1', clubId: 'C1' },
      }),
      (e: ExportError) => e.code === 'IFC-ERR-003',
    );
  });

  it('参与社团紧急停用 → 不能新建联合导出（JNT-023，IFC-ERR-006）', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedParticipantClubs('J1', ['C1', 'C2']);
    h.facts.seedSuspendedClub('J1', ['C2']);
    await assert.rejects(
      h.apply.execute({
        principal: clubLeaderPrincipal('hr', 'C1'),
        request: { kind: 'joint', jointActivityId: 'J1', clubId: 'C1' },
      }),
      (e: ExportError) => e.code === 'IFC-ERR-006',
    );
  });

  it('参与社团紧急停用 → 已有未过期可下载链接立即失权（JNT-023）', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    const res = await h.apply.execute({
      principal: clubLeaderPrincipal('hr', 'C1'),
      request: { kind: 'club', clubId: 'C1' },
    });
    await makeDownloadable(h, res.task);
    const count = await h.del.invalidateUnexpiredBySuspension({ clubId: 'C1' });
    assert.equal(count, 1);
    const task = await h.repo.load(res.task.id);
    assert.equal(task?.status, ExportTaskStatus.REVOKED);
    assert.equal(task?.canDownload(), false);
  });
});

// ---------------------------------------------------------------------------
// P3 失败重试
// ---------------------------------------------------------------------------

describe('P3 失败重试', () => {
  it('仅失败任务可重试；非失败 → IFC-ERR-007', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    const res = await h.apply.execute({
      principal: clubLeaderPrincipal('hr', 'C1'),
      request: { kind: 'club', clubId: 'C1' },
    });
    await assert.rejects(
      h.retry.execute({
        principal: clubLeaderPrincipal('hr', 'C1'),
        exportId: res.task.id,
        expectedRevision: res.task.revisionNumber,
      }),
      (e: ExportError) => e.code === 'IFC-ERR-007',
    );
  });

  it('失败重试沿用原快照；版本竞争 → IFC-ERR-008', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    const res = await h.apply.execute({
      principal: clubLeaderPrincipal('hr', 'C1'),
      request: { kind: 'club', clubId: 'C1' },
    });
    const genTask = (await h.repo.load(res.task.id)) as ExportTaskAggregate;
    genTask.claimGeneration('worker-1', 60 * 1000, new Date());
    genTask.markGenerationFailed('磁盘故障', new Date());
    await h.repo.save(genTask);
    const failedTask = (await h.repo.load(res.task.id)) as ExportTaskAggregate;
    assert.equal(failedTask.status, ExportTaskStatus.FAILED);
    const scopeBefore = failedTask.snapshot.data.scope;

    // 版本竞争：传入错误的 expectedRevision → 拒绝（IFC-ERR-008）
    await assert.rejects(
      h.retry.execute({
        principal: clubLeaderPrincipal('hr', 'C1'),
        exportId: failedTask.id,
        expectedRevision: failedTask.revisionNumber + 99,
      }),
      (e: ExportError) => e.code === 'IFC-ERR-008',
    );

    // 正确的 expectedRevision → 重试成功，沿用原快照
    await h.retry.execute({
      principal: clubLeaderPrincipal('hr', 'C1'),
      exportId: failedTask.id,
      expectedRevision: failedTask.revisionNumber,
    });
    const after = (await h.repo.load(failedTask.id)) as ExportTaskAggregate;
    assert.equal(after.status, ExportTaskStatus.PENDING_GENERATION);
    assert.equal(after.revisionNumber, failedTask.revisionNumber + 1);
    assert.deepEqual(after.snapshot.data.scope, scopeBefore);
  });

  it('社团强制停用后拒绝重试，不绕过封锁（JNT-023）', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    const res = await h.apply.execute({
      principal: clubLeaderPrincipal('hr', 'C1'),
      request: { kind: 'club', clubId: 'C1' },
    });
    const genTask = (await h.repo.load(res.task.id)) as ExportTaskAggregate;
    genTask.claimGeneration('worker-1', 60 * 1000, new Date());
    genTask.markGenerationFailed('磁盘故障', new Date());
    await h.repo.save(genTask);
    const failedTask = (await h.repo.load(res.task.id)) as ExportTaskAggregate;
    // 社团此刻被强制停用
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: true });
    await assert.rejects(
      h.retry.execute({
        principal: clubLeaderPrincipal('hr', 'C1'),
        exportId: failedTask.id,
        expectedRevision: failedTask.revisionNumber,
      }),
      (e: ExportError) => e.code === 'IFC-ERR-006',
    );
    const after = (await h.repo.load(failedTask.id)) as ExportTaskAggregate;
    assert.equal(after.status, ExportTaskStatus.FAILED);
  });

  it('个人副本重试：目标成员已离部后原部门负责人不得重试（EXP-003）', async () => {
    const h = makeHarness({});
    const depPrincipal: ExportPrincipal = {
      userId: 'dep',
      kind: 'department_leader',
      clubScopes: [{ clubId: 'C1', level: 'department', departmentIds: ['D1'] }],
    };
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    h.facts.seedDepartmentMembers('C1', 'D1', ['member-in']);
    h.facts.seedDepartmentApplicants('C1', 'D1', []);
    const res = await h.apply.execute({
      principal: depPrincipal,
      request: { kind: 'personal', targetUserId: 'member-in', clubId: 'C1', departmentId: 'D1' },
    });
    const genTask = (await h.repo.load(res.task.id)) as ExportTaskAggregate;
    genTask.claimGeneration('worker-1', 60 * 1000, new Date());
    genTask.markGenerationFailed('磁盘故障', new Date());
    await h.repo.save(genTask);
    const failedTask = (await h.repo.load(res.task.id)) as ExportTaskAggregate;
    assert.equal(failedTask.status, ExportTaskStatus.FAILED);

    // 目标成员已离部（不再出现在成员/招新申请人清单）→ 重试拒绝（IFC-ERR-003）
    h.facts.seedDepartmentMembers('C1', 'D1', []);
    await assert.rejects(
      h.retry.execute({
        principal: depPrincipal,
        exportId: failedTask.id,
        expectedRevision: failedTask.revisionNumber,
      }),
      (e: ExportError) => e.code === 'IFC-ERR-003',
    );
    const after = (await h.repo.load(failedTask.id)) as ExportTaskAggregate;
    assert.equal(after.status, ExportTaskStatus.FAILED);
  });

  it('超管特权导出重试：重认证过期 → 拒绝（IFC-ERR-002），不重新生成特权数据', async () => {
    const h = makeHarness({ superAdminUserIds: ['super'] });
    h.reauth.recordReauth('super');
    const res = await h.apply.execute({
      principal: platformSuperAdminPrincipal('super'),
      request: { kind: 'platform' as const, purpose: '审计' },
    });
    const genTask = (await h.repo.load(res.task.id)) as ExportTaskAggregate;
    genTask.claimGeneration('worker-1', 60 * 1000, new Date());
    genTask.markGenerationFailed('磁盘故障', new Date());
    await h.repo.save(genTask);
    const failedTask = (await h.repo.load(res.task.id)) as ExportTaskAggregate;
    assert.equal(failedTask.status, ExportTaskStatus.FAILED);

    // 重认证已超过 10 分钟窗口（IFC-ERR-002）→ 重试拒绝，特权数据不重新生成
    const now = new Date();
    h.reauth.recordReauth('super', new Date(now.getTime() - 11 * 60 * 1000));
    await assert.rejects(
      h.retry.execute({
        principal: platformSuperAdminPrincipal('super'),
        exportId: failedTask.id,
        expectedRevision: failedTask.revisionNumber,
        now,
      }),
      (e: ExportError) => e.code === 'IFC-ERR-002',
    );
    const after = (await h.repo.load(failedTask.id)) as ExportTaskAggregate;
    assert.equal(after.status, ExportTaskStatus.FAILED);
  });

  it('超管特权导出重试成功：审计 privileged=true（STAT-002 特权留痕）', async () => {
    const h = makeHarness({ superAdminUserIds: ['super'] });
    h.reauth.recordReauth('super');
    const res = await h.apply.execute({
      principal: platformSuperAdminPrincipal('super'),
      request: { kind: 'platform' as const, purpose: '审计' },
    });
    const genTask = (await h.repo.load(res.task.id)) as ExportTaskAggregate;
    genTask.claimGeneration('worker-1', 60 * 1000, new Date());
    genTask.markGenerationFailed('磁盘故障', new Date());
    await h.repo.save(genTask);
    const failedTask = (await h.repo.load(res.task.id)) as ExportTaskAggregate;
    assert.equal(failedTask.status, ExportTaskStatus.FAILED);

    h.audit.clear();
    await h.retry.execute({
      principal: platformSuperAdminPrincipal('super'),
      exportId: failedTask.id,
      expectedRevision: failedTask.revisionNumber,
    });
    const retryAudits = h.audit.findBy('export_retry');
    assert.equal(retryAudits.length, 1);
    // 特权标记须按操作者分类动态写入（此前硬编码 false 会导致超管特权重试丢失特权审计）
    assert.equal(retryAudits[0].privileged, true);
  });

  it('非超管重试：审计 privileged 恒为 false', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    const res = await h.apply.execute({
      principal: clubLeaderPrincipal('hr', 'C1'),
      request: { kind: 'club' as const, clubId: 'C1' },
    });
    const genTask = (await h.repo.load(res.task.id)) as ExportTaskAggregate;
    genTask.claimGeneration('worker-1', 60 * 1000, new Date());
    genTask.markGenerationFailed('磁盘故障', new Date());
    await h.repo.save(genTask);
    const failedTask = (await h.repo.load(res.task.id)) as ExportTaskAggregate;

    h.audit.clear();
    await h.retry.execute({
      principal: clubLeaderPrincipal('hr', 'C1'),
      exportId: failedTask.id,
      expectedRevision: failedTask.revisionNumber,
    });
    const retryAudits = h.audit.findBy('export_retry');
    assert.equal(retryAudits.length, 1);
    assert.equal(retryAudits[0].privileged, false);
  });
});

// ---------------------------------------------------------------------------
// P4 提前删除与联动失效
// ---------------------------------------------------------------------------

describe('P4 提前删除与联动失效', () => {
  it('非本人/授权者/超管提前删除被拒（EXP-003，IFC-ERR-003）', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    const res = await h.apply.execute({
      principal: clubLeaderPrincipal('hr', 'C1'),
      request: { kind: 'club', clubId: 'C1' },
    });
    const stranger: ExportPrincipal = {
      userId: 'stranger',
      kind: 'member_applicant',
      clubScopes: [],
    };
    await assert.rejects(
      h.del.byApplicant({
        principal: stranger,
        exportId: res.task.id,
        expectedRevision: res.task.revisionNumber,
      }),
      (e: ExportError) => e.code === 'IFC-ERR-003',
    );
  });

  it('申请人本人提前删除成功', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    const res = await h.apply.execute({
      principal: clubLeaderPrincipal('hr', 'C1'),
      request: { kind: 'club', clubId: 'C1' },
    });
    await makeDownloadable(h, res.task);
    const task = (await h.repo.load(res.task.id)) as ExportTaskAggregate;
    await h.del.byApplicant({
      principal: clubLeaderPrincipal('hr', 'C1'),
      exportId: task.id,
      expectedRevision: task.revisionNumber,
    });
    const after = await h.repo.load(task.id);
    assert.equal(after?.status, ExportTaskStatus.PRE_DELETED);
    assert.ok(h.audit.findBy('export_delete').length > 0);
  });

  it('授权者（代申请场景）可提前删除', async () => {
    const h = makeHarness({});
    const depPrincipal: ExportPrincipal = {
      userId: 'dep',
      kind: 'department_leader',
      clubScopes: [{ clubId: 'C1', level: 'department', departmentIds: ['D1'] }],
    };
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    h.facts.seedDepartmentMembers('C1', 'D1', ['target']);
    const res = await h.apply.execute({
      principal: depPrincipal,
      request: { kind: 'personal', targetUserId: 'target', clubId: 'C1', departmentId: 'D1' },
    });
    await makeDownloadable(h, res.task);
    const task = (await h.repo.load(res.task.id)) as ExportTaskAggregate;
    // 代申请人=dep；ownerUserId=target → dep 即 authorizer，可删除
    await h.del.byApplicant({
      principal: depPrincipal,
      exportId: task.id,
      expectedRevision: task.revisionNumber,
    });
    const after = await h.repo.load(task.id);
    assert.equal(after?.status, ExportTaskStatus.PRE_DELETED);
  });

  it('正式删除清单联动：命中导出内容的未过期任务失效（AUD-009）', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    const res = await h.apply.execute({
      principal: clubLeaderPrincipal('hr', 'C1'),
      request: { kind: 'club', clubId: 'C1' },
    });
    await makeDownloadable(h, res.task);
    const count = await h.del.applyFormalDelete({ selection: { clubId: 'C1' } });
    assert.equal(count, 1);
    const task = await h.repo.load(res.task.id);
    assert.equal(task?.status, ExportTaskStatus.PRE_DELETED);
    assert.ok(h.audit.findBy('export_formal_delete_invalidate').length > 0);
  });

  it('正式删除不可绕删：已过期任务仍被删除清单清理（AUD-009）', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    const res = await h.apply.execute({
      principal: clubLeaderPrincipal('hr', 'C1'),
      request: { kind: 'club', clubId: 'C1' },
    });
    await makeDownloadable(h, res.task);
    // 将任务收敛为已过期（EXPIRED）
    const downloadTask = (await h.repo.load(res.task.id)) as ExportTaskAggregate;
    downloadTask.expire();
    await h.repo.save(downloadTask);
    assert.equal((await h.repo.load(res.task.id))?.status, ExportTaskStatus.EXPIRED);
    // 已过期任务仍须被正式删除清理（EXPIRED --formal_delete_hit--> PRE_DELETED）
    const count = await h.del.applyFormalDelete({ selection: { clubId: 'C1' } });
    assert.equal(count, 1);
    assert.equal((await h.repo.load(res.task.id))?.status, ExportTaskStatus.PRE_DELETED);
  });
});

// ---------------------------------------------------------------------------
// 拒绝路径审计（STAT-002 可追踪）
// ---------------------------------------------------------------------------

describe('拒绝路径审计（STAT-002）', () => {
  it('越权导出（interviewer 批量）→ 留 denied 审计', async () => {
    const h = makeHarness({ kinds: { iv: 'interviewer' } });
    await assert.rejects(
      h.apply.execute({
        principal: interviewerPrincipal,
        request: { kind: 'club', clubId: 'C1' },
      }),
      (e: ExportError) => e.code === 'IFC-ERR-003',
    );
    const denied = h.audit.entries.find(
      (e) => e.action === 'export_apply' && e.outcome === 'denied' && e.principalId === 'iv-1',
    );
    assert.ok(denied, '应记录一条 denied 审计');
    assert.match(denied.reason ?? '', /IFC-ERR-003/);
  });

  it('社团强制停用 → 留 denied 审计', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: true });
    await assert.rejects(
      h.apply.execute({
        principal: clubLeaderPrincipal('hr', 'C1'),
        request: { kind: 'club', clubId: 'C1' },
      }),
      (e: ExportError) => e.code === 'IFC-ERR-006',
    );
    const denied = h.audit.entries.find(
      (e) =>
        e.action === 'export_apply' &&
        e.outcome === 'denied' &&
        e.principalId === 'hr' &&
        (e.reason ?? '').includes('IFC-ERR-006'),
    );
    assert.ok(denied, '应记录一条 denied 审计');
  });

  it('超管未重认证 → 留 denied 审计（privileged=true）', async () => {
    const h = makeHarness({ superAdminUserIds: ['super'] });
    await assert.rejects(
      h.apply.execute({
        principal: platformSuperAdminPrincipal('super'),
        request: { kind: 'platform', purpose: '审计' },
      }),
      (e: ExportError) => e.code === 'IFC-ERR-002',
    );
    const denied = h.audit.entries.find(
      (e) =>
        e.action === 'export_apply' &&
        e.outcome === 'denied' &&
        e.principalId === 'super' &&
        (e.reason ?? '').includes('IFC-ERR-002'),
    );
    assert.ok(denied);
    assert.equal(denied.privileged, true);
  });

  it('重试非失败任务 → 留 denied 审计（action=export_retry）', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    const res = await h.apply.execute({
      principal: clubLeaderPrincipal('hr', 'C1'),
      request: { kind: 'club', clubId: 'C1' },
    });
    await assert.rejects(
      h.retry.execute({
        principal: clubLeaderPrincipal('hr', 'C1'),
        exportId: res.task.id,
        expectedRevision: res.task.revisionNumber,
      }),
      (e: ExportError) => e.code === 'IFC-ERR-007',
    );
    const denied = h.audit.entries.find(
      (e) =>
        e.action === 'export_retry' &&
        e.outcome === 'denied' &&
        (e.reason ?? '').includes('IFC-ERR-007'),
    );
    assert.ok(denied);
    assert.equal(denied.exportId, res.task.id);
  });

  it('非授权者提前删除 → 留 denied 审计（action=export_delete）', async () => {
    const h = makeHarness({
      clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] },
    });
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    const res = await h.apply.execute({
      principal: clubLeaderPrincipal('hr', 'C1'),
      request: { kind: 'club', clubId: 'C1' },
    });
    const intruder: ExportPrincipal = {
      userId: 'outsider',
      kind: 'interviewer',
      clubScopes: [],
    };
    await assert.rejects(
      h.del.byApplicant({
        principal: intruder,
        exportId: res.task.id,
        expectedRevision: res.task.revisionNumber,
      }),
      (e: ExportError) => e.code === 'IFC-ERR-003',
    );
    const denied = h.audit.entries.find(
      (e) =>
        e.action === 'export_delete' &&
        e.outcome === 'denied' &&
        e.principalId === 'outsider' &&
        (e.reason ?? '').includes('IFC-ERR-003'),
    );
    assert.ok(denied);
    assert.equal(denied.exportId, res.task.id);
  });
});

// ---------------------------------------------------------------------------
// TOCTOU：仓储抛 ExportError(008) 触发拒绝审计与正确错误码
// ---------------------------------------------------------------------------

class SaveConflictRepo extends InMemoryExportTaskRepository {
  private saveCount = 0;
  constructor(
    private readonly applySaves: number,
    private readonly message: string,
  ) {
    super();
  }
  override async save(
    task: ExportTaskAggregate,
    opts?: { expectedRevision?: number },
  ): Promise<void> {
    this.saveCount += 1;
    if (this.saveCount <= this.applySaves) return super.save(task, opts);
    throw new ExportError('IFC-ERR-008', this.message);
  }
}

describe('TOCTOU 窗口：仓储抛 ExportError 触发拒绝审计', () => {
  it('重试：save 抛 ExportError(008) → 重抛并留 denied 审计', async () => {
    const repo = new SaveConflictRepo(2, 'TOCTOU 模拟：被并发写者推进');
    const h = makeHarnessWithRepo(
      { clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] } },
      repo,
    );
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    const res = await h.apply.execute({
      principal: clubLeaderPrincipal('hr', 'C1'),
      request: { kind: 'club', clubId: 'C1' },
    });
    // 推进到 FAILED
    const gen = (await h.repo.load(res.task.id)) as ExportTaskAggregate;
    gen.claimGeneration('worker-1', 60 * 1000, new Date());
    gen.markGenerationFailed('磁盘故障', new Date());
    await h.repo.save(gen);

    // 重试：预检通过后 save 抛 008
    await assert.rejects(
      h.retry.execute({
        principal: clubLeaderPrincipal('hr', 'C1'),
        exportId: res.task.id,
        expectedRevision: (await h.repo.load(res.task.id))?.revisionNumber ?? 0,
      }),
      (e: ExportError) => e.code === 'IFC-ERR-008',
    );
    const denied = h.audit.entries.find(
      (e) =>
        e.action === 'export_retry' &&
        e.outcome === 'denied' &&
        (e.reason ?? '').includes('IFC-ERR-008'),
    );
    assert.ok(denied, '仓储抛 008 时 retry 应留 denied 审计');
    assert.equal(denied.exportId, res.task.id);
  });

  it('提前删除：save 抛 ExportError(008) → 重抛并留 denied 审计', async () => {
    const repo = new SaveConflictRepo(1, 'TOCTOU 模拟：被并发写者推进');
    const h = makeHarnessWithRepo(
      { clubScopes: { hr: [{ clubId: 'C1', level: 'club', departmentIds: [] }] } },
      repo,
    );
    h.facts.seedClubContext({ clubId: 'C1', forcedSuspension: false });
    const res = await h.apply.execute({
      principal: clubLeaderPrincipal('hr', 'C1'),
      request: { kind: 'club', clubId: 'C1' },
    });
    const task = (await h.repo.load(res.task.id)) as ExportTaskAggregate;
    await assert.rejects(
      h.del.byApplicant({
        principal: clubLeaderPrincipal('hr', 'C1'),
        exportId: task.id,
        expectedRevision: task.revisionNumber,
      }),
      (e: ExportError) => e.code === 'IFC-ERR-008',
    );
    const denied = h.audit.entries.find(
      (e) =>
        e.action === 'export_delete' &&
        e.outcome === 'denied' &&
        (e.reason ?? '').includes('IFC-ERR-008'),
    );
    assert.ok(denied, '仓储抛 008 时 byApplicant 应留 denied 审计');
    assert.equal(denied.exportId, task.id);
  });
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

describe('工具函数', () => {
  it('applyIdempotencyHash 对作用域变化敏感', () => {
    const a = applyIdempotencyHash({ kind: 'club', clubId: 'C1' });
    const b = applyIdempotencyHash({ kind: 'club', clubId: 'C2' });
    assert.notEqual(a, b);
  });

  it('applyIdempotencyHash 对字段 key 顺序不敏感（UTF-16 码元序）', () => {
    const a = applyIdempotencyHash({
      kind: 'club',
      fields: { club_summary: ['a', 'b'], current_members: ['x'] },
    });
    const b = applyIdempotencyHash({
      kind: 'club',
      fields: { current_members: ['x'], club_summary: ['a', 'b'] },
    });
    assert.equal(a, b);
  });

  it('applyIdempotencyHash 并入申请者身份：不同用户同 key 摘要不同，同用户一致', () => {
    const base = { kind: 'personal' as const, clubId: 'C1', departmentId: 'D1' };
    // 不同用户对"本人个人副本"（targetUserId 缺省）以同 key 申请 → 摘要不同，
    // 从而在冲突预检处以 IFC-ERR-009 拒绝，而非误导性的跨用户回放 IFC-ERR-003。
    const a = applyIdempotencyHash(base, 'user-A');
    const b = applyIdempotencyHash(base, 'user-B');
    assert.notEqual(a, b);
    // 同用户同 key 相同请求 → 摘要一致，幂等回放不受影响。
    const c = applyIdempotencyHash(base, 'user-A');
    assert.equal(a, c);
  });
});
