/**
 * HighRiskCommandGuard 单元测试（CAS-REC-003 最近 10 分钟重认证）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HighRiskCommandGuard } from './high-risk-command.guard';
import { IdentityCommandError, IdentityErrorCode } from '../errors';
import type { ReauthEvidencePort } from '../ports/reauth-evidence.port';

const now = new Date('2026-08-20T12:00:00.000Z');
const tenMinutes = 10 * 60 * 1000;

function reauthProvider(reauthAt: Date | null): ReauthEvidencePort {
  return {
    async latestReauthAt() {
      return reauthAt;
    },
    async record() {},
  };
}

describe('HighRiskCommandGuard（CAS-REC-003）', () => {
  it('10 分钟内有成功重认证证据 → 放行', async () => {
    const guard = new HighRiskCommandGuard(reauthProvider(new Date(now.getTime() - 5 * 60 * 1000)));
    await guard.assertFreshReauth('user-1', now);
  });

  it('恰好 10 分钟前 → 仍视为窗口内（边界含），仅超过窗口过期', async () => {
    const guard = new HighRiskCommandGuard(reauthProvider(new Date(now.getTime() - tenMinutes)));
    await guard.assertFreshReauth('user-1', now);
  });

  it('超过 10 分钟 → 过期拒绝（IFC-ERR-002）', async () => {
    const guard = new HighRiskCommandGuard(
      reauthProvider(new Date(now.getTime() - tenMinutes - 1)),
    );
    await assert.rejects(
      guard.assertFreshReauth('user-1', now),
      (error: unknown) =>
        error instanceof IdentityCommandError && error.code === IdentityErrorCode.REAUTH_REQUIRED,
    );
  });

  it('无重认证证据 → 拒绝（失败关闭，不因链路未接入放行）', async () => {
    const guard = new HighRiskCommandGuard(reauthProvider(null));
    await assert.rejects(
      guard.assertFreshReauth('user-1', now),
      (error: unknown) =>
        error instanceof IdentityCommandError && error.code === IdentityErrorCode.REAUTH_REQUIRED,
    );
  });
});
