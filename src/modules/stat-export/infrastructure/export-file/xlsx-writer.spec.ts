/**
 * 极简 XLSX 写入器单测（5.4.3，EXP-002：导出文件安全与水印内嵌）。
 *
 * 验证策略：用 zip-writer 的校验读取器回读产物（不依赖系统 unzip），断言：
 * - OOXML 包结构完整（Content_Types/rels/workbook/styles/worksheets/core/app）；
 * - 水印元数据固化进 docProps/core.xml（创建者/时间戳/导出编号/水印文本）；
 * - 字符串单元格先公式逃逸（前置单引号）、再 XML 转义，两道工序均生效；
 * - 数值/布尔/null 单元格通道正确；同输入输出逐字节确定。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { inflateRawSync } from 'node:zlib';

import { crc32, readZipArchive } from './zip-writer';
import { XlsxWriter, columnLetter } from './xlsx-writer';
import { buildExportWatermarkMetadata } from '../../domain/services/export-watermark.policy';

// ===========================================================================
// 夹具
// ===========================================================================

const METADATA = buildExportWatermarkMetadata({
  exportId: 'a1b2c3d4e5f6',
  revisionNumber: 2,
  exporterUserId: 'u-123',
  exporterName: '张三',
  clubId: 'c-9',
  clubName: '篮球协会',
  generatedAt: new Date('2026-03-09T08:05:06.789Z'),
});

const FIXED_NOW = new Date('2026-03-09T08:06:00.000Z');

/** 组一个双表工作簿并回读解析，返回各部件文本 */
function buildSampleWorkbook() {
  const bytes = XlsxWriter.create(METADATA, { now: FIXED_NOW })
    .addSheet('社团汇总', [
      ['社团名称', '成员数', '活跃', '备注'],
      ['篮球协会', 42, true, null],
    ])
    .addSheet('招新漏斗', [[3.14, false]])
    .build();
  const parsed = readZipArchive(bytes);
  return {
    bytes,
    parsed,
    coreXml: parsed.text('docProps/core.xml'),
    workbookXml: parsed.text('xl/workbook.xml'),
    workbookRelsXml: parsed.text('xl/_rels/workbook.xml.rels'),
    rootRelsXml: parsed.text('_rels/.rels'),
    contentTypesXml: parsed.text('[Content_Types].xml'),
    sheet1Xml: parsed.text('xl/worksheets/sheet1.xml'),
    sheet2Xml: parsed.text('xl/worksheets/sheet2.xml'),
  };
}

// ===========================================================================
// 1. OOXML 包结构
// ===========================================================================

describe('XlsxWriter — OOXML 包结构（EXP-002）', () => {
  const sample = buildSampleWorkbook();

  it('包含全部必需部件（含两张工作表）', () => {
    const names = sample.parsed.entries.map((entry) => entry.filename);
    for (const required of [
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/core.xml',
      'docProps/app.xml',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]) {
      assert.ok(names.includes(required), `缺少部件 ${required}`);
    }
    assert.equal(sample.parsed.entryCount, names.length);
  });

  it('Content_Types 声明工作簿、工作表与 docProps 部件类型', () => {
    assert.ok(sample.contentTypesXml.includes('spreadsheetml.sheet.main+xml'));
    assert.ok(sample.contentTypesXml.includes('/xl/worksheets/sheet1.xml'));
    assert.ok(sample.contentTypesXml.includes('/xl/worksheets/sheet2.xml'));
    assert.ok(sample.contentTypesXml.includes('core-properties+xml'));
    assert.ok(sample.contentTypesXml.includes('extended-properties+xml'));
  });

  it('根 rels 挂载 workbook/core/app 三个关系', () => {
    assert.ok(sample.rootRelsXml.includes('Target="xl/workbook.xml"'));
    assert.ok(sample.rootRelsXml.includes('Target="docProps/core.xml"'));
    assert.ok(sample.rootRelsXml.includes('Target="docProps/app.xml"'));
  });

  it('workbook.xml 列出两个工作表；workbook.rels 指向工作表与 styles', () => {
    assert.ok(sample.workbookXml.includes('name="社团汇总"'));
    assert.ok(sample.workbookXml.includes('name="招新漏斗"'));
    assert.ok(sample.workbookRelsXml.includes('Target="worksheets/sheet1.xml"'));
    assert.ok(sample.workbookRelsXml.includes('Target="worksheets/sheet2.xml"'));
    assert.ok(sample.workbookRelsXml.includes('Target="styles.xml"'));
  });

  it('styles.xml 提供最小字体/填充/边框/样式集合', () => {
    const styles = sample.parsed.text('xl/styles.xml');
    assert.ok(styles.includes('<fonts count="1">'));
    assert.ok(styles.includes('patternType="gray125"')); // Excel 要求 fills[1] 为 gray125
    assert.ok(styles.includes('<cellXfs count="1">'));
  });
});

