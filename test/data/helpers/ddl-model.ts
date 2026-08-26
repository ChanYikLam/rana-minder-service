/**
 * 迁移 DDL 静态模型构建器（test/data 专用；SYN-DATA-* 数据完整性用例的素材层）。
 *
 * 经 migration-manifest 的惰性口径装载真实迁移模块，收集 up()/down() 发出的全部
 * SQL 文本并做纯文本解析，产出：
 * - 表清单＋全局创建顺序（含出生迁移/语句坐标）；
 * - 列定义（CREATE TABLE 主体行 ∪ 后续 ALTER TABLE ADD COLUMN 补丁链）；
 * - 主键（列级/表级）、具名 UNIQUE 约束、匿名表级 UNIQUE 列组；
 * - 唯一索引（含部分索引 WHERE 谓词）；
 * - 具名 CHECK 约束的有序事件流（ADD/DROP，可合并出「当前有效」定义）；
 * - 外键引用点（REFERENCES public.<目标> 出现的全局坐标）；
 * - 各迁移 down() 的 DROP TABLE 顺序。
 *
 * 仅做字符串解析，不构造任何数据库连接，不触及 pg/jose 依赖链。
 */

import { collectSql, type MigrationEntry } from './migration-manifest';

export interface CheckEvent {
  readonly op: 'add' | 'drop';
  readonly name: string;
  /** ADD 事件为 CHECK (…) 括号内文本；DROP 事件为空串 */
  readonly text: string;
}

export interface UniqueIndexFact {
  readonly name: string;
  readonly table: string;
  readonly columns: string[];
  /** 部分索引 WHERE 谓词（空白归一）；非部分索引为 null */
  readonly partialWhere: string | null;
}

export interface FkReferenceFact {
  /** 引用方表（REFERENCES 所在 CREATE TABLE 的表） */
  readonly table: string;
  /** 被引用目标表 */
  readonly refTable: string;
  /** 引用点坐标：manifest 迁移序 / 该迁移 up 语句序 */
  readonly mi: number;
  readonly si: number;
}

export interface TableModel {
  readonly name: string;
  /** 出生迁移序号（manifest 应用顺序） */
  readonly mi: number;
  /** 出生语句序号（该迁移 up 语句流内） */
  readonly si: number;
  /** 列名（小写）→ 定义行文本（含 ALTER ADD COLUMN 补丁链，按到达顺序） */
  readonly columns: Map<string, string[]>;
  /** 具名 UNIQUE 约束：约束名 → 列组 */
  readonly namedUnique: Map<string, string[]>;
  /** 匿名表级 UNIQUE 列组 */
  readonly anonUnique: string[][];
  /** 表级 PRIMARY KEY 列组；null 表示未声明表级主键（可能为列级主键） */
  tablePk: string[] | null;
}

export interface DdlModel {
  /** 表名（小写）→ 模型；Map 插入序即全局创建序 */
  readonly tables: Map<string, TableModel>;
  /** 全局创建序的表名数组 */
  readonly creationOrder: string[];
  readonly uniqueIndexes: UniqueIndexFact[];
  readonly fkRefs: FkReferenceFact[];
  /** 表名 → 有序 CHECK 事件流 */
  readonly checkEvents: Map<string, CheckEvent[]>;
  /** 迁移版本 → down() 的 DROP TABLE 顺序 */
  readonly downDrops: Map<string, string[]>;
}

interface BalanceResult {
  /** 括号内文本（不含两端括号） */
  readonly text: string;
  /** 闭合括号之后的字符位置 */
  readonly end: number;
}

function sliceBalanced(text: string, openIdx: number): BalanceResult {
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return { text: text.slice(openIdx + 1, i), end: i + 1 };
      }
    }
  }
  throw new Error(`括号不配对：…${text.slice(Math.max(0, openIdx - 60), openIdx + 20)}…`);
}

