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
  // 密码以引用形式提供，不进入配置文件正文（ADR-010 §1.2）。
  readonly passwordRef: string;
}

export interface CasdoorConfig {
  readonly endpoint: string;
  readonly clientId: string;
  readonly organization: string;
  readonly redirectUri: string;
  readonly clientSecretRef: string;
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

export interface RanaMinderConfig {
  readonly server: ServerConfig;
  readonly database: DatabaseConfig;
  readonly casdoor: CasdoorConfig;
  readonly storage: StorageConfig;
  readonly mail: MailConfig;
  readonly observability: ObservabilityConfig;
  readonly job: JobConfig;
}
