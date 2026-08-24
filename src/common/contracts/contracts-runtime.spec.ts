/**
 * 契约运行时面单测（P2 零覆盖补测：src/common/contracts，契约测试强相关）。
 *
 * 覆盖三个有运行时导出的文件；其余 17 个文件为纯类型声明（编译期契约），
 * 以"可被导入且不抛"作存在性冒烟，防止路径/导出改名破坏下游。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { externalSuccess, externalFailure } from './external-result';
import { API_PREFIX, orgPath, adminPath, activityPath } from './api-paths';
import { IFC_ERROR_CODES, IFC_ERROR_HTTP_STATUS } from './api-error';

describe('external-result（外部调用结果构造器）', () => {
  it('externalSuccess：SUCCESS + data + error=null，attemptId/timestamp 原样保留', () => {
    const ts = new Date('2026-08-23T00:00:00.000Z');
    const r = externalSuccess({ version: 3 }, 'att-1', ts);
    assert.equal(r.status, 'SUCCESS');
    assert.deepEqual(r.data, { version: 3 });
    assert.equal(r.error, null);
    assert.equal(r.attemptId, 'att-1');
    assert.equal(r.timestamp, ts);
  });

  it('externalFailure：data=null，错误四元组原样保留', () => {
    const ts = new Date('2026-08-23T00:00:01.000Z');
    const r = externalFailure(
      'UNCERTAIN',
      {
        code: 'X-WRITE-UNCERTAIN',
        message: 'write accepted but readback failed',
        retryable: true,
        rawStatusCode: null,
      },
      'att-2',
      ts,
    );
    assert.equal(r.status, 'UNCERTAIN');
    assert.equal(r.data, null);
    assert.equal(r.error?.code, 'X-WRITE-UNCERTAIN');
    assert.equal(r.error?.retryable, true);
    assert.equal(r.error?.rawStatusCode, null);
    assert.equal(r.attemptId, 'att-2');
  });

  it('attemptId 与业务幂等键分离：同 attemptId 不同 data 互不影响', () => {
    const a = externalSuccess('A', 'same-id');
    const b = externalSuccess('B', 'same-id');
    assert.equal(a.data, 'A');
    assert.equal(b.data, 'B');
  });
});

describe('api-paths（路由常量冻结基线）', () => {
  it('全局前缀为 /api（API-Q-002 未决前不得变更）', () => {
    assert.equal(API_PREFIX, '/api');
  });

  it('orgPath：社团作用域经 :clubId 表达且子资源拼接正确', () => {
    assert.equal(orgPath.base('club-1'), '/api/org/club-1');
    assert.equal(orgPath.context('club-1'), '/api/org/club-1/context');
    assert.equal(orgPath.dashboard('club-1'), '/api/org/club-1/dashboard');
    assert.equal(orgPath.members('club-1'), '/api/org/club-1/members');
    assert.equal(orgPath.recruitmentDetail('club-1', 'act-1'), '/api/org/club-1/recruitment/act-1');
  });

  it('adminPath：平台特权统一置于 /api/admin 下', () => {
    const joined = Object.values(adminPath).join(' ');
    for (const frag of ['/api/admin/clubs', '/api/admin/groups', '/api/admin/delete/preview']) {
      assert.ok(joined.includes(frag), `adminPath 缺少 ${frag}`);
    }
    assert.ok(Object.values(adminPath).every((p) => p.startsWith('/api/admin/')));
  });

  it('activityPath：报名侧 /api/activity 前缀', () => {
    assert.equal(activityPath.recruitmentApply('act-1'), '/api/activity/recruitment/act-1/apply');
    assert.equal(activityPath.jointApply('j-1'), '/api/activity/joint/j-1/apply');
  });
});

describe('api-error（17 类错误码与状态映射一致性）', () => {
  it('IFC_ERROR_CODES 无重复且含安全关键码', () => {
    assert.equal(new Set(IFC_ERROR_CODES).size, IFC_ERROR_CODES.length);
    for (const must of [
      'IFC-ERR-001',
      'IFC-ERR-002',
      'IFC-ERR-004',
      'IFC-ERR-013',
      'IFC-ERR-015',
    ]) {
      assert.ok(IFC_ERROR_CODES.includes(must as never), `缺少 ${must}`);
    }
  });

  it('每个错误码都有 HTTP 状态映射（无遗漏条目）', () => {
    for (const code of IFC_ERROR_CODES) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(IFC_ERROR_HTTP_STATUS, code),
        `${code} 缺少状态映射`,
      );
    }
  });
});
