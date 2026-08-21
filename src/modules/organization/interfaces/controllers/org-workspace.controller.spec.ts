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

describe('OrgWorkspaceController 预约命令端点', () => {
  const actor: RequestActor = { userId: 'u_operator' };

  function setup(options: { superAdmin?: boolean }) {
    const calls: string[] = [];
    const appointments = {
      scheduleExecute: async (input: { commandId: string; actor: string }) => {
        calls.push(`schedule:${input.commandId}:${input.actor}`);
        return { id: input.commandId, status: 'executing' };
      },
      retryExecute: async (input: { commandId: string; actor: string }) => {
        calls.push(`retry:${input.commandId}:${input.actor}`);
        return { id: input.commandId, status: 'executing' };
      },
    } as unknown as AppointmentCommandUseCase;
    const permissions = {
      isPlatformSuperAdmin: async () => options.superAdmin ?? false,
    } as unknown as CurrentPermissionsPort;
    const controller = new OrgWorkspaceController(
      {} as OrgContextQuery,
      {} as RelationCommandUseCase,
      appointments,
      {} as ClubStore,
      permissions,
    );
    return { controller, appointments, calls };
  }

  it('execute：平台超管（系统身份）可触发调度执行（scheduleExecute）', async () => {
    const { controller, calls } = setup({ superAdmin: true });
    const result = await controller.executeAppointment(actor, 'club-1', 'cmd-1');
    assert.deepEqual(calls, ['schedule:cmd-1:u_operator']);
    assert.equal(result.status, 'executing');
  });

  it('execute：非平台超管被拒绝（调度执行仅系统任务驱动，ORG-039）', async () => {
    const { controller, calls } = setup({ superAdmin: false });
    await assert.rejects(
      () => controller.executeAppointment(actor, 'club-1', 'cmd-1'),
      (err: unknown) => err instanceof OrgDomainError && err.code === 'IFC-ERR-FORBIDDEN',
    );
    assert.deepEqual(calls, []);
  });

  it('retry：有权操作者可触发人工重试（retryExecute）', async () => {
    const { controller, calls } = setup({ superAdmin: false });
    const result = await controller.retryAppointment(actor, 'club-1', 'cmd-1');
    assert.deepEqual(calls, ['retry:cmd-1:u_operator']);
    assert.equal(result.status, 'executing');
  });
});
