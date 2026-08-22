/**
 * ProfileNameWriteTaskHandler 单元测试（IDN-016 写回收口 + API-AUTH-004 服务账号）。
 *
 * 覆盖：服务账号身份/任务 traceId 透传、载荷校验、执行在单主体 RLS 事务边界内
 * 收口、载荷损坏 → 拒绝（任务层退避重试）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProfileNameWriteTaskHandler,
  JOB_SERVICE_ACCOUNT,
} from './profile-name-write-task.handler';
import { IdentityUnitOfWork } from '../identity/infrastructure/unit-of-work';
import { FakeDbAdapter } from '../identity/infrastructure/testing/fake-db-adapter';
import type {
  ApplyNameCorrectionWriteInput,
  ApplyNameCorrectionWriteUseCase,
} from '../identity/application/commands/apply-name-correction-write.use-case';
import type { ClaimedJobTask } from './job-task.store';

function claimedTask(overrides?: Partial<ClaimedJobTask>): ClaimedJobTask {
  return {
    id: 'name-correction:user-1:req-1',
    type: 'profile_name_write',
    subjectId: 'user-1',
    payload: { requestId: 'req-1', subjectId: 'user-1', newName: '新姓名' },
    attempts: 1,
    ...overrides,
  };
}

describe('ProfileNameWriteTaskHandler（姓名写回执行单元）', () => {
  it('以服务账号身份在单主体事务内执行写回，任务 id 作为追踪引用', async () => {
    const inputs: ApplyNameCorrectionWriteInput[] = [];
    const useCase: ApplyNameCorrectionWriteUseCase = {
      async execute(input) {
        inputs.push(input);
        return { requestId: input.requestId, synced: true };
      },
    };
    const db = new FakeDbAdapter();
    const handler = new ProfileNameWriteTaskHandler(useCase, new IdentityUnitOfWork(db));
    const task = claimedTask();

    await handler.execute(task);

    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].requestId, 'req-1');
    assert.equal(inputs[0].subjectId, 'user-1');
    assert.equal(inputs[0].newName, '新姓名');
    assert.equal(inputs[0].actor, JOB_SERVICE_ACCOUNT);
    assert.equal(inputs[0].traceId, task.id);
    const txId = db.events[0].slice('begin:'.length);
    assert.deepEqual(db.events, [
      `begin:${txId}`,
      `set-rls:${txId}:single`,
      `commit:${txId}`,
      `clear-rls:${txId}`,
    ]);
  });

  it('用例抛错 → 业务事务回滚后异常上抛（任务层退避重试）', async () => {
    const useCase: ApplyNameCorrectionWriteUseCase = {
      async execute() {
        throw new Error('casdoor write unavailable');
      },
    };
    const db = new FakeDbAdapter();
    const handler = new ProfileNameWriteTaskHandler(useCase, new IdentityUnitOfWork(db));

    await assert.rejects(handler.execute(claimedTask()), /casdoor write unavailable/);
    assert.equal(db.events.includes(`rollback:${db.events[0].slice('begin:'.length)}`), true);
  });

  it('任务载荷损坏 → 拒绝（不进入业务，任务层重试）', async () => {
    const useCase: ApplyNameCorrectionWriteUseCase = {
      async execute() {
        throw new Error('不应被调用');
      },
    };
    const handler = new ProfileNameWriteTaskHandler(
      useCase,
      new IdentityUnitOfWork(new FakeDbAdapter()),
    );

    await assert.rejects(
      handler.execute(claimedTask({ payload: { requestId: 'req-1' } })),
      /任务载荷格式不正确/,
    );
  });
});
