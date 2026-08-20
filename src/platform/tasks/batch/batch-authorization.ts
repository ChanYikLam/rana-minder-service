import { Injectable } from '@nestjs/common';
import type { BatchItemInput } from '../contracts';

export const BATCH_ITEM_AUTHORIZATION_PORT = Symbol('BATCH_ITEM_AUTHORIZATION_PORT');

export interface BatchItemAuthorizationPort {
  verify(
    principalId: string,
    operationType: string,
    businessType: string,
    item: BatchItemInput,
  ): Promise<{ ok: boolean; reason?: string }>;
}

@Injectable()
export class DevelopmentBatchItemAuthorization implements BatchItemAuthorizationPort {
  async verify(
    _principalId: string,
    _operationType: string,
    _businessType: string,
    _item: BatchItemInput,
  ): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true, reason: 'development-batch-authorization' };
  }
}
