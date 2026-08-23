/**
 * NotWiredDbAdapter 单测（P2 零覆盖补测：未连接态失败关闭）。
 *
 * 契约：全部数据库操作一律抛 DbUnavailableError——不静默成功、不返回伪造数据；
 * 业务命令在 UoW 事务边界内失败即整体回滚（ADR-005）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DbUnavailableError, NotWiredDbAdapter } from './not-wired-db.adapter';
import type { RlsScope, TransactionContext } from '../../shared/db-adapter';

describe('NotWiredDbAdapter（fail-closed 桩）', () => {
  const adapter = new NotWiredDbAdapter();
  const tx = { id: 'tx-0' } as TransactionContext;
  const scope: RlsScope = { kind: 'unprotected' };

  const methods: Array<[string, () => Promise<unknown>]> = [
    ['beginTransaction', () => adapter.beginTransaction()],
    ['commit', () => adapter.commit(tx)],
    ['rollback', () => adapter.rollback(tx)],
    ['setRlsContext', () => adapter.setRlsContext(tx, scope)],
    ['clearRlsContext', () => adapter.clearRlsContext(tx)],
    ['query', () => adapter.query(tx, 'SELECT 1', [])],
  ];

  for (const [name, fn] of methods) {
    it(`${name}() 抛 DbUnavailableError（不静默成功）`, async () => {
      await assert.rejects(fn, (err: unknown) => err instanceof DbUnavailableError);
    });
  }

  it('错误消息指向"未连接"，可被上层识别为依赖不可用', async () => {
    await assert.rejects(() => adapter.beginTransaction(), /未连接/);
  });
});
