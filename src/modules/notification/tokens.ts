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
/** 邮件配置存储端口（§14.4，开发阶段内存实现） */
export const EMAIL_CONFIG_STORE = 'EmailConfigStore';
/** 通知偏好存储端口（§7，按用户真实落库） */
export const PREFERENCES_STORE = 'NotificationPreferencesStore';
/** 发信密钥加密端口（NTF-006：密钥不明文存储/回显） */
export const EMAIL_SECRET_CIPHER = 'EmailSecretCipher';
/** 社团邮件策略存储端口（NTF-004：按活动或类型关闭邮件） */
export const CLUB_EMAIL_POLICY_STORE = 'ClubEmailPolicyStore';
/** 平台级邮件停用目录存储端口（超管统一停用某类邮件） */
export const PLATFORM_EMAIL_SUSPENSION_STORE = 'PlatformEmailSuspensionStore';
/** 邮件模板存储端口（NTF-005：平台默认＋社团自定义＋版本回滚） */
export const EMAIL_TEMPLATE_STORE = 'EmailTemplateStore';
/** 站内信紧急关闭特权核验端口（XCC-FAIL-009，fail-closed） */
export const NOTIFICATION_PRIVILEGE_VERIFIER = 'NotificationPrivilegeVerifier';
