/**
 * SessionErrorFilter 单元测试：
 * SessionError 携带的状态码/错误码被正确翻译为 HTTP 响应，避免退化为 500。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ArgumentsHost } from '@nestjs/common';
import { SessionErrorFilter } from './session-error.filter';
import { SessionError } from './casdoor-session.controller';

interface CapturedResponse {
  statusCode: number;
  body: unknown;
}

function buildHost(capture: CapturedResponse): ArgumentsHost {
  const res = {
    status(n: number) {
      capture.statusCode = n;
      return this;
    },
    json(body: unknown) {
      capture.body = body;
      return this;
    },
  };
  return {
    switchToHttp: () => ({ getResponse: () => res }),
  } as unknown as ArgumentsHost;
}

describe('SessionErrorFilter（HTTP 状态翻译）', () => {
  it('403 SessionError → 403 + 稳定错误码 IFC-ERR-011', () => {
    const capture: CapturedResponse = { statusCode: 0, body: null };
    const host = buildHost(capture);
    const filter = new SessionErrorFilter();
    filter.catch(new SessionError('账号已被禁用或删除', 403, 'IFC-ERR-011'), host);

    assert.equal(capture.statusCode, 403);
    assert.deepEqual(capture.body, {
      code: 'IFC-ERR-011',
      message: '账号已被禁用或删除',
      statusCode: 403,
    });
  });

  it('400 SessionError → 400 + 默认错误码 SESSION-ERR', () => {
    const capture: CapturedResponse = { statusCode: 0, body: null };
    const host = buildHost(capture);
    const filter = new SessionErrorFilter();
    filter.catch(new SessionError('Missing code or state', 400), host);

    assert.equal(capture.statusCode, 400);
    assert.deepEqual(capture.body, {
      code: 'SESSION-ERR',
      message: 'Missing code or state',
      statusCode: 400,
    });
  });

  it('非 4xx/5xx 状态码 → 防御性回退 500', () => {
    const capture: CapturedResponse = { statusCode: 0, body: null };
    const host = buildHost(capture);
    const filter = new SessionErrorFilter();
    filter.catch(new SessionError('boom', 200), host);

    assert.equal(capture.statusCode, 500);
  });
});
