/**
 * 通知/招新/配置/表单模块 nest 接口层冒烟测试（P1 任务③）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('NotificationAuthGuard（已有 spec 补充：RejectAll 会话）', () => {
  it('通知认证会话类型存在且 RejectAll 返回 null', async () => {
    const mod = await import('./notification/interfaces/notification-auth-session');
    const classes = Object.keys(mod).filter((k) => k.includes('Reject') || k.includes('Session'));
    assert.ok(classes.length > 0);
    const rejectCls = classes.find((k) => k.includes('Reject'));
    if (rejectCls) {
      const inst = new (
        mod as Record<string, new (...a: never[]) => { resolveSession(r: unknown): Promise<null> }>
      )[rejectCls]();
      assert.equal(await inst.resolveSession({}), null);
    }
  });
});

describe('RecruitmentResponseMapper', () => {
  it('映射函数可导入且为函数类型', async () => {
    const mod = await import('./recruitment/interfaces/nest/recruitment-response-mapper');
    const exports = Object.keys(mod);
    assert.ok(exports.length > 0);
    for (const key of exports) {
      assert.equal(typeof (mod as Record<string, unknown>)[key], 'function');
    }
  });
});

describe('ConfigResponseMapper', () => {
  it('映射函数可导入且为函数类型', async () => {
    const mod = await import('./config/interfaces/nest/config-response-mapper');
    const exports = Object.keys(mod);
    assert.ok(exports.length > 0);
    for (const key of exports) {
      assert.equal(typeof (mod as Record<string, unknown>)[key], 'function');
    }
  });
});

describe('FormResponseMapper', () => {
  it('映射函数可导入且为函数类型', async () => {
    const mod = await import('./form/interfaces/nest/form-response-mapper');
    const exports = Object.keys(mod);
    assert.ok(exports.length > 0);
    for (const key of exports) {
      assert.equal(typeof (mod as Record<string, unknown>)[key], 'function');
    }
  });
});

describe('Config AuthGuard / Form AuthGuard 类可导入', () => {
  it('config-auth.guard 导出 Guard 类', async () => {
    const mod = await import('./config/interfaces/nest/config-auth.guard');
    const guards = Object.keys(mod).filter((k) => k.includes('Guard'));
    assert.ok(guards.length > 0);
  });

  it('form-auth.guard 导出 Guard 类', async () => {
    const mod = await import('./form/interfaces/nest/form-auth.guard');
    const guards = Object.keys(mod).filter((k) => k.includes('Guard'));
    assert.ok(guards.length > 0);
  });
});
