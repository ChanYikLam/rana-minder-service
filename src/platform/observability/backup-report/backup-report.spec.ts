import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DefaultBackupReportService,
  NotWiredBackupReportPort,
  type BackupRecord,
  type RestoreRecord,
} from './backup-report';

describe('backup-report (DefaultBackupReportService)', () => {
  const NOW = new Date('2026-08-18T00:00:00.000Z');

  it('NotWired 桩：所有方法返回 undefined / []', async () => {
    const port = new NotWiredBackupReportPort();
    assert.equal(await port.lastBackup(), undefined);
    assert.equal(await port.lastRestore(), undefined);
    assert.deepEqual(await port.recentBackups(10), []);
    assert.deepEqual(await port.recentRestores(10), []);
  });

  it('execute 聚合空 port → snapshot 仅含 now 与空数组', async () => {
    const port = new NotWiredBackupReportPort();
    const snap = await new DefaultBackupReportService(port).execute(NOW);
    assert.equal(snap.now, NOW);
    assert.equal(snap.lastBackup, undefined);
    assert.equal(snap.lastRestore, undefined);
    assert.deepEqual(snap.recentBackups, []);
    assert.deepEqual(snap.recentRestores, []);
  });

  it('execute 聚合真实 port：lastBackup/lastRestore + recent 数组', async () => {
    const backup: BackupRecord = {
      backupId: 'b1',
      startedAt: new Date('2026-08-17T00:00:00.000Z'),
      completedAt: new Date('2026-08-17T01:00:00.000Z'),
      status: 'success',
      sizeBytes: 1024,
      location: '/var/backups/b1.tar.gz',
    };
    const restore: RestoreRecord = {
      restoreId: 'r1',
      startedAt: new Date('2026-08-18T00:00:00.000Z'),
      status: 'in-progress',
    };
    const port = {
      lastBackup: async () => backup,
      lastRestore: async () => restore,
      recentBackups: async (_l: number) => [backup],
      recentRestores: async (_l: number) => [restore],
    };
    const svc = new DefaultBackupReportService(port);
    const snap = await svc.execute(NOW);
    assert.equal(snap.lastBackup, backup);
    assert.equal(snap.lastRestore, restore);
    assert.equal(snap.recentBackups.length, 1);
    assert.equal(snap.recentRestores.length, 1);
  });

  it('limit 钳制：过大限到 100', async () => {
    let captured = -1;
    const port = {
      lastBackup: async () => undefined,
      lastRestore: async () => undefined,
      recentBackups: async (l: number) => {
        captured = l;
        return [];
      },
      recentRestores: async () => [],
    };
    await new DefaultBackupReportService(port).execute(NOW, { backupLimit: 9999 });
    assert.equal(captured, 100);
  });

  it('limit 钳制：负数归零', async () => {
    let captured = 999;
    const port = {
      lastBackup: async () => undefined,
      lastRestore: async () => undefined,
      recentBackups: async (l: number) => {
        captured = l;
        return [];
      },
      recentRestores: async () => [],
    };
    await new DefaultBackupReportService(port).execute(NOW, { backupLimit: -5 });
    assert.equal(captured, 0);
  });
});
