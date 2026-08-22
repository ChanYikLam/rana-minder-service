import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CorrectionStateMachine,
  CorrectionStatus,
} from '../../domain/state-machines/correction-state-machine';
import type { Correction } from '../../domain/models/correction';
import { CorrectionPolicy } from '../../domain/services/correction-policy';
import type { ObjectiveErrorType } from '../../domain/models/correction';
import { CORRECTION_REPOSITORY } from '../../infrastructure/correction-repository';
import type { CorrectionRepository } from '../../infrastructure/correction-repository';

/** 保存草稿输入（SRS-SM-AUD-001：新建→草稿） */
export interface SaveCorrectionDraftInput {
  readonly applicantId: string;
  /** 记录原作者（作者回避） */
  readonly authorId: string;
  readonly targetRecord: {
    readonly objectType: string;
    readonly objectId: string;
    /** 目标记录所属社团（跨社团改写判定；AUD-010） */
    readonly ownerClubId: string;
    readonly fieldKey: string;
    readonly recordVersion: number;
  };
  readonly objectiveErrorType: ObjectiveErrorType;
  readonly expectedCorrection: string;
  readonly evidenceRefs: readonly string[];
  /** 处理期限（超管配置） */
  readonly deadlineAt: string;
}

/** 提交输入（SRS-SM-AUD-001：草稿→待处理） */
export interface SubmitCorrectionInput {
  readonly correctionId: string;
  readonly applicantId: string;
  /** 客观错误描述（主观评价争议 → 拒绝） */
  readonly objectiveDescription: string;
}

/** 前置失败 */
export class CorrectionCommandError extends Error {
  constructor(
    code: 'IFC-ERR-003' | 'IFC-ERR-005' | 'IFC-ERR-006' | 'IFC-ERR-007',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'CorrectionCommandError';
  }
}

/**
 * 保存纠错申请草稿（SRS-SM-AUD-001：新建→草稿）。
 *
 * 学生可针对本人资料/报名/明显事实提交纠错申请并上传证据；
 * 证据访问不扩大原权限；不改变原业务记录。
 */
@Injectable()
export class SaveCorrectionDraftCommand {
  constructor(
    @Inject(CORRECTION_REPOSITORY) private readonly repo: CorrectionRepository,
    private readonly stateMachine: CorrectionStateMachine,
  ) {}

  async execute(input: SaveCorrectionDraftInput): Promise<Correction> {
    if (input.deadlineAt.length === 0 || !Number.isFinite(Date.parse(input.deadlineAt))) {
      throw new CorrectionCommandError('IFC-ERR-005', '无效的处理期限');
    }
    if (Date.parse(input.deadlineAt) <= Date.now()) {
      throw new CorrectionCommandError('IFC-ERR-005', '处理期限必须晚于当前时间');
    }
    if (input.expectedCorrection.trim().length === 0) {
      throw new CorrectionCommandError('IFC-ERR-005', '期望修正不能为空');
    }
    if (input.authorId.length === 0) {
      throw new CorrectionCommandError('IFC-ERR-005', '缺少记录原作者');
    }
    if (input.applicantId.length === 0) {
      throw new CorrectionCommandError('IFC-ERR-005', '缺少提交人');
    }
    // 目标业务记录关键字段非空，避免无效草稿进入待处理/跨社团判定
    if (input.targetRecord.objectType.length === 0) {
      throw new CorrectionCommandError('IFC-ERR-005', '缺少目标记录类型');
    }
    if (input.targetRecord.objectId.length === 0) {
      throw new CorrectionCommandError('IFC-ERR-005', '缺少目标记录标识');
    }
    if (input.targetRecord.fieldKey.length === 0) {
      throw new CorrectionCommandError('IFC-ERR-005', '缺少目标字段');
    }
    if (input.targetRecord.ownerClubId.length === 0) {
      throw new CorrectionCommandError('IFC-ERR-005', '缺少目标记录所属社团');
    }
    const now = new Date().toISOString();
    const correction: Correction = {
      correctionId: randomUUID(),
      applicantId: input.applicantId,
      authorId: input.authorId,
      targetRecord: input.targetRecord,
      objectiveErrorType: input.objectiveErrorType,
      expectedCorrection: input.expectedCorrection,
      evidenceRefs: input.evidenceRefs,
      deadlineAt: input.deadlineAt,
      status: this.stateMachine.transition('NEW', 'DRAFT'),
      version: 1,
      createdAt: now,
      submittedAt: null,
      overdueMarkedAt: null,
      decision: null,
      history: [{ at: now, type: 'DRAFTED', by: input.applicantId }],
    };
    await this.repo.save(correction);
    return correction;
  }
}

/**
 * 提交纠错申请（SRS-SM-AUD-001：草稿→待处理）。
 *
 * - 指明客观错误、期望修正、原因和必要证据；
 * - **单纯不认同主观评价不属于事实错误**（拒绝，IFC-ERR-006）；
 * - 原子保存正式申请、处理期限和角色型待办（占位）；原记录不变。
 */
@Injectable()
export class SubmitCorrectionCommand {
  constructor(
    @Inject(CORRECTION_REPOSITORY) private readonly repo: CorrectionRepository,
    private readonly policy: CorrectionPolicy,
    private readonly stateMachine: CorrectionStateMachine,
  ) {}

  async execute(input: SubmitCorrectionInput): Promise<Correction> {
    const correction = await this.repo.load(input.correctionId);
    if (correction === null) {
      throw new CorrectionCommandError('IFC-ERR-006', '纠错申请不存在');
    }
    if (correction.applicantId !== input.applicantId) {
      throw new CorrectionCommandError('IFC-ERR-003', '仅原提交人可提交');
    }
    if (correction.status === CorrectionStatus.PENDING) {
      return correction; // 幂等
    }
    if (correction.status !== CorrectionStatus.DRAFT) {
      throw new CorrectionCommandError('IFC-ERR-007', '仅草稿状态可提交');
    }
    // 客观错误判定：主观评价争议拒绝
    this.policy.assertObjectiveError(input.objectiveDescription);
    const now = new Date().toISOString();
    const submitted: Correction = {
      ...correction,
      status: this.stateMachine.transition('DRAFT', CorrectionStatus.PENDING),
      version: correction.version + 1,
      submittedAt: now,
      history: [...correction.history, { at: now, type: 'SUBMITTED', by: input.applicantId }],
    };
    // 用版本 CAS 推进草稿→待处理，避免并发提交覆盖（与决定/撤回单胜者语义一致）
    if (!(await this.repo.compareAndSwap(correction, submitted))) {
      const latest = await this.repo.load(input.correctionId);
      if (latest !== null && latest.status === CorrectionStatus.PENDING) {
        return latest; // 并发提交已生效，幂等返回
      }
      throw new CorrectionCommandError('IFC-ERR-007', '纠错申请已被并发变更，提交失败');
    }
    return submitted;
  }
}
