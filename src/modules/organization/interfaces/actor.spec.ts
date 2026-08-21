import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveActorFromHeaders } from './actor';
import { OrgDomainError } from '../domain/types';

describe('Actor 请求头解析（生产环境 fail-closed，IFC-ERR-001）', () => {
  const PROD_ENV = { NODE_ENV: 'production', ORG_DEV_ACTOR_HEADER: '1' };
  const DEV_ENABLED_ENV = { NODE_ENV: 'development', ORG_DEV_ACTOR_HEADER: '1' };
  const DEV_DISABLED_ENV = { NODE_ENV: 'development' };

  it('生产环境（NODE_ENV=production）：拒绝信任 x-actor-id', () => {
    assert.throws(
      () => resolveActorFromHeaders({ 'x-actor-id': 'u_root' }, PROD_ENV),
      (err: unknown) => err instanceof OrgDomainError && err.code === 'IFC-ERR-FORBIDDEN',
    );
  });

  it('开发环境未显式开启 ORG_DEV_ACTOR_HEADER：拒绝', () => {
    assert.throws(
      () => resolveActorFromHeaders({ 'x-actor-id': 'u_root' }, DEV_DISABLED_ENV),
      (err: unknown) => err instanceof OrgDomainError && err.code === 'IFC-ERR-FORBIDDEN',
    );
  });

  it('显式开启 ORG_DEV_ACTOR_HEADER=1 但缺 x-actor-id 头：拒绝', () => {
    assert.throws(
      () => resolveActorFromHeaders({}, DEV_ENABLED_ENV),
      (err: unknown) => err instanceof OrgDomainError && err.code === 'IFC-ERR-FORBIDDEN',
    );
  });

  it('显式开启 ORG_DEV_ACTOR_HEADER=1 且 x-actor-id 为空串：拒绝', () => {
    assert.throws(
      () => resolveActorFromHeaders({ 'x-actor-id': '' }, DEV_ENABLED_ENV),
      (err: unknown) => err instanceof OrgDomainError && err.code === 'IFC-ERR-FORBIDDEN',
    );
  });

  it('显式开启 ORG_DEV_ACTOR_HEADER=1 且 x-actor-id 合法：返回 RequestActor', () => {
    const result = resolveActorFromHeaders({ 'x-actor-id': 'u_root' }, DEV_ENABLED_ENV);
    assert.deepEqual(result, { userId: 'u_root' });
  });

  it('显式开启 ORG_DEV_ACTOR_HEADER=1 且 x-actor-id 头为数组：取首项', () => {
    const result = resolveActorFromHeaders(
      { 'x-actor-id': ['u_root', 'u_other'] },
      DEV_ENABLED_ENV,
    );
    assert.deepEqual(result, { userId: 'u_root' });
  });
});
