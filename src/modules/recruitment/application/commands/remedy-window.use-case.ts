/**
 * 申请补救窗口用例（REC-003、REC-006/009、REC-038、REC-044）。
 *
 * 补齐 README 声称的 CreateRemedyWindowUseCase（4.4 缺口），三种补救模式：
 * - RULE_TIGHTENING（规则收紧补救窗口）：发布后收紧规则为受影响申请开补窗，
 *   不自动淘汰既有申请（REC-007/REC-044）；命令层守卫窗口有效性；
 * - PERSONAL_RECOVERY（个人恢复窗口）：已退出（EXITED）申请在个人恢复窗口内
 *   重提恢复（RESUBMIT → SUBMITTED；REC-009）；
 * - IDENTITY_ANOMALY（身份异常顺延）：身份异常申请恢复（restoreIdentity →
 *   SUBMITTED；核实后由负责人/人事发布结论，REC-006/REC-038）。
 *
 * 窗口有效性（截止晚于当前、目标申请归属活动）由命令守卫；授权 fail-closed：
 * canManageRecruitment。
 */

import { Application } from '../../domain/models/application';
import type { RecruitmentRepository } from '../ports/recruitment-repository.port';
import type { RecruitmentAuthorizationPort } from '../ports/recruitment-authorization.port';
import { recruitmentErrors } from '../errors';

export const RemedyWindowKind = {
  RULE_TIGHTENING: 'RULE_TIGHTENING',
  PERSONAL_RECOVERY: 'PERSONAL_RECOVERY',
  IDENTITY_ANOMALY: 'IDENTITY_ANOMALY',
} as const;
export type RemedyWindowKind = (typeof RemedyWindowKind)[keyof typeof RemedyWindowKind];

export interface CreateRemedyWindowInput {
  readonly activityId: string;
  readonly kind: RemedyWindowKind;
  readonly targetApplicationIds: readonly string[];
  readonly deadline: Date;
  readonly reason: string;
  readonly actor: string;
  readonly now: Date;
}

export interface CreateRemedyWindowResult {
  readonly windowId: string;
  readonly kind: RemedyWindowKind;
  readonly targetApplicationIds: readonly string[];
  readonly deadline: string;
}

export interface CreateRemedyWindowUseCase {
  execute(input: CreateRemedyWindowInput): Promise<CreateRemedyWindowResult>;
}

export class DefaultCreateRemedyWindowUseCase implements CreateRemedyWindowUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(input: CreateRemedyWindowInput): Promise<CreateRemedyWindowResult> {
    const activity = await this.repository.loadActivity(input.activityId);
    if (activity === null) {
      throw recruitmentErrors.notFound('招新活动');
    }
    if (activity.paused) {
      throw recruitmentErrors.preconditionFailed('招新活动已暂停，补救窗口冻结');
    }
    if (
      !(await this.authorization.canManageRecruitment({
        clubId: activity.clubId,
        subjectId: input.actor,
        activityId: activity.id,
      }))
    ) {
      throw recruitmentErrors.forbidden('仅社团负责人/人事可开补救窗口');
    }
    if (!Object.values(RemedyWindowKind).includes(input.kind)) {
      throw recruitmentErrors.validation('不支持的补救窗口类型');
    }
    if (input.deadline.getTime() <= input.now.getTime()) {
      throw recruitmentErrors.validation('补救窗口截止须严格晚于当前时刻');
    }
    if (input.targetApplicationIds.length === 0) {
      throw recruitmentErrors.validation('补救窗口须指定受影响申请');
    }

    // 逐目标申请校验归属并执行补救动作（不自动淘汰既有申请）
    const windowId = `remedy-${input.activityId}-${input.now.getTime()}`;
    for (const applicationId of input.targetApplicationIds) {
      const snapshot = await this.repository.loadApplication(applicationId);
      if (snapshot === null) {
        throw recruitmentErrors.notFound(`招新申请 ${applicationId}`);
      }
      if (snapshot.activityId !== input.activityId) {
        throw recruitmentErrors.validation('补救窗口目标申请不属于该活动');
      }
      const application = Application.fromSnapshot(snapshot);
      if (input.kind === RemedyWindowKind.PERSONAL_RECOVERY) {
        // 个人恢复窗口守卫：仅已退出申请可入窗；窗口内重提由申请人经提交/重提
        // 用例发起（REC-009 语义：窗口有效性由命令守卫，重提动作走既有流程）
        if (application.status !== 'EXITED') {
          throw recruitmentErrors.preconditionFailed('个人恢复窗口仅适用于已退出申请');
        }
      } else if (input.kind === RemedyWindowKind.IDENTITY_ANOMALY) {
        // 身份异常顺延：恢复身份 → SUBMITTED
        if (application.status !== 'IDENTITY_EXCEPTION') {
          throw recruitmentErrors.preconditionFailed('身份异常顺延仅适用于身份异常申请');
        }
        application.restoreIdentity(input.now);
        const restored = application.toSnapshot();
        await this.repository.saveApplication(restored, snapshot.revisionNumber);
      }
      // RULE_TIGHTENING：受影响申请补窗（命令层守卫窗口有效性，不切换申请状态，
      // 不自动淘汰——REC-007/REC-044 语义）
    }

    return {
      windowId,
      kind: input.kind,
      targetApplicationIds: input.targetApplicationIds,
      deadline: input.deadline.toISOString(),
    };
  }
}
