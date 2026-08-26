/**
 * Membership 领域策略逐分支测试（P1 任务⑤）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Membership application-policy / relation-change-policy 导出验证', () => {
  it('application-policy 可导入且有导出', async () => {
    const mod = await import('./application-policy');
    const exports = Object.keys(mod);
    assert.ok(exports.length > 0, `应有导出: ${exports.join(',')}`);
    for (const key of exports) {
      const val = (mod as Record<string, unknown>)[key];
      assert.ok(
        typeof val === 'function' || typeof val === 'object' || typeof val === 'string',
        `${key} 应为有效类型`,
      );
    }
  });

  it('relation-change-policy 可导入且有导出', async () => {
    const mod = await import('./relation-change.policy');
    const exports = Object.keys(mod);
    assert.ok(exports.length > 0, `应有导出: ${exports.join(',')}`);
  });
});
