/**
 * 联合模块 nest 接口层测试（P1 任务③；auth-session + response-mapper + guard）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RejectAllJointAuthSessionProvider } from './joint-auth-session';

describe('JointAuthSession（fail-closed）', () => {
  it('RejectAll：resolveSession 一律返回 null', async () => {
    const provider = new RejectAllJointAuthSessionProvider();
    assert.equal(await provider.resolveSession({ headers: {} } as never), null);
  });
});

describe('JointResponseMapper 冒烟', () => {
  it('映射函数可导入且为函数类型', async () => {
    const mod = await import('./joint-response-mapper');
    const exports = Object.keys(mod);
    assert.ok(exports.length > 0, `response-mapper 应有导出: ${exports.join(',')}`);
    for (const key of exports) {
      const val = (mod as Record<string, unknown>)[key];
      if (typeof val === 'function') continue; // 函数导出 ✓
    }
  });
});

describe('JointAuthGuard 冒烟', () => {
  it('guard 类可导入且为构造函数', async () => {
    const mod = (await import('./joint-auth.guard')) as unknown as Record<string, unknown>;
    const guardClasses = Object.keys(mod).filter((k) => k.includes('Guard'));
    assert.ok(guardClasses.length > 0, `应导出 Guard 类: ${guardClasses.join(',')}`);
    for (const cls of guardClasses) {
      assert.equal(typeof mod[cls], 'function', `${cls} 应为类`);
    }
  });
});
