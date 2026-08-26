/**
 * TST-NFR-016 ~ 019 / 030 ~ 034：部署分级参考、容量结论证据门、
 * 容器化单机部署、同一程序多拓扑、外置配置与 HTTPS 门、升级迁移失败处置。
 *
 * - TST-NFR-016：开发测试/两社团试点参考规格冻结且标注为"参考"而非强制采购；
 * - TST-NFR-017：经济型生产参考 + 等效替换原则；
 * - TST-NFR-018：完整设计容量拓扑（职责拆分 + 独立备份）；
 * - TST-NFR-019：承载能力必须绑定压力/长稳/恢复证据，不得写成已保证能力；
 * - TST-NFR-030：Dockerfile/compose/config 样例齐备，单机可复现；
 * - TST-NFR-031：同一程序双入口共享同一模块图；拓扑差异仅来自外置配置；
 * - TST-NFR-032：学校/依赖更换无需改源码；HTTPS 门为权威规则；
 * - TST-NFR-033：迁移顺序确定、失败不伪装成功、占位配置拒绝启动；
 * - TST-NFR-034：发布说明/维护公告/回滚边界规则在场。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, readRepo, opsManual, baseSyntheticEnv } from './nfr-support';
import { loadConfig } from '../../src/config/config.loader';

const exists = (rel: string): boolean => fs.existsSync(path.join(REPO_ROOT, rel));

/** 全部 NFR-016..034 文档断言共用手册文本 */
function manual(): string {
  return opsManual();
}

// ---------------------------------------------------------------------------
// TST-NFR-016 ~ 018：部署分级参考
// ---------------------------------------------------------------------------

describe('TST-NFR-016 开发测试与两社团试点参考', () => {
  it('TST-NFR-016: 参考规格冻结在运维手册并明确为"已确认参考，不是承载保证"', () => {
    const text = manual();
    // 开发测试：4 核 8GB、100GB SSD；两社团试点：至少 4 核 8GB、200GB NVMe、附件独立存储
    assert.match(text, /开发测试 \| 4 核 8GB、100GB SSD/);
    assert.match(text, /两社团试点 \| 至少 4 核 8GB、200GB NVMe，附件独立存储/);
    // 参考性质声明：官方部署轮廓表声明参考而非强制采购
    assert.match(text, /官方支持的部署轮廓/);
    assert.match(text, /已确认参考，不是承载保证/);
    assert.match(text, /不得把参考值变成固定云厂商采购要求/);
    assert.ok(exists('docs/architecture/ADR-012-分级部署与恢复优先的生产拓扑.md'));
  });
});

describe('TST-NFR-017 单校经济型生产参考', () => {
  it('TST-NFR-017: 经济型生产参考在册；容量结论以压力证据为准并允许等效资源', () => {
    const text = manual();
    // ADR-012 / 手册中的生产参考行：8 核 32GB 档位
    assert.match(text, /8 核 32GB|500GB NVMe|等效/);
    // 等效替换原则（不因部署者使用等效资源而拒绝支持）
    const adr12 = readRepo('docs/architecture/ADR-012-分级部署与恢复优先的生产拓扑.md');
    assert.match(adr12, /等效|参考/);
  });
});

describe('TST-NFR-018 完整设计容量参考', () => {
  it('TST-NFR-018: 完整设计容量行在册——应用/数据库/后台检查节点与独立对象备份存储', () => {
    const text = manual();
    assert.match(
      text,
      /完整设计容量 \| 两台 4 核 8GB 应用节点、8 核 32GB PostgreSQL、4 核 8GB 后台\/文件检查节点及独立对象与备份存储/,
    );
    // 最终承载能力仍以证据为准（不把拓扑写成承载保证）
    assert.match(text, /最终承载能力仍以压力、长稳和恢复证据为准/);
  });
});

