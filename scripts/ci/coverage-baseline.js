#!/usr/bin/env node
/**
 * 覆盖率基线生成（P1-A 棘轮：coverage-baseline.json 自动升阈）。
 *
 * 用法：npm run test:cov:baseline
 * 职责：
 * 1. 运行全量覆盖率（npm run test:cov，输出 text/text-summary/json-summary）；
 * 2. 读取 coverage/coverage-summary.json 的 total 汇总；
 * 3. 写入 coverage-baseline.json（lines/branches/functions 百分比，1 位小数）。
 *
 * 语义：基线只升不降（棘轮，评审 P1-1）。若已存在旧基线，逐指标取
 * max(当前值, 旧基线)，绝不因单次运行噪声把历史峰值降阈；首次生成时
 * 以当前值为基线。coverage-gate.js 对照基线门禁；覆盖率提升时自动重写
 * 基线并要求随提交带上（未提交无害，门禁仍按旧基线放行）。
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SUMMARY = path.join(ROOT, 'coverage', 'coverage-summary.json');
const BASELINE = path.join(ROOT, 'coverage-baseline.json');

function fail(message) {
  console.error(`ERROR coverage-baseline: ${message}`);
  process.exit(1);
}

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = spawnSync(npmCmd, ['run', 'test:cov'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (run.status !== 0) {
  fail(`npm run test:cov 失败（exit=${run.status}）`);
}

if (!fs.existsSync(SUMMARY)) {
  fail(`未找到 ${SUMMARY}（确认 c8 已配置 json-summary reporter）`);
}

const total = JSON.parse(fs.readFileSync(SUMMARY, 'utf8')).total;
const round1 = (n) => Math.round(n * 10) / 10;
// 写入前校验：缺失/非有限数值（NaN）直接失败，不落脏基线（评审 warning 同口径）
for (const m of ['lines', 'branches', 'functions']) {
  const raw = total[m]?.pct;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    fail(`覆盖率数据缺失/非有限数值：${m}.pct=${String(raw)}（coverage-summary.json 结构异常）`);
  }
}
// 棘轮只升不降（评审 P1-1 棘轮降阈）：若已存在旧基线，逐指标取
// max(当前值, 旧基线)，绝不因单次运行噪声把历史峰值降阈。首次生成
// （无旧基线）时直接以当前值为基线。
let prev = null;
if (fs.existsSync(BASELINE)) {
  try {
    prev = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  } catch {
    fail(`已存在但无法解析 ${path.relative(ROOT, BASELINE)}，请先人工修复或删除后重跑`);
  }
}
const metric = (m) =>
  prev && typeof prev[m] === 'number' && Number.isFinite(prev[m])
    ? Math.max(round1(total[m].pct), prev[m])
    : round1(total[m].pct);
const baseline = {
  lines: metric('lines'),
  branches: metric('branches'),
  functions: metric('functions'),
  measuredAt: new Date().toISOString(),
};

fs.writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
console.log(
  `coverage-baseline 已写入 ${path.relative(ROOT, BASELINE)}: ` +
    `lines=${baseline.lines}% branches=${baseline.branches}% functions=${baseline.functions}%`,
);
