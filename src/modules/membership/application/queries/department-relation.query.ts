import { Inject, Injectable } from '@nestjs/common';

import type { DepartmentRelation } from '../../domain/models/department-relation';
import { currentTenureOf } from '../../domain/models/department-relation';
import { DepartmentRelationStatus } from '../../domain/state-machines/department-relation.state-machine';
import { DEPARTMENT_RELATION_REPOSITORY } from '../../infrastructure/department-relation-repository';
import type { DepartmentRelationRepository } from '../../infrastructure/department-relation-repository';

/** 单条关系段视图（当前关系与经历；IFC-SM-021 读侧） */
export interface DepartmentRelationView {
  readonly relationId: string;
  readonly clubId: string;
  readonly subjectId: string;
  readonly kind: DepartmentRelation['kind'];
  readonly refId: string;
  readonly status: DepartmentRelation['status'];
  /** 当前生效任期（POSITION 类；无则 null） */
  readonly currentTenure: DepartmentRelation['tenures'][number] | null;
  /** 全部任期（历史任期不可变；连任为新任期，不延长/覆盖 MEM-014） */
  readonly tenures: DepartmentRelation['tenures'];
  readonly actualStartAt: string | null;
  readonly actualEndAt: string | null;
  readonly endReason: string | null;
  /** 处理中意图（变更/结束） */
  readonly processing: boolean;
  readonly changeGroupId: string | null;
  readonly changeType: NonNullable<DepartmentRelation['change']>['changeType'] | null;
  /** 同步异常摘要（无异常为 null） */
  readonly anomaly: { reason: string; markedAt: string } | null;
  readonly history: DepartmentRelation['history'];
}

/**
 * 部门/职位关系查询（SRS-SM-MEM-002 读侧；当前关系与经历）。
 *
 * 展示口径收敛在此处：计划任期时间不出现在视图（不展示"已逾期"，MEM-012）；
 * 同步异常段给出 reason/markedAt 供处置入口使用。
 */
@Injectable()
export class DepartmentRelationQuery {
  constructor(
    @Inject(DEPARTMENT_RELATION_REPOSITORY)
    private readonly repo: DepartmentRelationRepository,
  ) {}

  /** 某成员在某社团的全部关系段 */
  async listRelations(clubId: string, subjectId: string): Promise<DepartmentRelationView[]> {
    const relations = await this.repo.listBySubject(clubId, subjectId);
    return relations.map((r) => this.toView(r));
  }

  /** 某成员当前有效的关系段 */
  async listCurrentValid(clubId: string, subjectId: string): Promise<DepartmentRelationView[]> {
    const relations = await this.repo.listBySubject(clubId, subjectId);
    return relations
      .filter((r) => r.status === DepartmentRelationStatus.CURRENTLY_VALID)
      .map((r) => this.toView(r));
  }

  private toView(r: DepartmentRelation): DepartmentRelationView {
    return {
      relationId: r.relationId,
      clubId: r.clubId,
      subjectId: r.subjectId,
      kind: r.kind,
      refId: r.refId,
      status: r.status,
      currentTenure: currentTenureOf(r),
      tenures: r.tenures,
      actualStartAt: r.actualStartAt,
      actualEndAt: r.actualEndAt,
      endReason: r.endReason,
      processing:
        r.status === DepartmentRelationStatus.CHANGE_PROCESSING ||
        r.status === DepartmentRelationStatus.END_PROCESSING,
      changeGroupId: r.change?.changeGroupId ?? null,
      changeType: r.change?.changeType ?? null,
      anomaly:
        r.anomaly === null ? null : { reason: r.anomaly.reason, markedAt: r.anomaly.markedAt },
      history: r.history,
    };
  }
}
