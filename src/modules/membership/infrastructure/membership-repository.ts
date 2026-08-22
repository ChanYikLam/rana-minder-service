import { Injectable } from '@nestjs/common';

import type { MembershipPeriod } from '../domain/models/membership-period';
import {
  ACTIVE_PERIOD_STATUSES,
  TERMINAL_PERIOD_STATUSES,
} from '../domain/state-machines/membership-period.state-machine';

/** 成员经历仓储注入令牌（MembershipRepository 为接口，注入须用显式 token） */
export const MEMBERSHIP_REPOSITORY = Symbol('MEMBERSHIP_REPOSITORY');

/**
 * 成员经历权威仓储（PostgreSQL 适配；SRS-SM-MEM-001、DATA-STA/SCP/RLS）。
 *
 * 保存经历段、生效意图、退出决定与不可变历史；当前 Group 关系以 Casdoor 为权威，
 * 本仓储不反向覆盖外部当前值（ORG-026）。
 */
export interface MembershipRepository {
  save(period: MembershipPeriod): Promise<void>;
  load(periodId: string): Promise<MembershipPeriod | null>;
  /** 同社团同学生的当前进行中经历（无则 null）；用于"社团＋用户当前成员唯一" */
  findActiveBySubject(clubId: string, subjectId: string): Promise<MembershipPeriod | null>;
  /** 该学生在该社团的全部经历段（时间线；MEM-013 多段并存） */
  listBySubject(clubId: string, subjectId: string): Promise<MembershipPeriod[]>;
  /** 单胜者竞争：期望版本匹配才提交（并发任务只一个成功，IFC-GEN-007） */
  compareAndSwap(current: MembershipPeriod, next: MembershipPeriod): Promise<boolean>;
}

/**
 * 进程内成员经历仓储（开发期占位）。
 *
 * save 时同步强制"同社团同学生最多一条进行中经历"——对应生产 PostgreSQL 的
 * 部分唯一索引 `(club_id, subject_id) WHERE status IN ('ACTIVATION_PROCESSING',
 * 'CURRENT_MEMBER', 'DEPARTURE_PROCESSING')`；校验在保存路径内原子完成，不依赖
 * 非原子的"检查后写入"，并发进入同样失败（IFC-ERR-009）。
 */
@Injectable()
export class InMemoryMembershipRepository implements MembershipRepository {
  private readonly periods = new Map<string, MembershipPeriod>();

  async save(period: MembershipPeriod): Promise<void> {
    if (ACTIVE_PERIOD_STATUSES.includes(period.status)) {
      for (const p of this.periods.values()) {
        if (
          p.periodId !== period.periodId &&
          p.clubId === period.clubId &&
          p.subjectId === period.subjectId &&
          ACTIVE_PERIOD_STATUSES.includes(p.status)
        ) {
          throw new Error('IFC-ERR-009: 同社团同学生已存在进行中的成员经历段');
        }
      }
    }
    this.periods.set(period.periodId, period);
  }

  async load(periodId: string): Promise<MembershipPeriod | null> {
    return this.periods.get(periodId) ?? null;
  }

  async findActiveBySubject(clubId: string, subjectId: string): Promise<MembershipPeriod | null> {
    for (const p of this.periods.values()) {
      if (
        p.clubId === clubId &&
        p.subjectId === subjectId &&
        ACTIVE_PERIOD_STATUSES.includes(p.status)
      ) {
        return p;
      }
    }
    return null;
  }

  async listBySubject(clubId: string, subjectId: string): Promise<MembershipPeriod[]> {
    const out: MembershipPeriod[] = [];
    for (const p of this.periods.values()) {
      if (p.clubId === clubId && p.subjectId === subjectId) out.push(p);
    }
    // 按业务生效时间倒序：最新经历在前
    return out.sort(
      (a, b) => Date.parse(b.businessEffectiveAt) - Date.parse(a.businessEffectiveAt),
    );
  }

  async compareAndSwap(current: MembershipPeriod, next: MembershipPeriod): Promise<boolean> {
    const latest = this.periods.get(current.periodId);
    if (latest === undefined || latest.version !== current.version) {
      return false; // 版本冲突：单胜者失败
    }
    // 终态不可变：终态记录不再被覆盖，严禁"终态 → 活跃"复活换入
    // （历史成员重入/重新进入一律新建经历段，MEM-013）
    if (TERMINAL_PERIOD_STATUSES.includes(latest.status)) {
      return false;
    }
    if (latest.status !== current.status) {
      return false;
    }
    await this.save(next);
    return true;
  }

  /** 测试辅助：清空（仅开发期占位使用） */
  clear(): void {
    this.periods.clear();
  }
}
