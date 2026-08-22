/**
 * 发件身份解析测试（NTF-008/009）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSenderIdentity, findIdentityOverrideAttempts } from './email-sender-identity';

describe('resolveSenderIdentity（NTF-008 署名）', () => {
  it('CLUB 作用域使用社团展示名与社团自己的发信账号', () => {
    const result = resolveSenderIdentity({
      scopeType: 'CLUB',
      clubDisplayName: '动漫社',
      platformDisplayName: 'RanaMinder 平台',
      clubFromAddress: 'anime@club.edu',
      platformFromAddress: 'platform@example.edu',
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.identity.displayName, '动漫社');
      assert.equal(result.identity.fromAddress, 'anime@club.edu');
      // 回复地址固定为实际发信账号（NTF-009）
      assert.equal(result.identity.replyTo, 'anime@club.edu');
    }
  });

  it('PLATFORM/JOINT 作用域使用平台名与平台账号', () => {
    const result = resolveSenderIdentity({
      scopeType: 'JOINT',
      clubDisplayName: null,
      platformDisplayName: 'RanaMinder 平台',
      clubFromAddress: null,
      platformFromAddress: 'platform@example.edu',
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.identity.displayName, 'RanaMinder 平台');
      assert.equal(result.identity.fromAddress, 'platform@example.edu');
    }
  });

  it('社团无有效发信配置时解析失败（只能发站内信，NTF-006）', () => {
    const result = resolveSenderIdentity({
      scopeType: 'CLUB',
      clubDisplayName: '动漫社',
      platformDisplayName: 'RanaMinder 平台',
      clubFromAddress: null,
      platformFromAddress: 'platform@example.edu',
    });
    assert.equal(result.ok, false);
  });
});

describe('findIdentityOverrideAttempts（NTF-008.3 模板不可覆盖身份）', () => {
  it('正文声明 From/Reply-To/Bcc 视为越权覆盖', () => {
    assert.ok(findIdentityOverrideAttempts('hello').length === 0);
    assert.ok(findIdentityOverrideAttempts('From: evil@example.com').length > 0);
    assert.ok(findIdentityOverrideAttempts('reply-to: someoneelse@example.com').length > 0);
    assert.ok(findIdentityOverrideAttempts('Bcc: victim@example.com').length > 0);
  });
});
