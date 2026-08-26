/**
 * MembershipNestController 单元测试（桩注入；仅验证传输层信封与错误映射）。
 *
 * 不依赖真实仓储/守卫：命令与查询以桩替换，断言
 * - 成功返回 { code: 0, data }；
 * - 领域错误被映射为正确 IFC-ERR 的 HttpException（状态码 + body.code）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HttpException } from '@nestjs/common';

import { MembershipNestController } from './membership.nest.controller';
import type { SubmitDepartmentApplicationCommand } from '../../application/commands/submit-department-application.command';
import type { DecideDepartmentApplicationCommand } from '../../application/commands/decide-department-application.command';
import type { ExecuteDepartmentApplicationCommand } from '../../application/commands/execute-department-application.command';
import type { WithdrawDepartmentApplicationCommand } from '../../application/commands/withdraw-department-application.command';
import type { MemberExperienceQuery } from '../../application/queries/member-experience.query';
import type { DepartmentRelationQuery } from '../../application/queries/department-relation.query';

type AnyStub = Record<string, (...args: unknown[]) => Promise<unknown>>;

function buildController(stubs: {
  submit?: AnyStub;
  decide?: AnyStub;
  execute?: AnyStub;
  withdraw?: AnyStub;
  experience?: AnyStub;
  relation?: AnyStub;
}): MembershipNestController {
  return new MembershipNestController(
    (stubs.submit ?? {
      execute: async () => ({}),
    }) as unknown as SubmitDepartmentApplicationCommand,
    (stubs.decide ?? {
      execute: async () => ({}),
    }) as unknown as DecideDepartmentApplicationCommand,
    (stubs.execute ?? {
      execute: async () => ({}),
    }) as unknown as ExecuteDepartmentApplicationCommand,
    (stubs.withdraw ?? {
      execute: async () => ({}),
    }) as unknown as WithdrawDepartmentApplicationCommand,
    (stubs.experience ?? { currentPeriod: async () => null }) as unknown as MemberExperienceQuery,
    (stubs.relation ?? { listCurrentValid: async () => [] }) as unknown as DepartmentRelationQuery,
  );
}

const authedRequest = {
  authSession: { subjectId: 'user-1', now: new Date() },
} as unknown as Record<string, unknown>;

test('提交部门申请成功返回 { code: 0, data }', async () => {
  const created = { applicationId: 'app-1', status: 'PENDING_APPROVAL' };
  const controller = buildController({
    submit: { execute: async () => created },
  });
  const result = await controller.submitDepartmentApply('club-1', authedRequest, {
    input: { type: 'join', targetDeptId: 'dept-1', reason: 'want' },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(result.data, created);
});

test('审批部门申请业务字段来自信封 input', async () => {
  let captured: unknown;
  const controller = buildController({
    decide: {
      execute: async (input: unknown) => {
        captured = input;
        return { applicationId: 'app-1', status: 'APPROVED_PENDING_EXECUTION' };
      },
    },
  });
  await controller.decideDepartmentApply('app-1', authedRequest, {
    input: { decision: 'approve' },
  });
  assert.deepEqual(captured, {
    applicationId: 'app-1',
    operatorId: 'user-1',
    decision: 'APPROVE',
    rejectReason: undefined,
  });
});

test('执行部门申请转发 applicationId 与 operatorId', async () => {
  let captured: unknown[] = [];
  const controller = buildController({
    execute: {
      execute: async (id: unknown, operatorId: unknown) => {
        captured = [id, operatorId];
        return { applicationId: 'app-1' };
      },
    },
  });
  await controller.executeDepartmentApply('app-1', authedRequest);
  assert.deepEqual(captured, ['app-1', 'user-1']);
});

test('领域错误被映射为正确 IFC-ERR 的 HttpException', async () => {
  const controller = buildController({
    submit: {
      execute: async () => {
        throw new Error('IFC-ERR-006: 已有待审批的部门关系申请');
      },
    },
  });
  await assert.rejects(
    async () =>
      controller.submitDepartmentApply('club-1', authedRequest, {
        input: { type: 'join', targetDeptId: 'dept-1' },
      }),
    (err: unknown) => {
      assert.ok(err instanceof HttpException);
      const http = err as HttpException;
      assert.equal(http.getStatus(), 422);
      const response = http.getResponse() as { code: string };
      assert.equal(response.code, 'IFC-ERR-006');
      return true;
    },
  );
});

test('未知错误兜底为 IFC-ERR-016 / 500', async () => {
  const controller = buildController({
    withdraw: {
      execute: async () => {
        throw new Error('unexpected internal failure');
      },
    },
  });
  await assert.rejects(
    async () => controller.withdrawDepartmentApply('app-1', authedRequest, { input: {} }),
    (err: unknown) => {
      const http = err as HttpException;
      assert.equal(http.getStatus(), 500);
      assert.equal((http.getResponse() as { code: string }).code, 'IFC-ERR-016');
      return true;
    },
  );
});

test('成员详情组合查询返回 { code: 0, data: { period, relations } }', async () => {
  const period = { periodId: 'p-1', status: 'CURRENT_MEMBER' };
  const relations = [{ relationId: 'r-1' }];
  const controller = buildController({
    experience: { currentPeriod: async () => period },
    relation: { listCurrentValid: async () => relations },
  });
  const result = await controller.getMemberDetail('club-1', 'user-1');
  assert.equal(result.code, 0);
  assert.deepEqual(result.data, { period, relations });
});
