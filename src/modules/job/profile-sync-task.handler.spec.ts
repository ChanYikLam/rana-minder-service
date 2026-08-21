/**
 * ProfileSyncTaskHandler 单元测试（IFC-SM-003 消费接力 + API-AUTH-004 服务账号）。
 *
 * 覆盖：服务账号身份/任务 traceId 透传、载荷校验、业务执行在单主体 RLS 事务
 * 边界内收口、载荷损坏 → 拒绝（任务层退避重试）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProfileSyncTaskHandler, JOB_SERVICE_ACCOUNT } from './profile-sync-task.handler';
import { IdentityUnitOfWork } from '../identity/infrastructure/unit-of-work';
import { FakeDbAdapter } from '../identity/infrastructure/testing/fake-db-adapter';
import type {
  ApplyProfileSyncStepUseCase,
  ApplyProfileSyncStepInput,
} from '../identity/application/commands/apply-profile-sync-step.use-case';
import type { ClaimedJobTask } from './job-task.store';

function claimedTask(overrides?: Partial<ClaimedJobTask>): ClaimedJobTask {
  return {
    id: 'profile_sync:user-1:phone:4',
    type: 'profile_sync',
    subjectId: 'user-1',
    payload: { subjectId: 'user-1', field: 'phone', targetVersion: 4, intentId: 'intent-1' },
    attempts: 1,
    ...overrides,
  };
}

describe('ProfileSyncTaskHandler（服务账号执行单元）', () => {
  it('以服务账号身份在单主体事务内执行同步步骤，任务 id 作为追踪引用', async () => {
    const inputs: ApplyProfileSyncStepInput[] = [];
    const useCase: ApplyProfileSyncStepUseCase = {
      async execute(input) {
        inputs.push(input);
        return { kind: 'SYNCED' };
      },
    };
    const db = new FakeDbAdapter();
    const handler = new ProfileSyncTaskHandler(useCase, new IdentityUnitOfWork(db));
    const task = claimedTask();

    await handler.execute(task);

    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].subjectId, 'user-1');
    assert.equal(inputs[0].field, 'phone');
    assert.equal(inputs[0].targetVersion, 4);
    assert.equal(inputs[0].intentId, 'intent-1');
    assert.equal(inputs[0].actor, JOB_SERVICE_ACCOUNT); // API-AUTH-004 服务账号
    assert.equal(inputs[0].traceId, task.id); // 任务 id 关联审计
    const txId = db.events[0].slice('begin:'.length);
    assert.deepEqual(db.events, [
      `begin:${txId}`,
      `set-rls:${txId}:single`,
      `commit:${txId}`,
      `clear-rls:${txId}`,
    ]);
  });

  it('用例抛错 → 业务事务回滚后异常上抛（任务层退避重试）', async () => {
    const useCase: ApplyProfileSyncStepUseCase = {
      async execute() {
        throw new Error('casdoor unavailable');
      },
    };
    const db = new FakeDbAdapter();
    const handler = new ProfileSyncTaskHandler(useCase, new IdentityUnitOfWork(db));

    await assert.rejects(handler.execute(claimedTask()), /casdoor unavailable/);
    assert.equal(db.events.includes(`rollback:${db.events[0].slice('begin:'.length)}`), true);
  });

  it('任务载荷损坏 → 拒绝（不进入业务，任务层重试）', async () => {
    const useCase: ApplyProfileSyncStepUseCase = {
      async execute() {
        throw new Error('不应被调用');
      },
    };
    const handler = new ProfileSyncTaskHandler(
      useCase,
      new IdentityUnitOfWork(new FakeDbAdapter()),
    );

    await assert.rejects(
      handler.execute(claimedTask({ payload: { subjectId: 'user-1' } })),
      /任务载荷格式不正确/,
    );
  });

  it('载荷为 null 或非对象 → 拒绝而非 TypeError（与 ProfileNameWriteTaskHandler 守卫一致）', async () => {
    const useCase: ApplyProfileSyncStepUseCase = {
      async execute() {
        throw new Error('不应被调用');
      },
    };
    const handler = new ProfileSyncTaskHandler(
      useCase,
      new IdentityUnitOfWork(new FakeDbAdapter()),
    );

    // 未显式提供 payload 时默认值为 null，即 DB 中 JSON null 的场景
    await assert.rejects(
      handler.execute(claimedTask({ payload: null as never })),
      /任务载荷格式不正确/,
    );
    await assert.rejects(
      handler.execute(claimedTask({ payload: 'junk' as never })),
      /任务载荷格式不正确/,
    );
  });
});
