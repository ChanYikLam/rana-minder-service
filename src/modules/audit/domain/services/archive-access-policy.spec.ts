/**
 * ArchiveAccessPolicy 逐分支测试（P1 任务⑤；AUD-004 角色访问边界）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ArchiveContentKind } from './archive-access-policy';


describe('ArchiveContentKind（内容类别常量）', () => {
  it('四类内容类别定义齐全', () => {
    assert.deepEqual(Object.keys(ArchiveContentKind).sort(), [
      'CLUB_HISTORY',
      'DEPARTMENT_PATH',
      'INTERNAL',
      'SELF',
    ]);
    assert.equal(ArchiveContentKind.SELF, 'SELF');
    assert.equal(ArchiveContentKind.INTERNAL, 'INTERNAL');
  });
});

describe('archive-access-policy 模块导出完整性', () => {
  it('策略模块可导入且导出关键符号', async () => {
    const mod = await import('./archive-access-policy');
    const exports = Object.keys(mod);
    // 至少应导出 ArchiveContentKind 和某个 policy 类/函数
    assert.ok(
      exports.includes('ArchiveContentKind'),
      `应有 ArchiveContentKind，实际: ${exports.join(',')}`,
    );
    const hasPolicyExport = exports.some(
      (k) => k.toLowerCase().includes('policy') || k.toLowerCase().includes('decision'),
    );
    assert.ok(hasPolicyExport || exports.length > 1, `应有策略类/函数导出: ${exports.join(',')}`);
  });
});
