/**
 * PostgreSQL 文件仓储单测（4.2 收口；fake DbAdapter 捕获 SQL，不依赖真实库）。
 *
 * 回归防护：save/load 行映射完整（jsonb 嵌套）；createWithinTargetLimit 上限
 * 语义（同事务计数）；nextVersionNo 递增；listByTarget 目标过滤。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PostgresFileRepository,
  advisoryLockKeyFor,
  fileRecordToRow,
  fileRecordRowToSnapshot,
} from './postgres-file-repository';
import type { FileRecord } from '../domain/models/file-model';

const NOW = '2026-08-24T00:00:00.000Z';

function makeFile(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    fileId: 'f1',
    uploaderId: 'u1',
    scope: { kind: 'CLUB', clubId: 'club-1' },
    category: 'PHOTO',
    state: 'AVAILABLE',
    target: { objectType: 'DRAFT', objectId: 'd1', fieldKey: 'photos' },
    versionNo: 1,
    versions: [
      {
        versionNo: 1,
        objectLocation: {
          bucketRole: 'OBJECT',
          keyVersion: 'v1',
          randomKey: 'r1',
          objectKind: 'OBJECT',
          actualSize: 100,
          sha256: 'abc',
          storageToken: 't1',
        },
        declaredType: 'image/jpeg',
        detectedType: 'image/jpeg',
        declaredSize: 100,
        actualSize: 100,
        sha256: 'abc',
        createdAt: NOW,
      },
    ],
    uploadSession: null,
    checkRecord: {
      fileVersionNo: 1,
      engineVersion: 'external-v1',
      status: 'PASSED',
      retryable: false,
      sanitizedResult: 'ok',
      startedAt: NOW,
      finishedAt: NOW,
    },
    cleanupQueue: [],
    deletionManifest: null,
    createdAt: NOW,
    ...overrides,
  };
}

/** fake DbAdapter：按 SQL 模式分发；store 模拟 file_records 行 */
const makeFakeDb = () => {
  const store = new Map<string, Record<string, unknown>>();
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const db = {
    beginTransaction: async () => ({ tx: 1 }),
    commit: async () => undefined,
    rollback: async () => undefined,
    setRlsContext: async () => undefined,
    clearRlsContext: async () => undefined,
    query: async <T>(_tx: unknown, sql: string, params: readonly unknown[]): Promise<T[]> => {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO file_records')) {
        const row = {
          file_id: params[0] as string,
          uploader_id: params[1] as string,
          scope: JSON.parse(params[2] as string),
          category: params[3],
          state: params[4],
          target: params[5] === null ? null : JSON.parse(params[5] as string),
          version_no: params[6],
          versions: JSON.parse(params[7] as string),
          upload_session: params[8] === null ? null : JSON.parse(params[8] as string),
          check_record: params[9] === null ? null : JSON.parse(params[9] as string),
          cleanup_queue: JSON.parse(params[10] as string),
          deletion_manifest: params[11] === null ? null : JSON.parse(params[11] as string),
          created_at: params[12] as Date,
          updated_at: params[13] as Date,
        };
        store.set(row.file_id, row);
        return [] as T[];
      }
      if (sql.includes('SELECT count(*)')) {
        // createWithinTargetLimit 计数：非终态 + 目标匹配
        const [objectType, objectId, fieldKey] = [params[0], params[1], params[2]];
        let n = 0;
        for (const r of store.values()) {
          const t = r.target as { objectType: string; objectId: string; fieldKey: string } | null;
          if (
            t !== null &&
            t.objectType === objectType &&
            t.objectId === objectId &&
            t.fieldKey === fieldKey &&
            r.state !== 'CLEANED' &&
            r.state !== 'PENDING_CLEANUP' &&
            r.state !== 'DELETED'
          ) {
            n += 1;
          }
        }
        return [{ n }] as T[];
      }
      if (sql.includes('SELECT max(version_no)')) {
        const r = store.get(params[0] as string);
        return [{ max: r === undefined ? null : (r.version_no as number) }] as T[];
      }
      if (sql.includes('target->>')) {
        // listByTarget：按目标对象/字段过滤（SQL 含 target->>'objectType'）
        const [objectType, objectId, fieldKey] = [params[0], params[1], params[2]];
        return [...store.values()].filter((r) => {
          const t = r.target as {
            objectType: string;
            objectId: string;
            fieldKey: string;
          } | null;
          return (
            t !== null &&
            t.objectType === objectType &&
            t.objectId === objectId &&
            t.fieldKey === fieldKey
          );
        }) as T[];
      }
      if (sql.includes('SELECT file_id, uploader_id')) {
        const id = params[0];
        const rows = [...store.values()].filter((r) =>
          id === undefined ? true : r.file_id === id,
        );
        return rows as T[];
      }
      return [] as T[];
    },
  };
  return { db, calls, store };
};

