import type { AuthoritativeSnapshot } from '../../contracts';
import type { DerivationRule } from '../../derivation/derivation-rule';
import type { PublicDirectoryItem } from '../public-directory.projection';

/**
 * 找活动源视图（领域模块 ACTIVITY 快照 view 至少提供这些字段）。
 *
 * firstPublishedAt：首次公布时间（C6.8：只有"首次公布后的联合活动"才能
 * 进入公开结果——若领域提供该字段，未公布（undefined 或晚于服务端时刻）
 * 视为不得进入；普通招新不受限）。
 */
export interface ActivityDirectorySourceView {
  readonly objectType: 'ACTIVITY';
  readonly displayName: string;
  readonly summary?: string;
  readonly deadlineAt?: string;
  readonly activityType?: string;
  /** 首次公布时间（联合活动语义；可选） */
  readonly firstPublishedAt?: string;
  readonly published: boolean;
  readonly channelOpen: boolean;
  readonly paused: boolean;
  readonly terminated: boolean;
}

/**
 * 找活动派生规则（C6.2）：按活动名称搜索＋活动类型/报名状态/截止筛选
 * （同一时刻不组合两个名称条件；筛选由查询入口登记目录校验后应用）。
 *
 * 进入公开结果条件（C6.8）：发布后的普通招新，或首次公布后的联合活动。
 */
export class ActivityDirectoryRule
  implements DerivationRule<AuthoritativeSnapshot, readonly PublicDirectoryItem[]>
{
  readonly ruleName = 'find-activity';

  derive(source: AuthoritativeSnapshot): readonly PublicDirectoryItem[] {
    const view = source.view as ActivityDirectorySourceView;
    if (view.objectType !== 'ACTIVITY') {
      return [];
    }
    if (!view.published || !view.channelOpen || view.paused || view.terminated) {
      return [];
    }
    // 首次公布后的联合活动（C6.8）：提供了 firstPublishedAt 则必须已公布
    if (view.firstPublishedAt !== undefined && view.firstPublishedAt === '') {
      return [];
    }
    return [
      {
        objectType: 'ACTIVITY',
        objectId: source.objectId,
        name: view.displayName,
        summary: view.summary,
        deadlineAt: view.deadlineAt,
        activityType: view.activityType,
        sourceVersion: source.version,
      },
    ];
  }
}
