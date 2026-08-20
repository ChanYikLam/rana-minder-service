import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryTaskProcessorRegistry } from './task-processor-registry';
import { DevelopmentTaskPrecondition } from './task-precondition';
import { LogOnlyExternalCallAdapter, ExternalStatus } from './external-call.adapter';
import { TaskExecutionPipeline } from './task-execution-pipeline';
import type { TaskHandler, TaskRecord, TaskRepository, TaskProcessorRegistry } from '../contracts';
import { TaskStatus, TaskType } from '../contracts';
import { LeaseManager } from '../lease';
import { RecoveryReplayConvergence } from '../idempotency';
import { InMemoryIdempotencyStore } from '../idempotency/in-memory-idempotency-store';
import type { RanaMinderConfig } from '../../../config';

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    taskId: 'task-1', taskType: TaskType.FILE_CHECK, status: TaskStatus.PENDING,
    intentId: 'intent-1', idempotencyKey: 'ik:1',
    scope: { kind: 'CLUB', clubId: 'c1' },
    source: { objectType: 'f', objectId: '1', version: 1, scope: { kind: 'CLUB', clubId: 'c1' } },
    payload: {}, lease: null, attempts: 0, maxAttempts: 5, notBefore: now,
    failure: null, resultRef: null, createdAt: now, updatedAt: now, ...overrides,
  };
}

const defaultConfig: RanaMinderConfig = {
  server: { port: 3000, host: '0.0.0.0', gracefulShutdownTimeoutMs: 10000 },
  database: { host: 'localhost', port: 5432, name: 'test', user: 'test', schema: 'app', ssl: false, passwordRef: 'pass' },
  casdoor: { endpoint: '', clientId: '', organization: '', redirectUri: '', clientSecretRef: '' },
  storage: { endpoint: '', region: '', accessKeyRef: 'a', secretKeyRef: 's', buckets: { quarantine: 'q', primary: 'p', derived: 'd' } },
  mail: { host: 'localhost', port: 1025, fromAddress: 'no-reply@test' },
  observability: { logLevel: 'info', traceSamplingRate: 1.0 },
  job: { schedulerIntervalMs: 1000, defaultLeaseMs: 60000, maxAttempts: 5 },
};

