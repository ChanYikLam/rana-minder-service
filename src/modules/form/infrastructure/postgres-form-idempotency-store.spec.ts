/**
 * Form PostgreSQL IdempotencyStore 测试（P3 覆盖补齐；FakeDbAdapter 全链路断言）。
 *
 * 相对 form-repositories.spec.ts 的全链路用例，本 spec 侧重独立验证
 * claim 占位 / 重放比对 / readResult 回读 / release 清理 的关键分支，断言真实行为。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FormUnitOfWork } from './unit-of-work';
import { FakeDbAdapter } from '../../../shared/testing/fake-db-adapter';
import { PostgresFormIdempotencyStore } from './postgres-form-idempotency-store';

async function inTx<T>(uow: FormUnitOfWork, fn: () => Promise<T>): Promise<T> {
  return uow.run({ kind: 'single', subjectId: 'leader-1' }, fn);
}

const scopeKey = 'create-draft:club:club-1';

describe('PostgresFormIdempotencyStore', () => {
  it('claim：新键占位成功返回 inserted，重放命中既有摘要', async () => {
    const db = new FakeDbAdapter();
    const uow = new FormUnitOfWork(db);
    const store = new PostgresFormIdempotencyStore(db, uow);

    const first = await inTx(uow, () =>
      store.claim({ scopeKey, idempotencyKey: 'key-1', semanticHash: 'hash-a' }),
    );
    assert.equal(first.inserted, true);
    assert.equal(first.existingHash, null);

    db.seed('form_idempotency', [
      { scope_key: scopeKey, idempotency_key: 'key-1', semantic_hash: 'hash-a', result: null },
    ]);
    const replayed = await inTx(uow, () =>
      store.claim({ scopeKey, idempotencyKey: 'key-1', semanticHash: 'hash-a' }),
    );
    assert.equal(replayed.inserted, false);
    assert.equal(replayed.existingHash, 'hash-a');
  });

  it('complete 回填后 readResult 命中返回结果', async () => {
    const db = new FakeDbAdapter();
    const uow = new FormUnitOfWork(db);
    const store = new PostgresFormIdempotencyStore(db, uow);
    db.seed('form_idempotency', [
      { scope_key: scopeKey, idempotency_key: 'key-2', semantic_hash: 'hash-b', result: null },
    ]);

    await inTx(uow, () =>
      store.complete({
        scopeKey,
        idempotencyKey: 'key-2',
        semanticHash: 'hash-b',
        result: { ok: true },
      }),
    );
    const result = await inTx(uow, () => store.readResult(scopeKey, 'key-2'));
    assert.deepEqual(result, { ok: true });
  });

  it('readResult：未命中返回 null', async () => {
    const db = new FakeDbAdapter();
    const uow = new FormUnitOfWork(db);
    const store = new PostgresFormIdempotencyStore(db, uow);
    assert.equal(await inTx(uow, () => store.readResult(scopeKey, 'ghost-key')), null);
  });

  it('release：删除幂等行（DELETE FROM form_idempotency）', async () => {
    const db = new FakeDbAdapter();
    const uow = new FormUnitOfWork(db);
    const store = new PostgresFormIdempotencyStore(db, uow);

    await inTx(uow, () => store.release(scopeKey, 'key-3'));
    const del = db.queries.find((q) => /DELETE FROM form_idempotency/i.test(q.sql));
    assert.ok(del, '应执行 DELETE FROM form_idempotency');
    assert.equal(del.params[0], scopeKey);
    assert.equal(del.params[1], 'key-3');
  });
});
