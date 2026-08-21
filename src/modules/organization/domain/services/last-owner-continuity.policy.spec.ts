import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LastOwnerContinuityPolicy } from './last-owner-continuity.policy';

describe('LastOwnerContinuityPolicy', () => {
  it('启用中的社团必须保留至少一名负责人（ORG-024）', () => {
    assert.doesNotThrow(() => LastOwnerContinuityPolicy.assertClubHasOwner(['u_a'], 'ACM社团'));
    assert.throws(
      () => LastOwnerContinuityPolicy.assertClubHasOwner([], 'ACM社团'),
      (e: Error) => e.message.includes('至少一名负责人'),
    );
  });

  it('紧急停用可暂时无负责人（ORG-028 强停豁免）', () => {
    assert.doesNotThrow(() => LastOwnerContinuityPolicy.assertClubHasOwner([], 'ACM社团', true));
  });

  it('撤销普通成员不触发继任要求', () => {
    assert.doesNotThrow(() =>
      LastOwnerContinuityPolicy.assertNoZeroOwnerWindow({
        currentOwners: ['u_a'],
        subjectId: 'u_c',
        successors: [],
      }),
    );
  });

  it('撤销负责人但仍有他人 → 允许', () => {
    assert.doesNotThrow(() =>
      LastOwnerContinuityPolicy.assertNoZeroOwnerWindow({
        currentOwners: ['u_a', 'u_b'],
        subjectId: 'u_a',
        successors: [],
      }),
    );
  });

  it('撤销最后一名负责人须同一操作指定继任者', () => {
    assert.throws(
      () =>
        LastOwnerContinuityPolicy.assertNoZeroOwnerWindow({
          currentOwners: ['u_a'],
          subjectId: 'u_a',
          successors: [],
        }),
      (e: Error) => e.message.includes('零负责人窗口'),
    );
    assert.doesNotThrow(() =>
      LastOwnerContinuityPolicy.assertNoZeroOwnerWindow({
        currentOwners: ['u_a'],
        subjectId: 'u_a',
        successors: ['u_b'],
      }),
    );
  });

  it('人事管理员平时不得处理负责人变更（ORG-021）', () => {
    assert.throws(
      () => LastOwnerContinuityPolicy.assertPersonnelMayTouchLeader('personnel', true, false),
      (e: Error) => e.message.includes('确认流程'),
    );
    assert.doesNotThrow(() =>
      LastOwnerContinuityPolicy.assertPersonnelMayTouchLeader('personnel', true, true),
    );
    assert.doesNotThrow(() =>
      LastOwnerContinuityPolicy.assertPersonnelMayTouchLeader('leader', true, false),
    );
  });
});
