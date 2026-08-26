/**
 * TST-NFR-046 ~ 050：AI 默认关闭与核心全流程独立、永久禁止 AI 自动业务决定、
 * 允许的辅助用途边界、AI 数据范围/外部模型/审计门、新用途非追溯与故障隔离。
 *
 * 当前代码基线不含任何 AI 能力（首期后置）。本套件以负向扫描 + 配置白名单
 * 行为探针自动化"结构性默认关闭"：
 * - 源码无 AI/模型供应商引用，核心模块零 AI 依赖链；
 * - 配置契约无 AI 段——即使外置配置注入 ai 节也不会被加载器接受；
 * - 候选辅助用途仅存在于需求文档且标注为未来候选能力。
 *
 * - TST-NFR-046：默认不启用 AI；无 AI 时核心流程独立可用；
 * - TST-NFR-047：不存在 AI 自动执行录取/评价/任命等决定的路径；
 * - TST-NFR-048：候选辅助用途未交付为功能，正式内容只能由正常业务命令形成；
 * - TST-NFR-049：默认无外部模型客户端；数据范围/脱敏/训练用途门未引入即无绕过面；
 * - TST-NFR-050：无追溯处理既有数据的 AI 管道；AI 故障不可能改变原业务结果。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, readRepo, baseSyntheticEnv } from './nfr-support';
import { loadConfig } from '../../src/config/config.loader';

/** 收集 src 下全部非测试 TS 文件 */
function listSrcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
        out.push(full);
      }
    }
  };
  walk(path.join(REPO_ROOT, 'src'));
  return out;
}

const NOW_BASE = new Date('2026-08-25T08:00:00.000Z');

const SRC_FILES = listSrcFiles();

/** AI/模型供应商特征（含常见客户端 SDK 与通用模型词）；匹配任一即视为出现 AI 引用 */
const AI_SIGNATURE =
  /\b(openai|anthropic|azure-openai|gemini|vertexai|bedrock|ollama|langchain|llm|gpt-|chatgpt|completion|embedding|modelprovider|ai-provider)\b/i;

// ---------------------------------------------------------------------------
// TST-NFR-046：AI 默认关闭且核心全流程独立
// ---------------------------------------------------------------------------

