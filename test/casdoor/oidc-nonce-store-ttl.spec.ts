/**
 * OIDC nonce 服务端存储测试（CAS-CAP-004 会话固定/登录 CSRF 防护）。
 *
 * 契约锚点：
 * - `CAS-CAP-004`（令牌、Claims 与 UserInfo 的主体绑定）：nonce 必须由服务端签发、
 *   一次性消费；未签发/已消费/过期一律拒绝；
 * - PKCE 载荷语义（2026-08-28 加固）：consume 返回签发时绑定的服务端私有载荷
 *   （未携带载荷为空串），无效/过期/已消费返回 null——一次性消费与载荷取回
 *   同一原子操作；
 * - `CAS-EVT-*` 反向印证：外部不可信输入不得绕过本地签发校验。
 *
 * 被测：InMemoryOidcNonceStore（oidc-nonce-store.ts）。
 * 确定性：该实现内部直接读 Date.now()，本测试通过临时替换 Date.now 注入时钟，
 * 无真实等待，TTL 边界精确可控。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryOidcNonceStore,
  DEFAULT_NONCE_TTL_MS,
} from '../../src/modules/identity/interfaces/nest/oidc-nonce-store';

/** 注入固定时钟：在 fn 执行期间 Date.now() 恒返回 atMs。 */
function withFrozenClock(atMs: number, fn: () => void): void {
  const real = Date.now;
  Date.now = () => atMs;
  try {
    fn();
  } finally {
    Date.now = real;
  }
}

describe('OidcNonceStore 一次性消费（CAS-CAP-004 回调单次有效）', () => {
  it('签发后首次消费成功（无载荷返回空串）', () => {
    withFrozenClock(1_000_000, () => {
      const store = new InMemoryOidcNonceStore();
      store.issue('nonce-alpha');
      assert.equal(store.consume('nonce-alpha'), '');
    });
  });

  it('重放拒绝：同一 nonce 第二次消费返回 null（「我确实签发过」且只允许一次）', () => {
    withFrozenClock(1_000_000, () => {
      const store = new InMemoryOidcNonceStore();
      store.issue('nonce-replay');
      assert.equal(store.consume('nonce-replay'), '');
      // 攻击者重放同一回调（同 state/nonce）
      assert.equal(store.consume('nonce-replay'), null);
      assert.equal(store.consume('nonce-replay'), null);
    });
  });

  it('未签发的 nonce 拒绝消费（伪造 state / 登录 CSRF）', () => {
    withFrozenClock(1_000_000, () => {
      const store = new InMemoryOidcNonceStore();
      assert.equal(store.consume('never-issued-by-this-service'), null);
    });
  });

  it('不同 nonce 互不影响（一次签发不授权其他 nonce）', () => {
    withFrozenClock(1_000_000, () => {
      const store = new InMemoryOidcNonceStore();
      store.issue('nonce-a');
      assert.equal(store.consume('nonce-b'), null);
      assert.equal(store.consume('nonce-a'), '');
    });
  });

  it('PKCE 载荷随消费一次性取回（verifier 与 nonce 绑定，不可二次取回）', () => {
    withFrozenClock(1_000_000, () => {
      const store = new InMemoryOidcNonceStore();
      store.issue('nonce-pkce', undefined, 'code-verifier-abc');
      assert.equal(store.consume('nonce-pkce'), 'code-verifier-abc');
      assert.equal(store.consume('nonce-pkce'), null);
    });
  });
});

describe('OidcNonceStore TTL 过期（确定性时钟注入）', () => {
  const T0 = 1_700_000_000_000;

  it('默认 TTL 为 10 分钟（与 Casdoor 授权码流程典型生命周期对齐）', () => {
    assert.equal(DEFAULT_NONCE_TTL_MS, 10 * 60 * 1000);
  });

  it('TTL 内消费成功；恰好到达 TTL 边界（now - issuedAt == ttl）仍有效', () => {
    withFrozenClock(T0, () => {
      const store = new InMemoryOidcNonceStore();
      store.issue('nonce-edge');
      withFrozenClock(T0 + DEFAULT_NONCE_TTL_MS, () => {
        assert.equal(store.consume('nonce-edge'), '');
      });
    });
  });

  it('TTL 内消费成功（默认 10 分钟窗口中段）', () => {
    const store = new InMemoryOidcNonceStore();
    withFrozenClock(T0, () => store.issue('nonce-late'));
    withFrozenClock(T0 + 5 * 60 * 1000, () => {
      assert.equal(store.consume('nonce-late'), '');
    });
  });

  it('超时 1ms 即失效（边界严格：now - issuedAt > ttl → null）', () => {
    const store = new InMemoryOidcNonceStore();
    withFrozenClock(T0, () => store.issue('nonce-expired'));
    withFrozenClock(T0 + DEFAULT_NONCE_TTL_MS + 1, () => {
      assert.equal(store.consume('nonce-expired'), null);
    });
  });

  it('自定义短 TTL 生效（issue 的第二参数控制有效期）', () => {
    const store = new InMemoryOidcNonceStore();
    withFrozenClock(T0, () => store.issue('nonce-short', 5_000));
    withFrozenClock(T0 + 5_000, () => {
      assert.equal(store.consume('nonce-short'), '');
    });
    withFrozenClock(T0 + 5_001, () => {
      assert.equal(store.consume('nonce-short'), null);
    });
  });

  it('重放发生在过期之后同样拒绝（一次性 ∧ TTL 双重约束取交集）', () => {
    const store = new InMemoryOidcNonceStore();
    withFrozenClock(T0, () => store.issue('nonce-both'));
    withFrozenClock(T0 + 1_000, () => {
      assert.equal(store.consume('nonce-both'), ''); // 首次合法消费
    });
    withFrozenClock(T0 + 2_000, () => {
      assert.equal(store.consume('nonce-both'), null); // 重放
    });
  });
});
