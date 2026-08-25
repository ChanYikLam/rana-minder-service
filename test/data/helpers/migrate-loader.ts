/**
 * migrate.ts 惰性装载器（test/data 专用；共享硬约束的落地点）。
 *
 * 硬约束：本地 `pg` 不可解析，禁止静态 import 触及 pg 的文件。
 * migrate.ts 静态引用 postgres-db-adapter → `import { Pool } from 'pg'`，
 * 因此本文件绝不静态 import migrate.ts / postgres-db-adapter / pg：
 * - 先探测真实 pg（可解析则直接用，CI 场景）；
 * - 否则以 Module._resolveFilename 临时补丁把解析名 `pg` 重定向到内存桩
 *   （./pg-stub），让 migrate.ts 完整加载；补丁即装即卸，不影响其他模块；
 * - runMigrations 只消费 DbAdapter 形状方法、从不构造连接池，桩永不被实例化。
 *
 * 可选真库分支（DATA-MIG-real-01）由调用方以
 * `canResolvePg() && process.env.DATABASE_URL` 双条件探测后才执行。
 */

const MIGRATE_REL = '../../../src/database/migrate';

/** pg 是否可解析（探测一次的结果由调用方缓存） */
export function canResolvePg(): boolean {
  try {
    (eval('require') as NodeRequire)('pg');
    return true;
  } catch {
    return false;
  }
}

export interface MigrateModule {
  /** migrate.ts 的真实导出：runMigrations(db: PostgresDbAdapter)（此处结构化放宽为 unknown） */
  runMigrations: (db: unknown) => Promise<string[]>;
}

interface ResolveFilenameHost {
  _resolveFilename: (
    request: string,
    parent?: unknown,
    isMain?: boolean,
    options?: unknown,
  ) => string;
}

/**
 * 加载真实 runMigrations：
 * 返回 null 仅表示依赖链异常（正常环境不会发生），调用方应 t.skip 并说明原因。
 *
 * 双重闸门（缺一不可）：
 * 1. 运行时：Module._resolveFilename 把 `pg` 解析重定向到内存桩——本地未安装
 *    pg 包，运行期 require('pg') 必须有落点（runMigrations 不构造连接池，桩不被实例化）；
 * 2. 编译期：postgres-db-adapter.ts 的 `import { Pool } from 'pg'` 在 ts-node 默认
 *    类型检查管线中是编译期 TS2307——TypeScript 的模块类型解析不走 Node 解析钩子，
 *    运行时重定向救不了诊断。故装载 migrate.ts 子树期间临时把 require.extensions['.ts']
 *    换成 ts-node transpile-only 服务（只发射、不诊断），装完立即还原原处理器；
 *    类型正确性由独立 `npm run typecheck` 把守，此处只为绕开缺失的可选依赖。
 */
export function loadMigrate(): MigrateModule | null {
  const req = eval('require') as NodeRequire;
  if (canResolvePg()) {
    return req(MIGRATE_REL) as MigrateModule;
  }

  const ModuleCtor = req('module') as unknown as ResolveFilenameHost;
  let stubPath: string;
  try {
    stubPath = req.resolve('./pg-stub');
  } catch {
    return null;
  }
  const original = ModuleCtor._resolveFilename;
  if (typeof original !== 'function') {
    return null;
  }
  ModuleCtor._resolveFilename = function (request, parent, isMain, options) {
    return request === 'pg' ? stubPath : original.call(ModuleCtor, request, parent, isMain, options);
  };

  interface TranspileService {
    compile(input: string, filename: string, lineOffset?: number): string;
  }
  type TsHandler = (
    module: { _compile(code: string, filename: string): void },
    filePath: string,
  ) => void;
  type ExtensionsBag = Record<string, TsHandler | undefined>;

  // Node ≥22 起 `module` 内建不再暴露 .extensions；扩展表在 require 函数上
  // （require.extensions），兜底 Module._extensions。
  const extensionBag: ExtensionsBag =
    (req as { extensions?: ExtensionsBag }).extensions ??
    (ModuleCtor as unknown as { _extensions: ExtensionsBag })._extensions;
  const previousTsHandler = extensionBag['.ts'];
  try {
    const tsNode = req('ts-node') as { create(options: { transpileOnly: boolean }): TranspileService };
    const service = tsNode.create({ transpileOnly: true });
    extensionBag['.ts'] = (targetModule, filePath) => {
      const fsMod = req('node:fs') as typeof import('node:fs');
      targetModule._compile(service.compile(fsMod.readFileSync(filePath, 'utf8'), filePath), filePath);
    };
    return req(MIGRATE_REL) as MigrateModule;
  } catch {
    return null;
  } finally {
    if (previousTsHandler) {
      extensionBag['.ts'] = previousTsHandler;
    }
    ModuleCtor._resolveFilename = original;
  }
}
