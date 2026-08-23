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

  it('敏感不落盘：嵌套对象/数组内的敏感字段与循环引用不泄漏、不抛错（CAS-SEC-001~004）', async () => {
    const rig = makeRig();
    // 嵌套对象中的敏感键仍须脱敏（防整段 JSON 落盘带出密码/令牌）
    const event = await rig.writer.write({
      ...baseEvent,
      newValues: {
        config: { apiKey: 'SECRET-KEY-123', password: 'pwd999' },
        items: [{ token: 't1', name: 'n1' }],
      },
    });
    const v = event.newValue ?? '';
    assert.ok(!v.includes('SECRET-KEY-123'), '嵌套 apiKey 不得落盘');
    assert.ok(!v.includes('pwd999'), '嵌套 password 不得落盘');
    assert.ok(!v.includes('t1'), '数组内 token 不得落盘');
    assert.ok(v.includes('config.apiKey=<REDACTED'), '嵌套敏感键仅记脱敏差异');
    assert.ok(v.includes('items[0].name=n1'), '非敏感叶子保留');
    // 循环引用对象不应抛错导致审计写入失败（避免业务整体失败被恶意输入触发）
    const circular: Record<string, unknown> = { a: {} };
    (circular.a as Record<string, unknown>).self = circular;
    const ev2 = await rig.writer.write({ ...baseEvent, newValues: { config: circular } });
    assert.ok(ev2.auditId.length > 0, '循环引用对象不应导致写入失败');
    assert.ok(!(ev2.newValue ?? '').includes('self='), '循环引用不把循环体正文落盘');
  });

  it('敏感不落盘：共享引用（非循环）对象各路径均脱敏，不遗漏差异（CAS-SEC-001~004）', async () => {
    const rig = makeRig();
    const shared = { token: 'SHARED-TOK-1', name: 'shared-name' };
    // 同一对象被多处引用但并非循环：每条路径都应记录脱敏差异，不得因去重而漏掉
    const event = await rig.writer.write({
      ...baseEvent,
      newValues: { a: shared, b: shared },
    });
    const v = event.newValue ?? '';
    assert.ok(!v.includes('SHARED-TOK-1'), '共享引用的敏感字段不得落盘');
    assert.ok(v.includes('a.token=<REDACTED'), '路径 a 的敏感字段应脱敏');
    assert.ok(v.includes('b.token=<REDACTED'), '路径 b 的敏感字段应脱敏（不得被去重漏掉）');
    assert.ok(v.includes('b.name=shared-name'), '共享引用的非敏感叶子在每条路径都应保留');
  });

  it('失败原因脱敏：错误信息中的令牌/密码不落盘，超长文本截断', async () => {
    const rig = makeRig();
    const event = await rig.writer.write({
      ...baseEvent,
      outcome: AuditOutcome.FAILURE,
      failureReason:
        '调用下游失败 token=abc123&secret=xyz，详见 https://x.com/a?access_token=SECRETTOK',
    });
    assert.ok(event.failureReason, '失败原因应保留');
    assert.ok(!event.failureReason?.includes('abc123'), '令牌不得落盘');
    assert.ok(!event.failureReason?.includes('xyz'), '密钥不得落盘');
    assert.ok(!event.failureReason?.includes('SECRETTOK'), 'URL 查询串凭证不得落盘');
    // 凭证出现在字符串起始处/无前置分隔符时也须脱敏（防起始位置泄漏）
    const atStart = await rig.writer.write({
      ...baseEvent,
      outcome: AuditOutcome.FAILURE,
      failureReason: 'token: abc123 调用下游失败',
    });
    assert.ok(!atStart.failureReason?.includes('abc123'), '起始处令牌不得落盘');
    const noSep = await rig.writer.write({
      ...baseEvent,
      outcome: AuditOutcome.FAILURE,
      failureReason: 'client_secret=xyz failed',
    });
    assert.ok(!noSep.failureReason?.includes('xyz'), '无分隔符密钥不得落盘');
    // 认证头里的令牌/会话值（Authorization Bearer / Cookie）不得落盘
    const auth = await rig.writer.write({
      ...baseEvent,
      outcome: AuditOutcome.FAILURE,
      failureReason:
        '下游 401，Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc，set-cookie: session=abcd1234',
    });
    assert.ok(!auth.failureReason?.includes('eyJhbGciOiJIUzI1NiJ9.abc'), 'Bearer 令牌不得落盘');
    assert.ok(!auth.failureReason?.includes('abcd1234'), 'Cookie 会话值不得落盘');
    // 超长文本截断
    const long = await rig.writer.write({
      ...baseEvent,
      outcome: AuditOutcome.FAILURE,
      failureReason: 'e'.repeat(500),
    });
    assert.ok((long.failureReason?.length ?? 0) < 300, '超长失败原因应截断');
    assert.ok(long.failureReason?.includes('truncated'), '应带截断标记');
  });

  it('仓储查询 limit<=0 返回空，缺省/正数返回最近 N 条', async () => {
    const rig = makeRig();
    await rig.writer.write({ ...baseEvent, actorId: 'u1' });
    await rig.writer.write({ ...baseEvent, actorId: 'u2' });
    await rig.writer.write({ ...baseEvent, actorId: 'u3' });
    assert.equal((await rig.repo.query({ limit: 0 })).length, 0);
    assert.equal((await rig.repo.query({ limit: -1 })).length, 0);
    const lastTwo = await rig.repo.query({ limit: 2 });
    assert.equal(lastTwo.length, 2);
    assert.equal(lastTwo[1]?.actorId, 'u3');
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
    // 本社团负责人/人事未指定 clubId 也应仅限本社团（防跨社团越权）：
    // 写入另一社团的记录，未带 clubId 过滤时也不得泄漏出来
    await rig.writer.write({ ...baseEvent, actorId: 'u9', scope: { kind: 'CLUB', clubId: 'c9' } });
    const c1NoFilter = await rig.query.search(
      { principalId: 'hr1', roles: ['HR_ADMIN'], clubId: 'c1' },
      {},
    );
    assert.equal(c1NoFilter.length, 1);
    assert.equal(c1NoFilter[0]?.actorId, 'u1');
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
    // 部门负责人未携带对象白名单 → 拒绝
    await assert.rejects(
      rig.query.search({ principalId: 'd1', roles: ['DEPARTMENT_LEADER'] }, {}),
      /须携带可访问业务对象白名单/,
    );
    // 部门负责人查询白名单外的对象 → 拒绝（防横向越权）
    await assert.rejects(
      rig.query.search(
        { principalId: 'd1', roles: ['DEPARTMENT_LEADER'], accessibleObjectIds: ['o1'] },
        { objectId: 'o999' },
      ),
      /只能查询自己有权访问的业务对象审计/,
    );
    // 成员 → 拒绝
    await assert.rejects(
      rig.query.search({ principalId: 'mem1', roles: ['MEMBER'] }, {}),
      /不看内部审计/,
    );
  });

  it('部门负责人查询结果强制限定在对象白名单内（防结果越权）', async () => {
    const rig = makeRig();
    await rig.writer.write({
      ...baseEvent,
      target: { objectType: 'MEMBERSHIP', objectId: 'o1' },
      actorId: 'u1',
    });
    await rig.writer.write({
      ...baseEvent,
      target: { objectType: 'MEMBERSHIP', objectId: 'o2' },
      actorId: 'u1',
    });
    // 白名单仅含 o1：即使 filter.objectId 传 o1，也拿不到 o2 的记录
    const rows = await rig.query.search(
      { principalId: 'd1', roles: ['DEPARTMENT_LEADER'], accessibleObjectIds: ['o1'] },
      { objectId: 'o1' },
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.target?.objectId, 'o1');
    // 不带 objectId 过滤时同样只返回白名单内对象
    const all = await rig.query.search(
      { principalId: 'd1', roles: ['DEPARTMENT_LEADER'], accessibleObjectIds: ['o2'] },
      {},
    );
    assert.equal(all.length, 1);
    assert.equal(all[0]?.target?.objectId, 'o2');
  });
});
