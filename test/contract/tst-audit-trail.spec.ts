/**
 * 审计显式落库/留痕契约（P3 类别 4 缺口补测；AUD-003/004；IFC-TX-006）。
 *
 * 覆盖（区别于 error-formatter 的脱敏单测——本套件验证审计流水**显式落库**）：
 * - 显式落库：AuditWriter.write → AUDIT_REPOSITORY.append 持久化，可按维度查询；
 * - 留痕流水：多条事件按 occurredAt 倒序可回放，原始事件不被后续写入覆盖；
 * - 只追加不可篡改：仓储接口无 update/delete 入口（结构性断言）；
 * - 关键审计失败整体失败：append 失败 → AuditWriteFailedError（IFC-ERR-012），
 *   业务关键操作随之失败，不允许"排队补写关键审计"；
 * - 敏感不落盘：密码/令牌/密钥仅记脱敏差异，原文不进入持久化事件。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { InMemoryAuditRepository } from '../../src/modules/audit/infrastructure/audit-repository';
import {
  AuditWriter,
  AuditWriteFailedError,
} from '../../src/modules/audit/application/commands/audit-writer';
import { AuditSanitizer } from '../../src/modules/audit/domain/services/audit-sanitizer';
import { AuditEventType, AuditOutcome } from '../../src/modules/audit/domain/models/audit-event';
import type { AuditRepository } from '../../src/modules/audit/infrastructure/audit-repository';

const ROOT = path.resolve(__dirname, '../..');

const makeRig = (repo: AuditRepository) => {
  const writer = new AuditWriter(repo, new AuditSanitizer());
  return { repo, writer };
};

const baseInput = {
  eventType: AuditEventType.MEMBERSHIP,
  actorId: 'hr1',
  actorRoles: ['HR_ADMIN'],
  scope: { kind: 'CLUB', clubId: 'club-1' },
  source: { channel: 'WEB' as const, ip: '10.0.0.1' },
  target: { objectType: 'MEMBERSHIP', objectId: 'm-1' },
  outcome: AuditOutcome.SUCCESS,
  requestId: 'req-audit-1',
};

describe('审计显式落库与留痕（AUD-003/004；P3 缺口补测）', () => {
  it('显式落库：write 后事件持久化并可按 actor/eventType 查询回放', async () => {
    const repo = new InMemoryAuditRepository();
    const { writer } = makeRig(repo);
    await writer.write({ ...baseInput });
    await writer.write({
      ...baseInput,
      eventType: AuditEventType.PERMISSION_CHANGE,
      requestId: 'req-audit-2',
    });

    const all = await repo.query({});
    assert.equal(all.length, 2);
    // 倒序回放：最新在前
    assert.equal(all[0].requestId, 'req-audit-2');
    assert.equal(all[1].requestId, 'req-audit-1');

    const byActor = await repo.query({ actorId: 'hr1' });
    assert.equal(byActor.length, 2);
    const byType = await repo.query({ eventType: AuditEventType.PERMISSION_CHANGE });
    assert.equal(byType.length, 1);
    assert.equal(byType[0].requestId, 'req-audit-2');
  });

  it('留痕不覆盖：后写事件不篡改先写事件的旧值/新值快照', async () => {
    const repo = new InMemoryAuditRepository();
    const { writer } = makeRig(repo);
    await writer.write({
      ...baseInput,
      oldValues: { role: 'MEMBER' },
      newValues: { role: 'LEADER' },
      requestId: 'req-first',
    });
    await writer.write({
      ...baseInput,
      oldValues: { role: 'LEADER' },
      newValues: { role: 'HISTORIC' },
      requestId: 'req-second',
    });
    const all = await repo.query({});
    const first = all.find((e) => e.requestId === 'req-first');
    const second = all.find((e) => e.requestId === 'req-second');
    assert.ok(first && second);
    assert.ok(first.oldValue?.includes('role=MEMBER'));
    assert.ok(second.newValue?.includes('role=HISTORIC'));
  });

  it('只追加不可篡改：仓储实现无 update/delete 入口（结构性断言）', async () => {
    const implProto = InMemoryAuditRepository.prototype as unknown as Record<string, unknown>;
    const methodNames = Object.getOwnPropertyNames(implProto).filter(
      (n) => n !== 'constructor' && typeof implProto[n] === 'function',
    );
    for (const name of methodNames) {
      assert.doesNotMatch(name, /^(update|delete|remove|edit|modify)/i);
    }
    // 权威接口文件同样不得声明修改/删除方法（防漂移）
    const src = fs.readFileSync(
      path.join(ROOT, 'src/modules/audit/infrastructure/audit-repository.ts'),
      'utf8',
    );
    const interfaceBlock = src.slice(0, src.indexOf('InMemoryAuditRepository'));
    assert.doesNotMatch(interfaceBlock, /\b(update|delete|remove)\w*\s*\(/i);
  });

  it('关键审计失败整体失败：append 抛错 → AuditWriteFailedError（IFC-ERR-012）', async () => {
    const failingRepo: AuditRepository = {
      append: async () => {
        throw new Error('audit insert failed (simulated)');
      },
      query: async () => [],
    } as unknown as AuditRepository;
    const { writer } = makeRig(failingRepo);
    await assert.rejects(
      () => writer.write({ ...baseInput }),
      (e: unknown) => e instanceof AuditWriteFailedError && e.message.includes('IFC-ERR-012'),
    );
  });

  it('敏感不落盘：密码/令牌/邮箱密钥原文不入持久化事件（仅脱敏差异）', async () => {
    const repo = new InMemoryAuditRepository();
    const { writer } = makeRig(repo);
    const event = await writer.write({
      ...baseInput,
      newValues: {
        emailSecret: 'mail-secret-value',
        password: 'SuperSecret123!',
        accessToken: 'tok-abc',
        role: 'LEADER',
      },
      requestId: 'req-sensitive',
    });
    const serialized = JSON.stringify(event);
    for (const secret of ['mail-secret-value', 'SuperSecret123!', 'tok-abc']) {
      assert.equal(serialized.includes(secret), false, `敏感原文泄漏: ${secret}`);
    }
  });

  it('锚点真实存在（防文档漂移）：审计写入器/仓储/清洗器', () => {
    for (const rel of [
      'src/modules/audit/application/commands/audit-writer.ts',
      'src/modules/audit/infrastructure/audit-repository.ts',
      'src/modules/audit/domain/services/audit-sanitizer.ts',
    ]) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `锚点不存在: ${rel}`);
    }
  });
});
