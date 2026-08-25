/**
 * TST-FAIL-001~013：13 条故障关闭语义证据（P1-B；CI-004 发布门）。
 *
 * 每条规则：实现锚点（fail-closed 行为所在真实文件）必须存在 +
 * 行为级证据套件必须存在；另附三个进程内真实行为探针：
 * - FAIL-002 身份门 fail-closed：生产环境拒绝信任 x-actor-id（账号状态不可信即拒绝）
 * - FAIL-004 Casdoor 写失败不假成功：异常 Group 写成员返回 failure；
 *   结果不确定语义由 IFC-ERR-013（EXTERNAL_UNKNOWN）承载
 * - FAIL-005 数据库故障不假成功：事务内抛错走 rollback 收口，绝不 commit
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ErrorCode } from '../../src/common/errors/error-code';
import { FakeDbAdapter } from '../../src/shared/testing/fake-db-adapter';
import { FormUnitOfWork } from '../../src/modules/form/infrastructure/unit-of-work';
import { InMemoryCasdoorPort } from '../../src/modules/organization/infrastructure/in-memory/memory-implementations';
import { resolveActorFromHeaders } from '../../src/modules/organization/interfaces/actor';
import { OrgDomainError } from '../../src/modules/organization/domain/types';
import { createRelationCommand } from '../../src/modules/organization/domain/models/relation-command';
import { RelationCommandStateMachine } from '../../src/modules/organization/domain/state-machines/relation-command.state-machine';

const ROOT = path.resolve(__dirname, '../..');
const exists = (rel: string): boolean => fs.existsSync(path.join(ROOT, rel));

interface FailEntry {
  readonly id: string;
  readonly title: string;
  /** fail-closed 行为所在真实实现文件 */
  readonly anchors: readonly string[];
  /** 已落地的行为级证据套件 */
  readonly evidence: readonly string[];
}

const A = (p: string): string => path.join('src/modules', p);

