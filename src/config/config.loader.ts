/**
 * 配置加载器（ADR-010 单文件外置配置 + Docker 只读挂载约定）。
 *
 * 加载顺序：
 *   1. 配置文件路径 = RANAMINDER_CONFIG_FILE 或默认 '/etc/ranaminder/config.yaml'
 *   2. 若文件存在：解析 YAML 为部分配置
 *   3. 若文件不存在：仅依赖环境变量（开发/测试模式）
 *   4. 应用环境变量覆盖（PORT/HOST/DATABASE_HOST 等）
 *   5. 解析所有 *Ref 字段为实际值
 *   6. 校验必填字段，返回完整 RanaMinderConfig
 *
 * YAML 解析：使用 eemeli/yaml 包（MIT，单一职责），待 DEP-Q-001 复核候选。
 *
 * 失败模式：必填字段缺失或引用解析失败 → throw ConfigLoadError，由 main.ts / worker
 * 接住并以非零状态退出。
 */

import { existsSync, readFileSync } from 'node:fs';
import * as YAML from 'yaml';

import { resolveSecret, isSecretRef, SecretRefError } from './secret-ref';
import type {
  RanaMinderConfig,
  ServerConfig,
  DatabaseConfig,
  CasdoorConfig,
  StorageConfig,
  MailConfig,
  ObservabilityConfig,
  JobConfig,
} from './configuration';

export class ConfigLoadError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ConfigLoadError';
  }
}

const DEFAULT_CONFIG_PATH = '/etc/ranaminder/config.yaml';

interface RawConfig {
  readonly server?: Partial<ServerConfig>;
  readonly database?: Partial<DatabaseConfig>;
  readonly casdoor?: Partial<CasdoorConfig>;
  readonly storage?: Partial<StorageConfig>;
  readonly mail?: Partial<MailConfig>;
  readonly observability?: Partial<ObservabilityConfig>;
  readonly job?: Partial<JobConfig>;
}

export interface LoadOptions {
  readonly configFilePath?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function loadConfig(options: LoadOptions = {}): RanaMinderConfig {
  const env = options.env ?? process.env;
  const path = options.configFilePath ?? env.RANAMINDER_CONFIG_FILE ?? DEFAULT_CONFIG_PATH;

  let raw: RawConfig = {};
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    try {
      raw = YAML.parse(text) as RawConfig;
    } catch (cause) {
      throw new ConfigLoadError(`Failed to parse YAML at ${path}`, cause);
    }
  }

  try {
    return buildConfig(raw, env);
  } catch (cause) {
    if (cause instanceof SecretRefError) {
      throw new ConfigLoadError(cause.message, cause);
    }
    throw cause;
  }
}

// ----- 内部 -----

function buildConfig(raw: RawConfig, env: NodeJS.ProcessEnv): RanaMinderConfig {
  return {
    server: buildServer(raw.server, env),
    database: buildDatabase(raw.database, env),
    casdoor: buildCasdoor(raw.casdoor, env),
    storage: buildStorage(raw.storage, env),
    mail: buildMail(raw.mail, env),
    observability: buildObservability(raw.observability, env),
    job: buildJob(raw.job, env),
  };
}

function buildServer(raw: Partial<ServerConfig> | undefined, env: NodeJS.ProcessEnv): ServerConfig {
  return {
    port: parseIntValue(raw?.port, env.PORT, 'PORT', 3000),
    host: parseString(raw?.host, env.HOST, 'HOST', '0.0.0.0'),
    gracefulShutdownTimeoutMs: parseIntValue(
      raw?.gracefulShutdownTimeoutMs,
      env.GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      'GRACEFUL_SHUTDOWN_TIMEOUT_MS',
      10000,
    ),
  };
}

