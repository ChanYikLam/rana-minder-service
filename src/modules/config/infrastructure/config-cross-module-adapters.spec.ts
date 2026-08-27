/**
 * config 跨模块能力真实适配器测试（CFG-001/002/003/005 接线；AUD-003/IFC-TX-002）。
 *
 * 覆盖：
 * - 审计映射（PROFILE_SYNC/SUPER_ADMIN_OP）与独立短事务落库、写入失败 IFC-ERR-012；
 * - 通知事实映射（'system' 事件、逻辑事件标识确定性、NTF-003 幂等重放跳过）；
 * - 共享事务上下文：ConfigUnitOfWork 窗口内 borrow 同一 TransactionContext——
 *   单次 begin/commit、外层失败整体回滚（audit 与 notification 两路皆证）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FakeDbAdapter } from '../../../shared/testing/fake-db-adapter';
import { ConfigUnitOfWork } from './unit-of-work';
import {
  AuditBackedConfigAudit,
  NotificationFactBackedConfigNotification,
} from './config-cross-module-adapters';
import { AuditUnitOfWork } from '../../audit/infrastructure/audit-unit-of-work';
import { PostgresAuditRepository } from '../../audit/infrastructure/postgres-audit-repository';
import { AuditSanitizer } from '../../audit/domain/services/audit-sanitizer';
import { AuditWriter } from '../../audit/application/commands/audit-writer';
import { PostgresNotificationRepository } from '../../notification/infrastructure/postgres-notification-adapters';
import { CreateNotificationFactCommand } from '../../notification/application/commands/create-notification-fact.command';
import type {
  NotificationRepository,
  KillSwitchRepository,
} from '../../notification/infrastructure/notification-ports';

const PROFILE_CHANGES = [
  { field: 'displayName', from: '旧名', to: '新名' },
  { field: 'intro', from: '', to: '新简介' },
] as const;

function makeAuditAdapter(db: FakeDbAdapter): AuditBackedConfigAudit {
  const uow = new AuditUnitOfWork(db);
  return new AuditBackedConfigAudit(
    new AuditWriter(new PostgresAuditRepository(db, uow), new AuditSanitizer(), uow),
  );
}

function makeNotificationAdapter(db: FakeDbAdapter): NotificationFactBackedConfigNotification {
  const repo = new PostgresNotificationRepository(db);
  const killSwitches = {
    findByScope: async () => null,
  } as unknown as KillSwitchRepository;
  // 零收件人解析器对齐生产 DefaultRecipientSnapshotResolver 对管理类事件的行为
  const resolver = { resolve: () => ({ recipients: [], resolutionRationale: '' }) };
  const command = new CreateNotificationFactCommand(repo, resolver as never, killSwitches);
  return new NotificationFactBackedConfigNotification(command, repo as NotificationRepository);
}

const insertCount = (db: FakeDbAdapter, table: string): number =>
  db.queries.filter((q) => q.sql.toUpperCase().startsWith(`INSERT INTO ${table.toUpperCase()}`))
    .length;

describe('config 跨模块适配器 · CFG-001/003 审计接线', () => {
  it('recordProfileChange 映射 PROFILE_SYNC 并以独立短事务落库', async () => {
    const db = new FakeDbAdapter();
    const at = new Date('2026-02-14T10:00:00+08:00');
    await makeAuditAdapter(db).recordProfileChange({
      clubId: 'club-1',
      by: 'user-7',
      onBehalf: false,
      at,
      changes: PROFILE_CHANGES,
    });

    assert.deepEqual(db.events, [
      'begin:tx-1',
      'set-rls:tx-1:unprotected',
      'query:tx-1',
      'commit:tx-1',
      'clear-rls:tx-1',
    ]);
    const insert = db.queries.find((q) => q.sql.includes('INSERT INTO audit_event'));
    assert.ok(insert);
    // 列序：$2 event_type $3 actor_id $4 actor_roles(JSON串) $5 scope(JSON串)
    assert.equal(insert.params[1], 'PROFILE_SYNC');
    assert.equal(insert.params[2], 'user-7');
    assert.equal(insert.params[3], '["OWNER"]');
    assert.match(String(insert.params[4]), /"clubId":"club-1"/u);
    // 新值差异逐字段留痕（脱敏器对普通字符串直通）
    assert.match(String(insert.params[9]), /新名/u);
    assert.equal(insert.params[10], 'SUCCESS');
  });

  it('onBehalf 代改时角色快照为 PLATFORM', async () => {
    const db = new FakeDbAdapter();
    await makeAuditAdapter(db).recordProfileChange({
      clubId: 'club-2',
      by: 'admin-1',
      onBehalf: true,
      at: new Date(),
      changes: PROFILE_CHANGES,
    });
    assert.deepEqual(db.queries[0].params[3], '["PLATFORM"]');
  });

  it('recordBoundaryChange 映射 SUPER_ADMIN_OP 且新旧分界留痕', async () => {
    const db = new FakeDbAdapter();
    await makeAuditAdapter(db).recordBoundaryChange({
      by: 'super-1',
      at: new Date('2026-01-01T00:00:00Z'),
      from: { month: 8, day: 1, timeZone: 'Asia/Shanghai' },
      to: { month: 9, day: 1, timeZone: 'Asia/Shanghai' },
    });
    const insert = db.queries[0];
    assert.equal(insert.params[1], 'SUPER_ADMIN_OP');
    assert.match(String(insert.params[7]), /ACADEMIC_YEAR_BOUNDARY/u);
    // 脱敏器差异序列化口径：key=value 分号连接
    assert.match(String(insert.params[8]), /month=8;day=1/u);
    assert.match(String(insert.params[9]), /month=9/u);
  });

  it('审计写入失败抛 IFC-ERR-012（业务整体失败）', async () => {
    const db = new FakeDbAdapter();
    db.queryError = new Error('connection refused');
    await assert.rejects(
      makeAuditAdapter(db).recordBoundaryChange({
        by: 'super-1',
        at: new Date(),
        from: { month: 8, day: 1, timeZone: 'UTC' },
        to: { month: 9, day: 1, timeZone: 'UTC' },
      }),
      /IFC-ERR-012/u,
    );
  });

  it('共享事务：config 窗口内借用同一事务，单次 begin/commit', async () => {
    const db = new FakeDbAdapter();
    const adapter = makeAuditAdapter(db);
    const configUow = new ConfigUnitOfWork(db);

    let innerTxId = '';
    await configUow.run({ kind: 'unprotected' }, async () => {
      innerTxId = configUow.active.id;
      await adapter.recordProfileChange({
        clubId: 'club-1',
        by: 'user-7',
        onBehalf: false,
        at: new Date(),
        changes: PROFILE_CHANGES,
      });
      // 借用段内不得出现任何独立提交（审计须随外层收口）
      assert.equal(
        db.events.some((e) => e.startsWith('commit:')),
        false,
      );
    });

    assert.equal(db.events.filter((e) => e === `begin:${innerTxId}`).length, 1);
    assert.equal(db.events.filter((e) => e === `commit:${innerTxId}`).length, 1);
    assert.equal(
      db.events.some((e) => e.startsWith('rollback:')),
      false,
    );
    // 审计 INSERT 发生在 config 的事务上下文中（query:<同一txId>）
    assert.ok(db.events.includes(`query:${innerTxId}`));
  });

  it('共享事务：外层业务失败 → 整体回滚，审计不抢先提交', async () => {
    const db = new FakeDbAdapter();
    const configUow = new ConfigUnitOfWork(db);
    const adapter = makeAuditAdapter(db);

    await assert.rejects(
      configUow.run({ kind: 'unprotected' }, async () => {
        await adapter.recordProfileChange({
          clubId: 'club-1',
          by: 'user-7',
          onBehalf: false,
          at: new Date(),
          changes: PROFILE_CHANGES,
        });
        throw new Error('business failed');
      }),
      /business failed/u,
    );

    assert.equal(db.events.filter((e) => e.startsWith('rollback:')).length, 1);
    assert.equal(
      db.events.some((e) => e.startsWith('commit:')),
      false,
    );
  });
});

describe('config 跨模块适配器 · CFG-002/005 通知事实接线', () => {
  it('notifyPolicyChange 映射零收件人 system 事实（dedup_key=logicalEventId）', async () => {
    const db = new FakeDbAdapter();
    const effectiveAt = new Date('2026-03-01T08:00:00Z');
    await makeNotificationAdapter(db).notifyPolicyChange({
      scope: 'CLUB',
      clubId: 'club-9',
      key: 'INVITATION_VALID_DAYS',
      oldValue: 20,
      newValue: 30,
      changedBy: 'leader-1',
      effectiveAt,
    });

    const insert = db.queries.find((q) => q.sql.includes('INSERT INTO notification_facts'));
    assert.ok(insert);
    // 零收件人事实：fact 级 dedup_key 回退 logicalEventId，且确定性含 scope/key/生效时刻
    const expectedLogical = 'cfg-policy-CLUB-club-9-INVITATION_VALID_DAYS-' + effectiveAt.getTime();
    assert.equal(insert.params[1], expectedLogical);
    assert.equal(insert.params[2], expectedLogical);
    assert.equal(insert.params[3], 'system');
    // payload 摘要脱敏口径：仅策略语义，不含操作者明文电话/邮箱等
    assert.match(String(insert.params[6]), /INVITATION_VALID_DAYS/u);
    assert.doesNotMatch(String(insert.params[6]), /leader-1/u);
  });

  it('NTF-003 幂等：重复发射不产生第二个 INSERT', async () => {
    const db = new FakeDbAdapter();
    const adapter = makeNotificationAdapter(db);
    const input = {
      scope: 'PLATFORM' as const,
      clubId: null,
      key: 'CONFIRM_DEADLINE_HOURS' as const,
      oldValue: 7,
      newValue: 14,
      changedBy: 'admin-1',
      effectiveAt: new Date('2026-03-02T00:00:00Z'),
    };
    await adapter.notifyPolicyChange(input);
    const afterFirst = insertCount(db, 'notification_facts');
    assert.equal(afterFirst, 1);

    await adapter.notifyPolicyChange(input);
    assert.equal(insertCount(db, 'notification_facts'), 1);
  });

  it('notifyConfigPublished 按 rootId+版本号确定性幂等，scope 固定 PLATFORM', async () => {
    const db = new FakeDbAdapter();
    const adapter = makeNotificationAdapter(db);
    const input = {
      rootId: 'field_mapping',
      kind: 'FIELD_MAPPING' as const,
      versionNumber: 3,
      publishedBy: 'admin-1',
      highRisk: true,
    };
    await adapter.notifyConfigPublished(input);
    const insert = db.queries.find((q) => q.sql.includes('INSERT INTO notification_facts'));
    assert.ok(insert);
    assert.equal(insert.params[1], 'cfg-published-field_mapping-v3');
    assert.equal(insert.params[3], 'system');

    await adapter.notifyConfigPublished(input);
    assert.equal(insertCount(db, 'notification_facts'), 1);
  });

  it('共享事务：config 窗口内发布通知随外层事务原子收口', async () => {
    const db = new FakeDbAdapter();
    const configUow = new ConfigUnitOfWork(db);
    const adapter = makeNotificationAdapter(db);

    let innerTxId = '';
    await configUow.run({ kind: 'unprotected' }, async () => {
      innerTxId = configUow.active.id;
      await adapter.notifyConfigPublished({
        rootId: 'field_mapping',
        kind: 'FIELD_MAPPING',
        versionNumber: 1,
        publishedBy: 'admin-1',
        highRisk: true,
      });
      assert.equal(
        db.events.some((e) => e.startsWith('commit:')),
        false,
      );
    });

    assert.equal(db.events.filter((e) => e === `commit:${innerTxId}`).length, 1);
    assert.equal(db.events.filter((e) => e.startsWith('begin:')).length, 1);
    assert.ok(db.events.includes(`query:${innerTxId}`));
  });
});
