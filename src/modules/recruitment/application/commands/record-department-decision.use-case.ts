/**
 * 记录部门考察决定用例（REC-004、SRS-SM-REC-004）。
 *
 * 负责人/人事可记录某申请在某部门的内部决定（通过/淘汰/候补/结束/挂起）。
 * 路径不存在时按志愿归属（或调剂授权）自动建立。
 */

import { DepartmentPath } from '../../domain/models/department-path';
import {
  DefaultDepartmentPathStateMachine,
  DepartmentDecision,
} from '../../domain/state-machines/department-path.state-machine';
import type { RecruitmentRepository } from '../ports/recruitment-repository.port';
import type { RecruitmentAuthorizationPort } from '../ports/recruitment-authorization.port';
import { recruitmentErrors } from '../errors';

export interface RecordDepartmentDecisionInput {
  readonly applicationId: string;
  readonly departmentId: string;
  readonly decision: DepartmentDecision;
  readonly decidedBy: string;
  readonly note?: string | null;
  readonly actor: string;
  readonly now: Date;
  readonly id?: string;
}

export interface RecordDepartmentDecisionResult {
  readonly pathId: string;
  readonly status: string;
}

export interface RecordDepartmentDecisionUseCase {
  execute(input: RecordDepartmentDecisionInput): Promise<RecordDepartmentDecisionResult>;
}

export class DefaultRecordDepartmentDecisionUseCase implements RecordDepartmentDecisionUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(input: RecordDepartmentDecisionInput): Promise<RecordDepartmentDecisionResult> {
    const application = await this.repository.loadApplication(input.applicationId);
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
      throw recruitmentErrors.forbidden('仅负责人/人事可记录部门考察决定');
    }
    if (!isValidDepartmentDecision(input.decision)) {
      throw recruitmentErrors.validation('非法的部门考察决定', { decision: input.decision });
    }
    const paths = await this.repository.loadDepartmentPathsByApplication(application.id);
    let snapshot = paths.find((p) => p.departmentId === input.departmentId) ?? null;
    const expectedRevision = snapshot === null ? -1 : snapshot.revisionNumber;
    if (snapshot === null) {
      snapshot = DepartmentPath.createFromChoice({
        id: input.id ?? `path:${input.applicationId}:${input.departmentId}`,
        applicationId: application.id,
        activityId: application.activityId,
        clubId: application.clubId,
        departmentId: input.departmentId,
        allowTransfer: false,
        now: input.now,
      }).toSnapshot();
    }
    const path = DepartmentPath.fromSnapshot(snapshot);
    const ok = path.recordDecision(
      new DefaultDepartmentPathStateMachine(),
      input.decision,
      input.decidedBy,
      input.now,
      input.note ?? null,
    );
    if (!ok) {
      throw recruitmentErrors.preconditionFailed('当前部门路径状态不允许该决定');
    }
    await this.repository.saveDepartmentPath(path.toSnapshot(), expectedRevision);
    return { pathId: path.id, status: path.status };
  }
}

function isValidDepartmentDecision(value: string): value is DepartmentDecision {
  return Object.values(DepartmentDecision).includes(value as DepartmentDecision);
}
