import { Inject, Injectable } from '@nestjs/common';
import type { ArchiveRecord } from '../../domain/models/archive';
import { ArchiveAccessPolicy } from '../../domain/services/archive-access-policy';
import type { ArchiveAccessContext, ArchiveAccessDecision, ArchiveContentKind, ArchiveRequestScope } from '../../domain/services/archive-access-policy';
import { ARCHIVE_REPOSITORY } from '../../infrastructure/archive-repository';
import type { ArchiveRepository } from '../../infrastructure/archive-repository';

/** 归档访问查询输入（AUD-004） */
export interface ArchiveAccessInput {
  readonly activityId: string;
  /** 当前角色上下文（按当前有效角色鉴权，不按历史职位） */
  readonly context: ArchiveAccessContext;
  /** 请求范围（SELF=本人 / CLUB=某社团 / ALL=全平台仅超管） */
  readonly scope: ArchiveRequestScope;
  /** 内容类别（内部评价/纠错/审计仅有权角色） */
  readonly contentKind?: ArchiveContentKind;
}

/** 归档访问结果 */
export interface ArchiveAccessResult {
  readonly archive: ArchiveRecord;
  readonly decision: ArchiveAccessDecision;
}

/**
 * 归档访问查询（AUD-004）。
 *
 * - 只读归档；访问按**当前有效角色**实时鉴权（历史负责人/离任成员不保留访问权）；
 * - 申请人看自己（内部评价/纠错/审计拒绝）；面试官结束后失权；部门负责人仅
 *   本部门路径（部门归属社团校验）；负责人/人事看本社团全部历史（且参与社团
 *   锁定快照需启用）；
 * - **超管可查看全部归档，每次特权访问返回 privileged 标志（调用方须写入审计）**。
 */
@Injectable()
export class ArchiveAccessQuery {
  constructor(
    @Inject(ARCHIVE_REPOSITORY) private readonly repo: ArchiveRepository,
    private readonly policy: ArchiveAccessPolicy,
  ) {}

  async access(input: ArchiveAccessInput): Promise<ArchiveAccessResult> {
    const archive = await this.repo.load(input.activityId);
    if (archive === null) {
      throw new Error('IFC-ERR-006: 归档不存在');
    }
    const decision = this.policy.check(input.context, archive, input.scope);
    if (input.contentKind !== undefined) {
      this.policy.assertContentAllowed(input.context, input.contentKind);
    }
    return { archive, decision };
  }
}
