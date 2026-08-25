/**
 * JobNestController 单元测试（传输层契约：成功返回 {code:0,data}，错误统一映射）。
 *
 * 直接构造控制器（不启动 Nest），用桩 store/runner 验证：
 * - GET  status  → 成功信封含真实计数；
 * - POST run-once → 返回处理数；
 * - POST :jobId/retry → 调用 store.requeue 并返回重投回执；
 * - 任意异常 → 抛出 500 IFC-ERR-016（脱敏，不泄露内部细节）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';

import { JobNestController } from './job.nest.controller';
import type { JobTaskStore, JobTaskStatus } from '../../job-task.store';
import type { JobTaskRunner } from '../../job-task-runner';

const SESSION_KEY = 'authSession';

function authedRequest(): Record<string, unknown> {
  return { [SESSION_KEY]: { subjectId: 'admin-1', now: new Date() } };
}

const DEFAULT_COUNTS: Record<JobTaskStatus, number> = {
  pending: 2,
  running: 1,
  done: 5,
  failed: 1,
};

function makeStore(overrides: Partial<JobTaskStore> = {}): JobTaskStore {
  return {
    claim: async () => [],
    complete: async () => {},
    retry: async () => {},
    fail: async () => {},
    countByStatus: async () => DEFAULT_COUNTS,
    requeue: async () => {},
    ...overrides,
  };
}

function makeRunner(processed = 3): JobTaskRunner {
  return { runOnce: async () => processed } as unknown as JobTaskRunner;
}

function makeController(store: JobTaskStore, runner: JobTaskRunner): JobNestController {
  return new JobNestController(store, runner);
}

describe('JobNestController（运维端点传输层）', () => {
  it('GET status 返回 {code:0,data} 且内含真实计数', async () => {
    const controller = makeController(makeStore(), makeRunner());

    const result = await controller.getStatus(authedRequest());

    assert.equal((result as { code: number }).code, 0);
    const data = (result as { data: { counts: Record<JobTaskStatus, number>; generatedAt: string } })
      .data;
    assert.deepEqual(data.counts, DEFAULT_COUNTS);
    assert.ok(typeof data.generatedAt === 'string');
  });

  it('POST run-once 返回处理数', async () => {
    const controller = makeController(makeStore(), makeRunner(7));

    const result = await controller.runOnce(authedRequest());

    assert.equal((result as { code: number }).code, 0);
    assert.equal((result as { data: { processed: number } }).data.processed, 7);
  });

  it('POST :jobId/retry 调用 store.requeue 并返回重投回执', async () => {
    let requeuedId: string | null = null;
    const store = makeStore({
      requeue: async (id: string) => {
        requeuedId = id;
      },
    });
    const controller = makeController(store, makeRunner());

    const result = await controller.retryJob('job-42', authedRequest());

    assert.equal(requeuedId, 'job-42');
    assert.equal((result as { code: number }).code, 0);
    assert.equal((result as { data: { jobId: string; requeued: boolean } }).data.jobId, 'job-42');
    assert.equal((result as { data: { requeued: boolean } }).data.requeued, true);
  });

  it('异常统一映射为 500 IFC-ERR-016（脱敏，不泄露内部细节）', async () => {
    const store = makeStore({
      countByStatus: async () => {
        throw new Error('connection refused: db.example/rana');
      },
    });
    const controller = makeController(store, makeRunner());

    await assert.rejects(
      () => controller.getStatus(authedRequest()),
      (err: unknown) => {
        if (!(err instanceof HttpException)) {
          return false;
        }
        assert.equal(err.getStatus(), 500);
        const body = err.getResponse() as { code: string; message: string; supportId: string };
        assert.equal(body.code, 'IFC-ERR-016');
        assert.ok(typeof body.supportId === 'string' && body.supportId.length > 0);
        assert.ok(!body.message.includes('connection refused'));
        return true;
      },
    );
  });
});
