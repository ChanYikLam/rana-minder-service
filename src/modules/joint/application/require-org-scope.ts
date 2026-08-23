/**
 * 组织作用域校验助手（interfaces→application 边界）。
 *
 * 组织端点命名空间为 /api/org/:clubId/joint/...，路径 clubId 即"操作组织作用域"。
 * 在 3.x 组织授权接入前，这里以领域层不变量兜底：操作组织必须确为联合活动的参与
 * 社团之一，否则视为跨组织越权（IDOR）并拒绝。授权端口调用亦应带入 actingClubId
 * 以便按组织精细判定。
 */

import type { JointRepository } from './ports/joint-repository.port';
import { jointErrors } from './errors';

/** 校验 actingClubId 确为联合活动的参与社团（跨组织作用域绑定）。 */
export async function assertOrgScope(
  repository: JointRepository,
  jointActivityId: string,
  actingClubId: string,
): Promise<void> {
  const participants = await repository.loadParticipantsByActivity(jointActivityId);
  if (!participants.some((p) => p.clubId === actingClubId)) {
    throw jointErrors.forbidden('该组织不属于此联合活动，无操作权限');
  }
}
