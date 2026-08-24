#!/usr/bin/env node
/**
 * 覆盖率门禁（P1-A 棘轮 + CI 阶段 4b）。
 *
 * 用法：
 *   npm run test:cov:gate                        # 完整：先跑覆盖率再对基线（本地便捷）
 *   node scripts/ci/coverage-gate.js --check-only # 复用已生成的 coverage/ 产物，
 *                                                # 不在 4b 重复执行单测（CI 阶段 4 已产出）
 *
 * 职责（对照 coverage-baseline.json，棘轮只升不降）：
 * 1. lines/branches/functions 任一低于「基线 - 容差(1.0pp)」→ 失败（exit 1）；
 *    容差吸收运行间覆盖率波动（函数指标最敏感），防 ±0.5pp 抖动误红；
 *    覆盖率数据缺失/非有限数值（NaN）仍 fail-closed，不静默放行（评审 warning）；
 * 2. 任一项高于「基线 + 容差」→ 自动重写基线（升阈）并提示随提交带上：
 *    - --check-only（CI 只读）：不写基线，仅提示本地跑完整模式更新并提交
 *      （避免 CI 脏工作区；升阈收敛到本地手动执行，评审 warning）；
 *    - 完整模式（本地）：直接重写 coverage-baseline.json；
 *    （未提交也无害：门禁按旧基线放行，覆盖仍不得跌破历史峰值过多）
 * 3. --check-only 且缺少 coverage/coverage-summary.json → 失败（fail-closed）。
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SUMMARY = path.join(ROOT, 'coverage', 'coverage-summary.json');
const BASELINE = path.join(ROOT, 'coverage-baseline.json');

const METRICS = ['lines', 'branches', 'functions'];
const checkOnly = process.argv.includes('--check-only');

/** 棘轮容差（百分点）：吸收运行间覆盖率波动（函数指标波动最明显，实测
 *  可差 ~1.4pp）。门禁仅在 current < baseline - TOLERANCE 时失败，仍是
 *  有意义的棘轮（覆盖不得跌破历史峰值过多），避免 CI 因 ±0.5pp 波动误红。 */
const RATCHET_TOLERANCE_PP = 1.0;

function fail(message) {
  console.error(`ERROR coverage-gate: ${message}`);
  process.exit(1);
}

if (!checkOnly) {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const run = spawnSync(npmCmd, ['run', 'test:cov'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (run.status !== 0) {
    fail(`npm run test:cov 失败（exit=${run.status}）`);
  }
}

if (!fs.existsSync(SUMMARY)) {
  fail(
    `未找到 ${path.relative(ROOT, SUMMARY)}。` +
      `--check-only 模式复用 CI 阶段 4 的产物；完整模式请先确认 c8 json-summary reporter 已配置。`,
  );
}
if (!fs.existsSync(BASELINE)) {
  fail(`未找到 ${path.relative(ROOT, BASELINE)}。请先运行 npm run test:cov:baseline 生成基线。`);
}

const total = JSON.parse(fs.readFileSync(SUMMARY, 'utf8')).total;
const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const round1 = (n) => Math.round(n * 10) / 10;

const current = {
  lines: round1(total.lines.pct),
  branches: round1(total.branches.pct),
  functions: round1(total.functions.pct),
};

// NaN fail-closed：pct 缺失/非数值（undefined→round1→NaN）时 NaN < base 恒为
// false，会静默放行覆盖率缺数据。逐指标强制有限数值（评审 warning）。
for (const m of METRICS) {
  const raw = total[m]?.pct;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    fail(`覆盖率数据缺失/非有限数值：${m}.pct=${String(raw)}（coverage-summary.json 结构异常）`);
  }
}

let failed = false;
for (const m of METRICS) {
  const cur = current[m];
  const base = baseline[m];
  if (typeof base !== 'number' || !Number.isFinite(base)) {
    fail(`基线缺少指标 ${m}（coverage-baseline.json 结构异常）`);
  }
  if (cur + 1e-9 < base - RATCHET_TOLERANCE_PP) {
    console.error(
      `  [FAIL] ${m}: ${cur}% < 基线 ${base}% - 容差 ${RATCHET_TOLERANCE_PP}pp（棘轮只升不降）`,
    );
    failed = true;
  }
}
if (failed) {
  fail('覆盖率回退低于基线（P1-A 门禁）');
}

const raised = METRICS.some((m) => current[m] > baseline[m] + RATCHET_TOLERANCE_PP);
if (raised) {
  const next = {
    lines: current.lines,
    branches: current.branches,
    functions: current.functions,
    measuredAt: new Date().toISOString(),
  };
  if (checkOnly) {
    // CI 只读校验：不写基线（CI 工作区无法提交，写入只会制造脏树），
    // 升阈收敛到本地 npm run test:cov:gate（完整模式）手动执行并随提交带上。
    console.warn(
      `[RATCHET] 覆盖率较基线提升（lines=${next.lines}% branches=${next.branches}% ` +
        `functions=${next.functions}%）。CI 只读模式不改写基线；` +
        `请在本地运行 npm run test:cov:gate 更新 coverage-baseline.json 并随提交带上（棘轮只升不降）。`,
    );
  } else {
    fs.writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    console.warn(
      `[RATCHET] 覆盖率较基线提升，已自动重写 coverage-baseline.json：` +
        `lines=${next.lines}% branches=${next.branches}% functions=${next.functions}%。` +
        `请将 coverage-baseline.json 纳入本次提交（棘轮只升不降）。`,
    );
  }
}

console.log(
  `coverage-gate: 通过（lines=${current.lines}% branches=${current.branches}% ` +
    `functions=${current.functions}%；基线 lines=${baseline.lines}% branches=${baseline.branches}% ` +
    `functions=${baseline.functions}%）`,
);
