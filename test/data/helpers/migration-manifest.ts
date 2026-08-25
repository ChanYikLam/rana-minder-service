/**
 * 迁移清单装载器（test/data 专用）。
 *
 * 与 src/database/migrate.ts 的 loadMigrationModules 保持同一枚举口径：
 * - 目录：src/database/migrations；
 * - 文件名过滤正则：/^(\d{12,14})_.*\.(ts|js)$/ 且排除 .d.ts；
 * - 字典序排序即应用顺序（时间戳前缀定宽，字典序==数值序）。
 *
 * 依赖边界：迁移模块本身只导出 up/down 纯函数（相互引用均为 `import type`，
 * 编译期擦除），不经 pg 依赖链，可在本地无 pg 环境安全动态加载——统一经
 * eval('require') 惰性解析，避免任何静态 import 触及 pg 链路文件。
 */

import { readdirSync } from 'node:fs';
import * as path from 'node:path';

/** 迁移目录（与 migrate.ts 的 MIGRATIONS_DIR 同源；ts-node 原地编译无 __dirname 漂移） */
export const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/database/migrations');

/** 与具体迁移工具解耦的最小查询执行器形状（同 migrate.ts MigrationQueryRunner） */
export interface MigrationRunnerLike {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/** 迁移模块最小形状（migrate.ts 允许 down 缺省；本仓库现状全部显式导出 down） */
export interface MigrationModuleLike {
  up(runner: MigrationRunnerLike): Promise<void>;
  down(runner: MigrationRunnerLike): Promise<void>;
}

export interface MigrationEntry {
  /** 文件名（含扩展名） */
  readonly file: string;
  /** 版本号 = 文件名去掉扩展名（migrate.ts 以此登记 schema_migrations.version） */
  readonly version: string;
  readonly mod: MigrationModuleLike;
}

const FILENAME_RE = /^(\d{12,14})_.*\.(ts|js)$/;

/** 枚举迁移文件（与 migrate.ts 同一过滤正则＋排序），返回按应用顺序排列的文件名 */
export function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => FILENAME_RE.test(f) && !f.endsWith('.d.ts'))
    .sort();
}

/** 版本号 = 文件名去扩展名（migrate.ts versionOfFile 同口径） */
export function versionOfFile(file: string): string {
  return file.replace(/\.(ts|js)$/, '');
}

/** 动态加载全部迁移模块（惰性 require，不静态触及任何 pg 链路文件） */
export function loadManifest(): MigrationEntry[] {
  const req = eval('require') as NodeRequire;
  return listMigrationFiles().map((file) => ({
    file,
    version: versionOfFile(file),
    mod: req(path.join(MIGRATIONS_DIR, file)) as MigrationModuleLike,
  }));
}

/** 用一次性记录执行器收集某模块 up/down 的全部 SQL 文本 */
export async function collectSql(
  mod: MigrationModuleLike,
  direction: 'up' | 'down',
): Promise<string[]> {
  const sqls: string[] = [];
  await mod[direction]({
    query: async (sql: string) => {
      sqls.push(sql);
      return [];
    },
  });
  return sqls;
}

/** 头注释中的「版本：<时间戳>」字段（名称与文件名一致性核对的载体） */
export function declaredVersionHeader(absFile: string): string | null {
  const fsMod: typeof import('node:fs') = eval('require')('node:fs');
  const text = fsMod.readFileSync(absFile, 'utf8');
  return text.match(/版本：(\d{12,14})/)?.[1] ?? null;
}
