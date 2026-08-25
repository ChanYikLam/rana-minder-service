/**
 * 安全控制独立验证：SEC-CTL-007 / SEC-CTL-008（高风险命令重新认证边界）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5、§6.3；
 * CAS-REC-003（最近 10 分钟重认证窗口）。
 *
 * 验证路径（真实代码，端口级假证据源，无 pg/jose 依赖）：
 * - src/modules/identity/application/services/high-risk-command.guard.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  HIGH_RISK_REAUTH_WINDOW_MS,
  HighRiskCommandGuard,
} from '../../src/modules/identity/application/services/high-risk-command.guard';
import type { ReauthEvidencePort } from '../../src/modules/identity/application/ports/reauth-evidence.port';

/** 按主体记录最近重认证时刻的假证据源（只存时间戳与会话引用，不存令牌）。 */
function fakeEvidence(records: Record<string, Date | null>): ReauthEvidencePort & {
  queried: string[];
} {
  const queried: string[] = [];
  return {
    queried,
    async latestReauthAt(subjectId: string) {
      queried.push(subjectId);
      return records[subjectId] ?? null;
    },
    async record(subjectId: string, at: Date) {
      records[subjectId] = at;
    },
  };
}

const NOW = new Date('2026-08-24T10:00:00Z');

describe('SEC-CTL-007 高风险命令前置校验失败关闭', () => {
  it(`SEC-CTL-007：缺失重新认证证据一律拒绝（IFC-ERR-002）`, async () => {
    const guard = new HighRiskCommandGuard(fakeEvidence({}));
    await assert.rejects(guard.assertFreshReauth('u1', NOW), (err: unknown) => {
      assert.equal((err as { code?: string })['code'], 'IFC-ERR-002');
      return true;
    });
  });

  it(`SEC-CTL-007：超过 ${HIGH_RISK_REAUTH_WINDOW_MS}ms 窗口的证据过期拒绝；恰在窗口内放行`, async () => {
    const stale = new Date(NOW.getTime() - HIGH_RISK_REAUTH_WINDOW_MS - 1);
    const freshBoundary = new Date(NOW.getTime() - HIGH_RISK_REAUTH_WINDOW_MS);

    const guardStale = new HighRiskCommandGuard(fakeEvidence({ u1: stale }));
    await assert.rejects(guardStale.assertFreshReauth('u1', NOW), /重新认证/);

    const guardFresh = new HighRiskCommandGuard(fakeEvidence({ u1: freshBoundary }));
    await assert.doesNotReject(guardFresh.assertFreshReauth('u1', NOW));
  });

  it('SEC-CTL-007：证据源故障（抛错/返回 null）按未认证处理，不因异常放行', async () => {
    const broken: ReauthEvidencePort = {
      latestReauthAt: async () => {
        throw new Error('evidence-store-down');
      },
      record: async () => undefined,
    };
    await assert.rejects(new HighRiskCommandGuard(broken).assertFreshReauth('u1', NOW));
  });
});

describe('SEC-CTL-008 重认证证据绑定主体', () => {
  it('SEC-CTL-008：证据按主体隔离——A 的新鲜证据不能替代 B 的缺失证据', async () => {
    const evidence = fakeEvidence({ 'user-A': new Date(NOW.getTime() - 60_000) });
    const guard = new HighRiskCommandGuard(evidence);

    await assert.doesNotReject(guard.assertFreshReauth('user-A', NOW));
    await assert.rejects(guard.assertFreshReauth('user-B', NOW), /重新认证/);
    assert.deepEqual(evidence.queried, ['user-A', 'user-B'], '每次校验必须回查当前主体自身证据');
  });

  it('SEC-CTL-008：客户端自报时间不可用——证据时刻只能来自服务端登记的认证链路', async () => {
    const evidence = fakeEvidence({});
    const guard = new HighRiskCommandGuard(evidence);
    // 客户端声称"刚刚"重新认证过：端口不接受任何调用方传入的认证时刻
    await assert.rejects(guard.assertFreshReauth('u1', NOW), (err: unknown) => {
      assert.equal((err as { code?: string })['code'], 'IFC-ERR-002');
      return true;
    });
    // 只有认证链路显式登记后才产生有效证据
    await evidence.record('u1', new Date(NOW.getTime() - 30_000));
    await assert.doesNotReject(guard.assertFreshReauth('u1', NOW));
  });
});
