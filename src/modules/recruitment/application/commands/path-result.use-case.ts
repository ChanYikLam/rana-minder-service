/**
 * 部门路径结果与调剂用例（REC-004、REC-016~018、REC-024、REC-031、REC-039）。
 *
 * 补齐 README 声称的 PublishPathResultUseCase 与调剂/候补/复核能力（4.4 缺口）：
 * - RecordTransferAuthorizationUseCase：调剂授权（置 allowTransfer，仅非终态）；
 * - PromoteWaitlistToAdmitUseCase：候补转录取（WAITLISTED → ADMITTED，
 *   与邀请模块联动的创建交由上层/邀请域接线——本用例收口路径状态）；
 * - PublishPathResultUseCase：结果发布（内部决定 → 已发布；复核改判通过
 *   重新 recordDecision 后再次发布，活动未结束且邀请未接受时允许——REC-024）。
 *
 * 授权 fail-closed：canManageRecruitment（负责人/人事）。
 */

import { DepartmentPath } from '../../domain/models/department-path';
import {
  DefaultDepartmentPathStateMachine,
  DepartmentDecision,
} from '../../domain/state-machines/department-path.state-machine';
import type { RecruitmentRepository } from '../ports/recruitment-repository.port';
import type { RecruitmentAuthorizationPort } from '../ports/recruitment-authorization.port';
import { recruitmentErrors } from '../errors';

// ---------- 通用：加载路径 + 活动/授权 ----------
async function loadPathAndAuthorize(
  repository: RecruitmentRepository,
  authorization: RecruitmentAuthorizationPort,
  pathId: string,
  actor: string,
  action: string,
): Promise<{ path: DepartmentPath; expectedRevision: number }> {
  const snapshot = await repository.loadDepartmentPath(pathId);
  if (snapshot === null) {
    throw recruitmentErrors.notFound('部门考察路径');
  }
  const activity = await repository.loadActivity(snapshot.activityId);
  if (activity === null) {
    throw recruitmentErrors.notFound('招新活动');
  }
  if (activity.paused) {
    throw recruitmentErrors.preconditionFailed('招新活动已暂停，部门路径业务冻结');
  }
  if (
    !(await authorization.canManageRecruitment({
      clubId: activity.clubId,
      subjectId: actor,
      activityId: activity.id,
    }))
  ) {
    throw recruitmentErrors.forbidden(`仅社团负责人/人事可${action}部门路径`);
  }
  return { path: DepartmentPath.fromSnapshot(snapshot), expectedRevision: snapshot.revisionNumber };
}

// ---------- 调剂授权 ----------
export interface RecordTransferAuthorizationInput {
  readonly pathId: string;
  readonly actor: string;
  readonly now: Date;
}

export interface RecordTransferAuthorizationUseCase {
  execute(
    input: RecordTransferAuthorizationInput,
  ): Promise<{ pathId: string; allowTransfer: boolean }>;
}

export class DefaultRecordTransferAuthorizationUseCase implements RecordTransferAuthorizationUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(
    input: RecordTransferAuthorizationInput,
  ): Promise<{ pathId: string; allowTransfer: boolean }> {
    const { path, expectedRevision } = await loadPathAndAuthorize(
      this.repository,
      this.authorization,
      input.pathId,
      input.actor,
      '授权调剂',
    );
    path.grantTransfer(input.now);
    const transferred = path.toSnapshot();
    await this.repository.saveDepartmentPath(transferred, expectedRevision);
    return { pathId: path.id, allowTransfer: path.allowTransfer };
  }
}

// ---------- 候补转录取 ----------
export interface PromoteWaitlistToAdmitInput {
  readonly pathId: string;
  readonly actor: string;
  readonly now: Date;
  readonly note?: string | null;
}

export interface PromoteWaitlistToAdmitUseCase {
  execute(input: PromoteWaitlistToAdmitInput): Promise<{ pathId: string; status: string }>;
}

export class DefaultPromoteWaitlistToAdmitUseCase implements PromoteWaitlistToAdmitUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(input: PromoteWaitlistToAdmitInput): Promise<{ pathId: string; status: string }> {
    const { path, expectedRevision } = await loadPathAndAuthorize(
      this.repository,
      this.authorization,
      input.pathId,
      input.actor,
      '候补转录取',
    );
    if (path.status !== 'WAITLISTED') {
      throw recruitmentErrors.preconditionFailed('仅候补路径可转录取');
    }
    if (
      !path.recordDecision(
        new DefaultDepartmentPathStateMachine(),
        DepartmentDecision.ADMIT,
        input.actor,
        input.now,
        input.note ?? null,
      )
    ) {
      throw recruitmentErrors.preconditionFailed('候补转录取失败（当前状态不允许）');
    }
    const promoted = path.toSnapshot();
    await this.repository.saveDepartmentPath(promoted, expectedRevision);
    // 与邀请模块联动的邀请创建由上层/邀请域接线（README：候补转邀请与邀请创建同一边界）
    return { pathId: path.id, status: path.status };
  }
}

// ---------- 结果发布 ----------
export interface PublishPathResultInput {
  readonly pathId: string;
  readonly actor: string;
  readonly now: Date;
}

export interface PublishPathResultUseCase {
  execute(
    input: PublishPathResultInput,
  ): Promise<{ pathId: string; status: string; published: boolean }>;
}

export class DefaultPublishPathResultUseCase implements PublishPathResultUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(
    input: PublishPathResultInput,
  ): Promise<{ pathId: string; status: string; published: boolean }> {
    const { path, expectedRevision } = await loadPathAndAuthorize(
      this.repository,
      this.authorization,
      input.pathId,
      input.actor,
      '发布结果',
    );
    // 发布前置：内部决定须为可发布终态（ADMITTED/REJECTED/WAITLISTED）——
    // 由领域模型 publish() 校验（终态之外抛异常），此处不再重复校验
    // Critical/评审修复：发布动作落库（此前仅返回 published:true，未持久化发布态）
    try {
      path.publish(input.now);
    } catch {
      throw recruitmentErrors.preconditionFailed('仅内部决定终态可发布结果');
    }
    const published = path.toSnapshot();
    await this.repository.saveDepartmentPath(published, expectedRevision);
    // 发布本身为幂等动作（可修改重发布；归档后仅纠错由上层判定——REC-024）
    // 结果通知与邀请联动由上层/邀请域接线（本用例收口发布判定与落库）
    return { pathId: path.id, status: path.status, published: path.published };
  }
}
