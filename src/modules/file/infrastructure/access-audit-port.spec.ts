import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LogOnlyAccessAudit } from './access-audit-port';
import { maskPrincipal } from '../domain/services/watermark-policy';
import { FileAccessAction } from '../domain/services/access-policy';

describe('LogOnlyAccessAudit（GOV-008/AUD-004 审计日志脱敏）', () => {
  it('审计日志对 principalId 脱敏，不打印完整主体标识', async () => {
    const audit = new LogOnlyAccessAudit();
    const logger = (audit as unknown as { logger: { log: (m: string) => void } }).logger;
    const logSpy = mock.method(logger, 'log', () => undefined);

    const principalId = 'usr_1234567890abcdef';
    await audit.report({
      action: FileAccessAction.DOWNLOAD,
      principalId,
      fileId: 'f1',
      sensitive: true,
      token: 'tok-1',
      occurredAt: '2026-01-01T00:00:00Z',
    });

    assert.equal(logSpy.mock.calls.length, 1);
    const line = String(logSpy.mock.calls[0].arguments[0]);
    // 日志中出现的是脱敏后的标识，而非完整 principalId
    assert.equal(line.includes(principalId), false, '日志不得包含完整 principalId');
    assert.equal(line.includes(maskPrincipal(principalId)), true, '日志应包含脱敏后的标识');
  });
});
