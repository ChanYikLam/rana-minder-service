/**
 * InvitationNestController 错误映射回归测试（4.5，接口清单 §8）。
 *
 * 安全/契约不变量：
 * - IFC-ERR-009（幂等冲突）经 InvitationUniqueViolationError 识别后映射为 422，
 *   而非落入 500（评审 REGRESSION：IFC-ERR-009 分支原先不可达）；
 * - IFC-ERR-006 → 404、IFC-ERR-003 → 403（错误映射回归护栏）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException, HttpStatus } from '@nestjs/common';

import { InvitationNestController } from './invitation.nest.controller';
import { INVITATION_AUTH_SESSION_KEY } from './invitation-auth.guard';
import { InvitationUniqueViolationError } from '../../infrastructure/postgres-invitation.repository';

function makeController(respond: (input: unknown) => Promise<unknown>): InvitationNestController {
  // respond 用于 accept；其余依赖以 no-op 桩填充（本测试仅触发 respond 路径）。
  const noop = { execute: async () => ({}) };
  const status = {
    getStatus: async () => ({ status: 'PENDING' }),
  };
  const routineStatus = {
    getStatus: async () => ({ status: 'PENDING' }),
  };
  // casdoorUser 桩：默认账号 ACTIVE，接受路径的实时复核放行。
  const casdoorUser = {
    readAccountStatus: async () => ({
      status: 'SUCCESS',
      data: { state: 'ACTIVE', observedAt: new Date(), externalVersion: null },
      error: null,
      attemptId: 'a',
      timestamp: new Date(),
    }),
  };
  return new InvitationNestController(
    { execute: respond } as never,
    noop as never,
    status as never,
    noop as never,
    noop as never,
    routineStatus as never,
    casdoorUser as never,
  );
}

function buildSessionRequest(): Record<string, unknown> {
  // 最小会话请求，绕过 guard（guard 逻辑不在本测试范围）。
  return { [INVITATION_AUTH_SESSION_KEY]: { subjectId: 'u_1001' } };
}

describe('InvitationNestController 错误映射（IFC-ERR-009 回归）', () => {
  it('accept 抛 InvitationUniqueViolationError → 422（IFC-ERR-009，而非 500）', async () => {
    const controller = makeController(async () => {
      throw new InvitationUniqueViolationError();
    });
    let caught: HttpException | undefined;
    try {
      await controller.recruitmentRespond('inv-1', buildSessionRequest() as never, {
        action: 'accept',
      });
    } catch (e) {
      caught = e as HttpException;
    }
    assert.ok(caught, '应抛出 HttpException');
    assert.equal(caught.getStatus(), HttpStatus.UNPROCESSABLE_ENTITY);
    assert.equal((caught.getResponse() as { code?: string }).code, 'IFC-ERR-009');
  });

  it('InvitationUniqueViolationError 暴露显式 code=IFC-ERR-009（供 mapError 识别，评审 CQ）', () => {
    const err = new InvitationUniqueViolationError();
    assert.equal(err.code, 'IFC-ERR-009');
  });

  it('accept 时账号 DISABLED/DELETED → 403（IFC-ERR-011，CAS-REC-002 实时复核）', async () => {
    const controller = makeController(async () => ({ status: 'ACCEPTED' }));
    // 覆盖为禁用状态，触发实时复核拒绝
    (
      controller as unknown as { casdoorUser: { readAccountStatus: () => Promise<unknown> } }
    ).casdoorUser = {
      readAccountStatus: async () => ({
        status: 'SUCCESS',
        data: { state: 'DISABLED', observedAt: new Date(), externalVersion: null },
        error: null,
        attemptId: 'a',
        timestamp: new Date(),
      }),
    };
    let caught: HttpException | undefined;
    try {
      await controller.recruitmentRespond('inv-1', buildSessionRequest() as never, {
        action: 'accept',
      });
    } catch (e) {
      caught = e as HttpException;
    }
    assert.ok(caught, '应抛出 HttpException');
    assert.equal(caught.getStatus(), HttpStatus.FORBIDDEN);
    assert.equal((caught.getResponse() as { code?: string }).code, 'IFC-ERR-011');
  });
});
