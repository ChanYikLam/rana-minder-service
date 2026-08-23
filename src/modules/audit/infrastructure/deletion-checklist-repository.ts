import { Injectable } from '@nestjs/common';
import type { DeletionChecklist } from '../domain/models/deletion';

/** 删除清单仓储注入令牌（DeletionChecklistRepository 为接口，注入须用显式 token） */
export const DELETION_CHECKLIST_REPOSITORY = Symbol('DELETION_CHECKLIST_REPOSITORY');

/**
 * 删除执行清单仓储（PostgreSQL 适配；IFC-TX-007、AUD-009）。
 *
 * 独立持久化：历史备份恢复后**重新应用清单防复现**；
 * 清单不可篡改（只追加状态推进，无覆盖式修改）。
 */
export interface DeletionChecklistRepository {
  save(checklist: DeletionChecklist): Promise<void>;
  load(checklistId: string): Promise<DeletionChecklist | null>;
  /** 乐观锁提交（并发执行防护：期望版本匹配才写入；W1） */
  compareAndSwap(current: DeletionChecklist, next: DeletionChecklist): Promise<boolean>;
  /** 恢复后重放：返回全部未完成清单（防复现） */
  listIncomplete(): Promise<readonly DeletionChecklist[]>;
  /** 全量清单（恢复备份后重放需含已完成清单；AUD-009） */
  listAll(): Promise<readonly DeletionChecklist[]>;
}

/** 进程内实现（开发期占位；compareAndSwap 以版本比较实现单胜者） */
@Injectable()
export class InMemoryDeletionChecklistRepository implements DeletionChecklistRepository {
  private readonly checklists = new Map<string, DeletionChecklist>();

  async save(checklist: DeletionChecklist): Promise<void> {
    this.checklists.set(checklist.checklistId, checklist);
  }

  async load(checklistId: string): Promise<DeletionChecklist | null> {
    return this.checklists.get(checklistId) ?? null;
  }

  async compareAndSwap(current: DeletionChecklist, next: DeletionChecklist): Promise<boolean> {
    const latest = this.checklists.get(current.checklistId);
    if (latest === undefined || latest.version !== current.version) {
      return false;
    }
    this.checklists.set(next.checklistId, next);
    return true;
  }

  async listIncomplete(): Promise<readonly DeletionChecklist[]> {
    return [...this.checklists.values()].filter((c) => !c.completed);
  }

  async listAll(): Promise<readonly DeletionChecklist[]> {
    return [...this.checklists.values()];
  }
}