function makeBasicRepo(tasks: Map<string, TaskRecord>): TaskRepository {
  return {
    insert: async (intent) => { const t = makeTask({ intentId: intent.intentId, taskType: intent.taskType } as any); tasks.set(t.taskId, t); return t; },
    findById: async (id) => tasks.get(id) ?? null,
    findByIntentId: async () => null,
    findByIdempotencyKey: async () => null,
    tryClaim: async (taskId, workerId, leaseUntil, leaseVersion, now) => {
      const t = tasks.get(taskId);
      if (t === undefined) return { claimed: false, task: null, reason: 'NOT_FOUND' };
      const claimed: TaskRecord = { ...t, status: TaskStatus.LEASED, lease: { workerId, leaseVersion, leaseUntil, leasedAt: now.toISOString() }, updatedAt: now.toISOString() };
      tasks.set(taskId, claimed);
      return { claimed: true, task: claimed };
    },
    updateAfterExecution: async (taskId, expectedVer, patch) => {
      const t = tasks.get(taskId);
      if (t === undefined) return null;
      if (t.status === TaskStatus.COMPLETED) return null;
      if (t.lease !== null && t.lease.leaseVersion !== expectedVer) return null;
      const updated = { ...t, ...patch, lease: patch.lease === undefined ? t.lease : patch.lease, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      tasks.set(taskId, updated);
      return updated;
    },
    listDueTaskIds: async () => [], listDeadlineTaskIds: async () => [], listExpiredLeaseTaskIds: async () => [],
    backlogSummary: async () => ({ pending: 0, leased: 0, retryableFailed: 0, uncertain: 0, manualIntervention: 0, completed: 0, perType: {} as Record<TaskType, number> }),
  } as TaskRepository;
}

describe('InMemoryTaskProcessorRegistry', () => {
  it('register/get', () => {
    const r = new InMemoryTaskProcessorRegistry();
    const h: TaskHandler = { taskType: TaskType.FILE_CHECK, handle: async () => {} };
    r.register(h);
    assert.equal(r.get(TaskType.FILE_CHECK), h);
  });
  it('unregistered undefined', () => {
    assert.equal(new InMemoryTaskProcessorRegistry().get(TaskType.CASDOOR_SYNC), undefined);
  });
  it('list returns all', () => {
    const r = new InMemoryTaskProcessorRegistry();
    r.register({ taskType: TaskType.FILE_CHECK, handle: async () => {} });
    r.register({ taskType: TaskType.CASDOOR_SYNC, handle: async () => {} });
    assert.equal(r.list().length, 2);
  });
});

describe('DevelopmentTaskPrecondition', () => {
  it('verify returns ok', async () => {
    const r = await new DevelopmentTaskPrecondition().verify(makeTask());
    assert.equal(r.ok, true);
  });
});

describe('ExternalCallAdapter', () => {
  it('call returns UNCERTAIN', async () => {
    const r = await new LogOnlyExternalCallAdapter().call(TaskType.CASDOOR_SYNC, {});
    assert.equal(r.status, ExternalStatus.UNCERTAIN);
  });
  it('readBack returns UNCERTAIN', async () => {
    const r = await new LogOnlyExternalCallAdapter().readBack(TaskType.CASDOOR_SYNC, {});
    assert.equal(r.status, ExternalStatus.UNCERTAIN);
  });
});

describe('TaskExecutionPipeline', () => {
  function makePipeline(overrides: {
    repository?: Partial<TaskRepository>;
    processors?: TaskHandler[];
    precondition?: { verify: () => Promise<{ ok: boolean; reason?: string }> };
    config?: Partial<RanaMinderConfig['job']>;
  } = {}) {
    const tasks = new Map<string, TaskRecord>();
    const repo: TaskRepository = { ...makeBasicRepo(tasks), ...overrides.repository } as TaskRepository;
    const idempotency = new InMemoryIdempotencyStore();
    const leaseMgr = new LeaseManager(repo);
    const convergence = new RecoveryReplayConvergence(repo, idempotency);
    const registry: TaskProcessorRegistry = {
      register: () => {},
      get: (type) => (overrides.processors ?? []).find((h) => h.taskType === type),
      list: () => overrides.processors ?? [],
    };
    const precondition = { verify: async () => ({ ok: true }), ...overrides.precondition };
    const config: RanaMinderConfig = { ...defaultConfig, job: { ...defaultConfig.job, ...overrides.config } };
    const pipeline = new TaskExecutionPipeline(repo, leaseMgr, convergence, registry, precondition, config);
    return { pipeline, tasks, idempotency };
  }

  it('nonexistent task returns', async () => {
    const { pipeline } = makePipeline();
    await pipeline.execute('nonexistent', 'w1', new Date());
  });

  it('completed task returns', async () => {
    const { pipeline, tasks } = makePipeline();
    tasks.set('task-1', makeTask({ taskId: 'task-1', status: TaskStatus.COMPLETED }));
    await pipeline.execute('task-1', 'w1', new Date());
    assert.equal(tasks.get('task-1')?.status, TaskStatus.COMPLETED);
  });

  it('idempotency COMPLETED -> finish', async () => {
    const { pipeline, tasks, idempotency } = makePipeline();
    const task = makeTask({ taskId: 'task-1', status: TaskStatus.PENDING, idempotencyKey: 'ik:1', intentId: 'intent-1' });
    tasks.set('task-1', task);
    await idempotency.begin('ik:1', 'intent-1');
    await idempotency.complete('ik:1', 'intent-1', 'ref://done');
    await pipeline.execute('task-1', 'w1', new Date());
    const updated = tasks.get('task-1');
    assert.equal(updated?.status, TaskStatus.COMPLETED);
    assert.equal(updated?.resultRef, 'ref://done');
  });

  it('precondition rejected -> MANUAL_INTERVENTION', async () => {
    const { pipeline, tasks } = makePipeline({ precondition: { verify: async () => ({ ok: false, reason: 'precondition rejected' }) } });
    tasks.set('task-1', makeTask({ taskId: 'task-1', status: TaskStatus.PENDING, attempts: 0 }));
    await pipeline.execute('task-1', 'w1', new Date());
    const updated = tasks.get('task-1');
    assert.equal(updated?.status, TaskStatus.MANUAL_INTERVENTION);
    assert.equal(updated?.failure?.kind, 'PRECONDITION_REJECTED');
  });

  it('no handler -> MANUAL_INTERVENTION', async () => {
    const { pipeline, tasks } = makePipeline();
    tasks.set('task-1', makeTask({ taskId: 'task-1', status: TaskStatus.PENDING, taskType: TaskType.FILE_CHECK }));
    await pipeline.execute('task-1', 'w1', new Date());
    const updated = tasks.get('task-1');
    assert.equal(updated?.status, TaskStatus.MANUAL_INTERVENTION);
    assert.ok(updated?.failure?.reason.includes('未注册'));
  });

  it('success -> COMPLETED', async () => {
    let handled = false;
    const { pipeline, tasks } = makePipeline({ processors: [{ taskType: TaskType.FILE_CHECK, handle: async () => { handled = true; } }] });
    tasks.set('task-1', makeTask({ taskId: 'task-1', status: TaskStatus.PENDING, taskType: TaskType.FILE_CHECK }));
    await pipeline.execute('task-1', 'w1', new Date());
    assert.equal(handled, true);
    const updated = tasks.get('task-1');
    assert.equal(updated?.status, TaskStatus.COMPLETED);
    assert.ok(updated?.resultRef?.startsWith('task:task-1:completed:'));
  });

  it('failure retryable -> RETRYABLE_FAILED', async () => {
    const { pipeline, tasks } = makePipeline({ processors: [{ taskType: TaskType.FILE_CHECK, handle: async () => { throw new Error('fail'); } }] });
    const now = new Date();
    tasks.set('task-1', makeTask({ taskId: 'task-1', status: TaskStatus.PENDING, taskType: TaskType.FILE_CHECK, attempts: 0, maxAttempts: 5 }));
    await pipeline.execute('task-1', 'w1', now);
    const updated = tasks.get('task-1');
    assert.equal(updated?.status, TaskStatus.RETRYABLE_FAILED);
    assert.equal(updated?.attempts, 1);
    assert.ok(new Date(updated?.notBefore ?? '').getTime() > now.getTime());
  });

  it('failure non-retryable -> MANUAL_INTERVENTION', async () => {
    const { pipeline, tasks } = makePipeline({ processors: [{ taskType: TaskType.FILE_CHECK, handle: async () => { throw new Error('persistent'); } }] });
    tasks.set('task-1', makeTask({ taskId: 'task-1', status: TaskStatus.PENDING, taskType: TaskType.FILE_CHECK, attempts: 4, maxAttempts: 5 }));
    await pipeline.execute('task-1', 'w1', new Date());
    const updated = tasks.get('task-1');
    assert.equal(updated?.status, TaskStatus.MANUAL_INTERVENTION);
    assert.equal(updated?.attempts, 5);
    assert.equal(updated?.failure?.kind, 'RETRY_LIMIT_EXCEEDED');
  });

  it('release version conflict does not throw', async () => {
    const { pipeline, tasks } = makePipeline({
      processors: [{ taskType: TaskType.FILE_CHECK, handle: async () => {} }],
      repository: { updateAfterExecution: async () => null },
    });
    tasks.set('task-1', makeTask({ taskId: 'task-1', status: TaskStatus.PENDING, taskType: TaskType.FILE_CHECK }));
    await pipeline.execute('task-1', 'w1', new Date());
  });
});
