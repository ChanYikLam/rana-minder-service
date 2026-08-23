/**
 * SessionError 异常过滤器（interfaces/nest；API-AUTH-001）。
 *
 * 把自定义 SessionError 翻译为对应 HTTP 状态码（400/401/403/503）并携带稳定
 * 错误码，避免未捕获时统一退化为 500。注册于全局（main.ts useGlobalFilters）。
 */

import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { SessionError } from './casdoor-session.controller';

@Catch(SessionError)
export class SessionErrorFilter implements ExceptionFilter<SessionError> {
  catch(exception: SessionError, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const status = isHttpStatus(exception.statusCode) ? exception.statusCode : 500;

    res.status(status).json({
      code: exception.code ?? 'SESSION-ERR',
      message: exception.message,
      statusCode: status,
    });
  }
}

function isHttpStatus(value: number): value is number {
  return Number.isInteger(value) && value >= 400 && value < 600;
}
