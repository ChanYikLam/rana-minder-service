/**
 * L5 运维演练门 5：Casdoor 失败关闭三联演练（OPS-VER-010 / 011 / 012）。
 *
 * 锚点语义（docs/operations/部署运维与恢复手册-v1.0.md §OPS-VER 表）：
 * - OPS-VER-010 Casdoor 实例指纹与读取能力：未配置实例时会话链路失败关闭；
 * - OPS-VER-011 服务账号、写后可见性、MFA/auth_time/撤销：会话吊销版本推进证据；
 * - OPS-VER-012 写后读回、全量对账和高风险实时读回：非确认结论不产生第二结果。
 *
 * 演练方式（真实类 + 假端口，手动 new 不经 Nest boot；无网络零 sleep）：
 * - RejectAllAuthSessionProvider + AuthGuard（stub 会话/stub 追踪）→ 401 体键集
 *   精确为 {code,message,supportId}；
 * - PostgresSessionRevocation + RecordingDbAdapter → 吊销版本单调推进与读取判定；
 * - CasdoorGroupHandler + CasdoorWriteService + 脚本化写端口 → 第三值/依赖不可用/
 *   截止超时/幂等一致 四条读回收口路径。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ExecutionContext } from '@nestjs/common';
import { HttpException } from '@nestjs/common';

import {
  AuthGuard,
  sessionFromRequest,
} from '../../src/modules/identity/interfaces/nest/auth.guard';
import { RejectAllAuthSessionProvider } from '../../src/modules/identity/interfaces/nest/auth-session';
import type {
  AuthSession,
  AuthSessionProvider,
} from '../../src/modules/identity/interfaces/nest/auth-session';
import type {
  TraceContextAdapter,
  TraceContext,
} from '../../src/platform/observability/infrastructure/trace-context.adapter';
import { isTraceId } from '../../src/platform/observability/domain/services/trace-id.generator';

import { IdentityUnitOfWork } from '../../src/modules/identity/infrastructure/unit-of-work';
import { PostgresSessionRevocation } from '../../src/modules/identity/infrastructure/postgres-session-revocation';
import { RecordingDbAdapter } from './helpers/recording-db';

import { FreshnessRegistry } from '../../src/platform/casdoor/domain/freshness-registry';
import type { CasdoorWritePort } from '../../src/platform/casdoor/contracts/ports';
import type { ExternalResult } from '../../src/platform/casdoor/contracts/external-result';
import { ExternalStatus } from '../../src/platform/casdoor/contracts/external-result';
import { CasdoorWriteService } from '../../src/platform/casdoor/application/casdoor-write.service';
import { CasdoorGroupHandler } from '../../src/platform/tasks/executors/handlers/casdoor-group.handler';
import { TaskExecutionError } from '../../src/platform/tasks/contracts';
import type { TaskRecord } from '../../src/platform/tasks/contracts';

const findings = {
  authFailClosed401: false,
  revocationVersionAdvance: false,
  readbackConclusions: false,
};

// ----- 门 A：OPS-VER-010 未配置 Casdoor 的失败关闭 -----

describe('OPS-VER-010 未配置 Casdoor 时会话链路失败关闭演练', () => {
  const requestStub = { headers: {}, cookies: {} } as never;

  it('RejectAllAuthSessionProvider：任何请求都解析不出会话（null，不猜测主体）', async () => {
    const provider = new RejectAllAuthSessionProvider();
    assert.equal(await provider.resolveSession(requestStub), null);
  });

  it('AuthGuard 手动装配：未认证 → HttpException(401)，响应体键集恰为 code/message/supportId', async () => {
    const trace = stubTrace({ traceId: 'tr-ops-fixed-010' });
    const guard = new AuthGuard(new RejectAllAuthSessionProvider(), trace);

    const err = (await guard.canActivate(stubContext()).then(
      () => null,
      (e: unknown) => e,
    )) as HttpException | null;

    assert.ok(err instanceof HttpException, '必须以 HttpException 形式拒绝');
    assert.equal(err.getStatus(), 401);
    const body = err.getResponse() as Record<string, unknown>;
    // IFC-ERR-001 错误响应形状精确匹配（API-GEN-005：只含三个键）
    assert.deepEqual(Object.keys(body).sort(), ['code', 'message', 'supportId']);
    assert.equal(body['code'], 'IFC-ERR-001');
    assert.equal(typeof body['message'], 'string');
    assert.equal(body['supportId'], 'tr-ops-fixed-010', 'supportId 复用当前追踪上下文');
    findings.authFailClosed401 = true;
  });

  it('无追踪上下文时 supportId 由生成器兜底且格式合法', async () => {
    const guard = new AuthGuard(new RejectAllAuthSessionProvider(), stubTrace(undefined));
    const err = (await guard.canActivate(stubContext()).then(
      () => null,
      (e: unknown) => e,
    )) as HttpException;
    const supportId = (err.getResponse() as Record<string, unknown>)['supportId'];
    assert.ok(isTraceId(supportId), `兜底 supportId 应为合法 traceId，实际 ${String(supportId)}`);
  });

  it('对照组：认证通过路径正常放行并挂载会话（证明 401 来自 fail-closed 而非接线断裂）', async () => {
    const session: AuthSession = { subjectId: 'user-ops', now: new Date('2026-08-24T00:00:00Z') };
    const allowAll: AuthSessionProvider = { resolveSession: async () => session };
    const guard = new AuthGuard(allowAll, stubTrace({ traceId: 'tr-ok' }));
    const req: Record<string, unknown> = {};
    assert.equal(await guard.canActivate(contextWith(req)), true);
    assert.equal(sessionFromRequest(req)?.subjectId, 'user-ops');
  });
});

// ----- 门 B：OPS-VER-011 会话吊销（撤销）版本簿记 -----

describe('OPS-VER-011 会话吊销版本推进与判定演练', () => {
  it('invalidateAllSessions：吊销版本在 SQL 层按 MAX+1 单调推进且只命中未失效会话', async () => {
    const db = new RecordingDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    const revocation = new PostgresSessionRevocation(db, uow);

    await uow.run({ kind: 'single', subjectId: 'user-ops' }, async () => {
      // 每次吊销 = SELECT ... FOR UPDATE（加锁，空集） + UPDATE（返回新版本）
      db.enqueueResult([]); // 锁定查询（首次）
      db.enqueueResult([{ revoke_version: '6' }]);
      assert.equal(await revocation.invalidateAllSessions('user-ops'), 6);

      db.enqueueResult([]); // 锁定查询（第二次）
      db.enqueueResult([{ revoke_version: '7' }]);
      assert.equal(await revocation.invalidateAllSessions('user-ops'), 7);
      return undefined as void;
    });

    // 每次吊销含 1 次锁定 SELECT + 1 次 UPDATE，共 4 次查询
    assert.equal(db.queries.length, 4);
    const updateQueries = db.queries.filter((q) => /UPDATE auth_sessions/.test(q.sql));
    assert.equal(updateQueries.length, 2);
    for (const q of updateQueries) {
      assert.match(q.sql, /MAX\(revoke_version\)/, '新版本取自当前最大吊销版本');
      assert.match(q.sql, /\+\s*1/, '版本号严格 +1 推进');
      assert.match(q.sql, /revoked_at IS NULL/, '已失效会话不得重复卷入');
      assert.deepEqual(q.params, ['user-ops']);
    }
    // 锁定查询：对该主体全部会话行加 FOR UPDATE，串行化并发吊销的版本计算
    const lockQueries = db.queries.filter((q) => q.sql.includes('FOR UPDATE'));
    assert.equal(lockQueries.length, 2, '每次吊销前须对该主体会话行加锁');
    for (const q of lockQueries) {
      assert.match(q.sql, /SELECT session_id FROM auth_sessions/);
      assert.match(q.sql, /WHERE subject_id = \$1/);
      assert.match(q.sql, /FOR UPDATE/, '须以行锁串行化并发吊销');
      assert.deepEqual(q.params, ['user-ops']);
    }
    // 吊销与账号状态同事务收口（IFC-TX-001）：查询发生在 begin 与 commit 之间
    const order = db.eventPrefixes().map((p) => p.split(':')[0]);
    assert.deepEqual(order, [
      'begin',
      'set-rls',
      'query',
      'query',
      'query',
      'query',
      'commit',
      'clear-rls',
    ]);
    findings.revocationVersionAdvance = true;
  });

  it('getRevocation 判定：有记录返回最新版本/时间；无记录返回 null（缺失即关闭）', async () => {
    const db = new RecordingDbAdapter();
    const revocation = new PostgresSessionRevocation(db, new IdentityUnitOfWork(db));

    db.enqueueResult([{ revoke_version: '7', revoked_at: new Date('2026-08-24T09:30:00.000Z') }]);
    assert.deepEqual(await revocation.getRevocation('user-ops'), {
      revokeVersion: 7,
      revokedAt: '2026-08-24T09:30:00.000Z',
    });

    db.enqueueResult([]);
    assert.equal(await revocation.getRevocation('nobody'), null);

    const select = db.queries.find((q) => q.sql.includes('SELECT MAX(revoke_version)'));
    assert.ok(select, '读取走聚合查询');
    assert.match(select.sql, /WHERE subject_id = \$1/);
  });
});

// ----- 门 C：OPS-VER-012 写后读回与高风险实时读回 -----

type WriteReq = Parameters<CasdoorWritePort['addGroupMembers']>[0];
type ReadbackReq = Parameters<CasdoorWritePort['readbackGroupMembers']>[0];

/** 脚本化写端口假体：记录全部调用并维护"外部成员事实"状态（模拟 Casdoor 侧） */
class ScriptedWritePort implements CasdoorWritePort {
  readonly calls: string[] = [];
  members = new Set<string>();
  mode: 'third-value' | 'dependency-unavailable' | 'target' = 'third-value';

