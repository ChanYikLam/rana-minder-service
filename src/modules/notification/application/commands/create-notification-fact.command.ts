/**
 * 创建通知事实命令（NTF-001、NTF-002、IFC-TX-002）。
 *
 * 由各领域命令在同事务内调用。通知事实、收件人快照与权益业务结果
 * 在同一数据库事务原子保存；保存失败则原业务整体回滚。
 *
 * 此命令是"供各领域命令同事务调用的事务能力"，不是独立公开命令。
 */

import { Injectable, Logger } from '@nestjs/common';
import type { CreateNotificationFactInput, RecipientSnapshot } from '../../domain';
import { validateNotificationFactInput } from '../../domain';
import type { NotificationRepository } from '../../infrastructure';
import type { RecipientResolver } from '../../domain';

export interface CreateNotificationFactResult {
  readonly factId: string;
  readonly snapshotCount: number;
}

@Injectable()
export class CreateNotificationFactCommand {
  private readonly logger = new Logger(CreateNotificationFactCommand.name);

  constructor(
    private readonly repository: NotificationRepository,
    private readonly resolver: RecipientResolver,
  ) {}

  /**
   * 在同事务内创建通知事实和收件人快照。
   * 此方法应在调用方数据库事务内执行。
   *
   * @param input 通知事实创建输入
   * @returns 创建结果
   * @throws 保存失败时抛出异常，调用方事务整体回滚（NTF-001、SRS-FAIL-008）
   */
  async execute(input: CreateNotificationFactInput): Promise<CreateNotificationFactResult> {
    // 校验输入合法性
    const validationError = validateNotificationFactInput(input);
    if (validationError) {
      throw new Error(`通知事实输入校验失败: ${validationError}`);
    }

    // 解析收件人快照（NTF-002）
    const resolveResult = this.resolver.resolve({
      logicalEventId: input.logicalEventId,
      eventType: input.eventType,
      sourceObjectId: input.sourceObjectId,
      scope: { type: input.scope.type, clubId: input.scope.clubId },
      operatorId: input.sourceCommandId,
      targetStudentId: input.sourceObjectId,
    });

    // 构建收件人快照并做去重检查：同一逻辑事件＋收件人已存在则跳过（NTF-003）
    const snapshots: RecipientSnapshot[] = [];
    for (const r of resolveResult.recipients) {
      const existing = await this.repository.findFactByDedupKey(r.dedupKey);
      if (existing) {
        this.logger.log(
          `已存在同逻辑事件＋收件人的通知事实，跳过（幂等 NTF-003）: ` +
            `dedupKey=${r.dedupKey}, factId=${existing.factId}`,
        );
        continue;
      }
      snapshots.push({
        snapshotId: '', // 由仓储生成
        factId: '', // 由仓储生成
        recipientId: r.recipientId,
        reason: r.reason,
        scope: r.scope,
        dedupKey: r.dedupKey,
        createdAt: '', // 由仓储生成
      });
    }

    if (snapshots.length === 0) {
      this.logger.warn(`通知事实 ${input.logicalEventId} 解析出的收件人列表为空或全部已去重`);
      return { factId: '', snapshotCount: 0 };
    }

    // 原子保存通知事实＋收件人快照（IFC-TX-002 边界 2）
    // 保存失败则抛出异常，由调用方事务整体回滚
    const result = await this.repository.saveFactWithSnapshots(input, snapshots);

    this.logger.log(
      `通知事实创建成功: factId=${result.fact.factId}, ` +
        `收件人数=${result.snapshots.length}, ` +
        `事件类型=${input.eventType}`,
    );

    return {
      factId: result.fact.factId,
      snapshotCount: result.snapshots.length,
    };
  }
}