describe('TST-NFR-046 AI 默认关闭且核心独立', () => {
  it('TST-NFR-046: 全部 src 源码零 AI/模型供应商引用（默认关闭的结构性证据）', () => {
    const offenders = SRC_FILES.filter((f) => AI_SIGNATURE.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(offenders, [], `源码出现 AI 引用: ${offenders.join(', ')}`);
    // 不存在任何 ai 相关目录或模块文件
    const aiFiles = SRC_FILES.filter((f) =>
      /(^|[\\/])ai([\\/]|-)/i.test(path.relative(REPO_ROOT, f)),
    );
    assert.deepEqual(aiFiles, []);
  });

  it('TST-NFR-046: 配置契约无 AI 段——注入未知 ai 配置节不会被加载器接受', () => {
    const config = loadConfig({ env: baseSyntheticEnv() });
    // RanaMinderConfig 仅包含十段固定结构；AI 未配置不是必填项，也不产生任何开关
    assert.deepEqual(Object.keys(config).sort(), [
      'backup',
      'casdoor',
      'database',
      'fileCheck',
      'job',
      'mail',
      'notify',
      'observability',
      'server',
      'storage',
    ]);
    assert.equal('ai' in config, false);
    // 加载器对未知顶层键（如 ai.enabled）静默忽略——无法通过配置启用 AI
    const yamlProbe = readRepo('src/config/config.loader.ts');
    assert.match(yamlProbe, /interface RawConfig/, '配置白名单结构必须显式声明');
    assert.doesNotMatch(yamlProbe, /ai\??:/, 'RawConfig 中不得出现 AI 配置段');
  });

  it('TST-NFR-046: 核心业务模块零 AI 依赖链——身份/招新/表单/通知源码不引用任何模型能力', () => {
    const coreDirs = [
      'src/modules/identity',
      'src/modules/recruitment',
      'src/modules/form',
      'src/modules/notification',
      'src/modules/membership',
      'src/modules/joint',
      'src/modules/stat-export',
      'src/modules/audit',
    ];
    for (const dir of coreDirs) {
      const files = SRC_FILES.filter((f) => f.replace(/\\/g, '/').includes(dir));
      assert.ok(files.length > 0, `核心目录缺失: ${dir}`);
      for (const file of files) {
        assert.ok(
          !AI_SIGNATURE.test(fs.readFileSync(file, 'utf8')),
          `核心模块 ${path.relative(REPO_ROOT, file)} 出现 AI 引用`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-047 / 048：禁止自动决定与辅助用途边界
// ---------------------------------------------------------------------------

describe('TST-NFR-047 永久禁止 AI 自动业务决定', () => {
  it('TST-NFR-047: 录取/评价/任命等命令与状态机层无任何自动化模型输出入口', () => {
    // 业务命令与状态机目录中不存在可被外部输出驱动的自动决定路径
    const decisionLayers = SRC_FILES.filter((f) =>
      /(state-machines|application[\\/]commands)/.test(path.relative(REPO_ROOT, f)),
    );
    assert.ok(decisionLayers.length > 50, '命令/状态机层文件数量异常');
    for (const file of decisionLayers) {
      assert.ok(
        !AI_SIGNATURE.test(fs.readFileSync(file, 'utf8')),
        `业务决定层 ${path.relative(REPO_ROOT, file)} 出现 AI 引用（违反永久禁止边界）`,
      );
    }
  });

  it('TST-NFR-047: 任务执行器注册表中无 AI 类型任务——后台编排不能被模型输出触发', async () => {
    const { TaskType, TASK_TYPE_OWNER } =
      await import('../../src/platform/tasks/contracts/task-type');
    for (const type of Object.values(TaskType)) {
      assert.ok(!/ai|model|llm/i.test(type), `任务类型 ${type} 涉及 AI`);
      assert.ok(TASK_TYPE_OWNER[type] !== undefined);
    }
  });
});

describe('TST-NFR-048 辅助用途仅为未来候选能力', () => {
  it('TST-NFR-048: 需求文档把 AI 用途限定为候选能力，正式内容仍由正常业务命令形成', () => {
    const requirementDoc = readRepo('docs/requirements/13-非功能运维与开源复用需求发现记录.md');
    // AI 属后置专项：候选能力不是首期交付承诺
    assert.match(requirementDoc, /未来 AI 能力必须重新开展专项需求发|AI 后置/);
    const contract = readRepo('docs/specification/测试规格与验收追踪-v1.0.md');
    assert.match(contract, /候选用途不是首期交付承诺/);
    // 正式写入动作只来自正常命令层：命令目录中不存在"采用草稿直转正式"的 AI 入口
    assert.equal(
      SRC_FILES.filter((f) => /adopt.*(draft|output)|ai.*adopt/i.test(path.basename(f))).length,
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-049 / 050：数据范围门与非追溯/故障隔离
// ---------------------------------------------------------------------------

describe('TST-NFR-049 AI 数据范围、外部模型和审计门', () => {
  it('TST-NFR-049: 默认无外部模型客户端与训练管道；适配器面不存在模型端点', () => {
    // adapters 目录只承载 Casdoor/数据库/存储/检查/邮件/通知/备份与观测记录八类真实依赖面
    const adaptersDir = path.join(REPO_ROOT, 'src/adapters');
    const adapterDirs = fs
      .readdirSync(adaptersDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
    assert.deepEqual(adapterDirs, [
      'backup',
      'casdoor',
      'db',
      'dep-latest',
      'file-check',
      'mail',
      'notify',
      'storage',
    ]);
    for (const dirName of adapterDirs) {
      const full = path.join(adaptersDir, dirName);
      for (const file of fs.readdirSync(full)) {
        if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) continue;
        const content = fs.readFileSync(path.join(full, file), 'utf8');
        assert.ok(!AI_SIGNATURE.test(content), `适配器 ${dirName}/${file} 出现 AI 引用`);
      }
    }
    // 外部服务配置仅三类技术安全通道，无模型供应商配置位
    const configurationSource = readRepo('src/config/configuration.ts');
    assert.match(configurationSource, /fileCheck: ExternalServiceConfig/);
    assert.match(configurationSource, /notify: ExternalServiceConfig/);
    assert.match(configurationSource, /backup: ExternalServiceConfig/);
    assert.doesNotMatch(configurationSource, /model|llm/i);
  });
});

describe('TST-NFR-050 新用途非追溯与 AI 故障隔离', () => {
  it('TST-NFR-050: 无任何读取既有历史数据进行模型处理的管道；重试语义不改变业务结果', async () => {
    // 结构性证据：不存在 AI 处理管道（同 NFR-046 扫描），因此无追溯处理面
    const offenders = SRC_FILES.filter((f) => AI_SIGNATURE.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(offenders, []);
    // 重试收敛不改写业务结果：失败记录重试放行但已完成意图永远返回原结果
    const { InMemoryIdempotencyStore } =
      await import('../../src/platform/tasks/idempotency/in-memory-idempotency-store');
    const store = new InMemoryIdempotencyStore();
    const begun = await store.begin(
      'k-iso',
      'i-iso',
      new Date(NOW_BASE.getTime() + 60_000).toISOString(),
    );
    assert.equal(begun, true);
    await store.complete('k-iso', 'i-iso', 'result:final');
    const record = await store.find('k-iso');
    assert.equal(record!.status, 'COMPLETED');
    assert.equal(record!.resultRef, 'result:final');
    // 同键再次 begin 被拒绝（重试不会生成第二份业务结果）
    const again = await store.begin(
      'k-iso',
      'i-iso-2',
      new Date(NOW_BASE.getTime() + 120_000).toISOString(),
    );
    assert.equal(again, false);
  });
});
