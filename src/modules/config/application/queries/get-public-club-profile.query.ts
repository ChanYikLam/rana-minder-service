/**
 * 公开获取社团展示资料查询（CFG-001，5.5.1；公开展示页）。
 *
 * 按观察者作用域投影（display-visibility-policy）：
 * - viewerSubjectId 为 null（未登录）→ ANONYMOUS：仅名称/Logo/简介/公开招新说明；
 * - 有 subjectId 且为本社团成员 → MEMBER：另含成员范围联系方式与内部说明；
 * - 其余有效登录 → AUTHENTICATED：另含主动公开联系方式。
 *
 * 资料不存在 → CFG_NOT_FOUND（公开端点不自动初始化，避免匿名请求写库）。
 * 投影结果结构性排除成员名单/部门关系/职位人员字段（策略内白名单守卫兜底）。
 */

import type { ClubProfileSnapshot } from '../../domain/models/club-profile';
import {
  projectClubProfile,
  type PublicClubProfileView,
  type AuthenticatedClubProfileView,
  type MemberClubProfileView,
} from '../../domain/services/display-visibility-policy';
import type { ClubProfileRepositoryPort, ClubMembershipPort } from '../ports';
import { cfgErrors } from '../errors';

export interface GetPublicClubProfileInput {
  readonly clubId: string;
  /** 未登录为 null */
  readonly viewerSubjectId: string | null;
}

export type GetPublicClubProfileResult =
  PublicClubProfileView | AuthenticatedClubProfileView | MemberClubProfileView;

export interface GetPublicClubProfileQuery {
  execute(input: GetPublicClubProfileInput): Promise<GetPublicClubProfileResult>;
}

export class DefaultGetPublicClubProfileQuery implements GetPublicClubProfileQuery {
  constructor(
    private readonly repository: ClubProfileRepositoryPort,
    private readonly membership: ClubMembershipPort,
  ) {}

  async execute(input: GetPublicClubProfileInput): Promise<GetPublicClubProfileResult> {
    const snapshot: ClubProfileSnapshot | null = await this.repository.load(input.clubId);
    if (snapshot === null) {
      throw cfgErrors.notFound('社团展示资料');
    }

    const scope =
      input.viewerSubjectId === null
        ? 'ANONYMOUS'
        : (await this.membership.isMember(input.clubId, input.viewerSubjectId))
          ? 'MEMBER'
          : 'AUTHENTICATED';

    return projectClubProfile(snapshot, scope);
  }
}
