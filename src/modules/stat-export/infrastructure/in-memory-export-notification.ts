/**
 * 内存导出完成通知桩（开发与单测用，5.4.4，EXP-001）。
 *
 * 仅记录 notifyExportCompleted 收到的事件供断言；生产适配器桥接 notification
 * 模块（IFC-TX-002 同事务保存通知事实），与 membership MembershipNotificationPort
 * 先例同构（见 ports/export-notification.port.ts JSDoc）。
 */

import {
  EXPORT_NOTIFICATION_PORT,
  type ExportCompletedEvent,
  type ExportNotificationPort,
} from '../application/ports/export-notification.port';

export class InMemoryExportNotification implements ExportNotificationPort {
  readonly events: ExportCompletedEvent[] = [];

  async notifyExportCompleted(evt: ExportCompletedEvent): Promise<void> {
    this.events.push({ ...evt });
  }

  /** 测试辅助：清空事件记录 */
  clear(): void {
    this.events.length = 0;
  }
}

export { EXPORT_NOTIFICATION_PORT };
