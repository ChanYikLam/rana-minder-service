import { Injectable } from '@nestjs/common';
import { ProjectionType } from '../contracts';
import type { AuthoritativeSnapshot, ProjectionRecord, ProjectionScope } from '../contracts';
import type { DerivationRule } from '../derivation/derivation-rule';
import { BaseProjectionBuilder } from './projection-builder';
import type { RebuildBasis } from './projection-builder';
import type { SourcePortRegistry } from './source-port-registry';

/**
 * 个人中心条目。
 * 只聚合本人事项和当前仍有权的角色型事项；每项携带真实作用域和稳定目标
 * 引用（IFC-QRY-009.5、read-model README §6.3）。
 */
export interface PersonalCenterItem {
  /** 稳定事项标识（源对象类型 + 稳定标识） */
  readonly itemId: string;
  /** 事项类型（申请/日程/邀请/待办/成员经历等） */
  readonly kind: string;
  readonly title: string;
  /** 该事项的真实作用域（不得跨社团合并或扩大） */
  readonly sourceScope: ProjectionScope;
  /** 稳定目标引用（详情与执行逐对象重验，IFC-QRY-003） */
  readonly targetRef: { readonly objectType: string; readonly objectId: string; readonly version: number };
  readonly deadlineAt?: string;
  readonly status: string;
}

/**
 * 个人中心源视图（领域模块快照 view 提供）。
 */
export interface PersonalCenterSourceView {
  readonly itemKind: string;
  readonly title: string;
  readonly deadlineAt?: string;
  readonly status: string;
}

/**
 * 个人中心派生规则：从主体相关权威对象派生事项条目（确定性）。
 */
@Injectable()
export class PersonalCenterRule
  implements DerivationRule<AuthoritativeSnapshot, readonly PersonalCenterItem[]>
{
  readonly ruleName = 'personal-center';

  derive(source: AuthoritativeSnapshot): readonly PersonalCenterItem[] {
    const view = source.view as PersonalCenterSourceView;
    return [
      {
        itemId: `${source.objectType}:${source.objectId}`,
        kind: view.itemKind,
        title: view.title,
        sourceScope: source.scope,
        targetRef: {
          objectType: source.objectType,
          objectId: source.objectId,
          version: source.version,
        },
        deadlineAt: view.deadlineAt,
        status: view.status,
      },
    ];
  }
}

/**
 * 全局个人中心投影（集合投影）。
 * 作用域为 SUBJECT（subjectId 锚点）；遍历已注册权威端口列举主体相关对象。
 */
@Injectable()
export class PersonalCenterProjection extends BaseProjectionBuilder<readonly PersonalCenterItem[]> {
  readonly projectionType = ProjectionType.PERSONAL_CENTER;
  readonly rule = new PersonalCenterRule();

  constructor(readonly sourcePorts: SourcePortRegistry) {
    super();
  }

  async rebuild(
    scope: ProjectionScope,
    basis: RebuildBasis,
  ): Promise<ProjectionRecord<readonly PersonalCenterItem[]> | null> {
    const items: PersonalCenterItem[] = [];
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
        objectType: 'PERSONAL_CENTER',
        objectId: scope.subjectId ?? 'personal-center',
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
