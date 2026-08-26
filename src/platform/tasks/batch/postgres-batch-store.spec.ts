/**
 * PostgresBatchStore.save 冲突路径版本语义守卫（评审修复回归）。
 *
 * 语义契约：save 落库版本恒为 batch.version + 1（与 InMemoryBatchStore.save 一致）。
 * 插入路径经 $4 = batch.version + 1；冲突路径必须 version = EXCLUDED.version，
 * 不得再 +1（历史缺陷：EXCLUDED 已含 +1，叠加后落库 batch.version + 2）。
 *
 * 本地无 pg 运行时，无法真实执行 ON CONFLICT；此处对生成 SQL 做文本级守卫，
 * 锁定冲突分支不再叠加自增。真库行为由 test/integration（DATABASE_URL 存在时）覆盖。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('PostgresBatchStore.save 版本语义（评审回归）', () => {
  const sql = readFileSync(
    join(__dirname, 'postgres-batch-store.ts'),
    'utf8',
  );

  it('save 的 VALUES 插入值即 batch.version + 1（$4）', () => {
    assert.match(sql, /batch\.version \+ 1,/);
  });

  it('ON CONFLICT 分支 version = EXCLUDED.version，禁止再次自增', () => {
    const clause = /ON CONFLICT \(batch_id\) DO UPDATE SET([\s\S]*?)`,/.exec(sql)?.[1] ?? '';
    assert.match(clause, /version\s*=\s*EXCLUDED\.version\s*,/);
    assert.doesNotMatch(clause, /version\s*=\s*EXCLUDED\.version\s*\+/);
  });
});
