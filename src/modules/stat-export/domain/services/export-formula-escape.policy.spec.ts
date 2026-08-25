/**
 * 导出单元格公式逃逸策略单测（5.4.3，EXP-002：导出文件内容安全）。
 *
 * 领域层纯规则：只断言逃逸判定的确定性输出，不依赖命令层/端口/仓储。
 * 覆盖边界：
 * - 公式前缀（=、+、-、@、\t、\r）→ 前置单引号逃逸；
 * - 数值/布尔/null 通道不逃逸（负数口径见策略文件头说明）；
 * - 普通文本/中文/中段 `=` 不受影响；
 * - 非标量兜底序列化同样过前缀检查。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FORMULA_RISK_PREFIXES,
  escapeExportCell,
  startsWithFormulaRiskPrefix,
} from './export-formula-escape.policy';

describe('FORMULA_RISK_PREFIXES — 风险前缀集合（EXP-002）', () => {
  it('覆盖 = + - @ 制表符 回车 六类公认公式/控制前缀', () => {
    assert.deepEqual([...FORMULA_RISK_PREFIXES], ['=', '+', '-', '@', '\t', '\r']);
  });

  it('startsWithFormulaRiskPrefix 与集合一致', () => {
    for (const prefix of FORMULA_RISK_PREFIXES) {
      assert.equal(
        startsWithFormulaRiskPrefix(`${prefix}x`),
        true,
        `前缀 ${JSON.stringify(prefix)}`,
      );
    }
    assert.equal(startsWithFormulaRiskPrefix('普通文本'), false);
    assert.equal(startsWithFormulaRiskPrefix(''), false);
  });
});

describe("escapeExportCell — 公式风险字符串前置 ' 逃逸（EXP-002）", () => {
  it("'=cmd|/C calc → 前置单引号，原始形态不再出现", () => {
    assert.equal(escapeExportCell('=cmd|/C calc'), "'=cmd|/C calc");
  });

  it("'+SUM(A1)' → 前置单引号", () => {
    assert.equal(escapeExportCell('+SUM(A1)'), "'+SUM(A1)");
  });

  it("字符串 '-2' 以 '-' 开头 → 前置单引号（字符串单元格按文本处理）", () => {
    assert.equal(escapeExportCell('-2'), "'-2");
  });

  it("'@x' → 前置单引号", () => {
    assert.equal(escapeExportCell('@x'), "'@x");
  });

  it("制表符开头（'\\tB'）→ 前置单引号", () => {
    assert.equal(escapeExportCell('\tB'), "'\tB");
  });

  it("回车开头 '\\r=1' → 前置单引号", () => {
    assert.equal(escapeExportCell('\r=1'), "'\r=1");
  });

  it('\'=HYPERLINK("http://evil")\' → 前置单引号（链接注入被中和）', () => {
    assert.equal(escapeExportCell('=HYPERLINK("http://evil")'), '\'=HYPERLINK("http://evil")');
  });
});

describe('escapeExportCell — 数值/布尔/空值通道不逃逸', () => {
  it('数值 -2 直接 String() 返回（数值走 <c t="n"> 通道，无公式解析路径）', () => {
    assert.equal(escapeExportCell(-2), '-2');
    assert.equal(escapeExportCell(-0.5), '-0.5');
  });

  it('正整数与浮点数规范化为字符串', () => {
    assert.equal(escapeExportCell(42), '42');
    assert.equal(escapeExportCell(3.14), '3.14');
  });

  it('bigint 同数值通道口径，不逃逸', () => {
    assert.equal(escapeExportCell(BigInt(-7)), '-7');
  });

  it('布尔返回 true/false 字面量', () => {
    assert.equal(escapeExportCell(true), 'true');
    assert.equal(escapeExportCell(false), 'false');
  });

  it('null / undefined → 空字符串（空单元格语义）', () => {
    assert.equal(escapeExportCell(null), '');
    assert.equal(escapeExportCell(undefined), '');
  });
});

describe('escapeExportCell — 普通内容原样透传', () => {
  it('普通英文文本不受影响', () => {
    assert.equal(escapeExportCell('hello world'), 'hello world');
  });

  it('中文文本不受影响', () => {
    assert.equal(escapeExportCell('社团联合会·招新统计'), '社团联合会·招新统计');
  });

  it('空字符串原样返回（不加引号）', () => {
    assert.equal(escapeExportCell(''), '');
  });

  it('仅中段包含 = 的文本不受影响（前缀判定而非包含判定）', () => {
    assert.equal(escapeExportCell('a=b'), 'a=b');
    assert.equal(escapeExportCell('评分=A→B'), '评分=A→B');
  });

  it('非标量对象 JSON 兜底序列化且同样过前缀检查', () => {
    assert.equal(escapeExportCell({ a: 1 }), '{"a":1}');
    // 序列化结果以 { 开头，不属于风险前缀
    assert.equal(startsWithFormulaRiskPrefix(escapeExportCell([1, 2])), false);
  });
});
