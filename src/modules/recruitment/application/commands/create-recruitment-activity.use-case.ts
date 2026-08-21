/**
 * 创建招新活动用例（REC-001、GOV-003）。
 *
 * 仅社团负责人/人事可建；fail-closed 授权桩默认拒绝（待 3.x 接入）。
 */

import { randomUUID } from 'node:crypto';
import { RecruitmentActivity } from '../../domain/models/recruitment-activity';
import type { RecruitmentRepository } from '../ports/recruitment-repository.port';
import type { RecruitmentAuthorizationPort } from '../ports/recruitment-authorization.port';
import { recruitmentErrors } from '../errors';

export interface CreateRecruitmentActivityInput {
  readonly clubId: string;
  readonly title: string;
  readonly description: string | null;
  readonly endDate?: Date | null;
  readonly actor: string;
  readonly now: Date;
  readonly id?: string;
}

export interface CreateRecruitmentActivityResult {
  readonly activityId: string;
}

export interface CreateRecruitmentActivityUseCase {
  execute(input: CreateRecruitmentActivityInput): Promise<CreateRecruitmentActivityResult>;
}

export class DefaultCreateRecruitmentActivityUseCase implements CreateRecruitmentActivityUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(input: CreateRecruitmentActivityInput): Promise<CreateRecruitmentActivityResult> {
    if (
      !(await this.authorization.canManageRecruitment({
        clubId: input.clubId,
        subjectId: input.actor,
        activityId: undefined,
      }))
    ) {
      throw recruitmentErrors.forbidden('仅社团负责人/人事可创建招新活动');
    }
    const id = input.id ?? randomUUID();
    const activity = RecruitmentActivity.createDraft({
      id,
      clubId: input.clubId,
      title: input.title,
      description: input.description,
      endDate: input.endDate ?? null,
      createdBy: input.actor,
      now: input.now,
    });
    await this.repository.saveActivity(activity.toSnapshot());
    return { activityId: id };
  }
}
