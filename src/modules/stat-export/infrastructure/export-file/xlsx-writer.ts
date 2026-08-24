/**
 * 极简 XLSX（SpreadsheetML）生成器（5.4.3，EXP-002：导出文件安全与水印内嵌）。
 *
 * 在零依赖手写 ZIP（./zip-writer）之上拼装最小合法的 OOXML 电子表格包：
 * - [Content_Types].xml / _rels/.rels：包结构与部件类型声明；
 * - docProps/core.xml：写入水印元数据（创建者/最后修改者/创建·修改时间，
 *   以及含 导出人/所属社团/生成时间/导出编号 的完整水印文本）；
 * - docProps/app.xml、xl/workbook.xml、xl/_rels/workbook.xml.rels、xl/styles.xml；
 * - 每个数据表对应 xl/worksheets/sheetN.xml，字符串单元格用 inlineStr 内联串。
 *
 * 单元格安全口径（EXP-002）：
 * - 所有字符串内容先过领域层公式逃逸策略 escapeExportCell（以风险前缀开头的
 *   文本前置半角单引号），再做 XML 转义——两道工序独立且都必须执行；
 * - 数值走 `<v>` 数值通道（t 缺省为 n），布尔走 t="b"，null/undefined 输出空单元格。
 *
 * 分层说明：本文件属基础设施层，允许依赖领域层策略（不得反向）。
 */

import { type ExportWatermarkMetadata } from '../../domain/services/export-watermark.policy';
import { escapeExportCell } from '../../domain/services/export-formula-escape.policy';
import { ZipWriter } from './zip-writer';

// ===========================================================================
// XML 基础设施
// ===========================================================================

/**
 * XML 转义（第二道工序）：&、<、>、" 转实体；按 XML 1.0 规范剔除非法控制字符
 * （\t \n \r 合法保留）。注意本函数不做公式逃逸，两者职责独立、顺序固定：
 * 先公式逃逸、后 XML 转义。
 */
function escapeXml(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // XML 1.0 仅允许 \t(9)/\n(10)/\r(13) 及 >= 0x20 的字符
    if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) {
      continue;
    }
    if (ch === '&') {
      out += '&amp;';
    } else if (ch === '<') {
      out += '&lt;';
    } else if (ch === '>') {
      out += '&gt;';
    } else if (ch === '"') {
      out += '&quot;';
    } else {
      out += ch;
    }
  }
  return out;
}

