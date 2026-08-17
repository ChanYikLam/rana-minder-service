import { Injectable } from '@nestjs/common';
import { ErrorCode } from './error-code';

export interface ErrorDetail {
  code: ErrorCode;
  message: string;
  field?: string;
}

export interface ErrorInput {
  code: ErrorCode;
  message: string;
  field?: string;
}

@Injectable()
export class ErrorFormatter {
  /** 构造脱敏错误对象：仅公开错误码与面向用户的消息，不携带内部细节。 */
  format(input: ErrorInput): ErrorDetail {
    return {
      code: input.code,
      message: input.message,
      ...(input.field !== undefined ? { field: input.field } : {}),
    };
  }
}
