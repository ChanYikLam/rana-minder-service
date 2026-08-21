import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ReconciliationHandler } from './reconciliation.handler';
import { TaskStatus, TaskType } from '../../contracts';
import type { TaskRecord } from '../../contracts';

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    taskId: 'task-1',
    taskType: TaskType.RECONCILIATION,
    status: TaskStatus.PENDING,
    intentId: 'intent-1',
    idempotencyKey: 'ik:1',
    scope: { kind: 'CLUB', clubId: 'c1' },
    source: { objectType: 'f', objectId: '1', version: 1, scope: { kind: 'CLUB', clubId: 'c1' } },
    payload: {},
    lease: null,
    attempts: 0,
    maxAttempts: 5,
    notBefore: now,
    failure: null,
    resultRef: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('ReconciliationHandler', () => {
  it('使用默认值当 payload 缺少字段时', async () => {
    let reconcileReq: any = null;
    const handler = new ReconciliationHandler({
      runFullReconciliation: async (req: any) => {
        reconcileReq = req;
        return {
          runId: req.runId,
          status: 'COMPLETE_SUCCESS' as const,
          pageCount: 0,
          attemptCount: 1,
          completedAt: '',
          differenceSummary: {},
          evidence: [],
        };
      },
    } as any);
    await handler.handle(makeTask({ payload: {} }));
    assert.equal(reconcileReq?.limit, 100);
    assert.equal(reconcileReq?.scope, 'platform');
  });

  it('limit 钳制：负数截断到 1', async () => {
    let reconcileReq: any = null;
    const handler = new ReconciliationHandler({
      runFullReconciliation: async (req: any) => {
        reconcileReq = req;
        return {
          runId: req.runId,
          status: 'COMPLETE_SUCCESS' as const,
          pageCount: 0,
          attemptCount: 1,
          completedAt: '',
          differenceSummary: {},
          evidence: [],
        };
      },
    } as any);
    await handler.handle(makeTask({ payload: { limit: -5 } }));
    assert.equal(reconcileReq?.limit, 1);
  });

  it('limit 钳制：超过 1000 截断到 1000', async () => {
    let reconcileReq: any = null;
    const handler = new ReconciliationHandler({
      runFullReconciliation: async (req: any) => {
        reconcileReq = req;
        return {
          runId: req.runId,
          status: 'COMPLETE_SUCCESS' as const,
          pageCount: 0,
          attemptCount: 1,
          completedAt: '',
          differenceSummary: {},
          evidence: [],
        };
      },
    } as any);
    await handler.handle(makeTask({ payload: { limit: 2000 } }));
    assert.equal(reconcileReq?.limit, 1000);
  });

  it('limit 钳制：合法值直接传递', async () => {
    let reconcileReq: any = null;
    const handler = new ReconciliationHandler({
      runFullReconciliation: async (req: any) => {
        reconcileReq = req;
        return {
          runId: req.runId,
          status: 'COMPLETE_SUCCESS' as const,
          pageCount: 0,
          attemptCount: 1,
          completedAt: '',
          differenceSummary: {},
          evidence: [],
        };
      },
    } as any);
    await handler.handle(makeTask({ payload: { limit: 50 } }));
    assert.equal(reconcileReq?.limit, 50);
  });
});
