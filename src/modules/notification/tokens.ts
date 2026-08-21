/**
 * 通知模块 DI Token 常量。
 *
 * 端口/领域服务一律以字符串 Token 注册与注入（接口在运行时被类型擦除，
 * 不能作为 DI Token；对齐 modules/form 的 token 约定）。所有命令/查询/
 * 控制器使用本文件常量注入，避免字符串字面量散落与口径不一致。
 */

/** 通知事实/收件人快照仓储端口 */
export const NOTIFICATION_REPOSITORY = 'NotificationRepository';
/** 站内信呈现适配器端口 */
export const INBOX_ADAPTER = 'InboxAdapter';
/** 邮件适配器端口 */
export const EMAIL_ADAPTER = 'EmailAdapter';
/** 渠道投递尝试仓储端口 */
export const CHANNEL_DELIVERY_ATTEMPT_REPOSITORY = 'ChannelDeliveryAttemptRepository';
/** 模板版本快照服务端口 */
export const TEMPLATE_SNAPSHOT_SERVICE = 'TemplateSnapshotService';
/** 站内信紧急关闭仓储端口 */
export const KILL_SWITCH_REPOSITORY = 'KillSwitchRepository';
/** 特权审计写入端口 */
export const PRIVILEGED_AUDIT_WRITER = 'PrivilegedAuditWriter';
/** 收件人解析领域服务 */
export const RECIPIENT_RESOLVER = 'RecipientResolver';
/** 通知认证会话解析端口（interfaces/nest） */
export const NOTIFICATION_AUTH_SESSION_PROVIDER = 'NotificationAuthSessionProvider';
