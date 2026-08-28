// no-spec-required 纯类型契约文件，无运行时代码；加载逻辑由 config.loader.spec.ts 全量覆盖
/**
 * RanaMinder 配置类型契约（ADR-010 单文件外置配置 + ADR-014 单库单 Schema +
 * ADR-009 Casdoor 适配 + ADR-008 S3 兼容存储 + ADR-011 内置最小观测 +
 * ADR-004 后台任务可靠投递）。
 *
 * 本文件只定义结构与必填字段，不做加载与运行时副作用；具体加载见
 * config.loader.ts，DI 注入见 configuration.module.ts。
 *
 * 数值与默认值均为 DEP-001 §2 候选基线，待首批技术验证后复核锁定，不得视为
 * 已冻结。
 */

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly gracefulShutdownTimeoutMs: number;
}

export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly name: string;
  readonly user: string;
  readonly schema: string;
  readonly ssl: boolean;
  /** SSL 证书校验开关（默认校验）；自签/内网测试可关闭，生产应保持 true。 */
  readonly sslRejectUnauthorized?: boolean;
  // 密码以引用形式提供，不进入配置文件正文（ADR-010 §1.2）。
  readonly passwordRef: string;
}

export interface CasdoorConfig {
  readonly endpoint: string;
  readonly clientId: string;
  readonly organization: string;
  readonly redirectUri: string;
  readonly clientSecretRef: string;
  /**
   * 本地会话 JWT 的独立签名密钥引用（CAS-AUTH-001）。
   * 为空时回退到解析后的 Casdoor clientSecret（高熵派生）；
   * 生产建议显式配置独立随机高熵密钥，避免与 Casdoor clientSecret 耦合。
   */
  readonly sessionSecretRef?: string;
  /**
   * OIDC PKCE（S256）开关（默认开启）。学校真实实例经能力验证脚本确认不支持时
   * 才允许显式置 false 并记录证据；关闭后基线回落为 confidential client +
   * 一次性 code + 服务端一次性 nonce/state。
   */
  readonly pkceEnabled?: boolean;
  /**
   * 会话 Cookie 强制 Secure（默认关闭，按请求自动探测 HTTPS）。生产/灰度经
   * HTTPS 提供服务时必须置 true：不再依赖 x-forwarded-proto 探测，防反代
   * 配置漂移导致 Cookie 明文传输。
   */
  readonly cookieSecureEnforced?: boolean;
  /**
   * 强制专用会话签名密钥（默认关闭）。置 true 时未配置 sessionSecretRef
   * （或长度 < 32 字符）将拒绝启动会话链路（fail-closed，503
   * CAS-ERR-SESSION_SECRET_REQUIRED）；生产部署应置 true，避免轮换
   * clientSecret 时连带打掉全部在线会话。
   */
  readonly requireDedicatedSessionSecret?: boolean;
  /** 发现文档缓存 TTL（毫秒）；缺省用客户端内置 1 小时。 */
  readonly discoveryTtlMs?: number;
  /** 会话 Cookie Max-Age（秒，默认 86400，与会话 JWT 24h 有效期对齐）。 */
  readonly sessionCookieMaxAgeSec?: number;
}

export interface StorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyRef: string;
  readonly secretKeyRef: string;
  // 三个私有 Bucket（DATA-Q-012 冻结：每个隔离部署环境三个私有文件 Bucket，
  // 分别对应隔离区、权威原件区、临时派生区）。
  readonly buckets: {
    readonly quarantine: string;
    readonly primary: string;
    readonly derived: string;
  };
}

export interface MailConfig {
  readonly host: string;
  readonly port: number;
  readonly fromAddress: string;
  readonly userRef?: string;
  readonly passwordRef?: string;
}

export interface ObservabilityConfig {
  // 日志级别；具体阈值与字段允许清单见 ops/README §6.1 + OPS-CFG-005。
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  // 首版默认全采；按 ADR-011 §2.1 收口，采样率不得影响业务关键路径。
  readonly traceSamplingRate: number;
}

export interface JobConfig {
  // 调度器轮询间隔；具体重试/退避参数待 1.3 通用任务信封阶段复核。
  readonly schedulerIntervalMs: number;
  // 默认租约时长；按 ADR-004 持久任务可靠投递。
  readonly defaultLeaseMs: number;
  readonly maxAttempts: number;
}

/** 外部服务适配器（文件检查/通知/备份）端点配置。endpoint 为空时适配器保持 fail-closed。 */
export interface ExternalServiceConfig {
  readonly endpoint: string;
  readonly tokenRef?: string;
}

export interface RanaMinderConfig {
  readonly server: ServerConfig;
  readonly database: DatabaseConfig;
  readonly casdoor: CasdoorConfig;
  readonly storage: StorageConfig;
  readonly mail: MailConfig;
  /** 外部技术安全检查服务（ADAPTERS_FILECHECK_REAL）。 */
  readonly fileCheck: ExternalServiceConfig;
  /** 外部通知渠道（ADAPTERS_NOTIFY_REAL）。 */
  readonly notify: ExternalServiceConfig;
  /** 外部备份/恢复记录服务（ADAPTERS_BACKUP_REAL）。 */
  readonly backup: ExternalServiceConfig;
  readonly observability: ObservabilityConfig;
  readonly job: JobConfig;
}
