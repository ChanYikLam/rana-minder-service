/**
 * TST-SEC-*：26 威胁 / 38 控制目标的证据清单（P1-B；CI-004 发布门）。
 *
 * 语义（防虚报）：
 * - 威胁侧：26 个 THR 桩位全部 status=未执行（逐项故障注入落地前不得宣称通过）；
 * - 控制侧：仅登记当前仓库已有可执行证据的条目，evidence 文件必须存在；
 *   未登记缺口 = TOTAL_CONTROLS - concrete.length，显式留白；
 * - 棘轮：concrete 数量 ≥ BASELINE_CONCRETE_CONTROLS 且只许上调
 *   （新增条目必须携带真实存在的 evidence 路径，否则本套件失败）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  BASELINE_CONCRETE_CONTROLS,
  CONCRETE_CONTROLS,
  threatStubs,
  TOTAL_CONTROLS,
  TOTAL_THREATS,
} from '../helpers/security-controls-inventory';

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
  });

  it('控制面总量守恒：38 个控制目标，登记数 + 显式留白 = 总额', () => {
    assert.equal(TOTAL_CONTROLS, 38);
    const gap = TOTAL_CONTROLS - CONCRETE_CONTROLS.length;
    assert.ok(gap >= 0, '登记数不得超过控制总额');
    // 留白必须可见：不允许悄悄补满而无需评审
    assert.ok(
      gap > 0,
      `当前已登记 ${CONCRETE_CONTROLS.length} 项；若确实补满 38 项请同步更新本断言与威胁模型追踪`,
    );
  });

  it(`棘轮下限：已具可执行证据的控制 ≥ ${BASELINE_CONCRETE_CONTROLS}`, () => {
    assert.ok(
      CONCRETE_CONTROLS.length >= BASELINE_CONCRETE_CONTROLS,
      `concrete=${CONCRETE_CONTROLS.length}`,
    );
  });

  it('每条控制项的证据文件真实存在', () => {
    const problems: string[] = [];
    for (const c of CONCRETE_CONTROLS) {
      if (c.evidence.length === 0) problems.push(`${c.id}: 无证据`);
      for (const ev of c.evidence) {
        if (!exists(ev)) problems.push(`${c.id}: 证据不存在 ${ev}`);
      }
    }
    assert.deepEqual(problems, []);
  });

  it('控制项编号唯一', () => {
    const ids = CONCRETE_CONTROLS.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});
