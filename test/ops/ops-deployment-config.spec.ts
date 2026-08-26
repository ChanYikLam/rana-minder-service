/**
 * L5 运维演练门 1：部署与配置基线（OPS-VER-001 / 004 / 005）。
 *
 * 锚点语义（docs/operations/部署运维与恢复手册-v1.0.md §OPS-VER 表）：
 * - OPS-VER-001 空环境按公开文档完成容器化单机部署：时间线、发布/配置、运行单元和核心冒烟；
 * - OPS-VER-004 外置单配置、只读挂载、无学校硬编码：配置扫描和写入拒绝；
 * - OPS-VER-005 正式 HTTPS 与浏览器零秘密：敏感标记扫描。
 *
 * 演练方式（确定性，无网络/活库）：
 * - 以真实 loadConfig（src/config/config.loader.ts）做"空环境 + 外置单文件"核心冒烟；
 * - 对 Dockerfile / docker-compose.yml / .env.example / config.example.yaml 做
 *   部署编排事实断言（单镜像双入口、迁移一次性服务先行、只读挂载、镜像版本锚定）；
 * - 高危秘密模式扫描与占位符 fail-closed 实弹验证（loader 拒绝 CHANGE_ME）。
 *
 * 运行方式（glob：test/ops 目录下全部 spec 文件）：
 *   node --env-file=.env.test --test -r ts-node/register "test/ops" 下的 "*.spec.ts"
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ConfigLoadError, loadConfig } from '../../src/config';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string): boolean => existsSync(path.join(ROOT, rel));

const compose = read('docker-compose.yml');
const dockerfile = read('Dockerfile');

/** 空环境冒烟所需的最小配置集（开发期明文直填，非引用；ADR-010 §1.2 允许） */
const SMOKE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  DATABASE_PASSWORD: 'ops-smoke-db-secret',
  CASDOOR_CLIENT_SECRET: 'ops-smoke-cas-secret',
  CASDOOR_ENDPOINT: 'https://casdoor.example.edu',
  CASDOOR_CLIENT_ID: 'replace-me',
  CASDOOR_ORGANIZATION: 'replace-me',
  CASDOOR_REDIRECT_URI: 'http://localhost:3000/api/auth/callback',
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_ACCESS_KEY: 'ops-smoke-ak',
  STORAGE_SECRET_KEY: 'ops-smoke-sk',
};

