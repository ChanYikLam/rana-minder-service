/**
 * 任务积压端口（T6）单元测试。
 *
 * 覆盖：
 * - PostgresTaskSummaryPort：委托任务仓储 backlogSummary() 映射为状态页 byKind 视图；
 * - 仓储异常：按"未知"降级（ADR-011 §2.1 第 2 条），不伪造成功；
 * - NotWired 桩：返回空积压（未知）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NotWiredTaskSummaryPort, PostgresTaskSummaryPort } from './task-summary';

describe('NotWiredTaskSummaryPort（未接线桩）', () => {
  it('summarize 返回空积压（状态页按未知渲染）', async () => {
    const port = new NotWiredTaskSummaryPort();
    const result = await port.summarize();
    assert.equal(result.backlog, undefined);
    assert.deepEqual(result.recentFailures, []);
  });
});

describe('PostgresTaskSummaryPort（T6 真实积压）', () => {
  it('聚合任务积压并映射为 byKind 视图', async () => {
    const repo = {
      backlogSummary: async () => ({
        pending: 3,
        leased: 2,
        retryableFailed: 1,
        uncertain: 0,
        manualIntervention: 1,
        completed: 10,
        perType: {},
      }),
    };
    const port = new PostgresTaskSummaryPort(repo);
    const result = await port.summarize();
    assert.ok(result.backlog);
    assert.deepEqual(result.backlog.byKind, {
      pending: 3,
      leased: 2,
      retryableFailed: 1,
      uncertain: 0,
      manualIntervention: 1,
      completed: 10,
    });
    assert.ok(result.backlog.capturedAt instanceof Date);
  });

  it('仓储异常：降级为未知（不伪造成功）', async () => {
    const repo = {
      backlogSummary: async () => {
        throw new Error('db down');
      },
    };
    const port = new PostgresTaskSummaryPort(repo);
    const result = await port.summarize();
    assert.equal(result.backlog, undefined);
    assert.deepEqual(result.recentFailures, []);
  });
});