function buildDatabase(raw: Partial<DatabaseConfig> | undefined, env: NodeJS.ProcessEnv): DatabaseConfig {
  return {
    host: parseString(raw?.host, env.DATABASE_HOST, 'DATABASE_HOST', 'localhost'),
    port: parseIntValue(raw?.port, env.DATABASE_PORT, 'DATABASE_PORT', 5432),
    name: parseString(raw?.name, env.DATABASE_NAME, 'DATABASE_NAME', 'ranaminder'),
    user: parseString(raw?.user, env.DATABASE_USER, 'DATABASE_USER', 'ranaminder'),
    schema: parseString(raw?.schema, env.DATABASE_SCHEMA, 'DATABASE_SCHEMA', 'app'),
    ssl: parseBool(raw?.ssl, env.DATABASE_SSL, false),
    passwordRef: requireField(
      raw?.passwordRef,
      env.DATABASE_PASSWORD_REF,
      'database.passwordRef',
      env.DATABASE_PASSWORD,
    ),
  };
}

function buildCasdoor(raw: Partial<CasdoorConfig> | undefined, env: NodeJS.ProcessEnv): CasdoorConfig {
  return {
    endpoint: parseString(raw?.endpoint, env.CASDOOR_ENDPOINT, 'CASDOOR_ENDPOINT', ''),
    clientId: parseString(raw?.clientId, env.CASDOOR_CLIENT_ID, 'CASDOOR_CLIENT_ID', ''),
    organization: parseString(
      raw?.organization,
      env.CASDOOR_ORGANIZATION,
      'CASDOOR_ORGANIZATION',
      '',
    ),
    redirectUri: parseString(
      raw?.redirectUri,
      env.CASDOOR_REDIRECT_URI,
      'CASDOOR_REDIRECT_URI',
      '',
    ),
    clientSecretRef: requireField(
      raw?.clientSecretRef,
      env.CASDOOR_CLIENT_SECRET_REF,
      'casdoor.clientSecretRef',
      env.CASDOOR_CLIENT_SECRET,
    ),
  };
}

function buildStorage(raw: Partial<StorageConfig> | undefined, env: NodeJS.ProcessEnv): StorageConfig {
  return {
    endpoint: parseString(raw?.endpoint, env.STORAGE_ENDPOINT, 'STORAGE_ENDPOINT', ''),
    region: parseString(raw?.region, env.STORAGE_REGION, 'STORAGE_REGION', 'us-east-1'),
    accessKeyRef: requireField(
      raw?.accessKeyRef,
      env.STORAGE_ACCESS_KEY_REF,
      'storage.accessKeyRef',
      env.STORAGE_ACCESS_KEY,
    ),
    secretKeyRef: requireField(
      raw?.secretKeyRef,
      env.STORAGE_SECRET_KEY_REF,
      'storage.secretKeyRef',
      env.STORAGE_SECRET_KEY,
    ),
    buckets: {
      quarantine: parseString(
        raw?.buckets?.quarantine,
        env.STORAGE_BUCKET_QUARANTINE,
        'STORAGE_BUCKET_QUARANTINE',
        'ranaminder-quarantine',
      ),
      primary: parseString(
        raw?.buckets?.primary,
        env.STORAGE_BUCKET_PRIMARY,
        'STORAGE_BUCKET_PRIMARY',
        'ranaminder-primary',
      ),
      derived: parseString(
        raw?.buckets?.derived,
        env.STORAGE_BUCKET_DERIVED,
        'STORAGE_BUCKET_DERIVED',
        'ranaminder-derived',
      ),
    },
  };
}

function buildMail(raw: Partial<MailConfig> | undefined, env: NodeJS.ProcessEnv): MailConfig {
  return {
    host: parseString(raw?.host, env.MAIL_HOST, 'MAIL_HOST', 'localhost'),
    port: parseIntValue(raw?.port, env.MAIL_PORT, 'MAIL_PORT', 1025),
    fromAddress: parseString(
      raw?.fromAddress,
      env.MAIL_FROM_ADDRESS,
      'MAIL_FROM_ADDRESS',
      'no-reply@example.edu',
    ),
    userRef: optionalString(raw?.userRef, env.MAIL_USER_REF, env.MAIL_USER),
    passwordRef: optionalString(raw?.passwordRef, env.MAIL_PASSWORD_REF, env.MAIL_PASSWORD),
  };
}

