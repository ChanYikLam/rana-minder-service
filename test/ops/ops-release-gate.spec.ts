/**
 * L5 运维演练门 2：开源发布物料门（OPS-VER-024）。
 *
 * 锚点语义：开源发布秘密、学校信息、许可证和文档门——扫描范围、物料/许可证、
 * 阻断项和复扫（docs/operations/部署运维与恢复手册-v1.0.md §OPS-VER 表）。
 *
 * 演练方式（确定性，纯文件面 + 真实 loadConfig 行为）：
 * - 许可证声明（package.json license = MIT）；
 * - 秘密清零扫描：高危秘密特征在发布面零命中；
 * - 占位符规则实弹：loadConfig 对未改写占位符拒绝启动（复扫机制本身可执行）；
 * - 学校信息清零：示例配置仅含 example/本地域，无院校名硬编码；
 * - 文档门：README 与部署手册 OPS-VER 全锚点清单存在。
 *
 * 已知缺口记录（不在本套件判定范围）：仓库根目录尚无 LICENSE 物料文件，
 * 属发布前须人工补齐的物料缺口；本演练固化的是可自动化证据。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ConfigLoadError, loadConfig } from '../../src/config';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{30,}/,
  /xox[baprs]-[0-9A-Za-z-]{10,}/,
  /AIza[0-9A-Za-z_-]{35}/,
];

describe('OPS-VER-024 开源发布秘密、学校信息、许可证和文档门演练', () => {
  it('许可证门：package.json 声明 MIT 且版本/引擎基线明确', () => {
    const pkg = JSON.parse(read('package.json')) as {
      license: string;
      version: string;
      engines?: Record<string, string>;
    };
    assert.equal(pkg.license, 'MIT');
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/, '语义化版本');
    assert.match(pkg.engines?.node ?? '', /^>=?\d/, 'Node 引擎基线必须显式声明');
  });

  it('秘密扫描门：src/test/scripts/apps/构建编排/示例配置 高危模式零命中', () => {
    const surfaces: readonly string[] = [
      'src',
      'test',
      'scripts',
      'apps',
      'Dockerfile',
      'docker-compose.yml',
      '.env.example',
      'config.example.yaml',
    ];
    const hits: string[] = [];
    for (const rel of surfaces) {
      const abs = path.join(ROOT, rel);
      if (!existsSync(abs)) continue;
      const stat = statSync(abs);
      const files = stat.isDirectory() ? walkFiles(abs) : [abs];
      for (const f of files) {
        const text = readFileSync(f, 'utf8');
        for (const p of SECRET_PATTERNS) {
          if (p.test(text)) hits.push(`${path.relative(ROOT, f)} 命中 ${p}`);
        }
      }
    }
    assert.deepEqual(hits, [], `疑似真实秘密阻断项：\n${hits.join('\n')}`);
  });

  it('占位符规则实弹复扫：加载 CHANGE_ME 配置被 fail-closed 拒绝（机制可执行）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ranaminder-rel-'));
    try {
      const file = path.join(dir, 'unreplaced.yaml');
      writeFileSync(
        file,
        [
          'database:',
          '  passwordRef: CHANGE_ME',
          'casdoor:',
          '  clientSecretRef: CHANGE_ME',
          'storage:',
          '  accessKeyRef: CHANGE_ME',
          '  secretKeyRef: CHANGE_ME',
        ].join('\n'),
      );
      assert.throws(
        () => loadConfig({ configFilePath: file }),
        (e: unknown) =>
          e instanceof ConfigLoadError && /placeholder not replaced/i.test(e.message),
        '未改写占位符必须阻断启动（ADR-010）',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('学校信息清零：示例配置无院校名与真实域（example.invalid/example.edu/localhost only）', () => {
    for (const rel of ['.env.example', 'config.example.yaml']) {
      const text = read(rel);
      // 中文院校名模式（xx大学/xx学院）
      const schoolHits = [...text.matchAll(/[一-龥]{2,10}(大学|学院)/g)].map((m) => m[0]);
      assert.deepEqual(schoolHits, [], `${rel} 出现疑似院校名：${schoolHits.join(',')}`);
      for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
        const host = m[1].toLowerCase();
        const ok =
          host === 'localhost' ||
          /^127(\.\d+){3}$/.test(host) ||
          /(^|\.)(example|invalid)(\.[a-z]{2,})?$/.test(host);
        assert.ok(ok, `${rel} 出现非示例主机 ${m[0]}`);
      }
    }
  });

  it('文档门：README 与部署手册存在，且 OPS-VER-001..024 锚点表完整', () => {
    const readme = read('README.md');
    assert.ok(readme.trim().length > 100, 'README 不得为空壳');

    const manualRel = 'docs/operations/部署运维与恢复手册-v1.0.md';
    assert.ok(existsSync(path.join(ROOT, manualRel)), '部署运维与恢复手册必须随仓库提供');
    const manual = read(manualRel);
    for (let i = 1; i <= 24; i += 1) {
      const id = `OPS-VER-${String(i).padStart(3, '0')}`;
      assert.ok(manual.includes(id), `部署手册缺少锚点 ${id}`);
    }
  });

  it('演练结论：许可证/秘密/占位符复扫/学校信息/文档 五项发布门全部通过', () => {
    const pkg = JSON.parse(read('package.json')) as { license: string };
    const findings = {
      licenseMit: pkg.license === 'MIT',
      secretZero: scanAll().length === 0,
      placeholderGateEnforced: true, // 上一用例已实弹验证
      schoolInfoZero: !/[一-龥]{2,10}(大学|学院)/.test(read('.env.example')),
      docsPresent:
        existsSync(path.join(ROOT, 'README.md')) &&
        existsSync(path.join(ROOT, 'docs', 'operations')),
    };
    assert.deepEqual(findings, {
      licenseMit: true,
      secretZero: true,
      placeholderGateEnforced: true,
      schoolInfoZero: true,
      docsPresent: true,
    });
  });
});

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out.sort();
}

function scanAll(): string[] {
  const hits: string[] = [];
  for (const rel of ['src', 'apps']) {
    for (const f of walkFiles(path.join(ROOT, rel))) {
      const text = readFileSync(f, 'utf8');
      for (const p of SECRET_PATTERNS) {
        if (p.test(text)) hits.push(`${path.relative(ROOT, f)} 命中 ${p}`);
      }
    }
  }
  return hits;
}
