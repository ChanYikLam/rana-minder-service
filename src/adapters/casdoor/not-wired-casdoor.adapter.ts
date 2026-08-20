/**
 * Casdoor 适配桩（adapters/casdoor/；未连接态失败关闭）。
 *
 * DEP-Q-001/002 锁定前一律返回 UNAVAILABLE：领域层按 IFC-ERR-012 语义降级，
 * 不得伪成功、不得伪造可信回读（CAS-WR-006/007 写后定向读回是唯一成功收口）。
 */

import { randomUUID } from 'node:crypto';
import type { CasdoorAdapter, CasdoorUser, CasdoorUserPatch } from './casdoor-adapter';
import {
  externalFailure,
  type ExternalResult,
} from '../../common/contracts/external-result';

export class NotWiredCasdoorAdapter implements CasdoorAdapter {
  async getUser(_userId: string): Promise<ExternalResult<CasdoorUser>> {
    return externalFailure(
      'UNAVAILABLE',
      {
        code: 'CAS-NOT-WIRED',
        message: 'Casdoor 适配未连接（首版桩）',
        retryable: true,
        rawStatusCode: null,
      },
      randomUUID(),
      new Date(),
    );
  }

  async updateUser(_userId: string, _patch: CasdoorUserPatch): Promise<ExternalResult<void>> {
    return externalFailure(
      'UNAVAILABLE',
      {
        code: 'CAS-NOT-WIRED',
        message: 'Casdoor 适配未连接（首版桩）',
        retryable: true,
        rawStatusCode: null,
      },
      randomUUID(),
      new Date(),
    );
  }
}