/**
 * 通知/招新/配置/表单模块 nest 接口层测试（P1 任务③）。
 *
 * 评审修复：
 * - RejectAllNotificationAuthSessionProvider 直接导入 + 无条件断言（消除静默假阳性）
 * - 各模块 ResponseMapper 导出函数签名验证
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RejectAllNotificationAuthSessionProvider } from './notification/interfaces/notification-auth-session';

describe('NotificationAuthSession（fail-closed，评审 warning②修复）', () => {
  it('RejectAllNotificationAuthSessionProvider：resolveSession 一律返回 null', async () => {
    // 直接导入具体类（不走反射），重命名/移除将导致编译错误而非静默通过
    const provider = new RejectAllNotificationAuthSessionProvider();
    const r = await provider.resolveSession({ headers: {} } as never);
    assert.equal(r, null, '未认证请求应返回 null（fail-closed → 守卫 401）');
  });

  it('多次调用结果一致（确定性拒绝）', async () => {
    const provider = new RejectAllNotificationAuthSessionProvider();
    assert.equal(await provider.resolveSession({} as never), null);
    assert.equal(
      await provider.resolveSession({ headers: { authorization: 'Bearer x' } } as never),
      null,
    );
  });
});

describe('RecruitmentResponseMapper', () => {
  it('映射函数可导入且为函数类型', async () => {
    const mod = await import('./recruitment/interfaces/nest/recruitment-response-mapper');
    const exports = Object.keys(mod);
    assert.ok(exports.length > 0, '应有导出');
    for (const key of exports) {
      assert.equal(typeof (mod as Record<string, unknown>)[key], 'function', `${key} 应为函数`);
    }
  });
});

describe('ConfigResponseMapper', () => {
  it('映射函数可导入且为函数类型', async () => {
    const mod = await import('./config/interfaces/nest/config-response-mapper');
    const exports = Object.keys(mod);
    assert.ok(exports.length > 0, '应有导出');
    for (const key of exports) {
      assert.equal(typeof (mod as Record<string, unknown>)[key], 'function', `${key} 应为函数`);
    }
  });
});

describe('FormResponseMapper', () => {
  it('映射函数可导入且为函数类型', async () => {
    const mod = await import('./form/interfaces/nest/form-response-mapper');
    const exports = Object.keys(mod);
    assert.ok(exports.length > 0, '应有导出');
    for (const key of exports) {
      assert.equal(typeof (mod as Record<string, unknown>)[key], 'function', `${key} 应为函数`);
    }
  });
});

describe('Config AuthGuard / Form AuthGuard 类可导入', () => {
  it('config-auth.guard 导出 Guard 类', async () => {
    const mod = (await import('./config/interfaces/nest/config-auth.guard')) as unknown as Record<
      string,
      unknown
    >;
    const guards = Object.keys(mod).filter((k) => k.includes('Guard'));
    assert.ok(guards.length > 0, `应有 Guard 类: ${guards.join(',')}`);
  });

  it('form-auth.guard 导出 Guard 类', async () => {
    const mod = (await import('./form/interfaces/nest/form-auth.guard')) as unknown as Record<
      string,
      unknown
    >;
    const guards = Object.keys(mod).filter((k) => k.includes('Guard'));
    assert.ok(guards.length > 0, `应有 Guard 类: ${guards.join(',')}`);
  });
});
