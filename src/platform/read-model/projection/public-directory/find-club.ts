import type { AuthoritativeSnapshot } from '../../contracts';
import type { DerivationRule } from '../../derivation/derivation-rule';
import type { PublicDirectoryItem } from '../public-directory.projection';

/**
 * 找社团源视图（领域模块 CLUB 快照 view 至少提供这些字段）。
 */
export interface ClubDirectorySourceView {
  readonly objectType: 'CLUB';
  readonly displayName: string;
  readonly summary?: string;
  readonly published: boolean;
  readonly channelOpen: boolean;
  readonly paused: boolean;
  readonly terminated: boolean;
}

/**
 * 找社团派生规则（C6.1）：按社团展示名称进入公开目录（单一名称模式）。
 *
 * 只有发布后的普通招新语义（published 且通道开放、无暂停/终态）才能进入
 * 公开结果（C6.8）；截止过滤由投影重建时按服务端时刻执行。
 */
export class ClubDirectoryRule implements DerivationRule<
  AuthoritativeSnapshot,
  readonly PublicDirectoryItem[]
> {
  readonly ruleName = 'find-club';

  derive(source: AuthoritativeSnapshot): readonly PublicDirectoryItem[] {
    const view = source.view as ClubDirectorySourceView;
    if (view.objectType !== 'CLUB') {
      return [];
    }
    if (!view.published || !view.channelOpen || view.paused || view.terminated) {
      return [];
    }
    return [
      {
        objectType: 'CLUB',
        objectId: source.objectId,
        name: view.displayName,
        summary: view.summary,
        sourceVersion: source.version,
      },
    ];
  }
}
