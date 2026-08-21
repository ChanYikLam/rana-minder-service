import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { OrgWorkspaceController } from './org-workspace.controller';
import { OrgDomainError } from '../../domain/types';
import type { OrgContextQuery } from '../../application/queries/org-context.query';
import type { RelationCommandUseCase } from '../../application/commands/relation-command.use-case';
import type { AppointmentCommandUseCase } from '../../application/commands/appointment-command.use-case';
import type { ClubStore } from '../../application/ports';
import type { CurrentPermissionsPort } from '../../application/ports';
import type { RequestActor } from '../actor';
import type { ClubSpace } from '../../domain/models/club-space';

const actor: RequestActor = { userId: 'u_operator' };

interface CallLog {
  context: Array<{ userId: string; clubId: string }>;
  dashboard: Array<{ userId: string; clubId: string }>;
  submitRelation: Array<Record<string, unknown>>;
  systemConfirmReadback: Array<{ clubId: string; commandId: string }>;
  manualRetry: Array<{ clubId: string; commandId: string; actor: string }>;
  listAppointments: Array<{ clubId: string }>;
  createAppointment: Array<Record<string, unknown>>;
  cancelAppointment: Array<Record<string, unknown>>;
  reconfirmAppointment: Array<Record<string, unknown>>;
  scheduleExecute: Array<Record<string, unknown>>;
  retryExecute: Array<Record<string, unknown>>;
  effectiveForClub: Array<{ userId: string; clubId: string }>;
  primaryRoleAt: Array<{ userId: string; clubId: string }>;
  isPlatformSuperAdmin: Array<{ userId: string }>;
}

function setup(options: { superAdmin?: boolean; permissionsFor?: string[]; primaryRole?: string }) {
  const log: CallLog = {
    context: [],
    dashboard: [],
    submitRelation: [],
    systemConfirmReadback: [],
    manualRetry: [],
    listAppointments: [],
    createAppointment: [],
    cancelAppointment: [],
    reconfirmAppointment: [],
    scheduleExecute: [],
    retryExecute: [],
    effectiveForClub: [],
    primaryRoleAt: [],
    isPlatformSuperAdmin: [],
  };

  const contextQuery = {
    context: async (userId: string, clubId: string) => {
      log.context.push({ userId, clubId });
      return { clubId, clubName: 'ACM' };
    },
    dashboard: async (userId: string, clubId: string) => {
      log.dashboard.push({ userId, clubId });
      return { club: { id: clubId, name: 'ACM' }, metrics: {} };
    },
  } as unknown as OrgContextQuery;

  const relations = {
    submit: async (input: Record<string, unknown>) => {
      log.submitRelation.push(input);
      return { id: 'rel-1', status: 'pending' };
    },
    systemConfirmReadback: async (input: { clubId: string; commandId: string }) => {
      log.systemConfirmReadback.push(input);
      return { id: input.commandId, status: 'committed' };
    },
    manualRetry: async (input: { clubId: string; commandId: string; actor: string }) => {
      log.manualRetry.push(input);
      return { id: input.commandId, status: 'retrying' };
    },
  } as unknown as RelationCommandUseCase;

  const appointments = {
    listForClub: async (clubId: string) => {
      log.listAppointments.push({ clubId });
      return [];
    },
    create: async (input: Record<string, unknown>) => {
      log.createAppointment.push(input);
      return { id: 'app-1', status: 'pending' };
    },
    cancel: async (input: Record<string, unknown>) => {
      log.cancelAppointment.push(input);
      return { id: input.commandId, status: 'cancelled' };
    },
    reconfirm: async (input: Record<string, unknown>) => {
      log.reconfirmAppointment.push(input);
      return { id: input.commandId, status: 'reconfirmed' };
    },
    scheduleExecute: async (input: Record<string, unknown>) => {
      log.scheduleExecute.push(input);
      return { id: input.commandId, status: 'executing' };
    },
    retryExecute: async (input: Record<string, unknown>) => {
      log.retryExecute.push(input);
      return { id: input.commandId, status: 'executing' };
    },
  } as unknown as AppointmentCommandUseCase;

  const clubs = {
    findById: async (clubId: string): Promise<ClubSpace | null> => {
      return { id: clubId, name: 'ACM' } as ClubSpace;
    },
  } as unknown as ClubStore;

  const permissions = {
    isPlatformSuperAdmin: async (userId: string) => {
      log.isPlatformSuperAdmin.push({ userId });
      return options.superAdmin ?? false;
    },
    effectiveForClub: async (userId: string, clubId: string) => {
      log.effectiveForClub.push({ userId, clubId });
      return options.permissionsFor ?? ['club:member:view-self'];
    },
    primaryRoleAt: async (userId: string, clubId: string) => {
      log.primaryRoleAt.push({ userId, clubId });
      return options.primaryRole ?? 'member';
    },
  } as unknown as CurrentPermissionsPort;

  const controller = new OrgWorkspaceController(
    contextQuery,
    relations,
    appointments,
    clubs,
    permissions,
  );

  return { controller, log, contextQuery, relations, appointments, clubs, permissions };
}

