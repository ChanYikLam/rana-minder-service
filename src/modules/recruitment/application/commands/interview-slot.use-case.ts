/**
 * 面试选时/改期用例（REC-005、REC-011/012/046）。
 *
 * 补齐 README 声称的 ChooseInterviewSlotUseCase / RescheduleInterviewUseCase
 * （4.4 缺口；interview-workflow 已覆盖 schedule/start/complete/void/cancel/
 * skip/hold/resume/recordEvaluation）：
 * - ChooseInterviewSlot：待选择（PENDING_SELECTION）记录选时——校验时间不早于
 *   当前、同面试官同时间无其他有效面试（容量/时间占用；ConflictFreeSlotPolicy
 *   的本地实现），原子占用；
 * - RescheduleInterview：已安排（SCHEDULED）改期——原子释放旧占用并取得新占用
 *   （冲突校验排除自身），失败保持旧安排（REC-046）。
 *
 * 申请人选时（CHOOSE）与负责人改期（RESCHEDULE）均需关联申请存在；
 * 授权 fail-closed：改期为管理权限，选时需申请归属校验。
 */

import { InterviewRecord } from '../../domain/models/interview-record';
import { DefaultInterviewRecordStateMachine } from '../../domain/state-machines/interview-record.state-machine';
import type { RecruitmentRepository } from '../ports/recruitment-repository.port';
import type { RecruitmentAuthorizationPort } from '../ports/recruitment-authorization.port';
import { recruitmentErrors } from '../errors';

export interface InterviewSlot {
  readonly interviewerId: string;
  readonly scheduledAt: Date;
  readonly location: string | null;
}

/**
 * 时间/容量冲突校验（ConflictFreeSlotPolicy 本地实现）：
 * 同轮次内同面试官同时间存在非 VOIDED/CANCELLED 面试即冲突
 * （改期时排除自身记录）。
 */
async function assertSlotFree(
  repository: RecruitmentRepository,
  roundId: string,
  slot: InterviewSlot,
  excludeRecordId?: string,
): Promise<void> {
  const roundInterviews = await repository.loadInterviewsByRound(roundId);
  const conflict = roundInterviews.some(
    (r) =>
      r.id !== excludeRecordId &&
      r.interviewerId === slot.interviewerId &&
      r.scheduledAt !== null &&
      r.scheduledAt.getTime() === slot.scheduledAt.getTime() &&
      r.status !== 'VOIDED' &&
      r.status !== 'CANCELLED',
  );
  if (conflict) {
    throw recruitmentErrors.preconditionFailed('面试官在该时段已有安排，请选择其他时间');
  }
}

// ---------- 选时 ----------
export interface ChooseInterviewSlotInput {
  readonly recordId: string;
  readonly slot: InterviewSlot;
  readonly actor: string;
  readonly now: Date;
}

export interface ChooseInterviewSlotUseCase {
  execute(
    input: ChooseInterviewSlotInput,
  ): Promise<{ recordId: string; status: string; scheduledAt: string }>;
}

export class DefaultChooseInterviewSlotUseCase implements ChooseInterviewSlotUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(
    input: ChooseInterviewSlotInput,
  ): Promise<{ recordId: string; status: string; scheduledAt: string }> {
    const snapshot = await this.repository.loadInterview(input.recordId);
    if (snapshot === null) {
      throw recruitmentErrors.notFound('面试记录');
    }
    const application = await this.repository.loadApplication(snapshot.applicationId);
    if (application === null) {
      throw recruitmentErrors.notFound('招新申请');
    }
    if (snapshot.status !== 'PENDING_SELECTION') {
      throw recruitmentErrors.preconditionFailed('仅待选择状态的面试记录可选时');
    }
    if (input.slot.scheduledAt.getTime() <= input.now.getTime()) {
      throw recruitmentErrors.validation('面试时间不可早于当前时间');
    }
    // 选时授权：申请归属校验（申请人本人或管理权限）
    const isOwner = application.applicantId === input.actor;
    const isManager = await this.authorization.canManageRecruitment({
      clubId: application.clubId,
      subjectId: input.actor,
      activityId: application.activityId,
    });
    if (!isOwner && !isManager) {
      throw recruitmentErrors.forbidden('仅申请人本人或负责人可选时');
    }
    await assertSlotFree(this.repository, snapshot.roundId, input.slot);
    const record = InterviewRecord.fromSnapshot(snapshot);
    if (
      !record.schedule(
        new DefaultInterviewRecordStateMachine(),
        input.slot.interviewerId,
        input.slot.scheduledAt,
        input.slot.location,
        input.now,
      )
    ) {
      throw recruitmentErrors.preconditionFailed('选时失败（当前状态不允许）');
    }
    const saved = record.toSnapshot();
    await this.repository.saveInterview(saved, snapshot.revisionNumber);
    return {
      recordId: record.id,
      status: record.status,
      scheduledAt: saved.scheduledAt!.toISOString(),
    };
  }
}

// ---------- 改期 ----------
export interface RescheduleInterviewInput {
  readonly recordId: string;
  readonly slot: InterviewSlot;
  readonly actor: string;
  readonly now: Date;
}

export interface RescheduleInterviewUseCase {
  execute(
    input: RescheduleInterviewInput,
  ): Promise<{ recordId: string; status: string; scheduledAt: string }>;
}

export class DefaultRescheduleInterviewUseCase implements RescheduleInterviewUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(
    input: RescheduleInterviewInput,
  ): Promise<{ recordId: string; status: string; scheduledAt: string }> {
    const snapshot = await this.repository.loadInterview(input.recordId);
    if (snapshot === null) {
      throw recruitmentErrors.notFound('面试记录');
    }
    const application = await this.repository.loadApplication(snapshot.applicationId);
    if (application === null) {
      throw recruitmentErrors.notFound('招新申请');
    }
    if (
      !(await this.authorization.canManageRecruitment({
        clubId: application.clubId,
        subjectId: input.actor,
        activityId: application.activityId,
      }))
    ) {
      throw recruitmentErrors.forbidden('仅社团负责人/人事可改期面试');
    }
    if (snapshot.status !== 'SCHEDULED') {
      throw recruitmentErrors.preconditionFailed('仅已安排的面试可改期');
    }
    if (input.slot.scheduledAt.getTime() <= input.now.getTime()) {
      throw recruitmentErrors.validation('新面试时间不可早于当前时间');
    }
    // 原子释放旧占用并取得新占用：冲突校验排除自身（REC-046），失败保持旧安排
    await assertSlotFree(this.repository, snapshot.roundId, input.slot, input.recordId);
    const record = InterviewRecord.fromSnapshot(snapshot);
    record.reassign(
      input.slot.interviewerId,
      input.slot.scheduledAt,
      input.slot.location,
      input.now,
    );
    const saved = record.toSnapshot();
    await this.repository.saveInterview(saved, snapshot.revisionNumber);
    return {
      recordId: record.id,
      status: record.status,
      scheduledAt: saved.scheduledAt!.toISOString(),
    };
  }
}