describe('OPS-VER-001 空环境容器化单机部署演练', () => {
  it('发布物时间线：单镜像双入口，迁移一次性服务先于 app/worker 完成', () => {
    // 单镜像：app 与 worker 复用同一 image anchor（DOCK-003/030）
    assert.match(compose, /image:\s*"\$\{RANAMINDER_IMAGE:[^}]*\}"/, '镜像 tag 必须由变量注入');
    assert.match(compose, /command:\s*\["node",\s*"dist\/main\.worker\.js"\]/, 'worker 入口');
    assert.match(dockerfile, /CMD \["node", "dist\/main.js"\]/, 'HTTP 入口为默认 CMD');
    assert.ok(!compose.includes(':latest'), '禁止浮动 latest tag');

    // 时间线：公共运行参数声明依赖顺序——postgres 健康后迁移完成，app/worker 才启动
    const commonBlock = compose.slice(
      compose.indexOf('x-app-common'),
      compose.indexOf('services:'),
    );
    assert.match(commonBlock, /depends_on:\s*\n\s+postgres:\s*\n\s+condition:\s*service_healthy/);
    assert.match(commonBlock, /migrate:\s*\n\s+condition:\s*service_completed_successfully/);
    // app 与 worker 均引用同一公共块（单镜像同参数），迁移服务自身只依赖数据库且不重启
    assert.match(compose, /^ {2}app:\n[\s\S]*?<<: \*app-common/m);
    assert.match(compose, /^ {2}worker:\n[\s\S]*?<<: \*app-common/m);
    assert.match(compose, /^ {2}migrate:\n[\s\S]*?restart: "no"/m);
    assert.match(
      compose,
      /^ {2}migrate:\n[\s\S]*?depends_on:\s*\n\s+postgres:\s*\n\s+condition:\s*service_healthy/m,
    );

    // 同一迁移源：compose 的 dist/database/migrate.js 与 package.json scripts.migrate 单源
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    assert.match(pkg.scripts['migrate'], /database\/migrate\.ts$/, '本地与容器共用同一迁移入口');
  });

  it('运行单元就绪证据：PostgreSQL18 / Casdoor 3.108.0 版本精确锚定（非 latest）', () => {
    assert.match(compose, /image:\s*postgres:18\s*$/m);
    assert.match(compose, /image:\s*casbin\/casdoor:3\.108\.0\s*$/m);
    assert.match(compose, /MINIO_TAG:-RELEASE\.\d{4}-\d{2}-\d{2}T/, 'MinIO 锁定 release tag');
  });

  it('核心冒烟：空环境仅注入必需秘密即可产出完整运行配置（loadConfig 真实类）', () => {
    const cfg = loadConfig({ env: SMOKE_ENV });
    assert.equal(cfg.server.port, 3000);
    assert.equal(cfg.server.host, '0.0.0.0');
    assert.equal(cfg.job.defaultLeaseMs, 60000);
    assert.equal(cfg.database.passwordRef, 'ops-smoke-db-secret');
    // Casdoor 端点来自外置环境；未配置实例的场景由 RejectAllAuthSessionProvider 承接
    assert.equal(cfg.casdoor.endpoint, 'https://casdoor.example.edu');
    // 三个私有 Bucket 名称来自外置配置默认值（DATA-Q-012）
    assert.deepEqual(cfg.storage.buckets, {
      quarantine: 'ranaminder-quarantine',
      primary: 'ranaminder-primary',
      derived: 'ranaminder-derived',
    });
  });

  it('核心冒烟（负向）：缺必需秘密 → 启动阻断 ConfigLoadError（fail-closed）', () => {
    assert.throws(
      () => loadConfig({ env: { NODE_ENV: 'production' } }),
      (e: unknown) => e instanceof ConfigLoadError && /Missing required config/.test(e.message),
    );
  });

  it('演练结论：空环境部署链（发布物→时间线→运行单元→冒烟）全部通过', () => {
    const timeline = /service_completed_successfully/.test(compose);
    const runtime = /dist\/main\.js/.test(dockerfile) && /main\.worker\.js/.test(compose);
    const smoke = (() => {
      try {
        return loadConfig({ env: SMOKE_ENV }).server.port === 3000;
      } catch {
        return false;
      }
    })();
    const blockedWithoutSecrets = (() => {
      try {
        loadConfig({ env: {} });
        return false;
      } catch {
        return true;
      }
    })();
    assert.deepEqual(
      { timeline, runtime, smoke, blockedWithoutSecrets },
      { timeline: true, runtime: true, smoke: true, blockedWithoutSecrets: true },
    );
  });
});