// -----------------------------------------------------------------------------
// §5 org 工作空间（context / dashboard）
// -----------------------------------------------------------------------------

describe('OrgWorkspaceController §5 工作空间', () => {
  it('context：把 (userId, :clubId) 透传给 OrgContextQuery，由其做归属校验', async () => {
    const { controller, log } = setup({});
    await controller.context(actor, 'club-acm');
    assert.deepEqual(log.context, [{ userId: 'u_operator', clubId: 'club-acm' }]);
  });

  it('dashboard：把 (userId, :clubId) 透传给 OrgContextQuery', async () => {
    const { controller, log } = setup({});
    await controller.dashboard(actor, 'club-acm');
    assert.deepEqual(log.dashboard, [{ userId: 'u_operator', clubId: 'club-acm' }]);
  });
});

// -----------------------------------------------------------------------------
// §10.2/§10.3 关系命令
// -----------------------------------------------------------------------------

describe('OrgWorkspaceController §10.2/§10.3 关系命令', () => {
  it('submitRelation：URL :clubId 与 DTO 全部字段合并提交，submittedBy 来自 actor', async () => {
    const { controller, log } = setup({});
    await controller.submitRelation(actor, 'club-acm', {
      type: 'join_club',
      subjectId: 'u_target',
      targetGroups: [{ ref: { owner: 'club-acm', name: '社员组' }, kind: 'add' }],
      objectVersion: 3,
      idempotencyKey: 'idem-1',
    } as never);
    assert.equal(log.submitRelation.length, 1);
    const submitted = log.submitRelation[0];
    assert.equal(submitted['clubId'], 'club-acm');
    assert.equal(submitted['subjectId'], 'u_target');
    assert.equal(submitted['objectVersion'], 3);
    assert.equal(submitted['idempotencyKey'], 'idem-1');
    assert.equal(submitted['submittedBy'], 'u_operator');
  });

  it('readback：仅平台超管（系统身份）可触发，非超管被拒（ORG-027 写后回读仅系统任务）', async () => {
    const nonSuper = setup({ superAdmin: false });
    await assert.rejects(
      () => nonSuper.controller.readback(actor, 'club-acm', 'cmd-1'),
      (err: unknown) => err instanceof OrgDomainError && err.code === 'IFC-ERR-FORBIDDEN',
    );
    assert.equal(nonSuper.log.systemConfirmReadback.length, 0);

    const superAdmin = setup({ superAdmin: true });
    await superAdmin.controller.readback(actor, 'club-acm', 'cmd-1');
    assert.equal(superAdmin.log.systemConfirmReadback.length, 1);
    assert.equal(superAdmin.log.systemConfirmReadback[0].clubId, 'club-acm');
    assert.equal(superAdmin.log.systemConfirmReadback[0].commandId, 'cmd-1');
  });

  it('retryRelation：URL :clubId/:commandId 透传，actor 来自 token', async () => {
    const { controller, log } = setup({});
    await controller.retryRelation(actor, 'club-acm', 'cmd-1');
    assert.equal(log.manualRetry.length, 1);
    assert.equal(log.manualRetry[0].clubId, 'club-acm');
    assert.equal(log.manualRetry[0].commandId, 'cmd-1');
    assert.equal(log.manualRetry[0].actor, 'u_operator');
  });
});

// -----------------------------------------------------------------------------
// §10.2 预约命令
// -----------------------------------------------------------------------------

