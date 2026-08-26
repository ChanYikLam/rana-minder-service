/**
 * 数据层集成测试 1/3：迁移清单完整性（DATA-MIG-list-*）。
 *
 * 枚举 src/database/migrations/*.ts，校验：
 * - 文件名时间戳前缀严格递增且唯一（migrate.ts 以字典序为应用顺序）；
 * - 每个模块导出 up/down 函数；
 * - 头注释「版本：<时间戳>」与文件名版本一致（名称与文件名一致性的仓库载体）。
 *
 * 运行：node --env-file=.env.test --test -r ts-node/register（枚举 test data 目录下全部 *.spec.ts；
 * 注意块注释内不得出现裸 glob——「**」后跟「/」会提前终止注释，见本文件历史缺陷）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import {
  MIGRATIONS_DIR,
  declaredVersionHeader,
  loadManifest,
  listMigrationFiles,
} from './helpers/migration-manifest';

const files = listMigrationFiles();
const versions = files.map((f) => f.slice(0, f.indexOf('_')));

describe('DATA-MIG-list 迁移清单完整性', () => {
  it('DATA-MIG-list-01: 清单非空且与目录枚举一致（migrate.ts 同一正则口径）', () => {
    assert.ok(files.length > 0, '迁移目录为空，清单演练失去对象');
    // 与 migrate.ts 载入口径一致：12~14 位时间戳前缀 + 下划线 + .ts/.js
    for (const file of files) {
      assert.match(file, /^\d{12,14}_[a-z0-9-]+\.(ts|js)$/, `文件名不合迁移命名约定: ${file}`);
    }
    const manifest = loadManifest();
    assert.equal(manifest.length, files.length);
    assert.deepEqual(
      manifest.map((e) => e.file),
      files,
      '装载顺序必须等于字典序（时间戳定宽 ⇒ 字典序==数值序）',
    );
  });

  it('DATA-MIG-list-02: 时间戳前缀严格递增且唯一', () => {
    assert.equal(new Set(versions).size, versions.length, '存在重复时间戳前缀的迁移文件');
    for (let i = 1; i < versions.length; i += 1) {
      assert.ok(
        versions[i - 1] < versions[i],
        `时间戳未严格递增: ${versions[i - 1]} !< ${versions[i]} (${files[i]})`,
      );
    }
    // 定宽校验：混入不同宽度前缀会让字典序失去数值含义
    for (let i = 0; i < versions.length; i += 1) {
      assert.match(versions[i], /^\d{14}$/, `时间戳前缀必须 14 位定宽: ${files[i]}`);
    }
  });

  it('DATA-MIG-list-03: 每个模块导出 up/down 且均为函数', async () => {
    const manifest = loadManifest();
    for (const entry of manifest) {
      assert.equal(typeof entry.mod.up, 'function', `${entry.file} 缺少 up(runner)`);
      assert.equal(typeof entry.mod.down, 'function', `${entry.file} 缺少 down(runner)`);
      // 冒烟：空执行器上 up/down 均可完整走通（不抛错）
      const noop = { query: async () => [] };
      await entry.mod.up(noop);
      await entry.mod.down(noop);
    }
  });

  it('DATA-MIG-list-04: 头注释「版本：」与文件名时间戳前缀一致（已知偏差仅限登记清单）', () => {
    // src/database/migrations/20260823130000_create-joint-tables.ts 头注释误写为
    // 20260823000000（与文件名不一致）。该文件在本次任务边界外不可修改，按
    // 现状固化口径登记为唯一已知偏差；出现新偏差即失败。
    const KNOWN_HEADER_DEVIATIONS: Record<string, string> = {
      '20260823130000_create-joint-tables.ts': '20260823000000',
    };
    for (const file of files) {
      const declared = declaredVersionHeader(path.join(MIGRATIONS_DIR, file));
      const timestamp = file.slice(0, file.indexOf('_'));
      if (KNOWN_HEADER_DEVIATIONS[file] !== undefined) {
        assert.equal(
          declared,
          KNOWN_HEADER_DEVIATIONS[file],
          `${file} 头注释版本偏离已登记的已知偏差值`,
        );
        continue;
      }
      assert.equal(
        declared,
        timestamp,
        `${file} 头注释 版本：(${declared}) 与文件名时间戳前缀 (${timestamp}) 不一致`,
      );
    }
  });
});
