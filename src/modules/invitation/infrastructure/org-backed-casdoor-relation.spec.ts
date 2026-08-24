/**
 * OrgBackedCasdoorRelationPort 单元测试（B5；REC-026/ORG-027 安全不变量）：
 * 未回读确认不得返回 confirmed；组合关系全部确认才成功。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  GroupMappingRegistry,
  GroupMappingRecord,
} from '../../organization/application/ports';
import type { CasdoorWritePort } from '../../../platform/casdoor/contracts/ports';
import { ExternalStatus } from '../../../platform/casdoor/contracts/external-result';
import type { ExternalResult } from '../../../platform/casdoor/contracts/external-result';
import { OrgBackedCasdoorRelationPort } from './org-backed-casdoor-relation';

const CLUB_REF = { owner: 'club-acm', name: 'club-acm-成员组' };
const DEPT_REF = { owner: 'club-acm', name: 'club-acm-tech部' };

function fakeRegistry(): GroupMappingRegistry {
  const records: GroupMappingRecord[] = [
    {
      ref: CLUB_REF,
      clubId: 'club-acm',
      purpose: 'CLUB' as never,
      departmentId: null,
      positionId: null,
      mappingVersion: 1,
    },
    {
      ref: DEPT_REF,
      clubId: 'club-acm',
      purpose: 'DEPARTMENT' as never,
      departmentId: 'dept-tech',
      positionId: null,
      mappingVersion: 1,
    },
  ];
  return {
    save: async () => undefined,
    findByRef: async () => null,
    listByClub: async (clubId: string) => (clubId === 'club-acm' ? records : []),
    listAll: async () => records,
  };
}

interface WriteScript {
  writeOk: boolean;
  readbackMembers: string[] | null;
}

function fakeCasdoor(script: WriteScript): CasdoorWritePort {
  return {
    addGroupMembers: async (): Promise<ExternalResult<void>> =>
      script.writeOk
        ? {
            status: ExternalStatus.TRUSTED_CURRENT,
            value: null as never,
            evidence: { observedAt: new Date().toISOString() },
            error: null,
          }
        : {
            status: ExternalStatus.DEPENDENCY_UNAVAILABLE,
            value: null,
            evidence: { observedAt: new Date().toISOString() },
            error: null,
          },
    removeGroupMembers: async (): Promise<ExternalResult<void>> => ({
      status: ExternalStatus.TRUSTED_CURRENT,
      value: null as never,
      evidence: { observedAt: new Date().toISOString() },
      error: null,
    }),
    updateUser: async (): Promise<ExternalResult<void>> => ({
      status: ExternalStatus.TRUSTED_CURRENT,
      value: null as never,
      evidence: { observedAt: new Date().toISOString() },
      error: null,
    }),
    readbackGroupMembers: async (): Promise<ExternalResult<readonly string[]>> =>
      script.readbackMembers === null
        ? {
            status: ExternalStatus.UNCERTAIN,
            value: null,
            evidence: { observedAt: new Date().toISOString() },
            error: null,
          }
        : {
            status: ExternalStatus.TRUSTED_CURRENT,
            value: script.readbackMembers,
            evidence: { observedAt: new Date().toISOString() },
            error: null,
          },
    readbackUser: async (): Promise<ExternalResult<never>> => ({
      status: ExternalStatus.NOT_FOUND,
      value: null,
      evidence: { observedAt: new Date().toISOString() },
      error: null,
    }),
  };
}

describe('OrgBackedCasdoorRelationPort（REC-026/ORG-027）', () => {
  it('写后回读确认成员在场 → ok+confirmed（唯一放行路径）', async () => {
    const port = new OrgBackedCasdoorRelationPort(
      fakeRegistry(),
      fakeCasdoor({ writeOk: true, readbackMembers: ['u_1001'] }),
    );
    const result = await port.writeAndReadBackGroup('club-acm', 'u_1001');
    assert.deepEqual(result, { ok: true, confirmed: true, reason: undefined });
  });

  it('写入成功但回读无此人 → 流程完成但未确认（不开放权限；REC-026 核心）', async () => {
    const port = new OrgBackedCasdoorRelationPort(
      fakeRegistry(),
      fakeCasdoor({ writeOk: true, readbackMembers: ['u_other'] }),
    );
    const result = await port.writeAndReadBackGroup('club-acm', 'u_1001');
    assert.equal(result.ok, true);
    assert.equal(result.confirmed, false);
  });

  it('写入依赖不可用 → ok=false（CAS-WR-008）', async () => {
    const port = new OrgBackedCasdoorRelationPort(
      fakeRegistry(),
      fakeCasdoor({ writeOk: false, readbackMembers: [] }),
    );
    const result = await port.writeAndReadBackGroup('club-acm', 'u_1001');
    assert.equal(result.ok, false);
    assert.equal(result.confirmed, false);
  });

  it('club 无 Group 映射 → fail-closed（不放行、不猜测）', async () => {
    const port = new OrgBackedCasdoorRelationPort(
      fakeRegistry(),
      fakeCasdoor({ writeOk: true, readbackMembers: ['u_1001'] }),
    );
    const result = await port.writeAndReadBackGroup('club-other', 'u_1001');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'CAS-BACK-CLUB_GROUP_NOT_FOUND');
  });

  it('组合关系：社团+部门全部确认才双 true（CAS-WR-013）', async () => {
    let call = 0;
    const base = fakeCasdoor({ writeOk: true, readbackMembers: ['u_1001'] });
    const originalReadback = base.readbackGroupMembers.bind(base);
    const scripted: CasdoorWritePort = Object.assign({}, base, {
      readbackGroupMembers: async (req: {
        ref: { owner: string; name: string };
        requestId: string;
        trackingId: string;
      }): Promise<ExternalResult<readonly string[]>> => {
        call += 1;
        if (call === 2) {
          return {
            status: ExternalStatus.UNCERTAIN,
            value: null,
            evidence: { observedAt: '' },
            error: null,
          };
        }
        return originalReadback(req);
      },
    });
    const port = new OrgBackedCasdoorRelationPort(fakeRegistry(), scripted);
    const result = await port.writeAndReadBackRelations('club-acm', 'u_1001', 'dept-tech');
    assert.equal(result.groupConfirmed, true);
    assert.equal(result.departmentConfirmed, false);
  });

  it('组合关系：社团组写入失败 → 双 false（fail-closed，CAS-WR-010）', async () => {
    const port = new OrgBackedCasdoorRelationPort(
      fakeRegistry(),
      fakeCasdoor({ writeOk: false, readbackMembers: [] }),
    );
    const result = await port.writeAndReadBackRelations('club-acm', 'u_1001', 'dept-tech');
    assert.equal(result.groupConfirmed, false);
    assert.equal(result.departmentConfirmed, false);
    assert.equal(result.reason, 'CAS-BACK-WRITE_FAILED:DEPENDENCY_UNAVAILABLE');
  });
});
