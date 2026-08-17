import { Injectable } from '@nestjs/common';
import { ProjectionType } from '../contracts';
import type { AuthoritativeSnapshot, ProjectionRecord, ProjectionScope } from '../contracts';
import type { DerivationRule } from '../derivation/derivation-rule';
import { BaseProjectionBuilder } from './projection-builder';
import type { RebuildBasis } from './projection-builder';
import type { SourcePortRegistry } from './source-port-registry';

/**
 * 公开目录条目（"找社团"/"找活动"；IFC-QRY-009.2 两模式独立，不混用名称条件）。
 */
export interface PublicDirectoryItem {
  readonly objectType: 'CLUB' | 'ACTIVITY';
  readonly objectId: string;
  /** 展示名称（权威字段；名称不得成为授权或业务引用，IFC-DATA-001） */
  readonly name: string;
  readonly summary?: string;
  /** 活动报名截止（"正在报名"按查询时共同派生，不是持久状态） */
  readonly deadlineAt?: string;
  readonly sourceVersion: number;
}

/**
 * 公开目录源视图（领域模块实现的快照 view 至少提供这些字段）。
 */
export interface PublicDirectorySourceView {
  readonly objectType: 'CLUB' | 'ACTIVITY';
  readonly displayName: string;
  readonly summary?: string;
  readonly deadlineAt?: string;
  readonly published: boolean;
  readonly channelOpen: boolean;
  readonly paused: boolean;
  readonly terminated: boolean;
}

/**
 * 公开目录派生规则：只放行发布后的普通招新/首次公布后的联合活动
 * （read-model README §6.3）。截止时间过滤按服务端时刻由投影重建时执行。
 */
@Injectable()
export class PublicDirectoryRule
  implements DerivationRule<AuthoritativeSnapshot, readonly PublicDirectoryItem[]>
{
  readonly ruleName = 'public-directory';

  derive(source: AuthoritativeSnapshot): readonly PublicDirectoryItem[] {
    const view = source.view as PublicDirectorySourceView;
    if (!view.published || !view.channelOpen || view.paused || view.terminated) {
      return [];
    }
    return [
      {
        objectType: view.objectType,
        objectId: source.objectId,
        name: view.displayName,
        summary: view.summary,
        deadlineAt: view.deadlineAt,
        sourceVersion: source.version,
      },
    ];
  }
}

/**
 * 公开目录投影（集合投影）。
 * 从 CLUB/ACTIVITY 权威端口列举已发布对象派生；领域模块未注册端口时
 * 该类型不参与（源不可用 → 明确不可用，不伪造新鲜结果）。
 */
@Injectable()
export class PublicDirectoryProjection extends BaseProjectionBuilder<readonly PublicDirectoryItem[]> {
  readonly projectionType = ProjectionType.PUBLIC_DIRECTORY;
  readonly rule = new PublicDirectoryRule();

  constructor(readonly sourcePorts: SourcePortRegistry) {
    super();
  }

  async rebuild(
    scope: ProjectionScope,
    basis: RebuildBasis,
  ): Promise<ProjectionRecord<readonly PublicDirectoryItem[]> | null> {
    const items: PublicDirectoryItem[] = [];
    let maxVersion = 0;
    for (const objectType of ['CLUB', 'ACTIVITY'] as const) {
      const port = this.sourcePorts.get(objectType);
      if (port === null) {
        continue; // 领域未实现：该类型不参与（不伪造）
      }
      const snapshots = await port.list(scope);
      for (const snapshot of snapshots) {
        items.push(...this.rule.derive(snapshot));
        maxVersion = Math.max(maxVersion, snapshot.version);
      }
    }
    if (maxVersion === 0) {
      return null;
    }
    return this.makeRecord(
      {
        objectType: 'PUBLIC_DIRECTORY',
        objectId: 'public-directory',
        version: maxVersion,
        scope,
      },
      items,
      scope,
      basis,
      maxVersion,
    );
  }

  protected formatVersion(): string {
    return 'v1';
  }
}
