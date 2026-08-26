/**
 * TST-SEC-*：26 威胁 / 38 控制目标的证据清单（P1-B；CI-004 发布门）。
 *
 * 语义（防虚报）：
 * - 威胁侧：26 个 THR 桩位全部 status=未执行（逐项故障注入落地前不得宣称通过）；
 * - 控制侧分两通道记账：
 *   · codeControls = CONCRETE_CONTROLS（37 项，每项有可执行测试证据文件）
 *   · processControls = PROCESS_CONTROLS（1 项 SEC-CTL-001，流程证据文档承载）
 *   codeControls + processControls === TOTAL_CONTROLS (38)
 * - 棘轮：codeControls ≥ BASELINE 且只许上调
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  BASELINE_CONCRETE_CONTROLS,
  CONCRETE_CONTROLS,
  PROCESS_CONTROLS,
  threatStubs,
  TOTAL_CONTROLS,
  TOTAL_THREATS,
} from '../helpers/security-controls-inventory';
import {
  resolveThreatIdsFromDoc,
  threatDisplayId,
  THREAT_MODEL_DOC,
} from '../helpers/authority-docs';

const ROOT = path.resolve(__dirname, '../..');
const exists = (rel: string): boolean => fs.existsSync(path.join(ROOT, rel));

describe('TST-SEC 安全控制证据', () => {
  it('威胁面占额完整：26 个 THR 桩位且全部未执行（禁止未测先过）', () => {
    const threats = threatStubs();
    assert.equal(threats.length, TOTAL_THREATS);
    assert.equal(TOTAL_THREATS, 26);
    for (const t of threats) {
      assert.equal(t.status, '未执行');
    }
    const ids = new Set(threats.map((t) => t.id));
    assert.equal(ids.size, TOTAL_THREATS);
    const docThreatIds = resolveThreatIdsFromDoc();
    assert.equal(
      docThreatIds.length,
      TOTAL_THREATS,
      `权威威胁模型文档 ${THREAT_MODEL_DOC} 应声明 ${TOTAL_THREATS} 个威胁，实际 ${docThreatIds.length}`,
    );
    const mapped = docThreatIds.map(threatDisplayId);
    assert.deepEqual(
      [...ids].sort(),
      mapped.map((n) => `TST-SEC-THR-${n}`).sort(),
      '桩位编号与权威威胁模型文档的 SEC-THR 目录不一致',
    );
  });

  it('控制面总量守恒（路径 2 轻量）：code(37) + process(1) = 总额 38', () => {
    assert.equal(TOTAL_CONTROLS, 38);
    const codeCount = CONCRETE_CONTROLS.length;
    const processCount = PROCESS_CONTROLS.length;
    // 两通道守恒：代码证据 + 流程证据 = 控制总额
    assert.equal(
      codeCount + processCount,
      TOTAL_CONTROLS,
      `code(${codeCount}) + process(${processCount}) 应等于 ${TOTAL_CONTROLS}`,
    );
    // 通道内不得有重叠 ID（同一控制项不可同时登记为代码+流程）
    const codeIds = new Set(CONCRETE_CONTROLS.map((c) => c.id));
    for (const p of PROCESS_CONTROLS) {
      assert.ok(!codeIds.has(p.id), `${p.id} 不应同时出现在 code 与 process 通道`);
    }
  });

  it(`棘轮下限：已具可执行证据的控制 ≥ ${BASELINE_CONCRETE_CONTROLS}`, () => {
    assert.ok(
      CONCRETE_CONTROLS.length >= BASELINE_CONCRETE_CONTROLS,
      `concrete=${CONCRETE_CONTROLS.length}`,
    );
  });

  it('每条代码控制项的证据文件真实存在', () => {
    const problems: string[] = [];
    for (const c of CONCRETE_CONTROLS) {
      if (c.evidence.length === 0) problems.push(`${c.id}: 无证据`);
      for (const ev of c.evidence) {
        if (!exists(ev)) problems.push(`${c.id}: 证据不存在 ${ev}`);
      }
    }
    assert.deepEqual(problems, []);
  });

  it('每条流程控制项的证据文档真实存在', () => {
    for (const p of PROCESS_CONTROLS) {
      assert.ok(exists(p.evidenceDoc), `${p.id}: 流程证据文档不存在 ${p.evidenceDoc}`);
    }
  });

  it('控制项编号唯一', () => {
    const ids = CONCRETE_CONTROLS.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});