// ===========================================================================
// 2. 水印元数据固化（core.xml）
// ===========================================================================

describe('XlsxWriter — 水印元数据写入 core.xml（EXP-002）', () => {
  const sample = buildSampleWorkbook();

  it('创建者/最后修改者为导出人（姓名(userId) 口径）', () => {
    assert.ok(sample.coreXml.includes('<dc:creator>张三(u-123)</dc:creator>'));
    assert.ok(sample.coreXml.includes('<cp:lastModifiedBy>张三(u-123)</cp:lastModifiedBy>'));
  });

  it('created/modified 时间戳取生成时间 ISO', () => {
    assert.ok(
      sample.coreXml.includes(
        '<dcterms:created xsi:type="dcterms:W3CDTF">2026-03-09T08:05:06.789Z</dcterms:created>',
      ),
    );
    assert.ok(
      sample.coreXml.includes(
        '<dcterms:modified xsi:type="dcterms:W3CDTF">2026-03-09T08:05:06.789Z</dcterms:modified>',
      ),
    );
  });

  it('导出编号与四段水印文本完整出现', () => {
    assert.ok(sample.coreXml.includes('EXP-20260309-A1B2C3D4-0002'));
    for (const segment of ['导出人:', '所属社团:', '生成时间:', '导出编号:']) {
      assert.ok(sample.coreXml.includes(segment), `core.xml 缺少水印段落 ${segment}`);
    }
    assert.ok(sample.coreXml.includes('篮球协会(c-9)'));
  });
});

// ===========================================================================
// 3. 单元格通道与公式逃逸（EXP-002 核心）
// ===========================================================================

describe('XlsxWriter — 单元格类型通道', () => {
  const sample = buildSampleWorkbook();

  it('字符串 inlineStr / 数值 / 布尔 / null 空单元格各就各位', () => {
    // 第一行为表头（全字符串）
    assert.ok(
      sample.sheet1Xml.includes(
        '<c r="A1" t="inlineStr"><is><t xml:space="preserve">社团名称</t></is></c>',
      ),
    );
    assert.ok(
      sample.sheet1Xml.includes(
        '<c r="D1" t="inlineStr"><is><t xml:space="preserve">备注</t></is></c>',
      ),
    );
    // 第二行：字符串/数值/布尔/null 各通道
    assert.ok(
      sample.sheet1Xml.includes(
        '<c r="A2" t="inlineStr"><is><t xml:space="preserve">篮球协会</t></is></c>',
      ),
    );
    assert.ok(sample.sheet1Xml.includes('<c r="B2"><v>42</v></c>'));
    assert.ok(sample.sheet1Xml.includes('<c r="C2" t="b"><v>1</v></c>'));
    assert.ok(sample.sheet1Xml.includes('<c r="D2"/>')); // null → 空单元格占位
    assert.ok(sample.sheet1Xml.includes('<row r="1">'));
    assert.ok(sample.sheet1Xml.includes('<row r="2">'));
    assert.ok(sample.sheet2Xml.includes('<c r="A1"><v>3.14</v></c>'));
    assert.ok(sample.sheet2Xml.includes('<c r="B1" t="b"><v>0</v></c>'));
  });

  it('负数走数值通道不逃逸（数值无公式解析路径）', () => {
    const bytes = XlsxWriter.create(METADATA, { now: FIXED_NOW })
      .addSheet('s', [[-1, '-1']])
      .build();
    const sheet = readZipArchive(bytes).text('xl/worksheets/sheet1.xml');
    assert.ok(sheet.includes('<c r="A1"><v>-1</v></c>')); // 数值通道
    assert.ok(sheet.includes('<t xml:space="preserve">\'-1</t>')); // 字符串通道被逃逸
  });

  it('列标超过 Z 后正确进位（A→AA→BA）', () => {
    assert.equal(columnLetter(0), 'A');
    assert.equal(columnLetter(25), 'Z');
    assert.equal(columnLetter(26), 'AA');
    assert.equal(columnLetter(52), 'BA');
    const bytes = XlsxWriter.create(METADATA, { now: FIXED_NOW })
      .addSheet('s', [new Array(27).fill('x')])
      .build();
    const sheet = readZipArchive(bytes).text('xl/worksheets/sheet1.xml');
    assert.ok(sheet.includes('<c r="AA1"'), '第 27 列应为 AA1');
  });
});