  private evidence(attemptId: string) {
    return {
      observedAt: '2026-08-24T10:00:00.000Z',
      instance: 'casdoor-fake',
      attemptId,
      version: 'v1',
    };
  }

  private ok<T>(value: T | null, attemptId: string): ExternalResult<T> {
    return {
      status: ExternalStatus.TRUSTED_CURRENT,
      value,
      evidence: this.evidence(attemptId),
      error: null,
    };
  }

  private unavailable<T>(attemptId: string): ExternalResult<T> {
    return {
      status: ExternalStatus.DEPENDENCY_UNAVAILABLE,
      value: null,
      evidence: this.evidence(attemptId),
      error: null,
    };
  }

  async addGroupMembers(req: WriteReq): Promise<ExternalResult<void>> {
    this.calls.push(`add:${req.requestId}`);
    if (this.mode === 'dependency-unavailable') return this.unavailable(req.requestId);
    for (const id of req.userIds) this.members.add(id);
    return this.ok(undefined, req.requestId);
  }

  async removeGroupMembers(
    req: Parameters<CasdoorWritePort['removeGroupMembers']>[0],
  ): Promise<ExternalResult<void>> {
    this.calls.push(`remove:${req.requestId}`);
    if (this.mode === 'dependency-unavailable') return this.unavailable(req.requestId);
    for (const id of req.userIds) this.members.delete(id);
    return this.ok(undefined, req.requestId);
  }

