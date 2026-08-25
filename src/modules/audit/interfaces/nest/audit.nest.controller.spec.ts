/**
 * AuditNestController 单元测试（interfaces/nest；P0 传输层落地）。
 *
 * 覆盖：
 * - (a) 成功调用返回 { code: 0, data }，领域结果映射到 contract DTO；
 * - (b) 领域错误（IFC-ERR-xxx）被统一映射为带正确 code 的 HttpException。
 *
 * 直接以桩构造控制器（new AuditNestController(stub...)），不启动 Nest DI。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';

import { AuditNestController } from './audit.nest.controller';
import type { AuditQuery } from '../../application/queries/audit-query';
import type { SaveCorrectionDraftCommand } from '../../application/commands/correction-submit.command';
import type { SubmitCorrectionCommand } from '../../application/commands/correction-submit.command';
import type { DecideCorrectionCommand } from '../../application/commands/correction-decide.command';
import type { WithdrawCorrectionCommand } from '../../application/commands/correction-decide.command';
import { CorrectionStatus } from '../../domain/state-machines/correction-state-machine';
import type { Correction } from '../../domain/models/correction';
import type { AuditEvent } from '../../domain/models/audit-event';
import type { CorrectionRecord } from '../../../../common/contracts/audit.contracts';

const session = { subjectId: 'user-1', now: new Date('2026-08-20T12:00:00.000Z') };
const request = { authSession: session } as unknown as Record<string, unknown>;

function buildController(stubs: {
  auditQuery?: Partial<AuditQuery>;
  saveDraft?: Partial<SaveCorrectionDraftCommand>;
  submit?: Partial<SubmitCorrectionCommand>;
  decide?: Partial<DecideCorrectionCommand>;
  withdraw?: Partial<WithdrawCorrectionCommand>;
}): AuditNestController {
  return new AuditNestController(
    (stubs.auditQuery ?? {}) as AuditQuery,
    (stubs.saveDraft ?? {}) as SaveCorrectionDraftCommand,
    (stubs.submit ?? {}) as SubmitCorrectionCommand,
    (stubs.decide ?? {}) as DecideCorrectionCommand,
    (stubs.withdraw ?? {}) as WithdrawCorrectionCommand,
  );
}

function fakeAuditEvent(): AuditEvent {
  return {
    auditId: 'evt-1',
    eventType: 'MEMBERSHIP',
    actorId: 'actor-1',
    actorRoles: ['CLUB_LEADER'],
    scope: { kind: 'org', clubId: 'club-1' },
    occurredAt: '2026-08-20T10:00:00.000Z',
    source: { channel: 'WEB' },
    target: { objectType: 'MEMBER', objectId: 'm-1' },
    oldValue: null,
    newValue: null,
    outcome: 'SUCCESS',
    requestId: 'req-1',
  };
}

function fakeCorrection(status: CorrectionStatus): Correction {
  return {
    correctionId: 'corr-1',
    applicantId: 'user-1',
    authorId: 'author-1',
    targetRecord: {
      objectType: 'PROFILE',
      objectId: 'obj-1',
      ownerClubId: 'club-1',
      fieldKey: 'name',
      recordVersion: 1,
    },
    objectiveErrorType: 'WRONG_NAME',
    expectedCorrection: '应为李四',
    evidenceRefs: ['ev-1'],
    deadlineAt: '2099-01-01T00:00:00.000Z',
    status,
    version: 2,
    createdAt: '2026-08-20T09:00:00.000Z',
    submittedAt: '2026-08-20T09:01:00.000Z',
    overdueMarkedAt: null,
    decision: null,
    history: [{ at: '2026-08-20T09:01:00.000Z', type: 'SUBMITTED', by: 'user-1' }],
  };
}

describe('AuditNestController 审计日志', () => {
  it('(a) 本社团日志成功 → { code:0, data:{ items, nextCursor } }', async () => {
    const controller = buildController({
      auditQuery: {
        async search() {
          return [fakeAuditEvent()];
        },
      },
    });
    const result = await controller.listOrgLogs('club-1', request);
    assert.deepEqual(result, {
      code: 0,
      data: { items: [fakeAuditEvent()].map(() => ({
        id: 'evt-1',
        actorName: 'actor-1',
        action: 'MEMBERSHIP',
        targetType: 'MEMBER',
        targetId: 'm-1',
        detail: '',
        createdAt: '2026-08-20T10:00:00.000Z',
        scope: 'org',
      })), nextCursor: null },
    });
  });

  it('(b) 越权查询 → HttpException 403 IFC-ERR-003', async () => {
    const controller = buildController({
      auditQuery: {
        async search() {
          throw new Error('IFC-ERR-003: 只能查询本社团审计');
        },
      },
    });
    await assert.rejects(
      controller.listOrgLogs('club-1', request),
      (error: unknown) =>
        error instanceof HttpException &&
        error.getStatus() === 403 &&
        (error.getResponse() as { code: string }).code === 'IFC-ERR-003',
    );
  });

  it('(a) 平台日志成功 → items 映射，无 clubId 过滤', async () => {
    const controller = buildController({
      auditQuery: {
        async search() {
          return [fakeAuditEvent()];
        },
      },
    });
    const result = await controller.listPlatformLogs(request);
    assert.equal((result as { code: number }).code, 0);
    assert.equal(
      (result as { data: { items: unknown[] } }).data.items.length,
      1,
    );
  });
});

describe('AuditNestController 事实纠错', () => {
  it('(a) 提交纠错（草稿→待处理）→ CorrectionRecord(status=submitted)', async () => {
    const controller = buildController({
      saveDraft: {
        async execute() {
          return fakeCorrection(CorrectionStatus.DRAFT);
        },
      },
      submit: {
        async execute() {
          return fakeCorrection(CorrectionStatus.PENDING);
        },
      },
    });
    const body = {
      input: {
        targetType: 'PROFILE',
        targetId: 'obj-1',
        reason: '姓名有误',
        evidence: 'ev-1',
        authorId: 'author-1',
        fieldKey: 'name',
        recordVersion: 1,
        objectiveErrorType: 'WRONG_NAME',
        expectedCorrection: '应为李四',
        deadlineAt: '2099-01-01T00:00:00.000Z',
      },
    };
    const result = await controller.createCorrection('club-1', request, body);
    assert.equal((result as { code: number }).code, 0);
    const data = (result as { data: CorrectionRecord }).data;
    assert.equal(data.id, 'corr-1');
    assert.equal(data.status, 'submitted');
    assert.equal(data.submitterName, 'user-1');
  });

  it('(a) 审批通过 → CorrectionRecord(status=approved)', async () => {
    const approved = fakeCorrection(CorrectionStatus.APPROVED);
    const controller = buildController({
      decide: {
        async execute() {
          return approved;
        },
      },
    });
    const body = { input: { decision: 'approve', reason: '确认', oldValue: '张三', newValue: '李四' } };
    const result = await controller.decideCorrection('club-1', 'corr-1', request, body);
    const data = (result as { data: CorrectionRecord }).data;
    assert.equal(data.status, 'approved');
  });

  it('(a) 撤回 → CorrectionRecord(status=withdrawn)', async () => {
    const controller = buildController({
      withdraw: {
        async execute() {
          return fakeCorrection(CorrectionStatus.WITHDRAWN);
        },
      },
    });
    const result = await controller.withdrawCorrection('corr-1', request);
    assert.equal((result as { data: CorrectionRecord }).data.status, 'withdrawn');
  });

  it('(b) 输入校验失败 → HttpException 422 IFC-ERR-005', async () => {
    const controller = buildController({
      saveDraft: {
        async execute() {
          throw new Error('IFC-ERR-005: 无效的处理期限');
        },
      },
      submit: { async execute() { return fakeCorrection(CorrectionStatus.PENDING); } },
    });
    await assert.rejects(
      controller.createCorrection('club-1', request, { input: {
        targetType: 'PROFILE', targetId: 'obj-1', reason: 'x', evidence: 'e',
        authorId: 'a', fieldKey: 'k', recordVersion: 1, objectiveErrorType: 'WRONG_NAME',
        expectedCorrection: 'y', deadlineAt: '',
      } }),
      (error: unknown) =>
        error instanceof HttpException &&
        error.getStatus() === 422 &&
        (error.getResponse() as { code: string }).code === 'IFC-ERR-005',
    );
  });

  it('(b) 状态冲突 → HttpException 409 IFC-ERR-007', async () => {
    const controller = buildController({
      decide: {
        async execute() {
          throw new Error('IFC-ERR-007: 终态不可覆盖，新证据需新申请');
        },
      },
    });
    await assert.rejects(
      controller.decideCorrection('club-1', 'corr-1', request, { input: { decision: 'approve', reason: 'r' } }),
      (error: unknown) =>
        error instanceof HttpException &&
        error.getStatus() === 409 &&
        (error.getResponse() as { code: string }).code === 'IFC-ERR-007',
    );
  });
});
