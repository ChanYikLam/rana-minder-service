import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultHealthSummaryService } from './health-summary';
import {
  DefaultStatusSummaryQueryService,
} from '../status-page/status-summary-query.service';
import { ProcessAppStatusPort } from '../status-page/app-status';
import { NotWiredDbStatusPort } from '../status-page/db-status';
import { NotWiredTaskSummaryPort } from '../status-page/task-summary';
import { NotWiredDepLatestPort } from '../status-page/dep-latest';

describe('health-summary (DefaultHealthSummaryService)', () => {
  const NOW = new Date('2026-08-18T00:00:00.000Z');
  const started = new Date('2026-08-17T00:00:00.000Z');

  const makeService = () => {
    const query = new DefaultStatusSummaryQueryService(
      new ProcessAppStatusPort('1.0.0', started),
      new NotWiredDbStatusPort(),
      new NotWiredTaskSummaryPort(),
      new NotWiredDepLatestPort(),
    );
    return new DefaultHealthSummaryService(query);
  };

  it('所有 stub 都 unknown（app/task 自身 fresh）→ overall=degraded', async () => {
    const view = await makeService().execute(NOW);
    assert.equal(view.overall, 'degraded');
    assert.equal(view.subsystems.length, 8);
  });

  it('app / task 始终 fresh；其余取决于 stub', async () => {
    const view = await makeService().execute(NOW);
    const byName = Object.fromEntries(view.subsystems.map((s) => [s.name, s.state]));
    assert.equal(byName['app'], 'fresh');
    assert.equal(byName['task'], 'fresh');
    assert.equal(byName['db'], 'unknown');
    assert.equal(byName['casdoor'], 'unknown');
  });

  it('subsystems 列表包含全部 8 个（app/db/task + 5 deps）', async () => {
    const view = await makeService().execute(NOW);
    const names = view.subsystems.map((s) => s.name).sort();
    assert.deepEqual(names, ['app', 'backup', 'casdoor', 'db', 'file-check', 'mail', 'notify', 'task']);
  });

  it('app 字段始终 fresh（snapshot 必有）', async () => {
    const view = await makeService().execute(NOW);
    const app = view.subsystems.find((s) => s.name === 'app');
    assert.equal(app?.state, 'fresh');
  });
});