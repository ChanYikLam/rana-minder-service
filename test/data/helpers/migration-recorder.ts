/**
 * SQL 记录器假适配器（test/data 专用；驱动真实 runMigrations 的簿记演练）。
 *
 * 实现 migrate.ts 所消费的 PostgresDbAdapter 方法形状（结构化鸭子类型，
 * 不做 instanceof 校验），职责：
 * - 记录事务生命周期事件（begin/commit/rollback/set-rls/clear-rls）；
 * - 逐条记录全部 SQL 与参数（迁移 DDL 演练的核对素材）；
 * - 以内存 Set 模拟 schema_migrations 簿记：SELECT 返回已登记版本、
 *   INSERT ... 参数[0] 入账（与 migrate.ts 的 INSERT (version) VALUES ($1) 对齐）；
 * - failWhenSql 注入故障谓词（模拟第 N 条迁移执行失败），命中即抛错、
 *   该条 SQL 不入记录（对齐真实适配器"未执行即抛错"语义）。
 *
 * 不引入 pg/jose 依赖链，本地无 pg 可直接运行（参照 test/ops/helpers/recording-db.ts 口径）。
 */

export interface RecordedStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** 压平空白，供跨语句稳定比对（学习/注入匹配均基于归一化文本） */
export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function firstLine(sql: string): string {
  return sql.trim().split('\n')[0] ?? '';
}

export class MigrateRecordingDb {
  readonly events: string[] = [];
  readonly statements: RecordedStatement[] = [];
  /** 故障注入谓词（归一化 SQL 匹配）；null 表示不注入 */
  failWhenSql: ((normalizedSql: string) => boolean) | null = null;

  private readonly ledger = new Set<string>();

  async beginTransaction(): Promise<{ id: string }> {
    const tx = { id: `tx-${this.events.filter((e) => e.startsWith('begin:')).length + 1}` };
    this.events.push(`begin:${tx.id}`);
    return tx;
  }

  async commit(tx: { id: string }): Promise<void> {
    this.events.push(`commit:${tx.id}`);
  }

  async rollback(tx: { id: string }): Promise<void> {
    this.events.push(`rollback:${tx.id}`);
  }

  async setRlsContext(tx: { id: string }, scope: { kind: string }): Promise<void> {
    this.events.push(`set-rls:${tx.id}:${scope.kind}`);
  }

  async clearRlsContext(tx: { id: string }): Promise<void> {
    this.events.push(`clear-rls:${tx.id}`);
  }

  async query<T>(_tx: unknown, sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const normalized = normalizeSql(sql);
    if (this.failWhenSql && this.failWhenSql(normalized)) {
      this.events.push('inject-error');
      throw new Error(`注入失败（假适配器）：${firstLine(sql)}`);
    }
    this.events.push(`query#${this.statements.length}`);
    this.statements.push({ sql, params });

    if (/^INSERT INTO schema_migrations\b/i.test(normalized)) {
      this.ledger.add(String(params[0]));
      return [];
    }
    if (/SELECT version FROM schema_migrations/i.test(normalized)) {
      // migrate.ts 以 rows.map(r => r.version) 消费——必须返回行对象形状，
      // 裸字符串会让全部版本被读成 undefined、簿记形同虚设。
      return [...this.ledger].map((version) => ({ version })) as unknown as T[];
    }
    return [] as T[];
  }

  /** 簿记快照（保持入账顺序） */
  ledgerSnapshot(): string[] {
    return [...this.ledger];
  }

  /**
   * 清空簿记（操作员语义）：真实库中逆序 down 后由操作员执行
   * DELETE FROM schema_migrations / DROP TABLE，本方法等价该动作，
   * 用于验证清账后可全量重放重建（book-03）。
   */
  resetLedger(): void {
    this.ledger.clear();
  }
}

export interface VersionBlock {
  /** 该版本 up(runner) 发出的全部语句（不含簿记 INSERT） */
  readonly sqls: string[];
  /** 簿记 INSERT 次数（全新库恰为 1） */
  insertCount: number;
}

export interface DryRunResult {
  /** 前导簿记语句（CREATE TABLE IF NOT EXISTS schema_migrations 等） */
  prologueSqls: string[];
  /** 版本 → up 语句块（按应用顺序） */
  blocks: Map<string, VersionBlock>;
}

/**
 * 把一次完整 runMigrations 的语句流切分为「前导簿记 + 各版本 up 块」。
 *
 * 真实执行顺序是【先 up(runner)、后簿记 INSERT】（migrate.ts 循环体），
 * 因此版本 V 的 up 块 = 上一次簿记 INSERT 之后、V 自己的 INSERT 之前的全部
 * 非簿记语句；采用「pending 缓冲 + INSERT 到达时落账」的归位算法。
 */
export function splitByVersionBlocks(statements: readonly RecordedStatement[]): DryRunResult {
  const prologueSqls: string[] = [];
  const blocks = new Map<string, VersionBlock>();
  let pending: string[] = [];

  for (const stmt of statements) {
    const normalized = normalizeSql(stmt.sql);
    if (/^INSERT INTO schema_migrations\b/i.test(normalized)) {
      const version = String(stmt.params[0]);
      blocks.set(version, { sqls: pending, insertCount: 1 });
      pending = [];
      continue;
    }
    if (/schema_migrations/i.test(normalized)) {
      prologueSqls.push(stmt.sql);
      continue;
    }
    pending.push(stmt.sql);
  }
  if (pending.length > 0) {
    // 正常流程不会出现：末尾未落账的悬挂语句显式暴露
    prologueSqls.push(...pending.map((sql) => `-- 悬挂语句\n${sql}`));
  }
  return { prologueSqls, blocks };
}
