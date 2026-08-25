/**
 * 导出单元格公式逃逸策略（5.4.3，EXP-002：导出文件内容安全）。
 *
 * 电子表格软件（Excel / WPS / LibreOffice）会把以 `=`、`+`、`-`、`@`、制表符、
 * 回车等开头的单元格文本按**公式**解析执行。攻击者只需让某个业务字段值形如
 * `=HYPERLINK(...)` 或 `=cmd|'/C calc'!A0`，导出文件被打开时即可触发公式注入
 * （CSV Injection / Formula Injection）。本策略是生成 XLSX/CSV 前的统一防线：
 *
 * - 仅对**字符串型单元格**生效：字符串序列化后若以风险前缀开头，则前置一个
 *   半角单引号 `'`。这是 Excel 官方语义——以 `'` 开头的单元格被强制按纯文本
 *   处理，单引号本身不会显示在单元格内容中，从而同时保住可读性与安全性。
 * - 数值 / 布尔 / 空值按原样字符串化返回，**不做**公式逃逸。
 *
 * ⚠️ 为什么负数不逃逸（关于 `-` 前缀的口径澄清）：
 * `String(-1)` 结果为 `'-1'`，若对数值也按风险前缀处理，所有负数都会被加上
 * `'` 而破坏数据。本策略将其收敛为：**逃逸判定只作用于字符串型入参的最终
 * 字符串形态**；数值单元格由 XLSX 写入器按 `<c t="n"><v>-1</v></c>` 的数值
 * 通道输出，电子表格软件对数值通道不存在公式解析路径，因此无需逃逸。
 * 若调用方把 `'-1'` 作为**字符串**传入（如手工拼装的编号），则属于字符串
 * 单元格，会被正常逃逸为 `'-1` —— 口径与"单元格实际类型"一致而非与字面
 * 内容一致。
 *
 * 分层约束：本文件为领域层纯规则，禁止依赖 @nestjs/* 与基础设施实现。
 */

/**
 * 公式风险前缀集合（EXP-002）。
 *
 * 覆盖电子表格软件公认的公式/控制前缀：
 * - `=` 公式；
 * - `+` / `-` 表达式快捷输入；
 * - `@` 宏函数（Lotus/Excel 新函数语法）；
 * - `\t` 制表符、`\r` 回车：粘贴类注入的常见引导字符。
 */
export const FORMULA_RISK_PREFIXES: readonly string[] = ['=', '+', '-', '@', '\t', '\r'];

/** 判断字符串是否以任一公式风险前缀开头（供策略内部与测试复用） */
export function startsWithFormulaRiskPrefix(text: string): boolean {
  return FORMULA_RISK_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/**
 * 对单个导出单元格做公式逃逸（EXP-002），返回安全的字符串形态。
 *
 * 规则：
 * - string：以 FORMULA_RISK_PREFIXES 任一前缀开头 → 前置单引号；否则原样返回；
 * - number / bigint：按数值通道约定直接 `String(value)`，不逃逸（见文件头说明）；
 * - boolean：`'true' | 'false'`，不逃逸；
 * - null / undefined：空字符串（导出为空单元格语义）；
 * - 其余对象：JSON 序列化兜底（失败再退化为 String()），并同样施加前缀检查，
 *   保证任何未知类型的最终文本都不会以风险前缀进入单元格。
 */
export function escapeExportCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  const type = typeof value;

  // 数值/布尔走专用单元格通道（<c t="n"> / <c t="b">），无公式解析路径，不逃逸。
  if (type === 'number' || type === 'bigint') {
    return String(value);
  }
  if (type === 'boolean') {
    return String(value);
  }

  const text = type === 'string' ? (value as string) : stringifyUnknown(value);
  return startsWithFormulaRiskPrefix(text) ? `'${text}` : text;
}

/** 非标量类型的确定性字符串化兜底：优先 JSON，循环引用等异常退化为 String() */
function stringifyUnknown(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
