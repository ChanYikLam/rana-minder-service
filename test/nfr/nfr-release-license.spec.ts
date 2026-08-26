/**
 * TST-NFR-020 ~ 023 / 035 ~ 039：开源发布合规面。
 *
 * - TST-NFR-020：主许可证为 MIT，无权威文档仍把 Apache-2.0 描述为项目默认许可证；
 * - TST-NFR-021：使用/再分发义务与"无明确专利授权"取舍已声明；
 * - TST-NFR-022：全部直接依赖在依赖与版本基线登记表中可追溯（名称/版本/许可证）；
 * - TST-NFR-023：不兼容内容发布阻断门（登记检查 + 秘密扫描）脚本真实存在；
 * - TST-NFR-035：示例/环境文件零真实秘密——占位符统一且加载器 fail-closed 拒绝占位值；
 * - TST-NFR-036：空环境部署文档存在且含安装步骤；
 * - TST-NFR-037：正式文档最低集合齐备；
 * - TST-NFR-038：发布元数据唯一版本号 + 迁移顺序确定、已完成步骤可识别；
 * - TST-NFR-039：品牌可配置、源码无学校硬编码。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, readRepo, baseSyntheticEnv } from './nfr-support';
import { loadConfig, ConfigLoadError } from '../../src/config/config.loader';

const exists = (rel: string): boolean => fs.existsSync(path.join(REPO_ROOT, rel));
const pkg = JSON.parse(readRepo('package.json')) as {
  license: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

// ---------------------------------------------------------------------------
// TST-NFR-020 / 021：主许可证与再分发义务
// ---------------------------------------------------------------------------

describe('TST-NFR-020 项目原创代码主许可证', () => {
  it('TST-NFR-020: package.json 声明 MIT 且权威文档确认 MIT 为项目唯一主许可证', () => {
    assert.equal(pkg.license, 'MIT');
    const requirementDoc = readRepo('docs/requirements/13-非功能运维与开源复用需求发现记录.md');
    assert.match(requirementDoc, /项目原创代码采用 MIT 许可证/);
    // 不存在仍把 Apache-2.0 描述为项目默认许可证的权威文档
    assert.match(requirementDoc, /不采用旧调研和实施蓝图建议的 Apache-2\.0/);
  });
});

describe('TST-NFR-021 使用权限、再分发义务与已知取舍', () => {
  it('TST-NFR-021: 再分发须保留版权声明；MIT 无专利授权的差异作为已知取舍记录', () => {
    const requirementDoc = readRepo('docs/requirements/13-非功能运维与开源复用需求发现记录.md');
    assert.match(requirementDoc, /再分发必须保留 MIT 版权和许可证声明/);
    // 已知取舍：MIT 没有 Apache-2.0 同等明确的专利授权条款
    assert.match(
      requirementDoc,
      /没有 Apache-2\.0 同等明确的专利授权条款.*已知取舍接受|MIT 没有 Apache-2\.0 同等明确的专利授权条款/,
    );
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-022 / 023：第三方清单与发布阻断门
// ---------------------------------------------------------------------------

describe('TST-NFR-022 第三方依赖清单可追溯', () => {
  it('TST-NFR-022: 每个直接依赖都在依赖与版本基线登记表中登记', () => {
    const registry = readRepo('docs/engineering/依赖与版本基线-v1.0.md');
    assert.match(registry, /DEP-003/);
    const directDeps = Object.keys({
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    });
    assert.ok(directDeps.length > 0);
    for (const dep of directDeps) {
      assert.ok(registry.includes(dep), `依赖 [${dep}] 未在依赖与版本基线中登记（DEP-003）`);
    }
  });
});

describe('TST-NFR-023 不兼容内容发布阻断', () => {
  it('TST-NFR-023: 许可证登记检查与秘密扫描两个发布阻断门真实存在且可执行', () => {
    assert.ok(exists('scripts/ci/check-license-registry.sh'), '缺少 DEP-003 登记检查门');
    assert.ok(exists('.gitleaks.toml'), '缺少秘密扫描配置');
    const gate = readRepo('scripts/ci/check-license-registry.sh');
    assert.match(gate, /exit 1/, '登记检查失败必须以非零退出阻断发布');
    // 第三方逐项核验规则在场：不兼容内容不得按 MIT 发布
    const requirementDoc = readRepo('docs/requirements/13-非功能运维与开源复用需求发现记录.md');
    assert.match(requirementDoc, /不能把不兼容内容直接按 MIT 发布/);
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-035：开源发布真实数据清零
// ---------------------------------------------------------------------------

describe('TST-NFR-035 发布面真实数据与秘密清零', () => {
  it('TST-NFR-035: 示例配置与环境样例不含真实秘密——占位符统一且被加载器拒绝', () => {
    const envExample = readRepo('.env.example');
    const configExample = readRepo('config.example.yaml');
    // 全部为虚构示例：引用形式或 CHANGE_ME 占位
    assert.match(configExample, /CHANGE_ME/);
    assert.match(envExample, /\$\{env:/);
    // 已知秘密模式扫描：私钥块/AWS AK/Sk 前缀等不得出现在示例面
    const scanned = `${envExample}\n${configExample}`;
    assert.doesNotMatch(scanned, /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/);
    assert.doesNotMatch(scanned, /AKIA[0-9A-Z]{16}/);
    assert.doesNotMatch(scanned, /\bsk-[A-Za-z0-9]{20,}\b/);
    // 加载到占位符值的启动路径被 fail-closed 拒绝
    assert.throws(
      () =>
        loadConfig({
          env: {
            ...baseSyntheticEnv(),
            DATABASE_PASSWORD: 'CHANGE_ME-not-replaced',
          },
        }),
      (err: unknown) =>
        err instanceof ConfigLoadError && /placeholder not replaced/.test(err.message),
    );
  });

  it('TST-NFR-035: gitleaks 允许清单只覆盖合成测试标记（非真实凭据）', () => {
    const gitleaks = readRepo('.gitleaks.toml');
    assert.match(gitleaks, /plain-secret-123/);
    assert.match(gitleaks, /fp1234567890/);
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-036 / 037 / 038：文档集合与发布元数据
// ---------------------------------------------------------------------------

/** 正式文档最低集合（九类 → 仓库权威文件映射；缺失即漂移） */
const REQUIRED_DOCS: ReadonlyArray<{ category: string; file: string }> = [
  { category: '安装/开发环境', file: 'docs/engineering/开发环境搭建指南-v1.0.md' },
  { category: 'Casdoor 配置', file: 'docs/specification/Casdoor集成契约-v1.0.md' },
  { category: '升级/备份恢复/部署运维', file: 'docs/operations/部署运维与恢复手册-v1.0.md' },
  { category: '接口说明', file: 'docs/specification/接口清单-HTTP端点-v1.0.md' },
  { category: '管理员使用', file: 'docs/specification/SRS-v1.0.md' },
  { category: '普通用户使用', file: 'docs/specification/SRS-v1.0.md' },
  { category: '安全报告方式', file: 'docs/specification/安全设计与实现级威胁模型-v1.0.md' },
  { category: '工程约定/贡献', file: 'docs/engineering/后端工程约定-v1.0.md' },
  { category: '测试实施', file: 'docs/engineering/测试实施指南-v1.0.md' },
];

