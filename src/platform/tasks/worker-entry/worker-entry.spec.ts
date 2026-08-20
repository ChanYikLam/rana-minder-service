import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TasksWorker } from './tasks-worker';
import type { RanaMinderConfig } from '../../../config';

function makeWorker(overrides: { schedulerRun?: () => Promise<void> } = {}) {
  const scheduler = { runOnce: overrides.schedulerRun ?? (async () => {}) };
  const config: RanaMinderConfig = {
    server: { port: 3000, host: '0.0.0.0', gracefulShutdownTimeoutMs: 10000 },
    database: { host: 'localhost', port: 5432, name: 'test', user: 'test', schema: 'app', ssl: false, passwordRef: 'pass' },
    casdoor: { endpoint: '', clientId: '', organization: '', redirectUri: '', clientSecretRef: '' },
    storage: { endpoint: '', region: '', accessKeyRef: 'a', secretKeyRef: 's', buckets: { quarantine: 'q', primary: 'p', derived: 'd' } },
    mail: { host: 'localhost', port: 1025, fromAddress: 'no-reply@test' },
    observability: { logLevel: 'info', traceSamplingRate: 1.0 },
    job: { schedulerIntervalMs: 1000, defaultLeaseMs: 60000, maxAttempts: 5 },
  };
  return { worker: new TasksWorker(scheduler as any, config), scheduler, config };
}

describe('TasksWorker', () => {
  it('start registers timer and avoids duplicate start', async () => {
    let calls = 0;
    const { worker } = makeWorker({ schedulerRun: async () => { calls += 1; } });
    worker.start('w1');
    assert.equal(worker['timer'] !== null, true);
    const timerBefore = worker['timer'];
    worker.start('w1');
    assert.equal(worker['timer'], timerBefore);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await worker.stop();
    assert.ok(calls >= 1);
  });

  it('start scheduler exception does not bubble', async () => {
    let calls = 0;
    const { worker } = makeWorker({
      schedulerRun: async () => {
        calls += 1;
        throw new Error('simulated scheduler failure');
      },
    });
    worker.start('w1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await worker.stop();
    assert.ok(calls >= 1);
  });

  it('stop clears timer', async () => {
    const { worker } = makeWorker();
    worker.start('w1');
    assert.notEqual(worker['timer'], null);
    await worker.stop();
    assert.equal(worker['timer'], null);
  });

  it('stop without start does not throw', async () => {
    const { worker } = makeWorker();
    await worker.stop();
    assert.equal(worker['timer'], null);
  });
});