/** 列序号（0 起）→ A/B/…/Z/AA/… 列标 */
export function columnLetter(index: number): string {
  let rest = index + 1;
  let letter = '';
  while (rest > 0) {
    const rem = (rest - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    rest = Math.floor((rest - 1) / 26);
  }
  return letter;
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

// ===========================================================================
// 写入器
// ===========================================================================

export interface XlsxWriterOptions {
  /** 底层 ZIP 时间戳（缺省 new Date()；注入后输出确定） */
  readonly now?: Date;
}

interface SheetDraft {
  readonly name: string;
  readonly rows: ReadonlyArray<readonly unknown[]>;
}

/** 极简 XLSX 写入器：create() → addSheet()* → build() */
export class XlsxWriter {
  private readonly sheets: SheetDraft[] = [];
  private readonly metadata: ExportWatermarkMetadata;
  private readonly options: XlsxWriterOptions;

  private constructor(metadata: ExportWatermarkMetadata, options: XlsxWriterOptions) {
    this.metadata = metadata;
    this.options = options;
  }

  /** 以水印元数据为起点创建写入器（元数据将固化进 docProps/core.xml） */
  static create(metadata: ExportWatermarkMetadata, options?: XlsxWriterOptions): XlsxWriter {
    return new XlsxWriter(metadata, options ?? {});
  }

  /** 追加一个工作表；同名表抛错（避免引用歧义），行数据在 build 时渲染 */
  addSheet(name: string, rows: ReadonlyArray<readonly unknown[]>): this {
    if (!name) {
      throw new Error('EXP-002: 工作表名不得为空');
    }
    if (this.sheets.some((sheet) => sheet.name === name)) {
      throw new Error(`EXP-002: 工作表名重复：${name}`);
    }
    this.sheets.push({ name, rows });
    return this;
  }

  /** 生成完整 XLSX 字节流（同一输入 + 注入时间输出逐字节一致） */
  build(): Uint8Array {
    if (this.sheets.length === 0) {
      throw new Error('EXP-002: XLSX 至少需要一个工作表');
    }

    const zip = new ZipWriter({ now: this.options.now });
    zip.add({ filename: '[Content_Types].xml', data: this.contentTypesXml() });
    zip.add({ filename: '_rels/.rels', data: this.rootRelsXml() });
    zip.add({ filename: 'docProps/core.xml', data: this.coreXml() });
    zip.add({ filename: 'docProps/app.xml', data: this.appXml() });
    zip.add({ filename: 'xl/workbook.xml', data: this.workbookXml() });
    zip.add({ filename: 'xl/_rels/workbook.xml.rels', data: this.workbookRelsXml() });
    zip.add({ filename: 'xl/styles.xml', data: this.stylesXml() });
    this.sheets.forEach((sheet, index) => {
      zip.add({
        filename: `xl/worksheets/sheet${index + 1}.xml`,
        data: this.worksheetXml(sheet),
      });
    });
    return zip.build();
  }

  // -----------------------------------------------------------------
  // 各 XML 部件
  // -----------------------------------------------------------------

  private contentTypesXml(): string {
    const sheetOverrides = this.sheets
      .map(
        (_, index) =>
          `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('');
    return (
      `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      `${sheetOverrides}` +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>'
    );
  }

  private rootRelsXml(): string {
    return (
      `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>'
    );
  }

  /** 水印元数据固化点（EXP-002）：core.xml 承载导出人/时间/导出编号等溯源要素 */
  private coreXml(): string {
    const meta = this.metadata;
    // 导出人展示口径与 watermarkText 的"导出人"段一致：姓名(userId)，缺省回退 userId
    const creator = meta.exporterName
      ? `${meta.exporterName}(${meta.exporterUserId})`
      : meta.exporterUserId;
    return (
      `${XML_DECL}` +
      '<cp:coreProperties' +
      ' xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
      ' xmlns:dc="http://purl.org/dc/elements/1.1/"' +
      ' xmlns:dcterms="http://purl.org/dc/terms/"' +
      ' xmlns:dcmitype="http://purl.org/dc/dcmitype/"' +
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>导出文件 ${escapeXml(meta.exportNo)}</dc:title>` +
      `<dc:subject>${escapeXml(meta.watermarkText)}</dc:subject>` +
      `<dc:creator>${escapeXml(creator)}</dc:creator>` +
      `<cp:lastModifiedBy>${escapeXml(creator)}</cp:lastModifiedBy>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${meta.generatedAtIso}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${meta.generatedAtIso}</dcterms:modified>` +
      `<cp:keywords>${escapeXml(meta.watermarkText)}</cp:keywords>` +
      '</cp:coreProperties>'
    );
  }

  private appXml(): string {
    return (
      `${XML_DECL}` +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
      '<Application>RanaMinder</Application>' +
      '</Properties>'
    );
  }

  private workbookXml(): string {
    const sheets = this.sheets
      .map(
        (sheet, index) =>
          `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
      )
      .join('');
    return (
      `${XML_DECL}` +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets>${sheets}</sheets>` +
      '</workbook>'
    );
  }

  private workbookRelsXml(): string {
    const sheetRels = this.sheets
      .map(
        (_sheet, index) =>
          `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
      )
      .join('');
    const stylesRelId = `rId${this.sheets.length + 1}`;
    return (
      `${XML_DECL}` +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `${sheetRels}` +
      `<Relationship Id="${stylesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      '</Relationships>'
    );
  }

  /** 最小样式表：Excel 要求 fonts/fills 至少各一（fills 需含 gray125 兜底项） */
  private stylesXml(): string {
    return (
      `${XML_DECL}` +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border/></borders>' +
      '<cellStyleXfs count="1"><xf/></cellStyleXfs>' +
      '<cellXfs count="1"><xf xfId="0"/></cellXfs>' +
      '</styleSheet>'
    );
  }

  private worksheetXml(sheet: SheetDraft): string {
    const rowsXml = sheet.rows
      .map((row, rowIndex) => {
        const cells = row
          .map((value, colIndex) => this.cellXml(value, rowIndex, colIndex))
          .join('');
        return `<row r="${rowIndex + 1}">${cells}</row>`;
      })
      .join('');
    return (
      `${XML_DECL}` +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<sheetData>${rowsXml}</sheetData>` +
      '</worksheet>'
    );
  }

  /**
   * 渲染单个单元格（EXP-002 安全收口）：
   * - 字符串通道：先 escapeExportCell（公式逃逸）再 escapeXml（XML 转义）；
   * - 数值/bigint 通道：`<v>` 直出（电子表格按数值解析，无公式解析路径）；
   * - 布尔：t="b"，1/0；
   * - null/undefined 与非有限数值：输出空单元格（保持列位对齐）。
   */
  private cellXml(value: unknown, rowIndex: number, colIndex: number): string {
    const ref = `${columnLetter(colIndex)}${rowIndex + 1}`;
    if (value === null || value === undefined) {
      return `<c r="${ref}"/>`;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        return `<c r="${ref}"/>`; // NaN/Infinity 无法进入数值通道，按空单元格处理
      }
      return `<c r="${ref}"><v>${String(value)}</v></c>`;
    }
    if (typeof value === 'bigint') {
      return `<c r="${ref}"><v>${value.toString()}</v></c>`;
    }
    if (typeof value === 'boolean') {
      return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
    }
    const safe = escapeXml(escapeExportCell(value));
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${safe}</t></is></c>`;
  }
}