  async updateUser(): Promise<ExternalResult<void>> {
    throw new Error('not used in drill');
  }

  async readbackGroupMembers(req: ReadbackReq): Promise<ExternalResult<readonly string[]>> {
    this.calls.push(`readback:${req.requestId}`);
    if (this.mode === 'dependency-unavailable') {
      // 读回仍可达但显示原值（写请求未送达的典型表现）
      return this.ok([...this.members].sort(), req.requestId);
    }
    if (this.mode === 'target') return this.ok([...this.members].sort(), req.requestId);
    // 第三值：读回出现既非原值也非目标值的成员关系（外部人工修改注入）
    return this.ok([...this.members, 'third-user'].sort(), req.requestId);
  }

  async readbackUser(): Promise<ExternalResult<never>> {
    throw new Error('not used in drill');
  }
}

function fixedClock(at: Date): { now(): Date } {
  return { now: () => at };
}

function taskOf(payload: Record<string, unknown>): TaskRecord {
  return {
    taskId: 'task-ops-012',
    intentId: 'intent-ops-012',
    taskType: 'CASDOOR_GROUP_WRITE',
    status: 'LEASED',
    payload,
    attempts: 0,
    maxAttempts: 5,
    lease: null,
    failure: null,
    resultRef: null,
    idempotencyKey: 'idem-ops-012',
    scope: { kind: 'PLATFORM' },
    notBefore: null,
    createdAt: '2026-08-24T09:00:00.000Z',
    updatedAt: '2026-08-24T09:00:00.000Z',
  } as unknown as TaskRecord;
}

function groupPayload(
  original: string[],
  target: string[],
  deadline?: string,
): Record<string, unknown> {
  return {
    commandId: 'cmd-ops-012',
    idempotencyKey: 'idem-ops-012',
    groupRef: { owner: 'school', name: 'club-a' },
    originalMemberIds: original,
    targetMemberIds: target,
    requestedAt: '2026-08-24T09:00:00.000Z',
    ...(deadline ? { deadline } : {}),
  };
}

