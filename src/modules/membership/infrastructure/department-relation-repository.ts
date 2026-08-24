import { Injectable } from '@nestjs/common';

import type { DepartmentRelation } from '../domain/models/department-relation';
import { DepartmentRelationStatus } from '../domain/state-machines/department-relation.state-machine';

/** 部门/职位关系仓储注入令牌（DepartmentRelationRepository 为接口，注入须用显式 token） */
export const DEPARTMENT_RELATION_REPOSITORY = Symbol('DEPARTMENT_RELATION_REPOSITORY');

/**
 * 部门/职位关系权威仓储（PostgreSQL 适配；SRS-SM-MEM-002、DATA-STA/SCP/RLS）。
 *
 * 保存关系段、变更/结束意图、任期序列与不可变历史；当前 Group 关系以 Casdoor
 * 为权威，本仓储不反向覆盖外部当前值（ORG-026）。
 */
export interface DepartmentRelationRepository {
  save(relation: DepartmentRelation): Promise<void>;
  load(relationId: string): Promise<DepartmentRelation | null>;
  /** 同社团同主体同目标的全部关系段（含历史） */
  listBySubjectAndRef(
    clubId: string,
    subjectId: string,
    refId: string,
  ): Promise<DepartmentRelation[]>;
  /** 同社团同主体的全部关系段 */
  listBySubject(clubId: string, subjectId: string): Promise<DepartmentRelation[]>;
  /** 按业务变更命令组 id 取全部涉及关系段（复合调岗/组合任命的原子收口范围） */
  findByChangeGroup(groupId: string): Promise<DepartmentRelation[]>;
  /** 单胜者竞争：期望版本匹配才提交（并发任务只一个成功，IFC-GEN-007） */
  compareAndSwap(current: DepartmentRelation, next: DepartmentRelation): Promise<boolean>;
}

/**
 * 进行中的关系状态（占用"社团×主体×目标"唯一活跃位）：
 * 变更处理中 / 当前有效 / 结束处理中 / 同步异常。
 * 无关系与历史结束为非活跃段：允许同目标再次发起新变更。
 */
export const ACTIVE_RELATION_STATUSES: readonly DepartmentRelationStatus[] = [
  DepartmentRelationStatus.CHANGE_PROCESSING,
  DepartmentRelationStatus.CURRENTLY_VALID,
  DepartmentRelationStatus.END_PROCESSING,
  DepartmentRelationStatus.SYNC_ANOMALY,
];

/**
 * 进程内部门/职位关系仓储（开发期占位）。
 *
 * save 时同步强制"同社团同主体同目标最多一条进行中关系段"——对应生产 PostgreSQL
 * 的部分唯一索引 `(club_id, subject_id, ref_id) WHERE status IN ('CHANGE_PROCESSING',
 * 'CURRENTLY_VALID','END_PROCESSING','SYNC_ANOMALY')`；校验在保存路径内原子完成，
 * 并发变更只一个成功（IFC-ERR-009）。
 */
@Injectable()
export class InMemoryDepartmentRelationRepository implements DepartmentRelationRepository {
  private readonly relations = new Map<string, DepartmentRelation>();

  async save(relation: DepartmentRelation): Promise<void> {
    if (ACTIVE_RELATION_STATUSES.includes(relation.status)) {
      for (const r of this.relations.values()) {
        if (
          r.relationId !== relation.relationId &&
          r.clubId === relation.clubId &&
          r.subjectId === relation.subjectId &&
          r.refId === relation.refId &&
          ACTIVE_RELATION_STATUSES.includes(r.status)
        ) {
          throw new Error('IFC-ERR-009: 同社团同成员同目标已存在进行中的关系段');
        }
      }
    }
    this.relations.set(relation.relationId, relation);
  }

  async load(relationId: string): Promise<DepartmentRelation | null> {
    return this.relations.get(relationId) ?? null;
  }

  async listBySubjectAndRef(
    clubId: string,
    subjectId: string,
    refId: string,
  ): Promise<DepartmentRelation[]> {
    const out: DepartmentRelation[] = [];
    for (const r of this.relations.values()) {
      if (r.clubId === clubId && r.subjectId === subjectId && r.refId === refId) out.push(r);
    }
    return out.sort((a, b) => b.version - a.version);
  }

  async listBySubject(clubId: string, subjectId: string): Promise<DepartmentRelation[]> {
    const out: DepartmentRelation[] = [];
    for (const r of this.relations.values()) {
      if (r.clubId === clubId && r.subjectId === subjectId) out.push(r);
    }
    return out.sort((a, b) => a.refId.localeCompare(b.refId));
  }

  async findByChangeGroup(groupId: string): Promise<DepartmentRelation[]> {
    const out: DepartmentRelation[] = [];
    for (const r of this.relations.values()) {
      if (r.change?.changeGroupId === groupId) out.push(r);
    }
    return out;
  }

  async compareAndSwap(current: DepartmentRelation, next: DepartmentRelation): Promise<boolean> {
    const latest = this.relations.get(current.relationId);
    if (latest === undefined || latest.version !== current.version) {
      return false; // 版本冲突：单胜者失败
    }
    if (latest.status !== current.status) {
      return false; // 状态已被他方推进：比较并交换失败
    }
    await this.save(next);
    return true;
  }

  /** 测试辅助：清空（仅开发期占位使用） */
  clear(): void {
    this.relations.clear();
  }
}
