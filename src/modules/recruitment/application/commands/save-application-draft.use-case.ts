/**
 * 保存报名草稿用例（A2；接口清单 §11.1 POST :activityId/draft）。
 *
 * 语义：无申请则创建 DRAFT；已有 DRAFT/WITHDRAWN 则更新 answers（version 递增）；
 * SUBMITTED → 422（须先撤销回草稿）；IDENTITY_EXCEPTION → 422（身份异常不可保存）。
 * 通道未开放/已截止 → 422（与提交同口径；草稿行需要批次归属）。
 */

import { randomUUID } from 'node:crypto';
import { Application } from '../../domain/models/application';
import type { RecruitmentRepository } from '../ports/recruitment-repository.port';
import { recruitmentErrors } from '../errors';

export interface SaveApplicationDraftInput {
  readonly activityId: string;
  readonly channelId: string;
  readonly applicantId: string;
  readonly answers?: unknown;
  readonly now: Date;
  readonly id?: string;
  /** 认证主体（用例内校验 applicantId 归属，防冒充） */
  readonly actor: string;
}

export interface SaveApplicationDraftResult {
  readonly applicationId: string;
}

export interface SaveApplicationDraftUseCase {
  execute(input: SaveApplicationDraftInput): Promise<SaveApplicationDraftResult>;
}

export class DefaultSaveApplicationDraftUseCase implements SaveApplicationDraftUseCase {
  constructor(private readonly repository: RecruitmentRepository) {}

  async execute(input: SaveApplicationDraftInput): Promise<SaveApplicationDraftResult> {
    if (input.applicantId !== input.actor) {
      throw recruitmentErrors.forbidden('申请归属须为当前认证账号');
    }
    const activity = await this.repository.loadActivity(input.activityId);
    if (activity === null) {
      throw recruitmentErrors.notFound('招新活动');
    }
    const channel = await this.repository.loadChannel(input.channelId);
    if (channel === null || channel.activityId !== activity.id) {
      throw recruitmentErrors.notFound('报名通道');
    }
    if (channel.status !== 'OPEN') {
      throw recruitmentErrors.preconditionFailed('报名通道未开放');
    }
    if (channel.deadline !== null && input.now.getTime() > channel.deadline.getTime()) {
      throw recruitmentErrors.preconditionFailed('报名通道当前窗口已截止');
    }

    const existing = await this.repository.loadApplicationByApplicantAndChannel(
      input.applicantId,
      input.channelId,
    );

    if (existing === null) {
      const application = Application.createDraft({
        id: input.id ?? randomUUID(),
        activityId: activity.id,
        channelId: channel.id,
        clubId: activity.clubId,
        applicantId: input.applicantId,
        now: input.now,
      });
      application.saveDraftAnswers(input.answers ?? {}, input.now);
      await this.repository.saveApplication(application.toSnapshot(), -1);
      return { applicationId: application.id };
    }

    const application = Application.fromSnapshot(existing);
    try {
      application.saveDraftAnswers(input.answers ?? {}, input.now);
    } catch {
      if (application.status === 'SUBMITTED') {
        throw recruitmentErrors.preconditionFailed('已提交报名，请先撤销回草稿再编辑');
      }
      if (application.status === 'IDENTITY_EXCEPTION') {
        throw recruitmentErrors.preconditionFailed('身份核验异常期间不可保存报名草稿');
      }
      throw recruitmentErrors.preconditionFailed('当前报名状态不可保存草稿');
    }
    await this.repository.saveApplication(application.toSnapshot(), existing.revisionNumber);
    return { applicationId: application.id };
  }
}