function buildObservability(
  raw: Partial<ObservabilityConfig> | undefined,
  env: NodeJS.ProcessEnv,
): ObservabilityConfig {
  return {
    logLevel: parseLogLevel(raw?.logLevel, env.LOG_LEVEL, 'info'),
    traceSamplingRate: parseNumber(
      raw?.traceSamplingRate,
      env.TRACE_SAMPLING_RATE,
      'TRACE_SAMPLING_RATE',
      1.0,
    ),
  };
}

function buildJob(raw: Partial<JobConfig> | undefined, env: NodeJS.ProcessEnv): JobConfig {
  return {
    schedulerIntervalMs: parseIntValue(
      raw?.schedulerIntervalMs,
      env.JOB_SCHEDULER_INTERVAL_MS,
      'JOB_SCHEDULER_INTERVAL_MS',
      1000,
    ),
    defaultLeaseMs: parseIntValue(
      raw?.defaultLeaseMs,
      env.JOB_DEFAULT_LEASE_MS,
      'JOB_DEFAULT_LEASE_MS',
      60000,
    ),
    maxAttempts: parseIntValue(raw?.maxAttempts, env.JOB_MAX_ATTEMPTS, 'JOB_MAX_ATTEMPTS', 5),
  };
}

// ----- 类型辅助 -----

function parseString(
  fromFile: unknown,
  fromEnv: string | undefined,
  envName: string,
  fallback: string,
): string {
  if (typeof fromFile === 'string' && fromFile.length > 0) return fromFile;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  if (fallback.length > 0) return fallback;
  throw new ConfigLoadError(`Missing required config: ${envName}`);
}

function parseIntValue(
  fromFile: unknown,
  fromEnv: string | undefined,
  envName: string,
  fallback: number,
): number {
  const raw = typeof fromFile === 'number' ? String(fromFile) : fromEnv;
  if (raw !== undefined && raw !== '') {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
    throw new ConfigLoadError(`Invalid integer for ${envName}: ${raw}`);
  }
  return fallback;
}

function parseNumber(
  fromFile: unknown,
  fromEnv: string | undefined,
  envName: string,
  fallback: number,
): number {
  const raw = typeof fromFile === 'number' ? String(fromFile) : fromEnv;
  if (raw !== undefined && raw !== '') {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n)) return n;
    throw new ConfigLoadError(`Invalid number for ${envName}: ${raw}`);
  }
  return fallback;
}

function parseBool(fromFile: unknown, fromEnv: string | undefined, fallback: boolean): boolean {
  if (typeof fromFile === 'boolean') return fromFile;
  if (typeof fromEnv === 'string') {
    if (fromEnv === 'true' || fromEnv === '1') return true;
    if (fromEnv === 'false' || fromEnv === '0') return false;
  }
  return fallback;
}

function parseLogLevel(
  fromFile: unknown,
  fromEnv: string | undefined,
  fallback: ObservabilityConfig['logLevel'],
): ObservabilityConfig['logLevel'] {
  const v = (typeof fromFile === 'string' ? fromFile : fromEnv)?.toLowerCase();
  if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v;
  return fallback;
}

function requireField(
  fromFile: unknown,
  fromEnv: string | undefined,
  envName: string,
  fallbackSecretEnv: string | undefined,
): string {
  if (typeof fromFile === 'string' && fromFile.length > 0) {
    return isSecretRef(fromFile) ? resolveSecret(fromFile) : fromFile;
  }
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return isSecretRef(fromEnv) ? resolveSecret(fromEnv) : fromEnv;
  }
  if (fallbackSecretEnv !== undefined && fallbackSecretEnv.length > 0) {
    return fallbackSecretEnv;
  }
  throw new ConfigLoadError(`Missing required config: ${envName}`);
}

function optionalString(
  fromFile: unknown,
  fromEnv: string | undefined,
  fallback: string | undefined,
): string | undefined {
  if (typeof fromFile === 'string' && fromFile.length > 0) {
    return isSecretRef(fromFile) ? resolveSecret(fromFile) : fromFile;
  }
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return isSecretRef(fromEnv) ? resolveSecret(fromEnv) : fromEnv;
  }
  return fallback;
}