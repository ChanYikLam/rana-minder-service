import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type {
  MembershipPeriod,
  MembershipRelationTarget,
} from '../../domain/models/membership-period';
import { MembershipEntrySource } from '../../domain/models/membership-period';
import { MembershipPolicy } from '../../domain/services/membership-policy';
import { MembershipPeriodStateMachine } from '../../domain/state-machines/membership-period.state-machine';
import { MEMBERSHIP_REPOSITORY } from '../../infrastructure/membership-repository';
import type { MembershipRepository } from '../../infrastructure/membership-repository';
import { InMemoryMembershipNotificationPort } from '../../infrastructure/in-memory-stubs';
import { MEMBERSHIP_NOTIFICATION_PORT } from '../ports';
import type { MembershipNotificationPort } from '../ports';

/** 进入成员经历输入（SRS-SM-MEM-001 转换 1；REC-026、JNT-016、MEM-007/018） */
export interface EnterMembershipInput {
  readonly clubId: string;
  readonly subjectId: string;
  /** 入社来源：普通/联合录取、常规邀请、非成员任命组合操作 */
  readonly source: MembershipEntrySource;
  /** 业务引用：邀请 id / 组合任命命令 id（幂等键的一部分） */
  readonly entryRef: string;
  /** 成员业务生效时间 = 接受时间/组合任命确认时间（REC-026，调用方传入） */
  readonly businessEffectiveAt: string;
  /** 组合写入目标：社团 Group 必有，另含可选初始部门/职位（不可拆分整体） */
  readonly targets: readonly MembershipRelationTarget[];
  /** 计划结束时间（任期计划值；仅记录，不驱动卸任，MEM-010/012） */
  readonly plannedEndAt?: string | null;
  /** 账号有效/社团启用/资料门满足等由调用方复核后传入 */
  readonly eligibilityOk: boolean;
}

/** 进入前置失败（IFC-ERR-006/007/009） */
export class EnterMembershipError extends Error {
  constructor(code: 'IFC-ERR-006' | 'IFC-ERR-007' | 'IFC-ERR-009', message: string) {
    super(`${code}: ${message}`);
    this.name = 'EnterMembershipError';
  }
}

/**
 * 进入成员经历（SRS-SM-MEM-001 转换 1）。
 *
 * - 接受普通/联合/常规入社邀请，或确认非成员职位任命组合操作后，
 *   原子创建"成员生效处理中"经历草稿与 Group 写入任务意图；
 * - 成员业务生效时间 = 接受/确认时间；回读确认前不开放权限（ORG-027）；
 * - **历史成员重入必须新建经历段**（MEM-013）：本命令永远创建新 periodId，
 *   不复活、不改写旧经历段；旧部门/职位/权限不恢复；
 * - **社团＋用户当前成员唯一**：同社团同学生存在进行中经历时拒绝；
 *   不同入社路径竞争只一个成功（仓储唯一约束 + 幂等返回）；
 * - **同一接受/任命幂等**：相同 entryRef 重复进入返回原经历段，不重复建段。
 */
@Injectable()
export class EnterMembershipCommand {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY) private readonly repo: MembershipRepository,
    private readonly policy: MembershipPolicy,
    @Inject(MEMBERSHIP_NOTIFICATION_PORT)
    private readonly notifications: MembershipNotificationPort = new InMemoryMembershipNotificationPort(),
    private readonly stateMachine: MembershipPeriodStateMachine = new MembershipPeriodStateMachine(),
  ) {}

  async execute(input: EnterMembershipInput): Promise<MembershipPeriod> {
    // 幂等：同一接受/任命引用只产生一段经历
    const existing = await this.repo.listBySubject(input.clubId, input.subjectId);
    const sameRef = existing.find((p) => p.entryRef === input.entryRef);
    if (sameRef !== undefined) {
      return sameRef;
    }

    // 唯一性：同社团同学生进行中经历唯一（不同入社路径竞争只一个成功）
    const active = await this.repo.findActiveBySubject(input.clubId, input.subjectId);
    if (active !== null) {
      if (active.status === 'CURRENT_MEMBER') {
        throw new EnterMembershipError(
          'IFC-ERR-006',
          '已是当前成员，不能重复进入（如对象为邀请应按其规则关闭）',
        );
      }
      throw new EnterMembershipError(
        'IFC-ERR-007',
        `已存在进行中的成员经历（${active.status}），处理中阻止同一目标的重复或冲突操作`,
      );
    }

    this.policy.assertEntryEligibility(input.eligibilityOk);
    if (!input.targets.some((target) => target.kind === 'CLUB')) {
      throw new EnterMembershipError(
        'IFC-ERR-006',
        '组合写入目标必须包含社团 Group（顺序不限）且不可为空',
      );
    }

    const now = new Date().toISOString();
    const period: MembershipPeriod = {
      periodId: randomUUID(),
      clubId: input.clubId,
      subjectId: input.subjectId,
      // 新建经历草稿即处于成员生效处理中（SRS-SM-MEM-001 转换 1 的目标态）
      status: 'ACTIVATION_PROCESSING',
      version: 1,
      entrySource: input.source,
      entryRef: input.entryRef,
      businessEffectiveAt: input.businessEffectiveAt,
      actualStartAt: null,
      actualEndAt: null,
      plannedEndAt: input.plannedEndAt ?? null,
      entryTargets: [...input.targets],
      activation: { progress: 'PROCESSING', phase: 'PENDING', attemptCount: 0 },
      departure: null,
      hasResidualAnomaly: false,
      history: [
        {
          at: now,
          type: 'ENTRY_STARTED',
          by: input.subjectId,
          note: `来源=${input.source} 引用=${input.entryRef} 目标=${input.targets.map((t) => t.kind).join('+')}`,
        },
      ],
    };
    // 唯一约束在保存路径内原子校验：并发进入只一个成功（IFC-ERR-009）
    await this.repo.save(period);
    // 转换 1 收口通知事实：通知本人与相关管理员进入成员生效处理中（IFC-TX-002）
    await this.notifications.save({
      kind: 'MEMBER_ENTRY_STARTED',
      toUserIds: [input.subjectId],
      clubId: input.clubId,
      dedupKey: 'MEMBER_ENTRY_STARTED:' + period.periodId,
      title: '成员身份生效处理中',
      body: '接受已确认，正在同步社团关系；确认完成前不开放成员权限。',
    });
    return period;
  }
}
