/**
 * 安全控制独立验证：SEC-CTL-024 / SEC-CTL-025（外部结果不确定与读回收敛）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5、§14；
 * CAS-WR-006~010 / CAS-REC-001（写后读回分类）、CAS-Q-002（分层新鲜度）。
 *
 * 验证路径（真实纯函数，无 pg/jose 依赖）：
 * - src/platform/casdoor/domain/result-classifier.ts
 * - src/platform/casdoor/domain/freshness-registry.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyMembershipReadback,
  classifyProfileReadback,
} from '../../src/platform/casdoor/domain/result-classifier';
import {
  FreshnessLevel,
  FreshnessRegistry,
  OPERATION_HIGH_RISK_COMMAND,
  OPERATION_LOGIN_SESSION,
  OPERATION_NORMAL_PROTECTED_READ,
} from '../../src/platform/casdoor/domain/freshness-registry';

describe('SEC-CTL-024 外部结果不确定不宣称成功', () => {
  it('SEC-CTL-024：读回状态不可信时一律 UNKNOWN（不得当作成功或失败收口）', () => {
    const verdict = classifyMembershipReadback({
      originalMemberIds: ['m1'],
      expectedMemberIds: ['m1', 'm2'],
      readbackMemberIds: ['m1', 'm2'],
      readbackStatus: 'STALE',
    });
    assert.equal(verdict, 'UNKNOWN');

    assert.equal(
      classifyProfileReadback({
        originalValue: 'a',
        expectedValue: 'b',
        readbackValue: 'b',
        readbackStatus: 'CACHED',
      }),
      'UNKNOWN',
    );
  });

  it('SEC-CTL-024：可信读回等于期望 → TARGET；等于原值 → ORIGINAL；第三方值 → THIRD', () => {
    assert.equal(
      classifyMembershipReadback({
        originalMemberIds: ['m1'],
        expectedMemberIds: ['m1', 'm2'],
        readbackMemberIds: ['m2', 'm1'],
        readbackStatus: 'TRUSTED_CURRENT',
      }),
      'TARGET',
    );
    assert.equal(
      classifyMembershipReadback({
        originalMemberIds: ['m1', 'm3'],
        expectedMemberIds: ['m1', 'm2'],
        readbackMemberIds: ['m1', 'm3'],
        readbackStatus: 'TRUSTED_CURRENT',
      }),
      'ORIGINAL',
    );
    assert.equal(
      classifyMembershipReadback({
        originalMemberIds: ['m1'],
        expectedMemberIds: ['m1', 'm2'],
        readbackMemberIds: ['m1', 'mX'],
        readbackStatus: 'TRUSTED_CURRENT',
      }),
      'THIRD',
    );
  });

  it('SEC-CTL-024：应移除成员仍残留读回且期望未齐 → PARTIAL（撤权未完成，不宣称完成）', () => {
    const verdict = classifyMembershipReadback({
      originalMemberIds: ['m9'],
      expectedMemberIds: ['m1', 'm2'],
      readbackMemberIds: ['m1', 'm9'],
      readbackStatus: 'TRUSTED_CURRENT',
    });
    assert.equal(verdict, 'PARTIAL');
  });

  it('SEC-CTL-024：NOT_FOUND 明确区分，不与 UNKNOWN 混同', () => {
    assert.equal(
      classifyProfileReadback({
        originalValue: null,
        expectedValue: null,
        readbackValue: null,
        readbackStatus: 'NOT_FOUND',
      }),
      'NOT_FOUND',
    );
  });
});

describe('SEC-CTL-025 登记式新鲜度：未知操作失败关闭、高风险强制实时', () => {
  it('SEC-CTL-025：未登记操作按实时读回失败关闭（调用方不可自选等级）', () => {
    const registry = new FreshnessRegistry();
    assert.equal(registry.resolve('TOTALLY_UNKNOWN_OP'), null);
    assert.equal(registry.requireRealTime('TOTALLY_UNKNOWN_OP'), true);
  });

  it('SEC-CTL-025：登录会话与高风险命令强制 REAL_TIME；普通受保护读允许受限观察窗口', () => {
    const registry = new FreshnessRegistry();
    assert.equal(registry.requireRealTime(OPERATION_LOGIN_SESSION), true);
    assert.equal(registry.requireRealTime(OPERATION_HIGH_RISK_COMMAND), true);

    const normal = registry.resolve(OPERATION_NORMAL_PROTECTED_READ);
    assert.notEqual(normal, null);
    assert.equal(normal?.level, FreshnessLevel.OBSERVATION);
    assert.ok((normal?.maxObservationAgeMs ?? 0) > 0, '观察级必须声明最大时效');
  });

  it('SEC-CTL-025：重复登记同一操作被拒绝（目录受控，不可被运行时覆盖）', () => {
    const registry = new FreshnessRegistry();
    assert.throws(() =>
      registry.register({
        operation: OPERATION_HIGH_RISK_COMMAND,
        level: FreshnessLevel.OBSERVATION,
      }),
    );
  });
});
