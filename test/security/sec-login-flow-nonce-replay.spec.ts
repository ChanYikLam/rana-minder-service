/**
 * 安全控制独立验证：SEC-CTL-003（OIDC/登录流程关联证据失败关闭）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5（SEC-CTL-003）、
 * §6.1（防登录流程混淆所需的请求关联证据）。
 *
 * 验证路径（真实代码）：
 * - src/modules/identity/interfaces/nest/oidc-nonce-store.ts（nonce 一次性 + 时效）
 * - jose 依赖探测：eval('require') + try/catch，缺失则 t.skip（本地不可解析约束）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_NONCE_TTL_MS,
  InMemoryOidcNonceStore,
} from '../../src/modules/identity/interfaces/nest/oidc-nonce-store';

/** 可选依赖探测：禁止静态 import 未安装依赖，按约束以 eval('require')+try/catch 探测。 */
function tryRequire(id: string): unknown | null {
  try {
    return eval('require')(id);
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('SEC-CTL-003 OIDC 登录流程关联证据失败关闭', () => {
  it('SEC-CTL-003：nonce 一次性消费——同一回调重放被拒（载荷契约）', () => {
    const store = new InMemoryOidcNonceStore();
    store.issue('nonce-A');
    assert.equal(store.consume('nonce-A'), '', '首次消费成功（无载荷返回空串）');
    assert.equal(store.consume('nonce-A'), null, '重放同一 nonce 必须失败');
    assert.equal(store.consume('nonce-B'), null, '未签发 nonce 校验必须失败');
  });

  it(`SEC-CTL-003：过期 nonce 拒绝（默认 TTL ${DEFAULT_NONCE_TTL_MS}ms 常量为正）`, async () => {
    assert.ok(DEFAULT_NONCE_TTL_MS > 0);
    const store = new InMemoryOidcNonceStore();
    store.issue('nonce-expired', 1);
    await sleep(10);
    assert.equal(store.consume('nonce-expired'), null, '过期请求关联证据不得建立会话');
  });

  it('SEC-CTL-003：jose 可用时 OIDC 客户端真实模块可加载；缺失则显式跳过（依赖探测）', async (t) => {
    if (tryRequire('jose') === null) {
      t.skip('本地 jose 不可解析（按硬约束以 eval(require) 探测跳过，不在 CI 外虚报执行）');
      return;
    }
    const mod = await import('../../src/platform/casdoor/infrastructure/casdoor-oidc-client');
    assert.equal(typeof mod.CasdoorOidcClient, 'function');
    assert.ok(mod.OIDC_FETCH_TIMEOUT_MS > 0, '出站 OIDC 请求必须有超时上限');
  });
});
