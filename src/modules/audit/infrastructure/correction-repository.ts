import { Injectable } from '@nestjs/common';
import type { Correction } from '../domain/models/correction';

/** 纠错仓储注入令牌（CorrectionRepository 为接口，注入须用显式 token） */
export const CORRECTION_REPOSITORY = Symbol('CORRECTION_REPOSITORY');

/**
 * 纠错权威仓储接口（SRS-SM-AUD-001）。
 *
 * 纠错链只追加；原值/原附件/原操作历史保留（AUD-001）。
 * 生产环境应由 PostgreSQL 适配器实现；当前 `InMemoryCorrectionRepository`
 * 仅为开发期占位（进程内存储，重启即失）。
 */
export interface CorrectionRepository {
  save(correction: Correction): Promise<void>;
  load(correctionId: string): Promise<Correction | null>;
  /** 单胜者：批准/驳回/撤回按同一申请版本比较并交换（AUD-010） */
  compareAndSwap(current: Correction, next: Correction): Promise<boolean>;
}

/** 进程内实现（开发期占位；compareAndSwap 版本比较单胜者） */
@Injectable()
export class InMemoryCorrectionRepository implements CorrectionRepository {
  private readonly corrections = new Map<string, Correction>();

  async save(correction: Correction): Promise<void> {
    this.corrections.set(correction.correctionId, correction);
  }

  async load(correctionId: string): Promise<Correction | null> {
    return this.corrections.get(correctionId) ?? null;
  }

  async compareAndSwap(current: Correction, next: Correction): Promise<boolean> {
    const latest = this.corrections.get(current.correctionId);
    if (latest === undefined || latest.version !== current.version) {
      return false;
    }
    this.corrections.set(current.correctionId, next);
    return true;
  }
}
