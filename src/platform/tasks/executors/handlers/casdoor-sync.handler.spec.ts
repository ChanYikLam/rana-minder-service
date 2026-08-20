import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CasdoorSyncHandler } from './casdoor-sync.handler';
import { TaskStatus, TaskType } from '../../contracts';
import type { TaskRecord } from '../../contracts';

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    taskId: 'task-1',
    taskType: TaskType.CASDOOR_SYNC,
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

describe('CasdoorSyncHandler', () => {
  it('payload 缺少 externalUserId 或 trackingId 时仅记录日志，不调用读服务', async () => {
    let readCalled = false;
    const handler = new CasdoorSyncHandler(
      {
        readAccountState: async () => {
          readCalled = true;
          return { status: 'TRUSTED_CURRENT' as const };
        },
      } as any,
      { resolve: () => ({ level: 'REAL_TIME' as const, reason: 'test' }) } as any,
    );
    await handler.handle(makeTask({ payload: {} }));
    assert.equal(readCalled, false);
  });

  it('payload 完整时调用读服务并解析 freshness', async () => {
    let readReq: any = null;
    let freshnessResolved = false;
    const handler = new CasdoorSyncHandler(
      {
        readAccountState: async (req: any) => {
          readReq = req;
          return {
            status: 'TRUSTED_CURRENT' as const,
            value: { externalId: 'u1', name: 'A', state: 'ACTIVE' },
          };
        },
      } as any,
      {
        resolve: () => {
          freshnessResolved = true;
          return { level: 'REAL_TIME' as const, reason: 'test' };
        },
      } as any,
    );
    await handler.handle(
      makeTask({
        payload: { externalUserId: 'u1', trackingId: 't1' },
      }),
    );
    assert.equal(freshnessResolved, true);
    assert.equal(readReq?.externalUserId, 'u1');
    assert.equal(readReq?.trackingId, 't1');
    assert.equal(readReq?.freshness, 'REAL_TIME');
  });
});
