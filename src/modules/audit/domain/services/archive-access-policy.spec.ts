/**
 * ArchiveAccessPolicy.check() 逐角色分支测试（P1 任务⑤；AUD-004）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ArchiveAccessPolicy } from './archive-access-policy';

const policy = new ArchiveAccessPolicy();

const participants = [
  { clubId: 'club-a', enabledAtLock: true },
  { clubId: 'club-b', enabledAtLock: false },
];

describe('ArchiveAccessPolicy.check（AUD-004 角色访问边界）', () => {
  it('超管：任何范围 → 允许 + privileged=true（须审计）', () => {
    const r = policy.check({ principalId: 'u_root', roles: ['SUPER_ADMIN'] }, participants, {
      type: 'ALL',
    });
    assert.equal(r.allowed, true);
    assert.equal(r.privileged, true);
  });

  it('面试官（无其他资格）→ 拒绝（结束后失去全部访问）', () => {
    assert.throws(
      () =>
        policy.check({ principalId: 'u_int', roles: ['INTERVIEWER'] }, participants, {
          type: 'SELF',
        }),
      (e: unknown) => {
        const msg = (e as Error).message;
        return msg.includes('面试官') || msg.includes('失去') || msg.includes('IFC-ERR-003');
      },
    );
  });

  it('申请人：SELF 范围 → 允许', () => {
    const r = policy.check(
      {
        principalId: 'u_applicant',
        roles: [],
        isApplicant: true,
        requestedOwnerId: 'u_applicant',
      },
      participants,
      { type: 'SELF' },
    );
    assert.equal(r.allowed, true);
    assert.equal(r.privileged, false);
  });

  it('申请人：非 SELF 范围 → 拒绝', () => {
    assert.throws(
      () =>
        policy.check(
          {
            principalId: 'u_applicant',
            roles: [],
            isApplicant: true,
          },
          participants,
          { type: 'CLUB', clubId: 'club-a' },
        ),
      (e: unknown) => {
        const msg = (e as Error).message;
        return msg.includes('申请人') || msg.includes('本人') || msg.includes('IFC-ERR-003');
      },
    );
  });

  it('社团负责人/人事：本社团归档 → 允许', () => {
    const r = policy.check(
      {
        principalId: 'u_handler',
        roles: ['CLUB_LEADER'],
        clubId: 'club-a',
      },
      participants,
      { type: 'CLUB', clubId: 'club-a' },
    );
    assert.equal(r.allowed, true);
  });

  it('社团停用期间 → 拒绝（停用不得访问，恢复后放行）', () => {
    assert.throws(
      () =>
        policy.check(
          {
            principalId: 'u_handler',
            roles: ['CLUB_LEADER'],
            clubId: 'club-b',
            clubDisabled: true,
          },
          participants,
          { type: 'CLUB', clubId: 'club-b' },
        ),
      (e: unknown) => {
        const msg = (e as Error).message;
        return msg.includes('停用') || msg.includes('IFC-ERR-003');
      },
    );
  });
});
