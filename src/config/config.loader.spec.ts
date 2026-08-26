/**
 * 配置加载器占位符 fail-closed 测试（ADR-010 / OPS-CFG-001）。
 *
 * 覆盖：示例配置以 CHANGE_ME 占位的秘密/必填项，加载器必须拒绝启动
 * （抛 ConfigLoadError），绝不带着占位符真实运行；改写为真实值或外置引用后正常加载。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, ConfigLoadError } from './config.loader';

/** 创建一份写入给定 YAML 内容的临时配置，返回其文件路径。 */
function writeTempConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rana-cfg-'));
  const file = join(dir, 'config.yaml');
  writeFileSync(file, content, 'utf8');
  return file;
}

function cleanupTemp(file: string): void {
  rmSync(join(file, '..'), { recursive: true, force: true });
}

/** 一份结构完整、无占位符的最小合法配置 */
const GOOD_CONFIG = `
server:
  host: 0.0.0.0
  port: 3000
database:
  host: postgres
  name: ranaminder
  user: ranaminder
  schema: app
  ssl: false
  passwordRef: realpassword123
casdoor:
  endpoint: https://casdoor.example.edu
  clientId: myclient
  organization: myorg
  redirectUri: http://localhost:3000/api/auth/callback
  clientSecretRef: realsecret456
  sessionSecretRef: realsession789
storage:
  endpoint: http://minio:9000
  region: us-east-1
  accessKeyRef: realaccess
  secretKeyRef: realminkey
`;

describe('config.loader 占位符 fail-closed', () => {
  it('改写了真实值的配置正常加载', () => {
    const file = writeTempConfig(GOOD_CONFIG);
    try {
      const cfg = loadConfig({ configFilePath: file });
      assert.equal(cfg.database.passwordRef, 'realpassword123');
      assert.equal(cfg.casdoor.clientId, 'myclient');
      assert.equal(cfg.casdoor.sessionSecretRef, 'realsession789');
      assert.equal(cfg.storage.secretKeyRef, 'realminkey');
    } finally {
      cleanupTemp(file);
    }
  });

  it('必填秘密字段仍为 CHANGE_ME 时拒绝启动', () => {
    const file = writeTempConfig(
      GOOD_CONFIG.replace('passwordRef: realpassword123', 'passwordRef: CHANGE_ME'),
    );
    try {
      assert.throws(
        () => loadConfig({ configFilePath: file }),
        (e: unknown) => e instanceof ConfigLoadError && /CHANGE_ME/.test((e as Error).message),
      );
    } finally {
      cleanupTemp(file);
    }
  });

  it('非秘密必填项（casdoor.clientId）仍为 CHANGE_ME 时也拒绝', () => {
    const file = writeTempConfig(GOOD_CONFIG.replace('clientId: myclient', 'clientId: CHANGE_ME'));
    try {
      assert.throws(
        () => loadConfig({ configFilePath: file }),
        (e: unknown) => e instanceof ConfigLoadError,
      );
    } finally {
      cleanupTemp(file);
    }
  });

  it('以 CHANGE_ME 为前缀的其它占位（如 CHANGE_ME_DB）同样拒绝', () => {
    const file = writeTempConfig(
      GOOD_CONFIG.replace('passwordRef: realpassword123', 'passwordRef: CHANGE_ME_DB'),
    );
    try {
      assert.throws(
        () => loadConfig({ configFilePath: file }),
        (e: unknown) => e instanceof ConfigLoadError,
      );
    } finally {
      cleanupTemp(file);
    }
  });
});

describe('config.loader SSL 证书校验开关（sslRejectUnauthorized）', () => {
  it('未配置时默认 true（安全默认：校验证书链）', () => {
    const file = writeTempConfig(GOOD_CONFIG);
    try {
      const cfg = loadConfig({ env: {}, configFilePath: file });
      assert.equal(cfg.database.sslRejectUnauthorized, true);
    } finally {
      cleanupTemp(file);
    }
  });

  it('配置文件显式 false 可关闭（自签/内部 CA 部署逃生通道）', () => {
    const file = writeTempConfig(
      GOOD_CONFIG.replace('ssl: false', 'ssl: false\n  sslRejectUnauthorized: false'),
    );
    try {
      const cfg = loadConfig({ env: {}, configFilePath: file });
      assert.equal(cfg.database.sslRejectUnauthorized, false);
    } finally {
      cleanupTemp(file);
    }
  });

  it('文件未配置时环境变量 DATABASE_SSL_REJECT_UNAUTHORIZED 生效；文件显式值优先（与 ssl 同口径）', () => {
    const noFlag = writeTempConfig(GOOD_CONFIG);
    try {
      // 文件未配置：环境变量决定
      assert.equal(
        loadConfig({ env: { DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' }, configFilePath: noFlag })
          .database.sslRejectUnauthorized,
        false,
      );
      assert.equal(
        loadConfig({ env: { DATABASE_SSL_REJECT_UNAUTHORIZED: '1' }, configFilePath: noFlag })
          .database.sslRejectUnauthorized,
        true,
      );
      // 文件显式配置：优先于环境变量（parseBool 文件优先语义）
      const explicit = writeTempConfig(
        GOOD_CONFIG.replace('ssl: false', 'ssl: false\n  sslRejectUnauthorized: false'),
      );
      try {
        assert.equal(
          loadConfig({
            env: { DATABASE_SSL_REJECT_UNAUTHORIZED: 'true' },
            configFilePath: explicit,
          }).database.sslRejectUnauthorized,
          false,
        );
      } finally {
        cleanupTemp(explicit);
      }
    } finally {
      cleanupTemp(noFlag);
    }
  });
});