export const FAIL_INVENTORY: readonly FailEntry[] = [
  {
    id: 'SRS-FAIL-001',
    title: 'Casdoor 暂时不可用或账号状态无法可信确认（新登录关闭＋15 分钟白名单降级）',
    anchors: [A('identity/domain/state-machines/account-access.state-machine.ts')],
    evidence: [
      A('identity/domain/state-machines/account-access.state-machine.spec.ts'),
      A('organization/interfaces/actor.spec.ts'),
    ],
  },
  {
    id: 'SRS-FAIL-002',
    title: 'Casdoor 可信确认账号禁用或删除（立即终止会话，历史保留）',
    anchors: [
      A('identity/domain/state-machines/account-access.state-machine.ts'),
      A('organization/interfaces/actor.ts'),
    ],
    evidence: [
      A('organization/interfaces/actor.spec.ts'),
      A('identity/domain/state-machines/account-access.state-machine.spec.ts'),
    ],
  },
  {
    id: 'SRS-FAIL-003',
    title: '普通资料连续 24 小时无法同步（先读回核验再回退/进入第三值冲突）',
    anchors: [A('identity/domain/state-machines/profile-sync.state-machine.ts')],
    evidence: [A('identity/domain/state-machines/profile-sync.state-machine.spec.ts')],
  },
  {
    id: 'SRS-FAIL-004',
    title: 'Casdoor Group 关系写入超时/不确定/失败（处理中保持原权限，先回读再收口）',
    anchors: [A('organization/application/commands/relation-command.use-case.ts')],
    evidence: [A('organization/application/commands/relation-command.use-case.spec.ts')],
  },
  {
    id: 'SRS-FAIL-005',
    title: '主业务数据库不可用（停止全部业务写入，不返回排队成功假象）',
    anchors: ['src/adapters/db/postgres-db-adapter.ts', A('form/infrastructure/unit-of-work.ts')],
    evidence: ['test/contract/tst-tx-boundaries.spec.ts'],
  },
  {
    id: 'SRS-FAIL-006',
    title: '文件存储/恶意内容检查/安全预览不可用（未检查文件不得放行或正式提交）',
    anchors: ['src/adapters/file-check/external-file-check.adapter.ts'],
    evidence: [
      A('file/application/commands/lifecycle.spec.ts'),
      A('file/application/commands/upload-flow.spec.ts'),
    ],
  },
  {
    id: 'SRS-FAIL-007',
    title: '平台或社团邮件账号不可用、密钥失效或投递失败（渠道失败不阻断主事务）',
    anchors: ['src/adapters/mail/smtp-mail.adapter.ts'],
    evidence: [A('notification/interfaces/notification.controller.spec.ts')],
  },
  {
    id: 'SRS-FAIL-008',
    title: '必须通知事件无法在业务事务内保存通知事实或收件人快照（原业务整体失败）',
    anchors: [
      'src/platform/tasks/outbox/task-intent-outbox.ts',
      'src/platform/tasks/outbox/in-memory-transactional-outbox.ts',
    ],
    evidence: ['test/contract/tst-tx-boundaries.spec.ts'],
  },
  {
    id: 'SRS-FAIL-009',
    title: '站内信被超级管理员紧急关闭（通知事实照存、恢复后按原事件时间补投）',
    anchors: [
      A('notification/application/commands/apply-kill-switch.command.ts'),
      A('notification/application/commands/resume-kill-switch.command.ts'),
    ],
    evidence: [A('notification/interfaces/notification.controller.spec.ts')],
  },
  {
    id: 'SRS-FAIL-010',
    title: '导出、统计重算或其他后台任务失败（不改业务源数据，可重试并通知申请人）',
    anchors: [
      A('stat-export/domain/state-machines/export-task.state-machine.ts'),
      'src/platform/tasks/executors/task-execution-pipeline.ts',
    ],
    evidence: [
      A('stat-export/domain/state-machines/export-task.state-machine.spec.ts'),
      'src/platform/tasks/executors/task-execution-pipeline.spec.ts',
    ],
  },
  {
    id: 'SRS-FAIL-011',
    title: '正式删除跨库/附件/缓存/索引部分失败（不宣称完成，失败项持续重试）',
    anchors: ['src/platform/tasks/batch/batch-orchestrator.ts'],
    evidence: [
      'src/platform/tasks/batch/batch.spec.ts',
      'src/platform/tasks/executors/task-execution-pipeline.spec.ts',
    ],
  },
  {
    id: 'SRS-FAIL-012',
    title: '从备份恢复正式环境（恢复后重放删除清单并与 Casdoor 对账）',
    anchors: ['src/adapters/backup/external-backup.adapter.ts'],
    evidence: ['src/adapters/backup/external-backup.adapter.spec.ts'],
  },
  {
    id: 'SRS-FAIL-013',
    title: '不可变配置新版本发布失败（旧版本保持完整有效，不得部分生效）',
    anchors: [A('organization/application/commands/permission-template.command.ts')],
    evidence: [
      A('organization/interfaces/controllers/admin-permission-templates.controller.spec.ts'),
    ],
  },
];

