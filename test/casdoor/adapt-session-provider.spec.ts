/**
 * adaptSessionProvider 模块会话适配器测试（B3 会话地基）。
 *
 * 契约锚点：
 * - identity AuthSession（subjectId/now/mailCapable）→ 各模块最小会话
 *   {subjectId, now} 的**投影映射**：模块自有类型是同一形状的子集，
 *   适配层不得泄漏多余字段（最小披露，API-GEN-005 同源原则）；
 * - null 透传：identity 无法认证（fail-closed）时模块侧同样得到 null → 守卫 401。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  adaptSessionProvider,
  type MinimalSessionProvider,
} from '../../src/shared/adapt-session-provider';
import type {
  AuthSession,
  AuthSessionProvider,
} from '../../src/modules/identity/interfaces/nest/auth-session';

interface StubModuleSession {
  readonly subjectId: string;
  readonly now: Date;
}

function identityProvider(
  returned: AuthSession | null,
  seenRequests: unknown[] = [],
): AuthSessionProvider {
  return {
    async resolveSession(request) {
      seenRequests.push(request);
      return returned;
    },
  };
}

describe('adaptSessionProvider 映射（AuthSession → 模块最小会话）', () => {
  it('成功会话 → 投影为恰好 {subjectId, now} 两字段（mailCapable 不下泄）', async () => {
    const now = new Date('2026-08-25T09:30:00.000Z');
    const identity = identityProvider({
      subjectId: 'u_1001',
      now,
      mailCapable: true,
    });
    const adapted: MinimalSessionProvider<StubModuleSession> =
      adaptSessionProvider<StubModuleSession>(identity);

    const session = await adapted.resolveSession({ some: 'request' });
    assert.ok(session);
    assert.deepEqual(session, { subjectId: 'u_1001', now });
    // 最小形状：无任何额外键
    assert.deepEqual(Object.keys(session).sort(), ['now', 'subjectId']);
  });

  it('now 为同一 Date 实例引用透传（服务端时间单一来源，不被适配层重造）', async () => {
    const now = new Date('2026-08-25T00:00:00.000Z');
    const adapted = adaptSessionProvider<StubModuleSession>(identityProvider({ subjectId: 's', now }));
    const session = await adapted.resolveSession(null);
    assert.equal(session?.now, now);
  });

  it('null 透传：identity 拒绝 → 模块侧同样 null（fail-closed 链路不断裂）', async () => {
    const adapted = adaptSessionProvider<StubModuleSession>(identityProvider(null));
    assert.equal(await adapted.resolveSession({ any: true }), null);
  });
});

describe('adaptSessionProvider 请求转发', () => {
  it('原始 request 对象原样传给 identity 会话源（不做包装/裁剪）', async () => {
    const seen: unknown[] = [];
    const request = { headers: { authorization: 'Bearer token-x' }, url: '/api/org/1/forms' };
    const adapted = adaptSessionProvider<StubModuleSession>(
      identityProvider({ subjectId: 'u', now: new Date(0) }, seen),
    );
    await adapted.resolveSession(request);
    assert.equal(seen.length, 1);
    assert.equal(seen[0], request);
  });
});
