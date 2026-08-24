/**
 * GOV-007/#68 生产装配防护：内存桩在 NODE_ENV=production 下构造即抛错；
 * 开发/测试不受影响。这是"生产不装配内存桩"红线的直接回归测试。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryAppointmentCommandStore,
  InMemoryCasdoorPort,
  InMemoryClubStore,
  InMemoryGroupMappingRegistry,
  InMemoryJobScheduler,
  InMemoryNotificationPort,
  InMemoryPermissionTemplateStore,
  InMemoryRelationCommandStore,
  MemoryCurrentPermissionsPort,
  assertMemoryStubAllowed,
} from './memory-implementations';
import { OrgDomainError } from '../../domain/types';

describe('内存桩生产装配防护（GOV-007）', () => {
  function withProdEnv(fn: () => void): void {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      fn();
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  }

  const constructEach = (): Array<() => unknown> => [
    () => new InMemoryClubStore(),
    () => new InMemoryRelationCommandStore(),
    () => new InMemoryAppointmentCommandStore(),
    () => new InMemoryPermissionTemplateStore(),
    () => new InMemoryGroupMappingRegistry(),
    () =>
      new InMemoryCasdoorPort({
        groups: [
          { ref: { owner: 'o', name: 'g' }, displayName: 'g', parentRef: null, memberIds: [] },
        ],
      }),
    () => new InMemoryJobScheduler(),
    () => new InMemoryNotificationPort(),
    () =>
      new MemoryCurrentPermissionsPort({
        superAdminUsers: [],
        clubPermissions: new Map(),
        positionGroupMemberships: new Map(),
      }),
  ];

  it('assertMemoryStubAllowed：生产抛 IFC-ERR-016，测试环境放行', () => {
    assert.throws(
      () => assertMemoryStubAllowed('X', { NODE_ENV: 'production' }),
      (e: unknown) => e instanceof OrgDomainError && e.code === 'IFC-ERR-016',
    );
    assert.doesNotThrow(() => assertMemoryStubAllowed('X', { NODE_ENV: 'test' }));
    assert.doesNotThrow(() => assertMemoryStubAllowed('X'));
  });

  it('全部九个内存桩在生产环境下构造即失败（fail-fast）', () => {
    for (const construct of constructEach()) {
      assert.throws(
        () => withProdEnv(construct as () => void),
        (e: unknown) =>
          e instanceof OrgDomainError && e.code === 'IFC-ERR-016' && e.message.includes('GOV-007'),
      );
    }
  });

  it('测试环境（NODE_ENV=test，来自 .env.test）下全部桩可正常构造', () => {
    for (const construct of constructEach()) {
      assert.doesNotThrow(() => construct());
    }
  });
});
