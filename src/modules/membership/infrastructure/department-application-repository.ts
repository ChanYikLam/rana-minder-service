import { Injectable } from '@nestjs/common';

import type { DepartmentApplication } from '../domain/models/department-application';
import { DepartmentApplicationStatus } from '../domain/state-machines/department-application.state-machine';

/** 部门关系申请仓储注入令牌 */
export const DEPARTMENT_APPLICATION_REPOSITORY = Symbol('DEPARTMENT_APPLICATION_REPOSITORY');

/** 进行中的申请状态（同一主体同类型同时最多一条待处理） */
export const OPEN_APPLICATION_STATUSES: readonly DepartmentApplicationStatus[] = [
  DepartmentApplicationStatus.PENDING_APPROVAL,
  DepartmentApplicationStatus.APPROVED_PENDING_EXECUTION,
  DepartmentApplicationStatus.EXECUTION_PROCESSING,
  DepartmentApplicationStatus.EXEC_FAILED_ORIGINAL_PRESERVED,
];

/**
 * 部门关系申请权威仓储（PostgreSQL 适配；SRS-SM-MEM-003）。
 *
 * 保存申请、关系快照、审批记录、执行尝试与不可变历史。
 */
export interface DepartmentApplicationRepository {
  save(application: DepartmentApplication): Promise<void>;
  load(applicationId: string): Promise<DepartmentApplication | null>;
  /** 同主体同类型的待处理申请（无则 null；无冲突待处理申请约束） */
  findOpenByApplicant(
    clubId: string,
    applicantId: string,
    type: DepartmentApplication['type'],
  ): Promise<DepartmentApplication | null>;
  listByClub(clubId: string): Promise<DepartmentApplication[]>;
  listByApplicant(clubId: string, applicantId: string): Promise<DepartmentApplication[]>;
  /** 单胜者竞争：期望版本匹配才提交（撤回/批准/驳回竞争只一个成功） */
  compareAndSwap(current: DepartmentApplication, next: DepartmentApplication): Promise<boolean>;
}

/**
 * 进程内申请仓储（开发期占位）。
 *
 * save 时同步强制"同社团同申请人同类型最多一条待处理申请"——对应生产 PostgreSQL
 * 的部分唯一索引；校验在保存路径内原子完成（IFC-ERR-009）。
 */
@Injectable()
export class InMemoryDepartmentApplicationRepository implements DepartmentApplicationRepository {
  private readonly applications = new Map<string, DepartmentApplication>();

  async save(application: DepartmentApplication): Promise<void> {
    if (OPEN_APPLICATION_STATUSES.includes(application.status)) {
      for (const a of this.applications.values()) {
        if (
          a.applicationId !== application.applicationId &&
          a.clubId === application.clubId &&
          a.applicantId === application.applicantId &&
          a.type === application.type &&
          OPEN_APPLICATION_STATUSES.includes(a.status)
        ) {
          throw new Error('IFC-ERR-009: 同社团同申请人同类型已存在待处理申请');
        }
      }
    }
    this.applications.set(application.applicationId, application);
  }

  async load(applicationId: string): Promise<DepartmentApplication | null> {
    return this.applications.get(applicationId) ?? null;
  }

  async findOpenByApplicant(
    clubId: string,
    applicantId: string,
    type: DepartmentApplication['type'],
  ): Promise<DepartmentApplication | null> {
    for (const a of this.applications.values()) {
      if (
        a.clubId === clubId &&
        a.applicantId === applicantId &&
        a.type === type &&
        OPEN_APPLICATION_STATUSES.includes(a.status)
      ) {
        return a;
      }
    }
    return null;
  }

  async listByClub(clubId: string): Promise<DepartmentApplication[]> {
    const out: DepartmentApplication[] = [];
    for (const a of this.applications.values()) {
      if (a.clubId === clubId) out.push(a);
    }
    return out.sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
  }

  async listByApplicant(clubId: string, applicantId: string): Promise<DepartmentApplication[]> {
    const out: DepartmentApplication[] = [];
    for (const a of this.applications.values()) {
      if (a.clubId === clubId && a.applicantId === applicantId) out.push(a);
    }
    return out.sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
  }

  async compareAndSwap(
    current: DepartmentApplication,
    next: DepartmentApplication,
  ): Promise<boolean> {
    const latest = this.applications.get(current.applicationId);
    if (latest === undefined || latest.version !== current.version) {
      return false; // 版本冲突：撤回/批准/驳回竞争只一个成功
    }
    if (latest.status !== current.status) {
      return false;
    }
    await this.save(next);
    return true;
  }

  /** 测试辅助：清空（仅开发期占位使用） */
  clear(): void {
    this.applications.clear();
  }
}
