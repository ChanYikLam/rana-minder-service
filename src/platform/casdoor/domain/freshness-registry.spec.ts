import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FreshnessRegistry,
  OPERATION_HIGH_RISK_COMMAND,
  OPERATION_NORMAL_PROTECTED_READ,
} from './freshness-registry';

describe('Casdoor 登记式分层新鲜度', () => {
  it('高风险命令必须实时读回', () => {
    const registry = new FreshnessRegistry();
    assert.equal(registry.requireRealTime(OPERATION_HIGH_RISK_COMMAND), true);
  });

  it('普通受保护只读允许登记为 OBSERVATION', () => {
    const registry = new FreshnessRegistry();
    const rule = registry.resolve(OPERATION_NORMAL_PROTECTED_READ);
    assert.equal(rule?.level, 'OBSERVATION');
    assert.equal(registry.requireRealTime(OPERATION_NORMAL_PROTECTED_READ), false);
  });

  it('未知操作按实时读回失败关闭', () => {
    const registry = new FreshnessRegistry();
    assert.equal(registry.requireRealTime('UNKNOWN_OPERATION'), true);
  });
});
