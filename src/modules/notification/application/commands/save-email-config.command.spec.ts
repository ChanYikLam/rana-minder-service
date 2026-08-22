/**
 * 邮件配置命令测试（NTF-006）。
 * 覆盖：权限（负责人/超管任一方可配置；人事与部门负责人无权）、
 * 密钥加密落库不明文、关键变更后必须重测、轮换失效、审计写入。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryEmailConfigStore, AesGcmEmailSecretCipher } from '../../infrastructure';
import type { PrivilegedAuditEntry, PrivilegedAuditWriter } from '../../infrastructure';
import {
  SaveEmailConfigCommand,
  EmailConfigPermissionError,
  type EmailConfigActor,
} from './save-email-config.command';
import { TestEmailConfigCommand } from './test-email-config.command';
import { RotateEmailKeyCommand } from './rotate-email-key.command';

class RecordingAudit implements PrivilegedAuditWriter {
  public entries: PrivilegedAuditEntry[] = [];
  async write(entry: PrivilegedAuditEntry): Promise<string> {
    this.entries.push(entry);
    return 'audit-' + this.entries.length;
  }
}

class StubAdapter {
  public next = 'SENT' as const;
  async send() {
    return { status: this.next, channelMessageId: 'm1', sanitizedError: null };
  }
}

describe('SaveEmailConfigCommand（NTF-006 社团发信密钥）', () => {
  let configs: InMemoryEmailConfigStore;
  let cipher: AesGcmEmailSecretCipher;
  let audit: RecordingAudit;
  let save: SaveEmailConfigCommand;
  const leader: EmailConfigActor = {
    userId: 'leader-1',
    displayName: '负责人',
    isPlatformAdmin: false,
    permissions: ['club:email:config'],
  };
  const hr: EmailConfigActor = {
    userId: 'hr-1',
    displayName: '人事',
    isPlatformAdmin: false,
    permissions: ['club:config:manage'],
  };

  beforeEach(() => {
    configs = new InMemoryEmailConfigStore();
    cipher = new AesGcmEmailSecretCipher();
    audit = new RecordingAudit();
    save = new SaveEmailConfigCommand(configs, cipher, audit);
  });

  it('负责人保存：密钥加密落库，存储中无明文', async () => {
    await save.execute({
      scope: { type: 'CLUB', clubId: 'club-1' },
      actor: leader,
      smtpHost: 'smtp.x.edu',
      smtpUser: 'club@x.edu',
      fromName: '社团',
      smtpSecret: 'plain-secret-123',
    });
    const stored = await configs.findByClub('club-1');
    assert.ok(stored?.secretCiphertext);
    assert.ok(!JSON.stringify(stored).includes('plain-secret-123'), '不得明文存储');
    assert.equal(cipher.decrypt(stored!.secretCiphertext!), 'plain-secret-123');
    assert.equal(stored!.verified, false, '新配置未验证');
    // 审计含操作者且不含密钥
    assert.equal(audit.entries.length, 1);
    assert.ok(!JSON.stringify(audit.entries[0]).includes('plain-secret-123'));
  });

  it('人事无权配置；超管任一方可单独配置（NTF-006.6）', async () => {
    await assert.rejects(
      () =>
        save.execute({
          scope: { type: 'CLUB', clubId: 'club-1' },
          actor: hr,
          smtpHost: 'smtp.x.edu',
          smtpUser: 'club@x.edu',
          fromName: '社团',
          smtpSecret: 'pw',
        }),
      (error: unknown) => error instanceof EmailConfigPermissionError,
    );
    await assert.doesNotReject(() =>
      save.execute({
        scope: { type: 'CLUB', clubId: 'club-1' },
        actor: { userId: 'super-1', displayName: '超管', isPlatformAdmin: true },
        smtpHost: 'smtp.x.edu',
        smtpUser: 'club@x.edu',
        fromName: '社团',
        smtpSecret: 'pw',
      }),
    );
  });

  it('关键信息变更后 verified 重置为 false（须重新测试启用）', async () => {
    const first = await save.execute({
      scope: { type: 'CLUB', clubId: 'club-1' },
      actor: leader,
      smtpHost: 'smtp.x.edu',
      smtpUser: 'club@x.edu',
      fromName: '社团',
      smtpSecret: 'pw',
    });
    // 模拟已通过测试
    await configs.save({ ...first, verified: true, lastTestPassedAt: new Date().toISOString() });

    // 仅改展示名：不触发重测
    const renamed = await save.execute({
      scope: { type: 'CLUB', clubId: 'club-1' },
      actor: leader,
      smtpHost: 'smtp.x.edu',
      smtpUser: 'club@x.edu',
      fromName: '新名字',
    });
    assert.equal(renamed.verified, true, '非关键变更保留验证状态');

    // 换主机：必须重测
    const moved = await save.execute({
      scope: { type: 'CLUB', clubId: 'club-1' },
      actor: leader,
      smtpHost: 'smtp.y.edu',
      smtpUser: 'club@x.edu',
      fromName: '新名字',
    });
    assert.equal(moved.verified, false, '关键变更后必须重新测试');

    // 换密钥：必须重测
    const rekeyed = await save.execute({
      scope: { type: 'CLUB', clubId: 'club-1' },
      actor: leader,
      smtpHost: 'smtp.y.edu',
      smtpUser: 'club@x.edu',
      fromName: '新名字',
      smtpSecret: 'new-pw',
    });
    assert.equal(rekeyed.verified, false);
    assert.notEqual(rekeyed.secretFingerprint, moved.secretFingerprint, '指纹随密钥变化');
  });

  it('新配置缺密钥时拒绝保存', async () => {
    await assert.rejects(
      () =>
        save.execute({
          scope: { type: 'CLUB', clubId: 'club-1' },
          actor: leader,
          smtpHost: 'smtp.x.edu',
          smtpUser: 'club@x.edu',
          fromName: '社团',
        }),
      (error: unknown) => (error as Error).message.includes('密钥缺失'),
    );
  });
});

describe('TestEmailConfigCommand / RotateEmailKeyCommand（NTF-006.7 测试后启用/轮换失效）', () => {
  let configs: InMemoryEmailConfigStore;
  let cipher: AesGcmEmailSecretCipher;
  let audit: RecordingAudit;
  let adapter: StubAdapter;
  let save: SaveEmailConfigCommand;
  let test: TestEmailConfigCommand;
  let rotate: RotateEmailKeyCommand;
  const leader: EmailConfigActor = {
    userId: 'leader-1',
    displayName: '负责人',
    isPlatformAdmin: false,
    permissions: ['club:email:config'],
  };

  beforeEach(() => {
    configs = new InMemoryEmailConfigStore();
    cipher = new AesGcmEmailSecretCipher();
    audit = new RecordingAudit();
    adapter = new StubAdapter();
    save = new SaveEmailConfigCommand(configs, cipher, audit);
    test = new TestEmailConfigCommand(configs, cipher, adapter as never, audit);
    rotate = new RotateEmailKeyCommand(configs, audit);
  });

  it('测试通过 → verified=true 并写审计；失败保持未验证', async () => {
    await save.execute({
      scope: { type: 'CLUB', clubId: 'club-1' },
      actor: leader,
      smtpHost: 'smtp.x.edu',
      smtpUser: 'club@x.edu',
      fromName: '社团',
      smtpSecret: 'pw',
    });
    const ok = await test.execute({ scope: { type: 'CLUB', clubId: 'club-1' }, actor: leader });
    assert.equal(ok.ok, true);
    assert.equal(ok.verified, true);

    adapter.next = 'TEMPORARY_FAILURE' as never;
    // 轮换后重填再失败
    await rotate.execute({ scope: { type: 'CLUB', clubId: 'club-1' }, actor: leader });
    await save.execute({
      scope: { type: 'CLUB', clubId: 'club-1' },
      actor: leader,
      smtpHost: 'smtp.x.edu',
      smtpUser: 'club@x.edu',
      fromName: '社团',
      smtpSecret: 'pw2',
    });
    const fail = await test.execute({ scope: { type: 'CLUB', clubId: 'club-1' }, actor: leader });
    assert.equal(fail.ok, false);
    const stored = await configs.findByClub('club-1');
    assert.equal(stored?.verified, false, '失败保持未验证');
  });

  it('轮换清除旧密钥并要求重填（只能重填或轮换，NTF-006.7）', async () => {
    await save.execute({
      scope: { type: 'CLUB', clubId: 'club-1' },
      actor: leader,
      smtpHost: 'smtp.x.edu',
      smtpUser: 'club@x.edu',
      fromName: '社团',
      smtpSecret: 'pw',
    });
    const result = await rotate.execute({
      scope: { type: 'CLUB', clubId: 'club-1' },
      actor: leader,
    });
    assert.equal(result.rotated, true);
    assert.equal(result.verified, false);
    const stored = await configs.findByClub('club-1');
    assert.equal(stored?.secretCiphertext, null, '旧密文清除');
    assert.ok(stored?.keyRotatedAt);
    assert.ok(audit.entries.some((e) => e.action === 'notification.email_config.rotate_key'));
  });
});