/** 列组解析：容忍外层括号与引号，逐 token 去修饰后小写 */
function splitColumns(raw: string): string[] {
  return raw
    .replace(/^[\s(]+/, '')
    .replace(/[\s)]+$/, '')
    .split(',')
    .map((c) =>
      c
        .trim()
        .replace(/^["`]+|["`]+$/g, '')
        .toLowerCase(),
    )
    .filter((c) => c.length > 0);
}

/**
 * 解析 CREATE TABLE 括号体：先在体级提取具名约束（CHECK 文本跨行，需括号配平），
 * 再把剩余内容逐行归类为列定义／表级主键／匿名 UNIQUE。具名 CHECK 事件经
 * onCheck 回调挂到所属表的有序事件流。
 */
function parseInto(body: string, tm: TableModel, onCheck: (event: CheckEvent) => void): void {
  const namedRe = /CONSTRAINT\s+(\w+)\s+(CHECK|UNIQUE|PRIMARY KEY)\s*\(/gi;
  let stripped = '';
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = namedRe.exec(body)) !== null) {
    stripped += body.slice(cursor, m.index);
    const name = m[1];
    const kind = m[2].toUpperCase();
    const openIdx = m.index + m[0].length - 1;
    const bal = sliceBalanced(body, openIdx);
    if (kind === 'CHECK') {
      onCheck({ op: 'add', name, text: bal.text });
    } else if (kind === 'UNIQUE') {
      tm.namedUnique.set(name, splitColumns(bal.text));
    } else {
      tm.tablePk = splitColumns(bal.text);
    }
    cursor = bal.end;
    namedRe.lastIndex = bal.end;
  }
  stripped += body.slice(cursor);

  for (const rawLine of stripped.split('\n')) {
    const line = rawLine.trim().replace(/,$/, '');
    if (!line) continue;
    const pkM = /^PRIMARY KEY\s*\(/i.exec(line);
    if (pkM) {
      tm.tablePk = splitColumns(line.slice(pkM[0].length - 1));
      continue;
    }
    const uqM = /^UNIQUE\s*\(/i.exec(line);
    if (uqM) {
      tm.anonUnique.push(splitColumns(line.slice(uqM[0].length - 1)));
      continue;
    }
    if (/^(FOREIGN KEY|CHECK)\b/i.test(line)) continue;
    const colM = /^([A-Za-z_]\w*)\s+([\s\S]+)$/.exec(line);
    if (colM) {
      const col = colM[1].toLowerCase();
      const defs = tm.columns.get(col) ?? [];
      defs.push(`${col} ${colM[2]}`.trim());
      tm.columns.set(col, defs);
    }
  }
}

/** 收集全部迁移模块的 up/down SQL 并解析为静态 DDL 模型（纯内存，无连接） */
export async function buildDdlModel(entries: readonly MigrationEntry[]): Promise<DdlModel> {
  const tables = new Map<string, TableModel>();
  const uniqueIndexes: UniqueIndexFact[] = [];
  const fkRefs: FkReferenceFact[] = [];
  const checkEvents = new Map<string, CheckEvent[]>();
  const downDrops = new Map<string, string[]>();

  const pushCheck = (table: string, event: CheckEvent): void => {
    const list = checkEvents.get(table) ?? [];
    list.push(event);
    checkEvents.set(table, list);
  };

  for (let mi = 0; mi < entries.length; mi += 1) {
    const entry = entries[mi];
    const upSqls = await collectSql(entry.mod, 'up');
    let currentCreate: string | null = null;

    for (let si = 0; si < upSqls.length; si += 1) {
      const sql = upSqls[si];

      const createM = /^\s*CREATE TABLE IF NOT EXISTS public\.(\w+)\s*\(/i.exec(sql);
      if (createM) {
        const name = createM[1].toLowerCase();
        if (tables.has(name)) {
          throw new Error(`表 ${name} 被重复创建（迁移 ${entry.file}）`);
        }
        const openIdx = createM.index + createM[0].length - 1;
        const tm: TableModel = {
          name,
          mi,
          si,
          columns: new Map(),
          namedUnique: new Map(),
          anonUnique: [],
          tablePk: null,
        };
        parseInto(sliceBalanced(sql, openIdx).text, tm, (event) => pushCheck(name, event));
        tables.set(name, tm);
        currentCreate = name;
      } else {
        const alterCol =
          /^\s*ALTER TABLE public\.(\w+)\s+ADD COLUMN (?:IF NOT EXISTS\s+)?([\s\S]+)$/i.exec(sql);
        if (alterCol) {
          const tm = tables.get(alterCol[1].toLowerCase());
          if (!tm) throw new Error(`ADD COLUMN 目标表不存在：${alterCol[1]}（${entry.file}）`);
          const def = alterCol[2].trim();
          const col = (/^([A-Za-z_]\w*)/.exec(def)?.[1] ?? '').toLowerCase();
          if (!col)
            throw new Error(`ADD COLUMN 无法解析列名（${entry.file}）：${def.slice(0, 60)}`);
          const defs = tm.columns.get(col) ?? [];
          defs.push(def);
          tm.columns.set(col, defs);
        } else {
          const addCon =
            /^\s*ALTER TABLE public\.(\w+)\s+ADD CONSTRAINT (\w+)\s+(CHECK|UNIQUE|PRIMARY KEY)\s*\(/i.exec(
              sql,
            );
          if (addCon) {
            const tm = tables.get(addCon[1].toLowerCase());
            if (!tm) throw new Error(`ADD CONSTRAINT 目标表不存在：${addCon[1]}（${entry.file}）`);
            const cname = addCon[2];
            const kind = addCon[3].toUpperCase();
            const openIdx = addCon.index + addCon[0].length - 1;
            const bal = sliceBalanced(sql, openIdx);
            if (kind === 'CHECK') {
              pushCheck(tm.name, { op: 'add', name: cname, text: bal.text });
            } else if (kind === 'UNIQUE') {
              tm.namedUnique.set(cname, splitColumns(bal.text));
            } else {
              tm.tablePk = splitColumns(bal.text);
            }
          } else {
            const dropCon =
              /^\s*ALTER TABLE public\.(\w+)\s+DROP CONSTRAINT (?:IF EXISTS\s+)?(\w+)/i.exec(sql);
            if (dropCon) {
              const tm = tables.get(dropCon[1].toLowerCase());
              if (tm) {
                pushCheck(tm.name, { op: 'drop', name: dropCon[2], text: '' });
                tm.namedUnique.delete(dropCon[2]);
              }
            }
          }
        }

        const idxM =
          /^\s*CREATE (UNIQUE\s+)?INDEX (?:IF NOT EXISTS\s+)?(\w+)\s+ON (?:public\.)?(\w+)\s*\(/i.exec(
            sql,
          );
        if (idxM) {
          const openIdx = idxM.index + idxM[0].length - 1;
          const bal = sliceBalanced(sql, openIdx);
          const whereM = /\bWHERE\s+([\s\S]+)$/i.exec(sql.slice(bal.end));
          uniqueIndexes.push({
            name: idxM[2].toLowerCase(),
            table: idxM[3].toLowerCase(),
            columns: splitColumns(bal.text),
            partialWhere: whereM ? whereM[1].replace(/\s+/g, ' ').trim() : null,
          });
        }
      }

      for (const refM of sql.matchAll(/REFERENCES\s+public\.(\w+)/gi)) {
        if (currentCreate) {
          fkRefs.push({ table: currentCreate, refTable: refM[1].toLowerCase(), mi, si });
        }
      }
    }

    const downSqls = await collectSql(entry.mod, 'down');
    downDrops.set(
      entry.version,
      downSqls
        .map((s) => /^\s*DROP TABLE (?:IF EXISTS\s+)?public\.(\w+)/i.exec(s)?.[1]?.toLowerCase())
        .filter((n): n is string => Boolean(n)),
    );
  }

  return {
    tables,
    creationOrder: [...tables.keys()],
    uniqueIndexes,
    fkRefs,
    checkEvents,
    downDrops,
  };
}

/** 具名 CHECK 的「当前有效」定义：按事件流合并，最近一次 ADD 胜出；被 DROP 后为 null */
export function effectiveCheck(model: DdlModel, table: string, name: string): string | null {
  let text: string | null = null;
  for (const ev of model.checkEvents.get(table) ?? []) {
    if (ev.name !== name) continue;
    text = ev.op === 'add' ? ev.text : null;
  }
  return text;
}

/** 列 NOT NULL 判定：显式 NOT NULL、列级 PRIMARY KEY、表级 PRIMARY KEY 成员均计 */
export function isNonNull(model: DdlModel, table: string, column: string): boolean {
  const tm = model.tables.get(table);
  if (!tm) return false;
  if (tm.tablePk?.includes(column)) return true;
  const defs = tm.columns.get(column) ?? [];
  return defs.some((d) => /\bNOT NULL\b/i.test(d) || /\bPRIMARY KEY\b/i.test(d));
}

export function uniqueIndexOf(model: DdlModel, name: string): UniqueIndexFact | undefined {
  return model.uniqueIndexes.find((u) => u.name === name);
}

/** 主键在场判定：表级 PRIMARY KEY 或任一列级 PRIMARY KEY */
export function hasPrimaryKey(tm: TableModel): boolean {
  if (tm.tablePk !== null) return true;
  for (const defs of tm.columns.values()) {
    if (defs.some((d) => /\bPRIMARY KEY\b/i.test(d))) return true;
  }
  return false;
}
