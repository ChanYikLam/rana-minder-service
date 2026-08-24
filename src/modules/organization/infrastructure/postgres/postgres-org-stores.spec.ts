/**
 * PostgreSQL 组织聚合仓储（FakeDbAdapter 全链路）：往返、乐观锁 CAS、
 * 幂等/在途查询与稳定映射 upsert（#68 / ADR-014）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FakeDbAdapter } from '../../../../shared/testing/fake-db-adapter';
import { createClubSpace } from '../../domain/models/club-space';
import { createRelationCommand } from '../../domain/models/relation-command';
import type { RelationCommand } from '../../domain/models/relation-command';
import { OrgUnitOfWork } from './org-unit-of-work';
import { PostgresClubStore } from './postgres-club.store';
import {
  PostgresAppointmentCommandStore,
  PostgresRelationCommandStore,
} from './postgres-command.stores';
import {
  PostgresGroupMappingRegistry,
  PostgresPermissionTemplateStore,
} from './postgres-config.stores';

function makeClub(): ReturnType<typeof createClubSpace> {
  const club = createClubSpace({
    id: 'club-1',
    name: 'ACM社团',
    description: '',
    candidate: { owner: 'club-acm', name: 'ACM社团' },
    actor: 'u_root',
    now: new Date('2026-08-01T00:00:00.000Z'),
  });
  club.status = 'enabled';
  club.clubGroup = { owner: 'club-acm', name: 'ACM社团' };
  return club;
}

function makeRelation(overrides: Partial<RelationCommand> = {}): RelationCommand {
  const base = createRelationCommand({
    id: 'relcmd-1',
    clubId: 'club-1',
    type: 'appoint_position',
    subjectId: 'u_c',
    originalRelation: [],
    targetRelation: [
      {
        stepId: 's1',
        kind: 'add_member',
        targetGroup: { owner: 'club-acm', name: '宣传部' },
        subjectId: 'u_c',
        idempotencyKey: 'k1',
        order: 0,
        attemptCount: 0,
      },
    ],
    objectVersion: 1,
    idempotencyKey: 'rel:key:1',
    submittedBy: 'u_b',
    now: new Date('2026-08-01T00:00:00.000Z'),
  });
  return { ...base, ...overrides };
}

describe('PostgresClubStore（FakeDbAdapter 全链路）', () => {
  it('保存→读取往返：payload 完整还原，group ref 列回填', async () => {
    const db = new FakeDbAdapter();
    const uow = new OrgUnitOfWork(db);
    const store = new PostgresClubStore(db, uow);
    const club = makeClub();
    await store.save(club);

    const loaded = await store.findById(club.id);
    assert.ok(loaded);
    assert.equal(loaded.id, 'club-1');
    assert.equal(loaded.name, 'ACM社团');
    assert.deepEqual(loaded.clubGroup, { owner: 'club-acm', name: 'ACM社团' });

    const byRef = await store.findByGroupRef({ owner: 'club-acm', name: 'ACM社团' });
    assert.equal(byRef?.id, 'club-1');
    assert.equal((await store.findByGroupRef({ owner: 'x', name: 'y' })) ?? null, null);
  });

  it('乐观锁：旧版本写入被拒（IFC-ERR-007），新版本放行', async () => {
    const db = new FakeDbAdapter();
    const uow = new OrgUnitOfWork(db);
    const store = new PostgresClubStore(db, uow);
    const club = makeClub(); // version=1
    await store.save(club);

    const newer = { ...club, version: 2, name: 'ACM社团v2' };
    await store.save(newer);

    await assert.rejects(
      () => store.save(club), // v1 < v2 → 拒绝
      (e: Error) => e.message.includes('乐观锁'),
    );
    assert.equal((await store.findById(club.id))?.name, 'ACM社团v2');
  });
});

describe('PostgresRelationCommandStore（FakeDbAdapter 全链路）', () => {
  it('幂等键精确查询 + 在途（in_flight）查询', async () => {
    const db = new FakeDbAdapter();
    const uow = new OrgUnitOfWork(db);
    const store = new PostgresRelationCommandStore(db, uow);
    const cmd = makeRelation({ status: 'processing' as never });
    await store.save(cmd);

    const byIdem = await store.findByExactIdempotencyKey('rel:key:1', 'u_c', 'appoint_position');
    assert.equal(byIdem?.id, 'relcmd-1');
    assert.equal(
      await store.findByExactIdempotencyKey('rel:key:1', 'u_other', 'appoint_position'),
      null,
    );

    const inFlight = await store.findByProcessingForSubject('club-1', 'u_c');
    assert.equal(inFlight?.id, 'relcmd-1');
  });

  it('终态后 in_flight 翻转：处理中查询不再命中', async () => {
    const db = new FakeDbAdapter();
    const uow = new OrgUnitOfWork(db);
    const store = new PostgresRelationCommandStore(db, uow);
    await store.save(makeRelation({ status: 'processing' as never }));
    assert.ok(await store.findByProcessingForSubject('club-1', 'u_c'));
    await store.save(makeRelation({ status: 'readback_confirmed' as never }));
    assert.equal(await store.findByProcessingForSubject('club-1', 'u_c'), null);
  });

  it('乐观锁：attemptCount 回退被拒', async () => {
    const db = new FakeDbAdapter();
    const uow = new OrgUnitOfWork(db);
    const store = new PostgresRelationCommandStore(db, uow);
    await store.save(makeRelation({ attemptCount: 3 }));
    await assert.rejects(
      () => store.save(makeRelation({ attemptCount: 2 })),
      (e: Error) => e.message.includes('乐观锁'),
    );
  });
});

describe('PostgresAppointmentCommandStore / PermissionTemplate / GroupMapping', () => {
  it('预约命令：按 clubId 列表 + relation_command_id 反查 + 调度版本 CAS', async () => {
    const db = new FakeDbAdapter();
    const uow = new OrgUnitOfWork(db);
    const store = new PostgresAppointmentCommandStore(db, uow);
    const base = {
      id: 'appt-1',
      clubId: 'club-1',
      scheduleVersion: 2,
      relationCommandId: 'relcmd-9',
    };
    await store.save(base as never);
    await assert.rejects(
      () => store.save({ ...base, scheduleVersion: 1 } as never),
      (e: Error) => e.message.includes('乐观锁'),
    );
    assert.equal((await store.findById('appt-1'))?.scheduleVersion, 2);
    assert.equal((await store.findByRelationCommandId('relcmd-9'))?.id, 'appt-1');
    assert.equal((await store.listByClub('club-1')).length, 1);
  });

  it('模板与绑定：绑定 (owner,name) 唯一覆盖，按 club 过滤，可移除', async () => {
    const db = new FakeDbAdapter();
    const uow = new OrgUnitOfWork(db);
    const store = new PostgresPermissionTemplateStore(db, uow);
    const binding = {
      clubId: 'club-1',
      positionGroup: { owner: 'club-acm', name: '负责人组' },
      templateId: 't-leader',
      publishedVersion: 1,
      departmentScope: null,
    } as unknown as Record<string, unknown>;
    await store.saveBinding(binding as never);
    await store.saveBinding({ ...binding, templateId: 't-leader-v2' } as never);
    const list = await store.listBindings('club-1');
    assert.equal(list.length, 1);
    assert.equal((list[0] as unknown as { templateId: string }).templateId, 't-leader-v2');
    await store.removeBinding('club-1', { owner: 'club-acm', name: '负责人组' });
    assert.equal((await store.listBindings('club-1')).length, 0);
  });

  it('稳定映射：复合主键 upsert 与按社团列举（ORG-013）', async () => {
    const db = new FakeDbAdapter();
    const uow = new OrgUnitOfWork(db);
    const registry = new PostgresGroupMappingRegistry(db, uow);
    await registry.save({
      ref: { owner: 'club-acm', name: '宣传部' },
      clubId: 'club-1',
      purpose: 'department',
      departmentId: 'dept-pr',
      positionId: null,
      mappingVersion: 1,
    });
    await registry.save({
      ref: { owner: 'club-acm', name: '宣传部' },
      clubId: 'club-1',
      purpose: 'department',
      departmentId: 'dept-pr-new',
      positionId: null,
      mappingVersion: 2,
    });
    const found = await registry.findByRef({ owner: 'club-acm', name: '宣传部' });
    assert.equal(found?.mappingVersion, 2);
    assert.equal(found?.departmentId, 'dept-pr-new');
    assert.equal((await registry.listByClub('club-1')).length, 1);
    assert.equal((await registry.listAll()).length, 1);
  });
});
