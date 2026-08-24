/**
 * 收件人快照计算器（NTF-002）。
 *
 * 根据事件类型、业务对象和作用域计算收件人名单。
 * 收件人名单在业务事件发生时形成快照，后续换届不改变历史收件人。
 */

import type { RecipientSnapshot, RecipientResolveInput, RecipientResolveResult } from '../models';

/**
 * 收件人解析器接口。
 * 各领域模块在创建通知时传入事件上下文，解析器返回收件人快照。
 */
export interface RecipientResolver {
  /**
   * 解析收件人。
   * @param input 事件上下文
   * @returns 收件人列表和解析依据
   */
  resolve(input: RecipientResolveInput): RecipientResolveResult;
}

/**
 * 默认收件人解析器。
 * 根据事件类型决定收件人：
 * - 权益事件（application, interview, invitation, conclusion, member, transition）通知学生本人
 * - 管理事件（system, correction）通知相关管理角色
 */
export class DefaultRecipientSnapshotResolver implements RecipientResolver {
  resolve(input: RecipientResolveInput): RecipientResolveResult {
    const recipients: Array<RecipientResolveResult['recipients'][number]> = [];

    const isStudentAffectingEvent = [
      'application',
      'interview',
      'invitation',
      'conclusion',
      'member',
      'transition',
    ].includes(input.eventType);

    if (isStudentAffectingEvent && input.targetStudentId) {
      // 直接影响学生权益的事件必须通知学生本人（NTF-001）
      recipients.push({
        recipientId: input.targetStudentId,
        reason: '本人',
        scope: input.scope,
        // 由命令层以 逻辑事件＋收件人 重建去重键（NTF-003、DATA-NTF-001）
        dedupKey: '',
      });
    }

    // 管理收件人按具体事件选择（NTF-001：管理员收件人按具体事件选择，
    // 不能无差别广播）
    // 管理角色收件人由各领域命令根据当前作用域和角色计算后传入
    // 此处仅作为默认实现框架

    return {
      recipients: recipients as readonly Omit<
        RecipientSnapshot,
        'snapshotId' | 'factId' | 'createdAt'
      >[],
      resolutionRationale: `事件类型=${input.eventType}, 目标学生=${input.targetStudentId ?? '无'}, 操作者=${input.operatorId}`,
    };
  }
}
