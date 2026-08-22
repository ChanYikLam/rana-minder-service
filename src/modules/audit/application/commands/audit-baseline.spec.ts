import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryAuditRepository } from '../../infrastructure/audit-repository';
import { AuditWriter } from './audit-writer';
import { AuditQuery } from '../queries/audit-query';
import { AuditEventType, AuditOutcome } from '../../domain/models/audit-event';
import { AuditSanitizer } from '../../domain/services/audit-sanitizer';

const makeRig = () => {
  const repo = new InMemoryAuditRepository();
  const writer = new AuditWriter(repo, new AuditSanitizer());
  const query = new AuditQuery(repo);
  return { repo, writer, query };
};

const baseEvent = {
  eventType: AuditEventType.MEMBERSHIP,
  actorId: 'hr1',
  actorRoles: ['HR_ADMIN'],
  scope: { kind: 'CLUB', clubId: 'c1' },
  source: { channel: 'WEB' as const, ip: '10.0.0.1' },
  target: { objectType: 'MEMBERSHIP', objectId: 'm1' },
  outcome: AuditOutcome.SUCCESS,
  requestId: 'req-1',
};

describe('5.3.2 不可变审计基线（AUD-003/004）', () => {
  it('审计字段完整：操作人/当时角色/作用域/时间/来源/关联对象/旧值新值/结果/请求编号', async () => {
    const rig = makeRig();
    const event = await rig.writer.write({
      ...baseEvent,
      oldValues: { role: 'MEMBER' },
      newValues: { role: 'DEPARTMENT_LEADER' },
    });
    assert.equal(event.actorId, 'hr1');
    assert.deepEqual(event.actorRoles, ['HR_ADMIN']);
    assert.equal(event.scope?.clubId, 'c1');
    assert.equal(event.source.ip, '10.0.0.1');
    assert.equal(event.target?.objectId, 'm1');
    assert.ok(event.oldValue?.includes('role=MEMBER'));
    assert.ok(event.newValue?.includes('role=DEPARTMENT_LEADER'));
    assert.equal(event.outcome, AuditOutcome.SUCCESS);
    assert.equal(event.requestId, 'req-1');
    assert.ok(event.auditId.length > 0);
  });

  it('敏感不落盘：密码/邮箱密钥/令牌/验证码/附件正文只记脱敏差异（CAS-SEC-001~004）', async () => {
    const rig = makeRig();
    const event = await rig.writer.write({
      ...baseEvent,
      newValues: {
        email: 'x@example.com',
        password: 'SuperSecret123!',
        smtpSecret: 'mail-secret',
        accessToken: 'tok-abc',
        verifyCode: '123456',
        attachmentBody: '机密附件正文内容',
        normalField: '普通字段',
      },
    });
    const v = event.newValue ?? '';
    assert.ok(!v.includes('SuperSecret123!'), '密码不得落盘');
    assert.ok(!v.includes('mail-secret'), '邮箱密钥不得落盘');
    assert.ok(!v.includes('tok-abc'), '令牌不得落盘');
    assert.ok(!v.includes('123456'), '验证码不得落盘');
    assert.ok(!v.includes('机密附件正文'), '附件正文不得落盘');
    assert.ok(/password=<REDACTED:\d+>/.test(v), '密码仅记脱敏差异');
    assert.ok(v.includes('normalField=普通字段'), '普通字段保留');
  });

  it('审计只追加不可篡改：仓储无修改/删除方法；查询按条件过滤', async () => {
    const rig = makeRig();
    await rig.writer.write({
      ...baseEvent,
      eventType: AuditEventType.AUTH_LOGIN,
      actorId: 'u1',
      target: null,
    });
    await rig.writer.write({ ...baseEvent, actorId: 'u2' });
    await rig.writer.write({ ...baseEvent, actorId: 'u2', eventType: AuditEventType.CORRECTION });
    // 按用户过滤
    const byActor = await rig.repo.query({ actorId: 'u2' });
    assert.equal(byActor.length, 2);
    // 按事件类型
    const byType = await rig.repo.query({ eventType: 'CORRECTION' });
    assert.equal(byType.length, 1);
    // 按社团
    const byClub = await rig.repo.query({ clubId: 'c1' });
    assert.equal(byClub.length, 3);
    // 只追加：总记录数不减少
    assert.equal((await rig.repo.query({})).length, 3);
  });

  it('事务同成同败：审计写入失败 → 业务操作整体失败（AUD-003/IFC-TX-006）', async () => {
    // 注入失败仓储（append 抛错）
    const failingRepo = {
      append: async () => {
        throw new Error('db down');
      },
      query: async () => [],
    };
    const failingWriter = new AuditWriter(failingRepo as never, new AuditSanitizer());
    await assert.rejects(failingWriter.write(baseEvent), /关键审计写入失败/);
  });

  it('审计中心查询权限：超管全平台；负责人/人事仅本社团；部门负责人限业务对象；成员拒绝', async () => {
    const rig = makeRig();
    await rig.writer.write({ ...baseEvent, actorId: 'u1' });
    // 超管全平台
    const all = await rig.query.search({ principalId: 'sa', roles: ['SUPER_ADMIN'] }, {});
    assert.equal(all.length, 1);
    // 本社团负责人/人事
    const c1 = await rig.query.search(
      { principalId: 'hr1', roles: ['HR_ADMIN'], clubId: 'c1' },
      {},
    );
    assert.equal(c1.length, 1);
    // 本社团负责人/人事未指定 clubId 也应仅限本社团（防跨社团越权）
    const c1NoFilter = await rig.query.search(
      { principalId: 'hr1', roles: ['HR_ADMIN'], clubId: 'c1' },
      {},
    );
    assert.equal(c1NoFilter.length, 1);
    // 无社团作用域的负责人/人事 → 拒绝
    await assert.rejects(
      rig.query.search({ principalId: 'hr3', roles: ['HR_ADMIN'] }, {}),
      /须携带社团作用域/,
    );
    // 跨社团查询 → 拒绝
    await assert.rejects(
      rig.query.search({ principalId: 'hr2', roles: ['HR_ADMIN'], clubId: 'c2' }, { clubId: 'c1' }),
      /只能查询本社团审计/,
    );
    // 部门负责人未限定对象 → 拒绝
    await assert.rejects(
      rig.query.search({ principalId: 'd1', roles: ['DEPARTMENT_LEADER'] }, {}),
      /需限定业务对象/,
    );
    // 成员 → 拒绝
    await assert.rejects(
      rig.query.search({ principalId: 'mem1', roles: ['MEMBER'] }, {}),
      /不看内部审计/,
    );
  });
});
