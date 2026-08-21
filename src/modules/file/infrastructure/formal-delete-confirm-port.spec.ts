import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LogOnlyFormalDeleteConfirm } from './formal-delete-confirm-port';

describe('LogOnlyFormalDeleteConfirm（AUD-008 二次确认核验占位）', () => {
  it('占位 fail-closed：未接入真实签发方前一律拒绝放行', async () => {
    const confirm = new LogOnlyFormalDeleteConfirm();
    assert.equal(await confirm.verify('CONF-001'), false, '占位期核验不通过（fail-closed）');
    assert.equal(await confirm.verify('ab'), false, '短凭据同样拒绝');
  });

  it('核验日志不打印完整凭据（GOV-008 脱敏口径）', async () => {
    const confirm = new LogOnlyFormalDeleteConfirm();
    const logger = (confirm as unknown as { logger: { log: (m: string) => void } }).logger;
    const logSpy = mock.method(logger, 'log', () => undefined);

    await confirm.verify('CONF-001');
    assert.equal(logSpy.mock.calls.length, 1);
    const line = String(logSpy.mock.calls[0].arguments[0]);
    assert.equal(line.includes('CONF-001'), false, '日志不得泄露完整凭据');
    assert.equal(line.includes('len='), true, '日志仅记录脱敏长度信息');
  });
});
