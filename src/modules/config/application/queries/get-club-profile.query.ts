/**
 * 管理端获取社团展示资料查询（CFG-001，5.5.1）。
 *
 * 仅负责人/人事（club:config:manage）或平台超管可读；回显 Casdoor Group 对应关系
 * （accessInfo，组织模块暴露绑定查询前为 null）供超管后台核对「展示名↔Group 名」。
 *
 * 不存在时自动初始化并保存：后台首屏配置场景下，新社团尚未有资料属常态，首次
 * 打开即落一条 revisionNumber=1 的默认资料，后续 PUT 直接走乐观锁更新；若改为
 * CFG_NOT_FOUND 则前端需额外处理首屏空态。公开端点不受此影响（公开查询仍 404）。
 */

import { ClubProfile } from '../../domain/models/club-profile';
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
  readonly profile: ClubProfileSnapshot;
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

    let snapshot = await this.repository.load(input.clubId);
    if (snapshot === null) {
      // 自动初始化默认资料（见文件头注释：便于后台首屏配置）
      const profile = ClubProfile.createDefault({
        clubId: input.clubId,
        clubName: input.clubId,
        now: new Date(),
      });
      snapshot = profile.toSnapshot();
      await this.repository.save(snapshot);
    }

    return { profile: snapshot, accessInfo: await this.accessInfo.getAccessInfo(input.clubId) };
  }
}
