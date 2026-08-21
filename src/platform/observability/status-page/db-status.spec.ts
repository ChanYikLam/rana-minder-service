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

import { NotWiredDbStatusPort, PostgresDbStatusPort } from './db-status';
import { FakeDbAdapter } from '../../../shared/testing/fake-db-adapter';

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

  it('查询出错：降级为 ok=false，不抛异常', async () => {
    const db = new FakeDbAdapter();
    db.queryError = new Error('connection refused');
    const port = new PostgresDbStatusPort(db);
    const result = await port.ping();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /connection refused/);
    }
  });
});
