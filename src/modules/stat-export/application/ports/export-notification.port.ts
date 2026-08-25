/**
 * 导出完成通知端口（5.4.4，EXP-001：生成完成后站内信，不使用邮件附件交付）。
 *
 * 导出文件一律经"任务详情页 + 短期下载地址"交付；站内信仅告知"导出已完成、
 * 可前往下载"，附件本身绝不通过邮件投递（EXP-001 交付边界，避免邮件通道绕过
 * 下载时的实时权限/有效期/停用重验）。
 *
 * 生产适配器桥接 notification 模块（IFC-TX-002：同事务保存通知事实，投递由
 * NTF 模块承接），与 membership 模块 MembershipNotificationPort 先例同构：
 * 领域模块只依赖本端口，不反向依赖 notification 模块（跨模块仅经端口/命令）。
 * 内存桩见 InMemoryExportNotification（记录事件供断言）。
 */

/** 导出完成通知事件 */
export interface ExportCompletedEvent {
  /** 站内信接收人（任务 ownerUserId：本人申请为申请方，代申请副本为被导出人） */
  readonly recipientUserId: string;
  readonly exportId: string;
  /** 导出编号（通知文案中的可读溯源标识，EXP-002） */
  readonly exportNo: string;
}

export interface ExportNotificationPort {
  notifyExportCompleted(evt: ExportCompletedEvent): Promise<void>;
}

export const EXPORT_NOTIFICATION_PORT = Symbol('EXPORT_NOTIFICATION_PORT');
