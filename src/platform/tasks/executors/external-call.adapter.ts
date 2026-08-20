import { Injectable, Logger } from '@nestjs/common';
import type { TaskType } from '../contracts';

export const ExternalStatus = {
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  UNCERTAIN: 'UNCERTAIN',
} as const;

export type ExternalStatus = (typeof ExternalStatus)[keyof typeof ExternalStatus];

export interface ExternalResult<T = unknown> {
  readonly status: ExternalStatus;
  readonly data?: T;
  readonly error?: string;
  readonly externalOperationId: string;
  readonly observedAt: string;
}

export const EXTERNAL_CALL_ADAPTER = Symbol('EXTERNAL_CALL_ADAPTER');

export interface ExternalCallAdapter {
  call(taskType: TaskType, payload: unknown): Promise<ExternalResult>;
  readBack(taskType: TaskType, payload: unknown): Promise<ExternalResult>;
}

@Injectable()
export class LogOnlyExternalCallAdapter implements ExternalCallAdapter {
  private readonly logger = new Logger(LogOnlyExternalCallAdapter.name);

  async call(taskType: TaskType, _payload: unknown): Promise<ExternalResult> {
    this.logger.warn(`外部调用适配桩：taskType=${taskType}，未执行真实外部调用，返回 UNCERTAIN`);
    return {
      status: ExternalStatus.UNCERTAIN,
      externalOperationId: `stub:${taskType}:${Date.now()}`,
      observedAt: new Date().toISOString(),
    };
  }

  async readBack(taskType: TaskType, _payload: unknown): Promise<ExternalResult> {
    this.logger.warn(`外部回读适配桩：taskType=${taskType}，未执行真实回读，返回 UNCERTAIN`);
    return {
      status: ExternalStatus.UNCERTAIN,
      externalOperationId: `stub-readback:${taskType}:${Date.now()}`,
      observedAt: new Date().toISOString(),
    };
  }
}
