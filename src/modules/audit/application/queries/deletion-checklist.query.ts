import { Inject, Injectable } from '@nestjs/common';
import type { DeletionChecklist } from '../../domain/models/deletion';
import { DeletionPolicy } from '../../domain/services/deletion-policy';
import { DELETION_CHECKLIST_REPOSITORY } from '../../infrastructure/deletion-checklist-repository';
import type { DeletionChecklistRepository } from '../../infrastructure/deletion-checklist-repository';

/** 删除清单查询（仅超管；含受影响对象预览与恢复重放清单） */
@Injectable()
export class DeletionChecklistQuery {
  constructor(
    @Inject(DELETION_CHECKLIST_REPOSITORY) private readonly repo: DeletionChecklistRepository,
    private readonly policy: DeletionPolicy,
  ) {}

  /** 展示受影响对象清单（AUD-005：删除前预览/二次确认；仅超管） */
  async previewAffected(checklistId: string, roles: readonly string[]): Promise<readonly string[]> {
    this.policy.assertSuperAdmin(roles);
    const checklist = await this.repo.load(checklistId);
    if (checklist === null) {
      throw new Error('IFC-ERR-006: 删除清单不存在');
    }
    return checklist.affectedObjects;
  }

  /** 未完成清单（普通重试；仅超管；AUD-009） */
  async listIncomplete(roles: readonly string[]): Promise<readonly DeletionChecklist[]> {
    this.policy.assertSuperAdmin(roles);
    return this.repo.listIncomplete();
  }

  /** 全量清单（恢复备份后重放需含已完成清单；仅超管；AUD-009） */
  async listAll(roles: readonly string[]): Promise<readonly DeletionChecklist[]> {
    this.policy.assertSuperAdmin(roles);
    return this.repo.listAll();
  }
}
