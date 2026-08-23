import { Inject, Injectable } from '@nestjs/common';
import { ArchiveKind } from '../../domain/models/archive';
import type { ArchiveRecord } from '../../domain/models/archive';
import { ARCHIVE_REPOSITORY } from '../../infrastructure/archive-repository';
import type { ArchiveRepository } from '../../infrastructure/archive-repository';

/** 归档活动输入（AUD-004：活动完成后自动进入只读归档） */
export interface ArchiveActivityInput {
  readonly activityId: string;
  readonly kind: ArchiveKind;
  /** 参与社团及锁定快照（按首次公布锁定；停用社团停用期间不能查看） */
  readonly participants: readonly { clubId: string; enabledAtLock: boolean }[];
  readonly sourceState: string;
}

/**
 * 自动只读归档（AUD-004）。
 *
 * - 招新/联合活动完成后自动归档，**不要求额外归档操作**；
 * - 归档只读（readOnly 恒 true）；参与关系与社团启用状态锁定为快照；
 * - **原子幂等**：并发归档只一个创建成功，其余返回已存在记录（createIfAbsent）。
 */
@Injectable()
export class ArchiveActivityCommand {
  constructor(@Inject(ARCHIVE_REPOSITORY) private readonly repo: ArchiveRepository) {}

  async execute(input: ArchiveActivityInput): Promise<ArchiveRecord> {
    if (input.activityId.trim().length === 0) {
      throw new Error('IFC-ERR-005: 活动 ID 不能为空');
    }
    if (input.participants.length === 0) {
      throw new Error('IFC-ERR-005: 归档需至少一个参与社团');
    }
    if (input.participants.some((p) => p.clubId.trim().length === 0)) {
      throw new Error('IFC-ERR-005: 参与社团 ID 不能为空');
    }
    const archive: ArchiveRecord = {
      activityId: input.activityId,
      kind: input.kind,
      archivedAt: new Date().toISOString(),
      participants: input.participants.map((p) => ({ ...p })),
      sourceState: input.sourceState,
      readOnly: true,
      version: 1,
    };
    // 原子创建：已存在返回原记录（幂等且不覆盖快照）
    const existing = await this.repo.createIfAbsent(archive);
    return existing ?? archive;
  }
}
