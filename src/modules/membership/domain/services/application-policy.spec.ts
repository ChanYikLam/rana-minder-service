/**
 * Membership DepartmentApplicationPolicy 逐分支测试（P1 任务⑤；MEM-009/017）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DepartmentApplicationPolicy, ApplicationPreconditionError } from './application-policy';

const policy = new DepartmentApplicationPolicy();

describe('DepartmentApplicationPolicy.assertSubmittable（MEM-009/017）', () => {
  it('JOIN：申请人是成员 + 目标部门有效 + 无冲突 → 通过', () => {
    assert.doesNotThrow(() =>
      policy.assertSubmittable(
        {
          applicantIsMember: true,
          targetDeptActive: true,
          applicantDepartmentIds: [],
          hasConflictingPending: false,
        },
        'JOIN' as never,
        'dept-1',
        [],
      ),
    );
  });

  it('JOIN：非社团成员 → forbidden', () => {
    assert.throws(
      () =>
        policy.assertSubmittable(
          {
            applicantIsMember: false,
            targetDeptActive: true,
            applicantDepartmentIds: [],
            hasConflictingPending: false,
          },
          'JOIN' as never,
          'dept-1',
          [],
        ),
      ApplicationPreconditionError,
    );
  });

  it('有冲突待审批 → precondition', () => {
    assert.throws(
      () =>
        policy.assertSubmittable(
          {
            applicantIsMember: true,
            targetDeptActive: true,
            applicantDepartmentIds: [],
            hasConflictingPending: true,
          },
          'JOIN' as never,
          'dept-1',
          [],
        ),
      ApplicationPreconditionError,
    );
  });

  it('LEAVE：申请人不在任何部门 → precondition（无退出范围）', () => {
    assert.throws(
      () =>
        policy.assertSubmittable(
          {
            applicantIsMember: true,
            targetDeptActive: null,
            applicantDepartmentIds: [],
            hasConflictingPending: false,
          },
          'LEAVE' as never,
          null,
          [],
        ),
      ApplicationPreconditionError,
    );
  });
});

describe('DepartmentApplicationPolicy.assertRejectReason', () => {
  it('拒绝原因为空 → precondition', () => {
    assert.throws(() => policy.assertRejectReason(null), ApplicationPreconditionError);
  });

  it('拒绝原因非空 → 通过', () => {
    assert.doesNotThrow(() => policy.assertRejectReason('不符合条件'));
  });
});
