import { Injectable } from '@nestjs/common';
import { ProjectionType } from '../contracts';
import type { AuthoritativeSnapshot, ProjectionRecord, ProjectionScope } from '../contracts';
import type { DerivationRule } from '../derivation/derivation-rule';
import { BaseProjectionBuilder } from './projection-builder';
import type { RebuildBasis } from './projection-builder';
import { SourcePortRegistry } from './source-port-registry';

/**
 * 当前社团管理工作台条目（IFC-QRY-003、IFC-QRY-009.6）。
 * 固定当前社团，不跨社团合并管理数据；打开/筛选/详情/命令均重新授权。
 */
export interface WorkbenchItem {
  /** 稳定条目标识 */
  readonly itemId: string;
  /** 条目类型（角色型待办/异常/批次/任务等） */
  readonly kind: string;
  readonly title: string;
  /** 目标角色类型（如 'CLUB_ADMIN'） */
  readonly targetRole: string;
  /** 社团/联合域作用域（不跨社团合并） */
  readonly targetScope: ProjectionScope;
  /** 源对象/版本（打开/执行时重新授权） */
  readonly sourceRef: { readonly objectType: string; readonly objectId: string; readonly version: number };
  readonly status: string;
  readonly deadlineAt?: string;
}

/**
 * 工作台源视图（领域模块快照 view 提供）。
 */
export interface WorkbenchSourceView {
  readonly itemKind: string;
  readonly title: string;
  readonly targetRole: string;
  readonly status: string;
  readonly deadlineAt?: string;
}

/**
 * 工作台派生规则：从社团作用域内角色型对象派生条目（确定性）。
 */
@Injectable()
export class ClubWorkbenchRule implements DerivationRule<AuthoritativeSnapshot, readonly WorkbenchItem[]> {
  readonly ruleName = 'club-workbench';

  derive(source: AuthoritativeSnapshot): readonly WorkbenchItem[] {
    const view = source.view as WorkbenchSourceView;
    return [
      {
        itemId: `${source.objectType}:${source.objectId}`,
        kind: view.itemKind,
        title: view.title,
        targetRole: view.targetRole,
        targetScope: source.scope,
        sourceRef: {
          objectType: source.objectType,
          objectId: source.objectId,
          version: source.version,
        },
        status: view.status,
        deadlineAt: view.deadlineAt,
      },
    ];
  }
}

/**
 * 当前社团管理工作台投影（集合投影）。
 * 作用域为 CLUB（clubId 锚点）；遍历已注册权威端口列举社团作用域对象。
 */
@Injectable()
export class ClubWorkbenchProjection extends BaseProjectionBuilder<readonly WorkbenchItem[]> {
  readonly projectionType = ProjectionType.CLUB_WORKBENCH;
  readonly rule = new ClubWorkbenchRule();

  constructor(readonly sourcePorts: SourcePortRegistry) {
    super();
  }

  async rebuild(
    scope: ProjectionScope,
    basis: RebuildBasis,
  ): Promise<ProjectionRecord<readonly WorkbenchItem[]> | null> {
    const items: WorkbenchItem[] = [];
    let maxVersion = 0;
    for (const port of this.sourcePorts.list()) {
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
        objectType: 'CLUB_WORKBENCH',
        objectId: scope.clubId ?? 'club-workbench',
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
