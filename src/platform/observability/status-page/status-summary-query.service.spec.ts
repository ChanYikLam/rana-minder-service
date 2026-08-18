import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DefaultStatusSummaryQueryService,
  type StatusSourceView,
} from './status-summary-query.service';
import { DefaultStaleUnknownRule } from './stale-unknown';
import {
  ProcessAppStatusPort,
} from './app-status';
import {
  NotWiredDbStatusPort,
  type DbPingResult,
} from './db-status';
import {
  NotWiredTaskSummaryPort,
} from './task-summary';
import {
  NotWiredDepLatestPort,
  type DepLatest,
} from './dep-latest';

class FakeDbStatusPort {
  constructor(private readonly result: DbPingResult) {}
  async ping(): Promise<DbPingResult> { return this.result; }
}

class FakeDepLatestPort {
  constructor(private readonly map: Partial<Record<'casdoor' | 'mail' | 'file-check' | 'notify' | 'backup', DepLatest>>) {}
  async latest(dep: 'casdoor' | 'mail' | 'file-check' | 'notify' | 'backup'): Promise<DepLatest> {
    return this.map[dep] ?? { state: 'unknown' };
  }
}

describe('status-summary-query (DefaultStatusSummaryQueryService)', () => {
  const NOW = new Date('2026-08-18T00:00:00.000Z');
  const started = new Date('2026-08-17T00:00:00.000Z');
  const app = new ProcessAppStatusPort('1.0.0', started);

  it('app snapshot 包含 version / startedAt / uptimeMs', async () => {
    const svc = new DefaultStatusSummaryQueryService(
      app,
      new NotWiredDbStatusPort(),
      new NotWiredTaskSummaryPort(),
      new NotWiredDepLatestPort(),
    );
    const view = await svc.execute(NOW);
    assert.equal(view.app.version, '1.0.0');
    assert.equal(view.app.uptimeMs, 24 * 60 * 60 * 1000);
  });

  it('db ping 失败 → state=unknown 带 data.error', async () => {
    const svc = new DefaultStatusSummaryQueryService(
      app,
      new NotWiredDbStatusPort(),
      new NotWiredTaskSummaryPort(),
      new NotWiredDepLatestPort(),
    );
    const view = await svc.execute(NOW);
    assert.equal(view.db.state, 'unknown');
    assert.ok((view.db.data as DbPingResult).ok === false);
  });

  it('db ping 成功 → state=fresh + ageMs=0', async () => {
    const svc = new DefaultStatusSummaryQueryService(
      app,
      new FakeDbStatusPort({ ok: true, latencyMs: 5 }) as never,
      new NotWiredTaskSummaryPort(),
      new NotWiredDepLatestPort(),
    );
    const view = await svc.execute(NOW);
    assert.equal(view.db.state, 'fresh');
    assert.equal(view.db.ageMs, 0);
  });

  it('dep lastCheckedAt 过期 → state=stale', async () => {
    const stale = new Date(NOW.getTime() - 10 * 60_000);
    const dep = new FakeDepLatestPort({
      backup: { state: 'fresh', lastCheckedAt: stale, lastResult: 'success' },
    });
    const svc = new DefaultStatusSummaryQueryService(
      app,
      new NotWiredDbStatusPort(),
      new NotWiredTaskSummaryPort(),
      dep as never,
    );
    const view = await svc.execute(NOW);
    const backupView: StatusSourceView<DepLatest> = view.deps.backup;
    assert.equal(backupView.state, 'stale');
    assert.ok(backupView.ageMs !== undefined && backupView.ageMs > 0);
  });

  it('dep lastCheckedAt 在阈值内 → state=fresh', async () => {
    const recent = new Date(NOW.getTime() - 30_000);
    const dep = new FakeDepLatestPort({
      casdoor: { state: 'fresh', lastCheckedAt: recent, lastResult: 'success' },
    });
    const svc = new DefaultStatusSummaryQueryService(
      app,
      new NotWiredDbStatusPort(),
      new NotWiredTaskSummaryPort(),
      dep as never,
    );
    const view = await svc.execute(NOW);
    assert.equal(view.deps.casdoor.state, 'fresh');
  });

  it('未提供 dep → state=unknown', async () => {
    const svc = new DefaultStatusSummaryQueryService(
      app,
      new NotWiredDbStatusPort(),
      new NotWiredTaskSummaryPort(),
      new NotWiredDepLatestPort(),
    );
    const view = await svc.execute(NOW);
    for (const k of ['casdoor', 'mail', 'file-check', 'notify', 'backup'] as const) {
      assert.equal(view.deps[k].state, 'unknown');
    }
  });

  it('注入自定义 rule：自定义阈值生效', async () => {
    const recent = new Date(NOW.getTime() - 500);
    const dep = new FakeDepLatestPort({
      mail: { state: 'fresh', lastCheckedAt: recent, lastResult: 'success' },
    });
    const svc = new DefaultStatusSummaryQueryService(
      app,
      new NotWiredDbStatusPort(),
      new NotWiredTaskSummaryPort(),
      dep as never,
      new DefaultStaleUnknownRule(),
    );
    const view = await svc.execute(NOW, { staleMs: { dep: 100 } });
    assert.equal(view.deps.mail.state, 'stale');
  });
});