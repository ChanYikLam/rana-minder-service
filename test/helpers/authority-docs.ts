/**
 * 权威文档解析工具（P1-B / TST-SM / TST-SEC；CI-004 发布门证据）。
 *
 * 目的：把清单断言从"恒真 / 自证"改为与仓库权威规格文档绑定，
 * 防止文档增删条目（威胁 / 分面）而测试套件静默通过（防虚报 / 防漂移）。
 *
 * 解析来源（均为仓库相对路径，缺失/格式变化会让解析失败并暴露漂移）：
 * - 威胁编号：docs/specification/安全设计与实现级威胁模型-v1.0.md 的威胁目录
 *   表格行 `| SEC-THR-### | ...`（SEC-THR-001 ~ 026）。
 * - 固定六分面：docs/specification/测试规格与验收追踪-v1.0.md 的"逐转换固定分面"
 *   表头行 `` | `NOM` | ... ``（NOM/AUT/STA/VER/CON/REV）。
 *
 * 文档解析失败或格式被改写时，这里会抛出带原因的 Error，使依赖它的断言
 * 显式失败，而不是静默通过。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 仓库根目录（本文件位于 test/helpers/ 下） */
export const REPO_ROOT = path.resolve(__dirname, '../..');

/** 权威威胁模型文档 */
export const THREAT_MODEL_DOC = path.join(
  REPO_ROOT,
  'docs/specification/安全设计与实现级威胁模型-v1.0.md',
);
/** 权威测试规格文档（固定分面定义所在） */
export const TEST_SPEC_DOC = path.join(REPO_ROOT, 'docs/specification/测试规格与验收追踪-v1.0.md');

/** 读取文件内容；缺失时抛错（防止以空内容静默通过） */
function readDoc(file: string, what: string): string {
  if (!fs.existsSync(file)) {
    throw new Error(`权威文档缺失：${file}（${what}）`);
  }
  return fs.readFileSync(file, 'utf8');
}

/**
 * 从威胁模型文档解析威胁目录中的全部 SEC-THR 编号。
 *
 * 匹配表格行 `| SEC-THR-### | ...`。返回按编号升序的稳定数组。
 */
export function resolveThreatIdsFromDoc(): readonly string[] {
  const content = readDoc(THREAT_MODEL_DOC, '威胁模型');
  const ids = new Set<string>();
  const lineRe = /^\|\s*(SEC-THR-\d{3})\s*\|/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(content)) !== null) {
    ids.add(m[1]);
  }
  return [...ids].sort();
}

/**
 * 从测试规格文档解析"逐转换固定分面"表中的分面代号。
 *
 * 匹配固定分面表体行 `` | `NOM` | ... ``。返回按文档出现顺序的数组。
 * 若无法解析到任何分面，视为格式漂移并抛错。
 */
export function resolveFixedFacetsFromDoc(): readonly string[] {
  const content = readDoc(TEST_SPEC_DOC, '测试规格');
  // 定位固定分面表起始标记；找不到视为格式漂移
  const startMark = '逐转换固定分面如下：';
  const start = content.indexOf(startMark);
  if (start === -1) {
    throw new Error(`测试规格文档中未找到“${startMark}”节：${TEST_SPEC_DOC}`);
  }
  // 固定分面表紧随其后，条件分面表（FLT…RCV）在 REV 行之后另起，
  // 因此只取从起始标记到首个非固定分面行（或表结束）之间的 `| \`XXX\` |` 行。
  const facets: string[] = [];
  const facetLineRe = /^\|\s*`([A-Z]{3})`\s*\|/gm;
  facetLineRe.lastIndex = start;
  let m: RegExpExecArray | null;
  while ((m = facetLineRe.exec(content)) !== null) {
    // 条件分面表以 FLT 开头，遇到即停止
    if (m[1] === 'FLT') break;
    facets.push(m[1]);
  }
  if (facets.length === 0) {
    throw new Error(`测试规格文档中未解析到任何固定分面：${TEST_SPEC_DOC}`);
  }
  return facets;
}