describe('OPS-VER-004 外置单配置只读挂载与无学校硬编码演练', () => {
  it('只读挂载：根文件系统只读 + 配置以 :ro 挂载到 loader 默认路径', () => {
    assert.match(compose, /read_only:\s*true/, '应用根文件系统只读（DOCK-042）');
    assert.match(compose, /\.\/config\.yaml:\/etc\/ranaminder\/config\.yaml:ro/);
    assert.match(compose, /RANAMINDER_CONFIG_FILE:\s*\/etc\/ranaminder\/config\.yaml/);
    // tmpfs 仅开放 /tmp 临时写入，无其他持久化写路径
    assert.match(compose, /tmpfs:\s*\n\s+- \/tmp/);
  });

  it('写入拒绝（实弹）：加载仍为 CHANGE_ME 占位符的配置必须被拒绝启动', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ranaminder-ops-'));
    try {
      const file = path.join(dir, 'config.yaml');
      writeFileSync(
        file,
        ['server:', '  port: 8443', 'database:', '  passwordRef: CHANGE_ME'].join('\n'),
      );
      assert.throws(
        () => loadConfig({ env: SMOKE_ENV, configFilePath: file }),
        (e: unknown) =>
          e instanceof ConfigLoadError && /placeholder not replaced/i.test(e.message),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('外置单配置生效：临时 YAML 文件的值优先于内置默认值（单文件部署契约）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ranaminder-ops-'));
    try {
      const file = path.join(dir, 'config.external.yaml');
      writeFileSync(
        file,
        [
          'server:',
          '  port: 8443',
          'database:',
          '  passwordRef: external-db-secret',
          'casdoor:',
          '  clientSecretRef: external-cs',
          'storage:',
          '  accessKeyRef: external-ak',
          '  secretKeyRef: external-sk',
        ].join('\n'),
      );
      const cfg = loadConfig({ env: SMOKE_ENV, configFilePath: file });
      assert.equal(cfg.server.port, 8443);
      assert.equal(cfg.database.passwordRef, 'external-db-secret');
      // 外部配置不驻留可变全局态：两次加载返回相互独立的对象（改写不串扰）
      const mutated = loadConfig({ env: SMOKE_ENV, configFilePath: file });
      (mutated.server as { port: number }).port = 1;
      assert.equal(loadConfig({ env: SMOKE_ENV, configFilePath: file }).server.port, 8443);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('无学校硬编码：src 全量 URL 主机均为示例域/本地域（无真实院校端点）', () => {
    const offenders = scanSrcForRealHosts();
    assert.deepEqual(offenders, [], `发现疑似硬编码外部主机（须为示例/本地域）：\n${offenders.join('\n')}`);
  });

  it('示例配置零真实端点：.env.example 与 config.example.yaml 仅示例域/本地域', () => {
    for (const rel of ['.env.example', 'config.example.yaml']) {
      assert.ok(exists(rel), `${rel} 必须随仓库提供`);
      const text = read(rel);
      for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
        assert.ok(
          isExampleHost(m[1]),
          `${rel} 出现非示例主机 ${m[0]}（学校真实信息不得进入仓库）`,
        );
      }
    }
  });

  it('演练结论：只读挂载/占位符拒绝/无学校硬编码三证据齐备', () => {
    const readonlyMount = /read_only:\s*true/.test(compose) && /config\.yaml:ro/.test(compose);
    let placeholderRejected = false;
    const dir = mkdtempSync(path.join(tmpdir(), 'ranaminder-ops-'));
    try {
      const file = path.join(dir, 'c.yaml');
      writeFileSync(file, 'database:\n  passwordRef: CHANGE_ME\n');
      try {
        loadConfig({ env: {}, configFilePath: file });
      } catch (e) {
        placeholderRejected = e instanceof ConfigLoadError;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const noSchoolHardcode = scanSrcForRealHosts().length === 0;
    assert.deepEqual(
      { readonlyMount, placeholderRejected, noSchoolHardcode },
      { readonlyMount: true, placeholderRejected: true, noSchoolHardcode: true },
    );
  });
});

describe('OPS-VER-005 正式 HTTPS 与浏览器零秘密演练', () => {
  it('.env.example 秘密字段全部为 ${env:}/${file:} 引用或 replace-me 占位（零明文秘密）', () => {
    const lines = read('.env.example').split(/\r?\n/);
    const secretKeys = [
      'DATABASE_PASSWORD',
      'CASDOOR_CLIENT_SECRET',
      'CASDOOR_SESSION_SECRET',
      'STORAGE_ACCESS_KEY',
      'STORAGE_SECRET_KEY',
      'EMAIL_SECRET_CIPHER_KEY',
    ];
    for (const key of secretKeys) {
      const line = lines.find((l) => l.startsWith(`${key}=`));
      if (line === undefined) continue; // 可选项允许注释省略
      const value = line.slice(key.length + 1).trim();
      const ok =
        /^\$\{env:[A-Z_]+\}$/.test(value) ||
        /^\$\{file:[^}]+\}$/.test(value) ||
        /^replace-me$/.test(value) ||
        value === '';
      assert.ok(ok, `${key} 必须为引用/占位形式，实际：${value}`);
    }
  });

  it('高危秘密模式扫描：发布面（src/test/scripts/apps/Dockerfile/compose/示例配置）零命中', () => {
    const surfaces = ['src', 'test', 'scripts', 'apps', 'Dockerfile', 'docker-compose.yml'];
    const hits = scanSecretPatterns(surfaces);
    assert.deepEqual(hits, [], `发现疑似真实秘密：\n${hits.join('\n')}`);
  });

  it('浏览器构建面零秘密：apps/web 不含任何 env/密钥产物文件', () => {
    const webDir = path.join(ROOT, 'apps', 'web');
    assert.ok(existsSync(webDir), 'apps/web 应存在');
    const files = listFiles(webDir, '');
    const risky = files.filter((f) => /\.(js|mjs|cjs|env|env\..*)$/i.test(f));
    assert.deepEqual(risky, [], '前端目录不得携带脚本/env 产物（当前仅允许文档）');
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      assert.ok(!/SECRET|PASSWORD|PRIVATE[_ ]?KEY/i.test(text), `${f} 含秘密字样`);
    }
  });

  it('HTTPS 姿态证据：传输加密开关与反向代理约定存在（OPS-CFG-006）', () => {
    // 配置层提供 database.ssl 传输加密布尔开关，正式环境强制 TLS 的口径在示例中声明
    assert.match(read('config.example.yaml'), /ssl:\s*false\s+#.*TLS/s);
    // 编排层明确生产经反向代理对外（HTTPS 终结点由代理承担）
    assert.match(compose, /生产经反向代理对外/);
    assert.match(compose, /APP_HTTP_PORT:-3000/, '对外端口经宿主映射交给代理层');
  });

  it('演练结论：秘密引用纪律/高危模式清零/浏览器面清洁 全部成立', () => {
    const refsOnly = read('.env.example').includes('${env:CASDOOR_CLIENT_SECRET}');
    const zeroHits = scanSecretPatterns(['src', 'apps']).length === 0;
    const browserClean = !existsSync(path.join(ROOT, 'apps', 'web', '.env'));
    assert.deepEqual(
      { refsOnly, zeroHits, browserClean },
      { refsOnly: true, zeroHits: true, browserClean: true },
    );
  });
});

// ----- 共享辅助 -----

/** 示例/本地主机判定：localhost、127.x、无点单标签主机、example/invalid/local/test 域 */
function isExampleHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || /^127(\.\d+){3}$/.test(h)) return true;
  if (!h.includes('.')) return true; // minio / x / host 等容器内单标签名
  return /(^|\.)(example|invalid|local|test)(\.[a-z]{2,})?$/.test(h) || h.endsWith('.example');
}

/** 已知无害主机白名单（src 中出现的非示例两点域名） */
const EXTRA_ALLOWED_HOSTS = new Set([
  'x.com',
  // OOXML/W3C/RDF 标准命名空间常量（xmlns 字符串，非网络端点）：xlsx 导出所必需
  'schemas.openxmlformats.org',
  'www.w3.org',
  'purl.org',
]);

function scanSrcForRealHosts(): string[] {
  const offenders: string[] = [];
  for (const f of listFiles(path.join(ROOT, 'src'), '.ts')) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
      if (!isExampleHost(m[1]) && !EXTRA_ALLOWED_HOSTS.has(m[1].toLowerCase())) {
        offenders.push(`${path.relative(ROOT, f)} -> ${m[0]}`);
      }
    }
  }
  return offenders;
}

/** 高危秘密特征（私钥块/云密钥/token 前缀），命中即视为疑似真实秘密 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{30,}/,
  /xox[baprs]-[0-9A-Za-z-]{10,}/,
  /AIza[0-9A-Za-z_-]{35}/,
];

function scanSecretPatterns(surfaceRels: readonly string[]): string[] {
  const hits: string[] = [];
  for (const rel of surfaceRels) {
    const abs = path.join(ROOT, rel);
    if (!existsSync(abs)) continue;
    const scoped = statSync(abs).isDirectory() ? listFiles(abs, '') : [abs];
    for (const f of scoped) {
      const text = readFileSync(f, 'utf8');
      for (const p of SECRET_PATTERNS) {
        if (p.test(text)) hits.push(`${path.relative(ROOT, f)} 命中 ${p}`);
      }
    }
  }
  return hits;
}

function listFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (ext === '' || full.endsWith(ext)) out.push(full);
    }
  }
  return out.sort();
}