describe('OPS-VER-012 写后读回、全量对账和高风险实时读回演练', () => {
  it('第三值冲突：读回出现第三方关系 → 人工核验结论，单轮传输后立即停手', async () => {
    const port = new ScriptedWritePort();
    port.mode = 'third-value';
    port.members = new Set(['u-old']);
    const handler = new CasdoorGroupHandler(
      new CasdoorWriteService(port, fixedClock(new Date('2026-08-24T10:00:00Z'))),
    );

    const err = (await handler.handle(taskOf(groupPayload(['u-old'], ['u-new']))).then(
      () => null,
      (e: unknown) => e,
    )) as TaskExecutionError;

    assert.ok(err instanceof TaskExecutionError, '非确认结论必须上抛');
    assert.equal(err.failureKind, 'MANUAL_INTERVENTION_REQUIRED');
    assert.match(err.message, /THIRD_VALUE/);
    // 单轮传输 + 恰一次定向读回；无补偿覆盖写、无第二轮尝试（不制造第二结果）
    assert.equal(port.calls.filter((c) => c.startsWith('add:')).length, 1);
    assert.equal(port.calls.filter((c) => c.startsWith('remove:')).length, 1);
    assert.equal(port.calls.filter((c) => c.startsWith('readback:')).length, 1);
    findings.readbackConclusions = true;
  });

  it('依赖不可用：传输层故障优先于分类判定，外部关系保持原样且结论可重试', async () => {
    const port = new ScriptedWritePort();
    port.mode = 'dependency-unavailable';
    port.members = new Set(['u-old']);
    const handler = new CasdoorGroupHandler(
      new CasdoorWriteService(port, fixedClock(new Date('2026-08-24T10:00:00Z'))),
    );

    const err = (await handler.handle(taskOf(groupPayload(['u-old'], ['u-new']))).then(
      () => null,
      (e: unknown) => e,
    )) as TaskExecutionError;

    assert.ok(err instanceof TaskExecutionError);
    assert.equal(err.failureKind, 'EXTERNAL_UNCERTAIN', '依赖不可用归类为可重试外部故障');
    assert.equal(err.retryable, true);
    assert.deepEqual([...port.members].sort(), ['u-old'], '不可用窗口内不得伪造任何写入结果');
  });

  it('截止超时（15 分钟上限）：不发起任何调用，直接转人工核验', async () => {
    const port = new ScriptedWritePort();
    // 时钟已越过 deadline → 首次循环检查即失败关闭
    // （deadline 由调用方传入 CasdoorWriteService；handler 层不转发该字段，
    //   故本场景直接驱动写服务这一真实类验证超窗语义）
    const service = new CasdoorWriteService(port, fixedClock(new Date('2026-08-25T00:00:00Z')));
    const conclusion = await service.writeGroupMembership({
      commandId: 'cmd-ops-012',
      idempotencyKey: 'idem-ops-012',
      groupRef: { owner: 'school', name: 'club-a' },
      originalMemberIds: ['u-old'],
      targetMemberIds: ['u-new'],
      requestedAt: '2026-08-24T09:00:00.000Z',
      deadline: '2026-08-24T10:15:00.000Z',
    });

    assert.equal(conclusion.kind, 'MANUAL_INTERVENTION_REQUIRED');
    assert.equal(conclusion.retryable, false, '超窗属稳定结论，重试无法修复');
    assert.match(conclusion.reason, /重试上限|人工核验/);
    assert.deepEqual(port.calls, [], '超窗后不得发起盲写');
  });

  it('幂等一致：目标与原值一致时不发起外部写入，直接 CONFIRMED 收口', async () => {
    const port = new ScriptedWritePort();
    port.mode = 'target';
    port.members = new Set(['u-keep']);
    const handler = new CasdoorGroupHandler(
      new CasdoorWriteService(port, fixedClock(new Date('2026-08-24T10:00:00Z'))),
    );

    await handler.handle(taskOf(groupPayload(['u-keep'], ['u-keep'])));
    assert.deepEqual(port.calls, [], '无差异即零写入（迟到重复命令不制造第二结果）');
  });

  it('高风险实时读回目录：未知操作一律要求 REAL_TIME（CAS-Q-002 失败关闭）', () => {
    const registry = new FreshnessRegistry();
    assert.equal(registry.requireRealTime('TOTALLY_UNKNOWN_OP'), true);
    assert.equal(registry.requireRealTime('PERMISSION_SENSITIVE_READ'), true);
  });
});

describe('OPS-VER-010..012 Casdoor 失败关闭演练结论', () => {
  it('三门证据齐备（结构化汇总）', () => {
    assert.deepEqual(findings, {
      authFailClosed401: true,
      revocationVersionAdvance: true,
      readbackConclusions: true,
    });
  });
});

// ----- 辅助 -----

function stubTrace(current: TraceContext | undefined): TraceContextAdapter {
  return {
    run<T>(_ctx: TraceContext, fn: () => T): T {
      return fn();
    },
    runWithNewChild<T>(_parent: TraceContext, fn: () => T): T {
      return fn();
    },
    runWithNewRoot<T>(fn: () => T): T {
      return fn();
    },
    current: () => current,
  };
}

function contextWith(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function stubContext(): ExecutionContext {
  return contextWith({ headers: {} });
}
