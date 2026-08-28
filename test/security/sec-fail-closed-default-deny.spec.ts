/**
 * 安全控制独立验证：SEC-CTL-002（默认拒绝 / fail-closed）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5（SEC-CTL-002：
 * 未登录、证据缺失、上下文不完整……默认拒绝；拒绝不产生成功副作用）。
 *
 * 验证路径（真实代码，无 pg/jose 依赖）：
 * - src/modules/organization/interfaces/actor.ts（自报 x-actor-id 头反白名单）
 * - src/platform/tasks/executors/task-precondition.ts + batch/*（DenyAll 三件套）
 * - src/platform/observability/status-page/status-page-authorizer.ts（RejectAll）
 * - src/modules/identity/interfaces/http/envelope.ts（请求信封顶层未知键拒绝）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveActorFromHeaders } from '../../src/modules/organization/interfaces/actor';
import { DenyAllTaskPrecondition } from '../../src/platform/tasks/executors/task-precondition';
import { DenyAllBatchItemAuthorization } from '../../src/platform/tasks/batch/batch-authorization';
import { DenyAllBatchItemExecutor } from '../../src/platform/tasks/batch/batch-item-executor';
import type { TaskRecord } from '../../src/platform/tasks/contracts';
import type { BatchItemInput, TaskScope } from '../../src/platform/tasks/contracts';
import {
  RejectAllStatusPageAuthorizer,
  StatusPageForbiddenError,
} from '../../src/platform/observability/status-page/status-page-authorizer';
import { parseRequestEnvelope } from '../../src/modules/identity/interfaces/http/envelope';
import {
  IdentityCommandError,
  IdentityErrorCode,
} from '../../src/modules/identity/application/errors';

const SCOPE: TaskScope = { kind: 'CLUB', clubId: 'c1' };
const ITEM: BatchItemInput = { itemId: 'i1', version: 1, input: {}, idempotencyKey: 'k1' };

describe('SEC-CTL-002 默认拒绝与失败关闭', () => {
  it('SEC-CTL-002：生产环境拒绝信任自报 x-actor-id 头（fail-closed）', () => {
    assert.throws(
      () =>
        resolveActorFromHeaders({ 'x-actor-id': 'u_root' }, {
          NODE_ENV: 'production',
        } as unknown as NodeJS.ProcessEnv),
      /x-actor-id/,
    );
  });

  it('SEC-CTL-002：未显式声明开发开关时（含 NODE_ENV 缺失/staging）一律拒绝自报身份头', () => {
    const envs: Record<string, string | undefined>[] = [
      {},
      { NODE_ENV: 'test' },
      { NODE_ENV: 'development' },
      { NODE_ENV: 'staging' },
      { ORG_DEV_ACTOR_HEADER: '1' },
    ];
    for (const env of envs) {
      assert.throws(
        () => resolveActorFromHeaders({ 'x-actor-id': 'u_root' }, env as NodeJS.ProcessEnv),
        Error,
        `env=${JSON.stringify(env)} 应拒绝`,
      );
    }
  });

  it('SEC-CTL-002：任务前置检查 DenyAll 桩全拒且不产生成功副作用', async () => {
    const precondition = new DenyAllTaskPrecondition();
    const result = await precondition.verify({ taskId: 't1' } as unknown as TaskRecord);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /not-configured/);
  });

  it('SEC-CTL-002：批量项鉴权与执行 DenyAll 双桩全拒（REJECTED 而非 SUCCEEDED）', async () => {
    const authz = await new DenyAllBatchItemAuthorization().verify('u1', 'OP', 'BIZ', ITEM);
    assert.equal(authz.ok, false);

    const executed = await new DenyAllBatchItemExecutor().execute('u1', 'OP', 'BIZ', SCOPE, ITEM);
    assert.equal(executed.status, 'REJECTED');
    assert.equal((executed as unknown as Record<string, unknown>)['resultRef'], undefined);
  });

  it('SEC-CTL-002：状态页 RejectAll 授权器同步/异步全拒，伪造超管角色不获放行', async () => {
    const authorizer = new RejectAllStatusPageAuthorizer();
    assert.throws(() => authorizer.assertSuperAdmin(undefined), StatusPageForbiddenError);
    assert.throws(
      () => authorizer.assertSuperAdmin({ userId: 'u1', roles: ['SUPER_ADMIN'] }),
      StatusPageForbiddenError,
    );
    await assert.rejects(authorizer.assertSuperAdminAsync(undefined), StatusPageForbiddenError);
    await assert.rejects(
      authorizer.assertSuperAdminAsync({ userId: 'u1', roles: ['super-admin'] }),
      StatusPageForbiddenError,
    );
  });

  it('SEC-CTL-002：请求信封顶层未知键拒绝（IFC-ERR-005），非对象信封拒绝（IFC-ERR-017）', () => {
    assert.throws(
      () => parseRequestEnvelope({ input: {}, rogueField: 1 }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as IdentityCommandError).code, IdentityErrorCode.VALIDATION_FAILED);
        return true;
      },
    );
    for (const bad of [null, 'str', 42, []]) {
      assert.throws(
        () => parseRequestEnvelope(bad),
        (err: unknown) => {
          assert.equal((err as IdentityCommandError).code, IdentityErrorCode.BAD_REQUEST);
          return true;
        },
      );
    }
    // F10 修复后的契约：expectedVersion 允许 0（资料首建未保存时 version 即 0，
    // 首存场景以其为乐观锁基线）；负数仍拒绝。
    const ok = parseRequestEnvelope({ expectedVersion: 0 });
    assert.equal(ok.expectedVersion, 0);
    assert.throws(
      () => parseRequestEnvelope({ expectedVersion: -1 }),
      (err: unknown) => {
        assert.equal((err as IdentityCommandError).code, IdentityErrorCode.VALIDATION_FAILED);
        return true;
      },
    );
  });
});
