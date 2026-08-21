import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AdminPermissionTemplatesController } from './admin-permission-templates.controller';
import { OrgDomainError } from '../../domain/types';
import type { PermissionTemplateQuery } from '../../application/queries/permission-template.query';
import type { PermissionTemplateCommand } from '../../application/commands/permission-template.command';
import type { CurrentPermissionsPort } from '../../application/ports';
import type { RequestActor } from '../actor';

const actor: RequestActor = { userId: 'u_root' };

interface CallLog {
  list: unknown[];
  create: unknown[];
  saveDraft: unknown[];
  diff: unknown[];
  publish: unknown[];
  isPlatformSuperAdmin: unknown[];
}

function setup(options: { superAdmin?: boolean } = {}): {
  controller: AdminPermissionTemplatesController;
  log: CallLog;
} {
  const log: CallLog = {
    list: [],
    create: [],
    saveDraft: [],
    diff: [],
    publish: [],
    isPlatformSuperAdmin: [],
  };

  const query = {
    list: async () => {
      log.list.push({});
      return [];
    },
    diff: async (input: { templateId: string }) => {
      log.diff.push(input);
      return { added: [], removed: [] };
    },
  } as unknown as PermissionTemplateQuery;

  const command = {
    create: async (input: { name: string; permissions: string[] }) => {
      log.create.push(input);
      return { id: 't-1', name: input.name };
    },
    saveDraft: async (input: { templateId: string; name: string; permissions: string[] }) => {
      log.saveDraft.push(input);
      return { id: input.templateId };
    },
    publish: async (input: {
      templateId: string;
      reauthProof: string;
      previewVersion: number;
      reason: string;
    }) => {
      log.publish.push(input);
      return { id: input.templateId, status: 'published' };
    },
  } as unknown as PermissionTemplateCommand;

  const permissions = {
    isPlatformSuperAdmin: async (userId: string) => {
      log.isPlatformSuperAdmin.push({ userId });
      return options.superAdmin ?? false;
    },
  } as unknown as CurrentPermissionsPort;

  const controller = new AdminPermissionTemplatesController(query, command, permissions);

  return { controller, log };
}

// -----------------------------------------------------------------------------
// §15.3 权限模板 —— 所有端点执行平台超管前置（platform:config:manage）
// -----------------------------------------------------------------------------

describe('AdminPermissionTemplatesController §15.3 平台超管前置（platform:config:manage）', () => {
  it('非平台超管调用任一端点均被拒绝（不泄露模板与差异）', async () => {
    const { controller, log } = setup({ superAdmin: false });
    const allCalls = [
      () => controller.list(actor),
      () => controller.create(actor, { name: 't', permissions: [] } as never),
      () => controller.saveDraft(actor, 't-1', { name: 't', permissions: [] } as never),
      () => controller.diff(actor, 't-1'),
      () =>
        controller.publish(actor, 't-1', {
          reauthProof: 'p',
          previewVersion: 1,
          reason: 'r',
        } as never),
    ];
    for (const fn of allCalls) {
      await assert.rejects(
        fn,
        (err: unknown) => err instanceof OrgDomainError && err.code === 'IFC-ERR-FORBIDDEN',
      );
    }
    assert.equal(log.list.length, 0);
    assert.equal(log.create.length, 0);
    assert.equal(log.saveDraft.length, 0);
    assert.equal(log.diff.length, 0);
    assert.equal(log.publish.length, 0);
  });
});

describe('AdminPermissionTemplatesController §15.3 全部端点（已通过前置）', () => {
  it('list / create / saveDraft / diff / publish 透传', async () => {
    const { controller, log } = setup({ superAdmin: true });

    const listed = await controller.list(actor);
    assert.deepEqual(listed, { items: [] });

    const created = await controller.create(actor, { name: 't-1', permissions: ['p:1'] } as never);
    assert.equal((log.create[0] as { name: string }).name, 't-1');
    assert.deepEqual((log.create[0] as { permissions: string[] }).permissions, ['p:1']);
    assert.equal(created.id, 't-1');

    await controller.saveDraft(actor, 't-1', { name: 't-2', permissions: ['p:1', 'p:2'] } as never);
    const saved = log.saveDraft[0] as { templateId: string; name: string; permissions: string[] };
    assert.equal(saved.templateId, 't-1');
    assert.deepEqual(saved.permissions, ['p:1', 'p:2']);

    await controller.diff(actor, 't-1');
    assert.equal((log.diff[0] as { templateId: string }).templateId, 't-1');

    const published = await controller.publish(actor, 't-1', {
      reauthProof: 'proof-1',
      previewVersion: 3,
      reason: '发布版本',
    } as never);
    const pub = log.publish[0] as {
      templateId: string;
      reauthProof: string;
      previewVersion: number;
      reason: string;
    };
    assert.equal(pub.templateId, 't-1');
    assert.equal(pub.reauthProof, 'proof-1');
    assert.equal(pub.previewVersion, 3);
    assert.equal(pub.reason, '发布版本');
    assert.equal(published.status, 'published');
  });
});
