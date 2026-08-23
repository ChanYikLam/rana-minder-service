/**
 * 共享同意快照校验（joint 域服务；JNT-003 硬前提）。
 *
 * 活动公布时锁定参与社团集合（排序后稳定哈希）；申请人提交须携带相同哈希，
 * 不得自动勾选或沿用其他活动同意。哈希算法稳定、确定性，供仓储与用例复用。
 */

import { createHash } from 'node:crypto';

export class ConsentVerifier {
  /** 由参与社团 clubId 列表计算确定性哈希（排序去重） */
  static computeConsentHash(clubIds: readonly string[]): string {
    const normalized = [...new Set(clubIds)].sort();
    return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  }

  static verify(provided: string, lockedClubIds: readonly string[]): boolean {
    return provided === ConsentVerifier.computeConsentHash(lockedClubIds);
  }
}