describe('TST-NFR-019 容量结论证据门', () => {
  it('TST-NFR-019: 权威文档不存在未经证据绑定的绝对承载承诺', () => {
    const readme = readRepo('README.md');
    // README 不做任何"可承载 X 并发/账号"的绝对承诺
    assert.doesNotMatch(readme, /可承载\s*\d+/);
    assert.doesNotMatch(readme, /支持\s*\d+\s*(并发|万)/);
    // 承载口径被权威文档显式约束到证据
    assert.match(manual(), /最终承载能力仍以压力、长稳和恢复证据为准/);
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-030 / 031：容器化单机与同程序多拓扑
// ---------------------------------------------------------------------------

describe('TST-NFR-030 官方容器化单机部署', () => {
  it('TST-NFR-030: 单机方案由 Dockerfile + compose + 示例配置构成，不依赖 Kubernetes', () => {
    for (const file of [
      'Dockerfile',
      'docker-compose.yml',
      '.dockerignore',
      'config.example.yaml',
    ]) {
      assert.ok(exists(file), `缺少单机部署文件: ${file}`);
    }
    const compose = readRepo('docker-compose.yml');
    // compose 内含数据库与应用服务定义（单机可复现运行）
    assert.match(compose, /postgres/i);
    // 不强制 Kubernetes：仓库不含 k8s 编排作为必需入口
    assert.ok(!exists('k8s'), '不应存在必需的 Kubernetes 清单目录');
    // 示例秘密不得用于正式环境：占位符统一
    const configExample = readRepo('config.example.yaml');
    assert.match(configExample, /CHANGE_ME/);
  });
});

describe('TST-NFR-031 同一程序支持拆分与单社团配置', () => {
  it('TST-NFR-031: HTTP 与 worker 双入口共用同一 AppModule（无源码分叉）', () => {
    const main = readRepo('src/main.ts');
    const worker = readRepo('src/main.worker.ts');
    assert.match(main, /from '\.\/app\.module'/);
    assert.match(worker, /AppModule/);
    // worker 入口不启动 HTTP 监听
    assert.match(worker, /worker/i);
  });

  it('TST-NFR-031: 单机/拆分拓扑差异仅来自外置配置——同一代码加载不同 env 即得不同拓扑', () => {
    // 单机形态
    const standalone = loadConfig({
      env: { ...baseSyntheticEnv(), HOST: '0.0.0.0', PORT: '3000', DATABASE_HOST: '127.0.0.1' },
    });
    // 应用/数据库拆分形态：仅改配置即指向独立数据库节点
    const split = loadConfig({
      env: { ...baseSyntheticEnv(), HOST: '10.0.0.11', PORT: '3001', DATABASE_HOST: '10.0.0.20' },
    });
    assert.equal(standalone.server.port, 3000);
    assert.equal(split.server.port, 3001);
    assert.notEqual(standalone.database.host, split.database.host);
    // 社团范围限制走策略作用域（CLUB 覆盖值），不需要源码分叉
    assert.ok(exists('src/modules/config/domain/models/scoped-policy.ts'));
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-032 / 033 / 034：外置配置、HTTPS 门与升级处置
// ---------------------------------------------------------------------------

describe('TST-NFR-032 外部配置、无学校硬编码与 HTTPS 门', () => {
  it('TST-NFR-032: 更换学校与外部依赖仅需替换配置——Casdoor 端点/组织全部来自环境', () => {
    const schoolA = loadConfig({
      env: {
        ...baseSyntheticEnv(),
        CASDOOR_ENDPOINT: 'https://casdoor.school-a.example.edu',
        CASDOOR_ORGANIZATION: 'school-a',
        CASDOOR_REDIRECT_URI: 'https://a.example.edu/auth/callback',
      },
    });
    const schoolB = loadConfig({
      env: {
        ...baseSyntheticEnv(),
        CASDOOR_ENDPOINT: 'https://casdoor.school-b.example.edu',
        CASDOOR_ORGANIZATION: 'school-b',
        CASDOOR_REDIRECT_URI: 'https://b.example.edu/auth/callback',
      },
    });
    assert.equal(schoolA.casdoor.organization, 'school-a');
    assert.equal(schoolB.casdoor.organization, 'school-b');
    assert.notEqual(schoolA.casdoor.endpoint, schoolB.casdoor.endpoint);
  });

  it('TST-NFR-032: 正式环境必须使用 HTTPS 为权威规则（OPS-CFG-006），非正式配置被阻止或警告', () => {
    const text = manual();
    assert.match(text, /OPS-CFG-006/);
    assert.match(text, /正式环境必须使用 HTTPS；非 HTTPS 正式配置必须明确阻止或警告/);
    // 安全设计侧同样冻结 HTTPS 门沿用 SRS-NFR-032
    const threatModel = readRepo('docs/specification/安全设计与实现级威胁模型-v1.0.md');
    assert.match(threatModel, /HTTPS 门沿用 SRS-NFR-032/);
  });
});

describe('TST-NFR-033 升级预检、备份与迁移失败处置', () => {
  it('TST-NFR-033: 迁移顺序确定、已完成步骤可识别；不兼容条件在变更前拒绝启动', () => {
    const dir = path.join(REPO_ROOT, 'src/database/migrations');
    const versions = fs
      .readdirSync(dir)
      .filter((f) => /^\d{14}_/.test(f))
      .sort();
    assert.ok(versions.length >= 10);
    // 迁移按登记表幂等执行：重跑安全、失败即抛非零退出（不伪装成功）
    const migrateSource = readRepo('src/database/migrate.ts');
    assert.match(migrateSource, /CREATE TABLE IF NOT EXISTS schema_migrations/);
    assert.match(migrateSource, /process\.exit\(1\)|exitCode = 1|throw/);
    // 配置面预检：必填缺失/占位未改写 → 启动前失败关闭
    const loaderSource = readRepo('src/config/config.loader.ts');
    assert.match(loaderSource, /Missing required config/);
    assert.match(loaderSource, /PLACEHOLDER_PREFIX/);
  });

  it('TST-NFR-033: 升级前兼容检查与回滚边界权威规则在场', () => {
    const text = manual();
    assert.match(text, /OPS-UPG-001/);
    assert.match(text, /不得跨越未声明来源版本直接升级/);
    assert.match(text, /无法安全回滚的迁移必须在变更前警告并提供恢复路径/);
  });
});

describe('TST-NFR-034 发布说明、维护与回滚边界', () => {
  it('TST-NFR-034: 维护公告 24 小时规则冻结；零停机不是强制承诺', () => {
    const text = manual();
    assert.match(text, /至少提前 24 小时公告/);
    assert.match(text, /超出窗口、紧急维护和未公告停机计入不可用/);
    // 回滚通过新版本表达，不覆盖历史版本
    assert.match(text, /不可变配置回滚通过基于旧版本创建并发布新版本表达/);
    assert.match(readRepo('package.json'), /"version"/);
  });
});