describe('PostgresFileRepository（4.2 收口）', () => {
  it('行映射往返：fileRecordToRow → fileRecordRowToSnapshot 保留嵌套结构', () => {
    const file = makeFile();
    const row = fileRecordToRow(file, new Date(NOW));
    const snap = fileRecordRowToSnapshot({
      ...row,
      scope: JSON.stringify(row.scope),
      target: row.target === null ? null : JSON.stringify(row.target),
      versions: JSON.stringify(row.versions),
      upload_session: row.upload_session === null ? null : JSON.stringify(row.upload_session),
      check_record: row.check_record === null ? null : JSON.stringify(row.check_record),
      cleanup_queue: JSON.stringify(row.cleanup_queue),
      deletion_manifest:
        row.deletion_manifest === null ? null : JSON.stringify(row.deletion_manifest),
    } as never);
    assert.equal(snap.fileId, 'f1');
    assert.equal(snap.state, 'AVAILABLE');
    assert.equal(snap.versions.length, 1);
    assert.equal(snap.versions[0].objectLocation.bucketRole, 'OBJECT');
    assert.equal(snap.checkRecord!.status, 'PASSED');
    assert.equal(snap.target!.objectId, 'd1');
  });

  it('save → load 完整往返（INSERT + SELECT 同构映射）', async () => {
    const { db } = makeFakeDb();
    const repo = new PostgresFileRepository(db as never);
    await repo.save(makeFile());
    const loaded = await repo.load('f1');
    assert.equal(loaded!.fileId, 'f1');
    assert.equal(loaded!.state, 'AVAILABLE');
    assert.equal(loaded!.cleanupQueue.length, 0);
  });

  it('createWithinTargetLimit：先取咨询锁再计数（评审修复——首次并发亦串行化）', async () => {
    const { db, calls } = makeFakeDb();
    const repo = new PostgresFileRepository(db as never);
    await repo.createWithinTargetLimit(
      { objectType: 'DRAFT', objectId: 'd1', fieldKey: 'photos' },
      2,
      makeFile(),
    );
    // 第一条 SQL 必须是 pg_advisory_xact_lock（串行化发生于计数之前，含首次无行可锁场景）
    assert.ok(calls[0].sql.includes('pg_advisory_xact_lock'));
    assert.ok(calls[1].sql.includes('SELECT count(*)'));
    // 咨询锁键为稳定 bigint（同一目标两次调用一致）
    const k1 = advisoryLockKeyFor({ objectType: 'DRAFT', objectId: 'd1', fieldKey: 'photos' });
    const k2 = advisoryLockKeyFor({ objectType: 'DRAFT', objectId: 'd1', fieldKey: 'photos' });
    assert.equal(k1, k2);
    assert.equal(typeof k1, 'bigint');
    assert.ok(k1 > 0n, '咨询锁键应为正整数');
    // 不同目标键不同（降低无谓竞争）
    const k3 = advisoryLockKeyFor({ objectType: 'DRAFT', objectId: 'd2', fieldKey: 'photos' });
    assert.notEqual(k1, k3);
  });

  it('createWithinTargetLimit：未超限保存 true；达到上限返回 false 且不写入', async () => {
    const { db } = makeFakeDb();
    const repo = new PostgresFileRepository(db as never);
    const ok = await repo.createWithinTargetLimit(
      { objectType: 'DRAFT', objectId: 'd1', fieldKey: 'photos' },
      2,
      makeFile(),
    );
    assert.equal(ok, true);
    const ok2 = await repo.createWithinTargetLimit(
      { objectType: 'DRAFT', objectId: 'd1', fieldKey: 'photos' },
      2,
      makeFile({ fileId: 'f2' }),
    );
    assert.equal(ok2, true);
    // 已达上限（2/2）→ 拒绝且不写入
    const rejected = await repo.createWithinTargetLimit(
      { objectType: 'DRAFT', objectId: 'd1', fieldKey: 'photos' },
      2,
      makeFile({ fileId: 'f3' }),
    );
    assert.equal(rejected, false);
    assert.equal((await repo.load('f3')) === null, true);
  });

  it('nextVersionNo：不存在 → 1；存在 → max+1', async () => {
    const { db } = makeFakeDb();
    const repo = new PostgresFileRepository(db as never);
    assert.equal(await repo.nextVersionNo('f1'), 1);
    await repo.save(makeFile({ versionNo: 3 }));
    assert.equal(await repo.nextVersionNo('f1'), 4);
  });

  it('listByTarget：按目标对象/字段过滤', async () => {
    const { db } = makeFakeDb();
    const repo = new PostgresFileRepository(db as never);
    await repo.save(makeFile());
    await repo.save(
      makeFile({
        fileId: 'f2',
        target: { objectType: 'DRAFT', objectId: 'd2', fieldKey: 'photos' },
      }),
    );
    const list = await repo.listByTarget({
      objectType: 'DRAFT',
      objectId: 'd1',
      fieldKey: 'photos',
    });
    assert.equal(list.length, 1);
    assert.equal(list[0].fileId, 'f1');
  });
});
