/**
 * 管理端获取社团展示资料查询（CFG-001，5.5.1）。
 *
 * 仅负责人/人事（club:config:manage）或平台超管可读；回显 Casdoor Group 对应关系
 * （accessInfo，组织模块暴露绑定查询前为 null）供超管后台核对「展示名↔Group 名」。
 *
 * 不存在时返回 profile=null（评审修复：读端点不再带写副作用——自动初始化职责
 * 归属写路径，UpdateClubProfileCommand 在资料不存在时自行 createDefault；前端
 * 以 null 渲染空白表单，首次保存即完成初始化）。公开端点不受影响（仍 404）。
 */

import type { ClubProfileSnapshot } from '../../domain/models/club-profile';
import type {
  ClubProfileRepositoryPort,
  ClubProfileAuthorizationPort,
  ClubAccessInfoPort,
} from '../ports';
import { cfgErrors } from '../errors';

export interface GetClubProfileInput {
  readonly clubId: string;
  readonly actor: string;
}

export interface GetClubProfileResult {
  /** null=尚未初始化（无写副作用；首存由 PUT 命令完成） */
  readonly profile: ClubProfileSnapshot | null;
  readonly accessInfo: {
    casdoorGroupId: string;
    casdoorGroupName: string;
  } | null;
}

export interface GetClubProfileQuery {
  execute(input: GetClubProfileInput): Promise<GetClubProfileResult>;
}

export class DefaultGetClubProfileQuery implements GetClubProfileQuery {
  constructor(
    private readonly repository: ClubProfileRepositoryPort,
    private readonly authorization: ClubProfileAuthorizationPort,
    private readonly accessInfo: ClubAccessInfoPort,
  ) {}

  async execute(input: GetClubProfileInput): Promise<GetClubProfileResult> {
    if ((await this.authorization.canManageAs(input.clubId, input.actor)) === null) {
      throw cfgErrors.forbidden('仅社团负责人/人事或平台超管可查看展示资料');
    }

    const snapshot = await this.repository.load(input.clubId);
    return { profile: snapshot, accessInfo: await this.accessInfo.getAccessInfo(input.clubId) };
  }
}
