/**
 * DB 连通性端口（T4）单元测试。
 *
 * 覆盖：
 * - PostgresDbStatusPort 探测成功：返回 ok=true + latencyMs；
 * - 查询出错：降级为 ok=false，不抛异常（ADR-011：状态页不向用户暴露内部异常）；
 * - 未连接桩 NotWiredDbStatusPort：返回 ok=false。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { DbAdapter } from '../../../shared/db-adapter';
import { FakeDbAdapter } from '../../../shared/testing/fake-db-adapter';
import { NotWiredDbStatusPort, PostgresDbStatusPort } from './db-status';

describe('NotWiredDbStatusPort（未连接桩）', () => {
  it('ping 返回 ok=false（未接线，状态页显示未知）', async () => {
    const port = new NotWiredDbStatusPort();
    const result = await port.ping();
    assert.equal(result.ok, false);
  });
});

describe('PostgresDbStatusPort（T4 真实连通）', () => {
  it('探测成功：返回 ok=true 与 latencyMs', async () => {
    const db = new FakeDbAdapter();
    const port = new PostgresDbStatusPort(db);
    const result = await port.ping();
    assert.equal(result.ok, true);
    assert.ok(result.ok === true && result.latencyMs >= 0);
  });

  it('查询出错：降级为 ok=false，不抛异常，且错误做最小披露', async () => {
    const db = new FakeDbAdapter();
    db.queryError = new Error('connection refused');
    const port = new PostgresDbStatusPort(db);
    const result = await port.ping();
    assert.equal(result.ok, false);
    if (!result.ok) {
      // 不向用户暴露原始异常（ADR-011 §5 最小披露）
      assert.equal(result.error, 'db connectivity check failed');
      assert.doesNotMatch(result.error, /connection|refused/);
    }
  });

  it('setRlsContext 出错：事务回滚收口，连接不泄漏（DATA-CON-006）', async () => {
    const events: string[] = [];
    const tx = { id: 'tx-leak-check' };
    const failingDb: DbAdapter = {
      beginTransaction: async () => {
        events.push('begin');
        return tx;
      },
      commit: async () => {
        events.push('commit');
      },
      rollback: async () => {
        events.push('rollback');
      },
      setRlsContext: async () => {
        events.push('set-rls');
        throw new Error('set rls context failed');
      },
      clearRlsContext: async () => {
        events.push('clear-rls');
      },
      query: async () => {
        events.push('query');
        return [];
      },
    };
    const port = new PostgresDbStatusPort(failingDb);
    const result = await port.ping();
    assert.equal(result.ok, false);
    // 必须回滚收口释放连接，且不得再触碰已收口连接（clear-rls 为 no-op）
    assert.deepEqual(events, ['begin', 'set-rls', 'rollback', 'clear-rls']);
    assert.equal(events.includes('commit'), false);
  });
});
