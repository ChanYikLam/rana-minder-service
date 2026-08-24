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

/**
 * 生产默认批量项鉴权：fail-closed（拒绝）。
 * 真实授权接入前禁止任何批量项执行；Development 桩仅用于非生产环境。
 */
@Injectable()
export class DenyAllBatchItemAuthorization implements BatchItemAuthorizationPort {
  async verify(
    principalId: string,
    operationType: string,
    businessType: string,
    item: BatchItemInput,
  ): Promise<{ ok: boolean; reason?: string }> {
    return {
      ok: false,
      reason: `production-batch-authorization-not-configured:${principalId}:${operationType}:${item.itemId}`,
    };
  }
}
