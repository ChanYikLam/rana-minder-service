/**
 * 秘密引用解析（ADR-010 单文件外置配置）。
 *
 * 配置文件中不应直接出现明文密钥；密钥通过引用从环境变量或受限路径文件加载。
 *
 * 引用格式：
 *   - ${env:VAR_NAME}          从 process.env.VAR_NAME 读取
 *   - ${file:/path/to/secret}  从白名单路径文件读取并去除首尾空白
 *
 * 文件路径白名单（避免任意文件读取）：
 *   - /etc/ranaminder/secrets/
 *   - /run/secrets/           （Docker secrets）
 *
 * 未支持的引用（${vault:...} 等）一律报错，不静默忽略。
 */

import { existsSync, readFileSync } from 'node:fs';

export type SecretRef = string;

const ENV_PATTERN = /^\$\{env:([A-Z_][A-Z0-9_]*)\}$/;
const FILE_PATTERN = /^\$\{file:([^}]+)\}$/;

const ALLOWED_FILE_PREFIXES: readonly string[] = [
  '/etc/ranaminder/secrets/',
  '/run/secrets/',
];

export class SecretRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretRefError';
  }
}

export function isSecretRef(value: unknown): value is SecretRef {
  return typeof value === 'string' && value.startsWith('${');
}

export function resolveSecret(ref: SecretRef): string {
  if (typeof ref !== 'string') {
    throw new SecretRefError('Secret reference must be a string');
  }

  const envMatch = ENV_PATTERN.exec(ref);
  if (envMatch) {
    const value = process.env[envMatch[1]];
    if (value === undefined) {
      throw new SecretRefError(`Secret env var not set: ${envMatch[1]}`);
    }
    return value;
  }

  const fileMatch = FILE_PATTERN.exec(ref);
  if (fileMatch) {
    const path = fileMatch[1].trim();
    if (!ALLOWED_FILE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      throw new SecretRefError(`Secret file path not in allowlist: ${path}`);
    }
    if (!existsSync(path)) {
      throw new SecretRefError(`Secret file not found: ${path}`);
    }
    return readFileSync(path, 'utf8').trim();
  }

  if (ref.startsWith('${')) {
    throw new SecretRefError(`Unsupported secret reference: ${ref}`);
  }

  // 非引用字符串视为开发期明文；生产必须用引用形式（ADR-010 §1.2）。
  return ref;
}