/**
 * TST-NFR-001~054 共享支撑工具（锚点解析、权威文档读取、确定性时钟/统计）。
 *
 * 权威来源：
 * - docs/specification/SRS-故障恢复安全通知与质量约束-v1.0.md（SRS-NFR-001~054 定义行）
 * - docs/specification/测试规格与验收追踪-v1.0.md（TST-NFR-001~054 验收合同行）
 * - docs/operations/部署运维与恢复手册-v1.0.md（OPS-BKP/OPS-UPG 等运维预算）
 *
 * 解析失败或格式漂移时抛错显式失败，不静默通过（对齐 test/helpers/authority-docs.ts）。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 仓库根目录（本文件位于 test/nfr/ 下） */
export const REPO_ROOT = path.resolve(__dirname, '../..');

/** 读取仓库内文件；缺失时抛错 */
export function readRepo(relPath: string): string {
  const full = path.join(REPO_ROOT, relPath);
  if (!fs.existsSync(full)) {
    throw new Error(`仓库文件缺失：${relPath}`);
  }
  return fs.readFileSync(full, 'utf8');
}

/** 仓库内文件是否存在 */
export function repoExists(relPath: string): boolean {
  return fs.existsSync(path.join(REPO_ROOT, relPath));
}

const SRS_NFR_DOC = 'docs/specification/SRS-故障恢复安全通知与质量约束-v1.0.md';
const TST_SPEC_DOC = 'docs/specification/测试规格与验收追踪-v1.0.md';
const OPS_MANUAL_DOC = 'docs/operations/部署运维与恢复手册-v1.0.md';

function buildRowMap(file: string, idPattern: RegExp): Map<string, string> {
  const content = readRepo(file);
  const map = new Map<string, string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(idPattern.source, 'gm');
  while ((m = re.exec(content)) !== null) {
    if (!map.has(m[1])) {
      map.set(m[1], m[0]);
    }
  }
  return map;
}

let srsNfrRows: Map<string, string> | null = null;
let tstNfrRows: Map<string, string> | null = null;

/** 解析 SRS-NFR-### 权威定义行（表格整行） */
export function srsNfrDefinition(nfrId: string): string {
  if (srsNfrRows === null) {
    srsNfrRows = buildRowMap(SRS_NFR_DOC, /^\| (SRS-NFR-\d{3}) \|[^\n]*$/gm);
  }
  const row = srsNfrRows.get(nfrId);
  if (row === undefined) {
    throw new Error(`${SRS_NFR_DOC} 中未找到 ${nfrId} 定义行`);
  }
  return row;
}

/** 解析 TST-NFR-### 验收合同行（表格整行） */
export function tstNfrContract(tstId: string): string {
  if (tstNfrRows === null) {
    tstNfrRows = buildRowMap(TST_SPEC_DOC, /^\| (TST-NFR-\d{3}) \| [^\n]*$/gm);
  }
  const row = tstNfrRows.get(tstId);
  if (row === undefined) {
    throw new Error(`${TST_SPEC_DOC} 中未找到 ${tstId} 合同行`);
  }
  return row;
}

/** 运维手册全文 */
export function opsManual(): string {
  return readRepo(OPS_MANUAL_DOC);
}

/** 已排序样本的百分位数（最近邻插值；输入必须已升序） */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) {
    throw new Error('percentile：空样本');
  }
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx];
}

/** 固定基准时刻（全部用例共享的注入时钟原点） */
export const FIXED_NOW = new Date('2026-08-25T08:00:00.000Z');

/** 固定时刻 + 偏移毫秒 */
export function at(offsetMs: number): Date {
  return new Date(FIXED_NOW.getTime() + offsetMs);
}

/**
 * loadConfig 探针共用的最小合成环境（全部必填字段齐备、全部为虚构值）。
 * 各用例在其上覆盖需要探测的键。
 */
export function baseSyntheticEnv(): Record<string, string> {
  return {
    ORG_DEV_ACTOR_HEADER: '1',
    DATABASE_PASSWORD: 'synthetic-pw',
    CASDOOR_ENDPOINT: 'https://casdoor.example.edu',
    CASDOOR_CLIENT_ID: 'syn-client',
    CASDOOR_ORGANIZATION: 'syn-org',
    CASDOOR_REDIRECT_URI: 'https://app.example.edu/auth/callback',
    CASDOOR_CLIENT_SECRET: 'synthetic-secret',
    STORAGE_ENDPOINT: 'https://storage.example.edu',
    STORAGE_ACCESS_KEY: 'synthetic-ak',
    STORAGE_SECRET_KEY: 'synthetic-sk',
  };
}
