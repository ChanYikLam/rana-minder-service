/**
 * Ops 运维可观测（T7）单元测试。
 *
 * 覆盖：
 * - DB 连通成功：写 healthy ops 日志（warn）并返回 ok=true；
 * - DB 连通失败：写 degraded ops 日志（error）并返回 ok=false（最小披露，不抛异常）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NestOpsTelemetry } from './ops-telemetry';
import type { DbStatusPort } from './db-status';

interface Logged {
  level: 'warn' | 'error';
  record: Record<string, unknown>;
}

describe('NestOpsTelemetry（T7 数据库连通 → 脱敏日志）', () => {
  it('连通成功：写 healthy 日志并返回 ok=true + latencyMs', async () => {
    const logs: Logged[] = [];
    const db: DbStatusPort = {
      ping: async () => ({ ok: true, latencyMs: 12 }),
    };
    const logger = {
      warn: (record: Record<string, unknown>) => logs.push({ level: 'warn', record }),
      error: (record: Record<string, unknown>) => logs.push({ level: 'error', record }),
    };
    const ops = new NestOpsTelemetry(db, logger);
    const result = await ops.reportDbConnectivity();
    assert.equal(result.ok, true);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, 'warn');
    assert.equal(logs[0].record.ok, true);
    assert.equal(logs[0].record.latencyMs, 12);
  });

  it('连通失败：写 degraded 日志并返回 ok=false（不抛异常）', async () => {
    const logs: Logged[] = [];
    const db: DbStatusPort = {
      ping: async () => ({ ok: false, error: 'connection refused' }),
    };
    const logger = {
      warn: (record: Record<string, unknown>) => logs.push({ level: 'warn', record }),
      error: (record: Record<string, unknown>) => logs.push({ level: 'error', record }),
    };
    const ops = new NestOpsTelemetry(db, logger);
    const result = await ops.reportDbConnectivity();
    assert.equal(result.ok, false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, 'error');
    assert.equal(logs[0].record.ok, false);
    assert.match(String(logs[0].record.error), /connection refused/);
  });
});