describe('TST-NFR-036 空环境文档部署', () => {
  it('TST-NFR-036: 部署手册包含从空环境安装的可执行步骤与容器化入口', () => {
    const manual = readRepo('docs/operations/部署运维与恢复手册-v1.0.md');
    assert.ok(manual.length > 5000, '部署运维手册内容过薄，不足以支撑空环境部署');
    assert.ok(exists('docker-compose.yml'), '缺少容器化单机编排文件');
    assert.ok(exists('Dockerfile'), '缺少镜像构建文件');
    assert.ok(exists('README.md'));
  });
});

describe('TST-NFR-037 正式文档最低集合', () => {
  it('TST-NFR-037: 九类文档均有对应仓库文件且内容非占位', () => {
    assert.equal(REQUIRED_DOCS.length, 9);
    for (const doc of REQUIRED_DOCS) {
      assert.ok(exists(doc.file), `缺少${doc.category}文档：${doc.file}`);
      const content = readRepo(doc.file);
      assert.ok(content.length > 1000, `${doc.file} 内容过薄（占位页不计为存在）`);
    }
  });
});

describe('TST-NFR-038 发布元数据与升级路径', () => {
  it('TST-NFR-038: 版本号唯一且符合语义化版本；升级/回滚规则冻结在运维手册', () => {
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/, '发布版本必须为 X.Y.Z 语义化版本');
    const manual = opsManualText();
    assert.match(manual, /OPS-UPG-001/);
    assert.match(manual, /每个正式版本必须声明支持的来源版本/);
    assert.match(manual, /OPS-UPG-005/);
    assert.match(manual, /不可安全回滚/);
  });

  it('TST-NFR-038: 数据库迁移顺序确定且已完成步骤可重复识别（schema_migrations 登记）', () => {
    const dir = path.join(REPO_ROOT, 'src/database/migrations');
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .sort();
    assert.ok(files.length >= 10, '迁移文件数量异常');
    // 文件名即版本：YYYYMMDDHHMMSS_ 描述，严格升序唯一（幂等重跑安全的顺序基础）
    const pattern = /^\d{14}_[a-z0-9-]+\.ts$/;
    let previous = '';
    for (const file of files) {
      assert.match(file, pattern, `迁移文件命名不符合版本契约: ${file}`);
      const version = file.slice(0, 14);
      assert.ok(version > previous, `迁移版本必须严格递增: ${previous} -> ${version}`);
      previous = version;
    }
    const migrateSource = readRepo('src/database/migrate.ts');
    assert.match(migrateSource, /schema_migrations/);
    assert.match(migrateSource, /ON CONFLICT \(version\) DO NOTHING/);
  });
});

function opsManualText(): string {
  return readRepo('docs/operations/部署运维与恢复手册-v1.0.md');
}

// ---------------------------------------------------------------------------
// TST-NFR-039：品牌配置与发布审计门
// ---------------------------------------------------------------------------

describe('TST-NFR-039 品牌配置与无学校硬编码', () => {
  it('TST-NFR-039: 展示可见性由存储档案驱动而非代码常量；源码无虚构学校名硬编码', async () => {
    // 品牌/展示字段属于数据模型（社团档案），不在代码内写死学校名称
    const { ClubProfile } = await import('../../src/modules/config/domain/models/club-profile');
    assert.equal(typeof ClubProfile, 'function');
    // 扫描 src 源码：不得出现具体学校名称硬编码（示例域名 example.edu 属于允许占位）
    const srcDir = path.join(REPO_ROOT, 'src');
    const offenders: string[] = [];
    const schoolNamePattern = /(某某大学|示例大学|Test University|Fake University)/;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
          if (schoolNamePattern.test(fs.readFileSync(full, 'utf8'))) {
            offenders.push(path.relative(REPO_ROOT, full));
          }
        }
      }
    };
    walk(srcDir);
    assert.deepEqual(offenders, [], `发现学校名称硬编码: ${offenders.join(', ')}`);
  });
});