describe("XlsxWriter — 公式逃逸（先加 ' 再转义，EXP-002）", () => {
  /** 公式样输入与其必须以单引号逃逸后的形态 */
  const RISKY_INPUTS = [
    '=cmd|/C calc',
    '+SUM(A1)',
    '@x',
    '\tB',
    '\r=1',
    '=HYPERLINK("http://evil")',
  ];

  const bytes = XlsxWriter.create(METADATA, { now: FIXED_NOW })
    .addSheet('注入面', [['安全文本', ...RISKY_INPUTS, '-1']])
    .build();
  const sheet = readZipArchive(bytes).text('xl/worksheets/sheet1.xml');

  /** 测试侧独立复刻 XML 实体映射（与实现的转义互为印证而非共用代码） */
  const xmlLiteral = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  for (const raw of RISKY_INPUTS) {
    it(`公式样输入 ${JSON.stringify(raw)} 以单引号逃逸而非原样进入单元格`, () => {
      // 单引号本身无需实体化，其余 XML 特殊字符须按实体出现
      const escapedCell = `<t xml:space="preserve">'${xmlLiteral(raw)}</t>`;
      assert.ok(sheet.includes(escapedCell), `应存在逃逸形态 ${escapedCell}`);
      const unprimedCell = `<t xml:space="preserve">${xmlLiteral(raw)}</t>`;
      assert.equal(sheet.includes(unprimedCell), false, `不得存在未加引号的形态 ${unprimedCell}`);
    });
  }

  it("字符串 '-1' 同样逃逸；普通文本不加引号", () => {
    assert.ok(sheet.includes('<t xml:space="preserve">\'-1</t>'));
    assert.ok(sheet.includes('<t xml:space="preserve">安全文本</t>'));
  });
});

// ===========================================================================
// 4. XML 转义独立生效
// ===========================================================================

describe('XlsxWriter — XML 转义与控制字符清洗（EXP-002）', () => {
  const bytes = XlsxWriter.create(METADATA, { now: FIXED_NOW })
    .addSheet('s<1>', [['a<b>&"c', 'x\u0007y']])
    .build();
  const workbook = readZipArchive(bytes);
  const sheet = workbook.text('xl/worksheets/sheet1.xml');

  it('& < > " 全部转实体', () => {
    assert.ok(sheet.includes('a&lt;b&gt;&amp;&quot;c'));
    // 工作表名同样转义
    assert.ok(workbook.text('xl/workbook.xml').includes('name="s&lt;1&gt;"'));
  });

  it('XML 1.0 非法控制字符被剔除（保留 \\t \\n \\r）', () => {
    assert.ok(sheet.includes('<t xml:space="preserve">xy</t>'));
  });
});

// ===========================================================================
// 5. ZIP 完整性与确定性
// ===========================================================================

describe('XlsxWriter — ZIP 完整性与确定性', () => {
  it('每个部件 CRC 可复算且解压回路一致；文件名全部置 EFS 位', () => {
    const { bytes, parsed } = buildSampleWorkbook();
    for (const entry of parsed.entries) {
      assert.equal(entry.flags & 0x0800, 0x0800); // UTF-8 文件名标志
      assert.equal(entry.crc32, crc32(inflateRawSync(entry.compressedData)));
      assert.deepEqual(
        parsed.read(entry.filename),
        Buffer.from(inflateRawSync(entry.compressedData)),
      );
    }
    assert.ok(bytes.length > 0);
  });

  it('同输入两次 build 逐字节一致；时间不同则不同', () => {
    const make = (now: Date) =>
      XlsxWriter.create(METADATA, { now })
        .addSheet('表', [['a', 1]])
        .build();
    assert.deepEqual(make(FIXED_NOW), make(FIXED_NOW));
    assert.notDeepEqual(make(FIXED_NOW), make(new Date('2026-03-10T08:06:00.000Z')));
  });
});

// ===========================================================================
// 6. 防呆约束
// ===========================================================================

describe('XlsxWriter — 防呆约束（EXP-002）', () => {
  it('未添加任何工作表即 build 抛错', () => {
    assert.throws(() => XlsxWriter.create(METADATA).build(), /至少需要一个工作表/);
  });

  it('重复工作表名抛错', () => {
    const writer = XlsxWriter.create(METADATA).addSheet('dup', []);
    assert.throws(() => writer.addSheet('dup', []), /重复/);
  });

  it('空工作表名抛错', () => {
    assert.throws(() => XlsxWriter.create(METADATA).addSheet('', []), /不得为空/);
  });
});
