/**
 * L3 契约测试冒烟：验证传输层契约的运行时常量（错误码 / 状态码映射 / API 路径）。
 * 类型级契约由 tsc（CI 阶段 2）覆盖，此处只覆盖可执行的运行时部分。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IFC_ERROR_CODES, IFC_ERROR_HTTP_STATUS } from '../../src/common/contracts/api-error';
import { API_AUTH, API_PREFIX, orgPath } from '../../src/common/contracts/api-paths';

test('契约 L3 冒烟：17 类错误码与 HTTP 状态映射完整且一致', () => {
  assert.equal(IFC_ERROR_CODES.length, 17);
  assert.deepEqual(Object.keys(IFC_ERROR_HTTP_STATUS).sort(), [...IFC_ERROR_CODES].sort());

  for (const code of IFC_ERROR_CODES) {
    assert.equal(typeof IFC_ERROR_HTTP_STATUS[code], 'number');
  }

  assert.equal(IFC_ERROR_HTTP_STATUS['IFC-ERR-001'], 401);
  assert.equal(IFC_ERROR_HTTP_STATUS['IFC-ERR-005'], 422);
  assert.equal(IFC_ERROR_HTTP_STATUS['IFC-ERR-008'], 409);
  assert.equal(IFC_ERROR_HTTP_STATUS['IFC-ERR-013'], 202);
  assert.equal(IFC_ERROR_HTTP_STATUS['IFC-ERR-014'], 202);
  assert.equal(IFC_ERROR_HTTP_STATUS['IFC-ERR-015'], 404);
  assert.equal(IFC_ERROR_HTTP_STATUS['IFC-ERR-017'], 400);
});

test('契约 L3 冒烟：API 路径常量为 /api 前缀且作用域路径可构造', () => {
  assert.equal(API_PREFIX, '/api');
  assert.equal(API_AUTH.session, '/api/auth/session');
  assert.equal(orgPath.base('club-1'), '/api/org/club-1');
  assert.equal(orgPath.memberDetail('club-1', 'member-1'), '/api/org/club-1/members/member-1');
});