describe('TST-FAIL 001~013 故障关闭语义', () => {
  it('清单完备（13 条、编号有序）且锚点/证据文件真实存在', () => {
    assert.equal(FAIL_INVENTORY.length, 13);
    assert.deepEqual(
      FAIL_INVENTORY.map((e) => e.id),
      Array.from({ length: 13 }, (_, i) => `SRS-FAIL-${String(i + 1).padStart(3, '0')}`),
    );
    for (const entry of FAIL_INVENTORY) {
      for (const anchor of entry.anchors) {
        assert.ok(exists(anchor), `${entry.id} 锚点不存在: ${anchor}`);
      }
      for (const ev of entry.evidence) {
        assert.ok(exists(ev), `${entry.id} 证据套件不存在: ${ev}`);
      }
    }
  });

  it('FAIL-002 探针：身份门 fail-closed——生产环境拒绝信任 x-actor-id（IFC-ERR-FORBIDDEN）', () => {
    // 账号状态不可信时请求主体解析直接拒绝（不产生半可信身份）。
    // 与既有证据 actor.spec.ts 对齐：断言具体错误码 IFC-ERR-FORBIDDEN，
    // 而非仅 instanceof OrgDomainError 的弱断言（IFC-ERR-001 为文档层编号，
    // 实现层实际抛出的是 ErrorCode.FORBIDDEN）。
    assert.throws(
      () => resolveActorFromHeaders({ 'x-actor-id': 'u_root' }, { NODE_ENV: 'production' }),
      (e: unknown) => e instanceof OrgDomainError && e.code === 'IFC-ERR-FORBIDDEN',
    );
  });

  it('FAIL-004 探针：Casdoor 异常 Group 写成员返回 failure 不假成功；不确定语义 = IFC-ERR-013', async () => {
    // 场景：Casdoor Group 关系写入结果不确定/失败。
    // 注：simulateAnomaly('no_access') 会把该 Group 加入 failingRefs，
    // 写成员时由 failingRefs 机制返回 failure（readable=false 本身不驱动写失败）。
    const casdoor = new InMemoryCasdoorPort({
      groups: [
        {
          ref: { owner: 'club-acm', name: '宣传部' },
          displayName: '宣传部',
          parentRef: null,
          memberIds: [],
        },
      ],
    });
    await casdoor.simulateAnomaly({ owner: 'club-acm', name: '宣传部' }, 'no_access');
    const result = await casdoor.writeMembership({
      ref: { owner: 'club-acm', name: '宣传部' },
      subjectId: 'u_x',
      action: 'add',
      requestId: 'req-fail-004',
    });
    // 关键断言：外部写失败绝不允许返回 success（假成功即越权来源）
    assert.equal(result.outcome, 'failure');

    // 外部结果不确定的领域语义由 EXTERNAL_UNKNOWN（IFC-ERR-013）承载，且必须真实走通
    // 状态机 readback_confirmed 分支（回读未确认全部目标 → 拒绝转成功），而非仅调用工厂
    // 做错误码等值检查。此处驱动与 production 同源的 RelationCommandStateMachine：
    const command = createRelationCommand({
      id: 'relcmd-fail-004',
      clubId: 'club-acm-1',
      type: 'join_department',
      subjectId: 'u_x',
      originalRelation: [],
      targetRelation: [
        {
          stepId: 's1',
          kind: 'add_member',
          targetGroup: { owner: 'club-acm', name: '宣传部' },
          subjectId: 'u_x',
          idempotencyKey: 'k1',
          order: 0,
          attemptCount: 0,
        },
      ],
      objectVersion: 3,
      idempotencyKey: 'rel:fail-004:u_x',
      submittedBy: 'u_admin',
      now: new Date('2026-08-01T00:00:00.000Z'),
    });
    const machine = new RelationCommandStateMachine();
    assert.throws(
      () =>
        machine.transition({
          command: { ...command, status: 'processing' },
          event: 'readback_confirmed',
          now: new Date('2026-08-01T00:05:00.000Z'),
          facts: {
            // 回读未确认全部目标（confirmedSteps 不全）→ 状态机拒绝转成功并抛 externalUnknown
            readback: { confirmedSteps: [] },
          },
        }),
      // 简化为单断言：ErrorCode.EXTERNAL_UNKNOWN 的值即 'IFC-ERR-013'，无需重复核验同一错误码
      (e: unknown) => e instanceof OrgDomainError && e.code === ErrorCode.EXTERNAL_UNKNOWN,
    );
  });

  it('FAIL-005 探针：数据库故障——事务内抛错走 rollback 收口，不产生 commit 假成功', async () => {
    const db = new FakeDbAdapter();
    const uow = new FormUnitOfWork(db);
    await assert.rejects(
      () =>
        uow.run({ kind: 'unprotected' }, async () => {
          throw new Error('database unavailable');
        }),
      /database unavailable/,
    );
    // 失败路径：必须出现 rollback 且绝不出现 commit（假成功=0）
    assert.ok(
      db.events.some((e) => e.startsWith('rollback:')),
      '失败路径应走 rollback',
    );
    assert.ok(
      db.events.every((e) => !e.startsWith('commit:')),
      '失败路径不得产生 commit（假成功）',
    );
  });
});
