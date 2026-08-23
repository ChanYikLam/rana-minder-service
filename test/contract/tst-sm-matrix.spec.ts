/**
 * TST-SM-*：29 状态机 × 306 转换的测试矩阵证据（P1-B；CI-004 发布门）。
 *
 * 断言四件事（全部可执行，无文档审阅）：
 * 1. 清单完备：29 台、转换数合计 306（与接口实现规格 §12.2 逐条一致）；
 * 2. 实现存在：每台 machinePath 在仓库中真实存在（防"文档有、代码无"）；
 * 3. 逐转换测试承载：evidence 非空的台，其每个证据文件真实存在；
 * 4. 待实现清单 = EXPECTED_SM_PENDING（棘轮）：补测必须缩减该常量，
 *    新增未实现台（或回退已落地台）都会让本套件失败。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { EXPECTED_SM_PENDING, SM_FACETS, SRS_SM_INVENTORY } from '../helpers/srs-sm-inventory';

const ROOT = path.resolve(__dirname, '../..');
const exists = (rel: string): boolean => fs.existsSync(path.join(ROOT, rel));

describe('TST-SM 状态机测试矩阵（29×306）', () => {
  it('清单完备：29 台且声明转换数合计 306', () => {
    assert.equal(SRS_SM_INVENTORY.length, 29);
    const total = SRS_SM_INVENTORY.reduce((s, e) => s + e.declaredTransitions, 0);
    assert.equal(total, 306);
  });

  it('编号连续且唯一：IDN/ORG/REC/JNT/INV/MEM/FORM/FILE/NTF/AUD/EXP 全覆盖', () => {
    const ids = SRS_SM_INVENTORY.map((e) => e.id);
    assert.equal(new Set(ids).size, 29);
    for (const prefix of [
      'IDN',
      'ORG',
      'REC',
      'JNT',
      'INV',
      'MEM',
      'FORM',
      'FILE',
      'NTF',
      'AUD',
      'EXP',
    ]) {
      assert.ok(
        ids.some((id) => id.includes(`SRS-SM-${prefix}-`)),
        `缺少 ${prefix} 域`,
      );
    }
  });

  it('固定六分面入口定义齐全（NOM/AUT/STA/VER/CON/REV）', () => {
    assert.deepEqual([...SM_FACETS], ['NOM', 'AUT', 'STA', 'VER', 'CON', 'REV']);
  });

  it('每台状态机实现文件真实存在（防文档漂移）', () => {
    const missing = SRS_SM_INVENTORY.filter((e) => !exists(e.machinePath));
    assert.deepEqual(
      missing.map((e) => `${e.id}: ${e.machinePath}`),
      [],
      '以下状态机实现文件不存在',
    );
  });

  it('已落地台的证据文件真实存在', () => {
    const problems: string[] = [];
    for (const entry of SRS_SM_INVENTORY) {
      if (entry.evidence.length === 0) continue;
      for (const ev of entry.evidence) {
        if (!exists(ev)) problems.push(`${entry.id}: 证据不存在 ${ev}`);
      }
    }
    assert.deepEqual(problems, []);
  });

  it('待实现清单与棘轮基线一致（补测后须缩减 EXPECTED_SM_PENDING）', () => {
    const pending = SRS_SM_INVENTORY.filter((e) => e.evidence.length === 0).map((e) => e.id);
    assert.deepEqual(pending.sort(), [...EXPECTED_SM_PENDING].sort());
    // 每个待实现台至少给出机器路径（后续补测的落点已明确）
    for (const id of EXPECTED_SM_PENDING) {
      const entry = SRS_SM_INVENTORY.find((e) => e.id === id);
      assert.ok(entry, `EXPECTED_SM_PENDING 含未知台 ${id}`);
      assert.ok(exists(entry.machinePath), `${id} 的实现应已存在`);
    }
  });

  it('进度快照：已落地台数 ≥ 当前基线（回归防护）', () => {
    const landed = SRS_SM_INVENTORY.filter((e) => e.evidence.length > 0).length;
    assert.ok(landed >= 25, `已落地 ${landed} 台，低于基线 25（不得回退）`);
  });
});