describe('OrgWorkspaceController §10.2 预约命令', () => {
  it('listAppointments：当前无有效权限 → 403（ORG-038 逐请求重算）', async () => {
    const { controller, log } = setup({ permissionsFor: [] });
    await assert.rejects(
      () => controller.listAppointments(actor, 'club-acm'),
      (err: unknown) => err instanceof OrgDomainError && err.code === 'IFC-ERR-FORBIDDEN',
    );
    assert.equal(log.listAppointments.length, 0);
  });

  it('listAppointments：有效权限 → 委托 appointments.listForClub', async () => {
    const { controller, log } = setup({ permissionsFor: ['club:appointment:manage'] });
    const result = await controller.listAppointments(actor, 'club-acm');
    assert.deepEqual(log.effectiveForClub, [{ userId: 'u_operator', clubId: 'club-acm' }]);
    assert.deepEqual(log.listAppointments, [{ clubId: 'club-acm' }]);
    assert.deepEqual(result, { items: [] });
  });

  it('createAppointment：group 引用按 owner/name 解析，URL :clubId 优先于 DTO', async () => {
    const { controller, log } = setup({});
    await controller.createAppointment(actor, 'club-acm', {
      type: 'appoint',
      subjectId: 'u_target',
      departmentGroupId: 'club-acm/宣传部',
      positionGroupId: 'club-acm/副部长',
      revokeFromGroupId: 'club-acm/前部门',
      plannedAt: '2030-01-01T00:00:00Z',
    } as never);
    assert.equal(log.createAppointment.length, 1);
    const created = log.createAppointment[0];
    assert.equal(created['clubId'], 'club-acm');
    assert.equal(created['initiator'], 'u_operator');
    assert.deepEqual(created['content'], {
      subjectId: 'u_target',
      departmentGroup: { owner: 'club-acm', name: '宣传部' },
      positionGroup: { owner: 'club-acm', name: '副部长' },
      revokeFromGroup: { owner: 'club-acm', name: '前部门' },
    });
  });

  it('createAppointment：malformed group 引用 → 422（owner/name 缺一不可）', async () => {
    const { controller } = setup({});
    await assert.rejects(
      () =>
        controller.createAppointment(actor, 'club-acm', {
          type: 'appoint',
          subjectId: 'u_target',
          departmentGroupId: 'only-name',
        } as never),
      (err: unknown) => err instanceof OrgDomainError && err.code === 'IFC-ERR-VALIDATION',
    );
  });

  it('cancelAppointment：URL :clubId/:commandId 透传，actor 与 reason 来自请求', async () => {
    const { controller, log } = setup({});
    await controller.cancelAppointment(actor, 'club-acm', 'cmd-1', {
      reason: '组织调整',
    } as never);
    assert.equal(log.cancelAppointment.length, 1);
    const cancelled = log.cancelAppointment[0];
    assert.equal(cancelled['clubId'], 'club-acm');
    assert.equal(cancelled['commandId'], 'cmd-1');
    assert.equal(cancelled['actor'], 'u_operator');
    assert.equal(cancelled['reason'], '组织调整');
  });

  it('reconfirmAppointment：newExecTime 透传', async () => {
    const { controller, log } = setup({});
    await controller.reconfirmAppointment(actor, 'club-acm', 'cmd-1', {
      newExecTime: '2030-02-01T00:00:00Z',
    } as never);
    const reconfirmed = log.reconfirmAppointment[0];
    assert.equal(reconfirmed['clubId'], 'club-acm');
    assert.equal(reconfirmed['commandId'], 'cmd-1');
    assert.equal(reconfirmed['actor'], 'u_operator');
    assert.equal(reconfirmed['newExecTime'], '2030-02-01T00:00:00Z');
  });

  it('executeAppointment：平台超管（系统身份）可触发 scheduleExecute（ORG-039）', async () => {
    const superAdmin = setup({ superAdmin: true });
    const result = await superAdmin.controller.executeAppointment(actor, 'club-acm', 'cmd-1');
    assert.equal(superAdmin.log.scheduleExecute.length, 1);
    assert.equal(superAdmin.log.scheduleExecute[0].commandId, 'cmd-1');
    assert.equal(superAdmin.log.scheduleExecute[0].clubId, 'club-acm');
    assert.equal(superAdmin.log.scheduleExecute[0].actor, 'u_operator');
    assert.equal(result.status, 'executing');
  });

  it('executeAppointment：非平台超管被拒（调度执行仅系统任务驱动，ORG-039）', async () => {
    const { controller, log } = setup({ superAdmin: false });
    await assert.rejects(
      () => controller.executeAppointment(actor, 'club-acm', 'cmd-1'),
      (err: unknown) => err instanceof OrgDomainError && err.code === 'IFC-ERR-FORBIDDEN',
    );
    assert.equal(log.scheduleExecute.length, 0);
  });

  it('retryAppointment：人工重试 → 委托 retryExecute，URL :clubId/:commandId 透传', async () => {
    const { controller, log } = setup({});
    const result = await controller.retryAppointment(actor, 'club-acm', 'cmd-1');
    assert.equal(log.retryExecute.length, 1);
    assert.equal(log.retryExecute[0].commandId, 'cmd-1');
    assert.equal(log.retryExecute[0].clubId, 'club-acm');
    assert.equal(log.retryExecute[0].actor, 'u_operator');
    assert.equal(result.status, 'executing');
  });
});
