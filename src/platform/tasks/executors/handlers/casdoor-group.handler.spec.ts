import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CasdoorGroupHandler } from './casdoor-group.handler';
import { TaskStatus, TaskType } from '../../contracts';
import type { TaskRecord } from '../../contracts';

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    taskId: 'task-1',
    taskType: TaskType.CASDOOR_GROUP_WRITE,
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

describe('CasdoorGroupHandler', () => {
  it('payload 缺少必填字段时仅记录日志，不调用写服务', async () => {
    let writeCalled = false;
    const handler = new CasdoorGroupHandler({
      writeGroupMembership: async () => {
        writeCalled = true;
        return { kind: 'CONFIRMED' as const };
      },
    } as any);
    await handler.handle(makeTask({ payload: {} }));
    assert.equal(writeCalled, false);
  });

  it('payload 缺少 commandId 时跳过', async () => {
    let writeCalled = false;
    const handler = new CasdoorGroupHandler({
      writeGroupMembership: async () => {
        writeCalled = true;
        return { kind: 'CONFIRMED' as const };
      },
    } as any);
    await handler.handle(
      makeTask({
        payload: {
          idempotencyKey: 'ik',
          groupRef: { owner: 'o', name: 'g' },
          originalMemberIds: ['a'],
          targetMemberIds: ['b'],
        },
      }),
    );
    assert.equal(writeCalled, false);
  });

  it('payload 完整时调用写服务并返回结论', async () => {
    let writeReq: any = null;
    const handler = new CasdoorGroupHandler({
      writeGroupMembership: async (req: any) => {
        writeReq = req;
        return { kind: 'CONFIRMED' as const };
      },
    } as any);
    await handler.handle(
      makeTask({
        payload: {
          commandId: 'cmd-1',
          idempotencyKey: 'ik-1',
          groupRef: { owner: 'o', name: 'g' },
          originalMemberIds: ['a'],
          targetMemberIds: ['a', 'b'],
          requestedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    );
    assert.equal(writeReq?.commandId, 'cmd-1');
    assert.equal(writeReq?.groupRef?.owner, 'o');
    assert.deepEqual(writeReq?.targetMemberIds, ['a', 'b']);
  });
});
