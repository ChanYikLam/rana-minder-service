import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SearchNormalizer } from './search-normalizer';
import { VisibilityDerivationRules } from './visibility-derivation';

describe('SearchNormalizer（C6.6 规范化固定顺序）', () => {
  const n = new SearchNormalizer();

  it('顺序：NFC → 折叠 → NFC → 去首尾空白 → 内部压缩为 U+0020', () => {
    assert.equal(n.normalize('  招聘   新成员  '), '招聘 新成员');
    // 全角/半角不折叠（规范 C6.6：不折叠标点、简繁体、全角/半角）
    assert.equal(n.normalize('ＡＢＣ'), 'ａｂｃ');
    assert.equal(n.normalize('ABC'), 'abc'); // 大小写折叠
    assert.equal(n.normalize('  a\t b \n c  '), 'a b c'); // 内部空白压缩
  });

  it('不足 3 个有效字符不启用近似层（C6.3/C6.14 阈值边界）', () => {
    assert.equal(n.isApproxCandidateEnabled(''), false);
    assert.equal(n.isApproxCandidateEnabled('  ab '), false);
    assert.equal(n.isApproxCandidateEnabled('招聘'), false); // 2 个有效字符
    assert.equal(n.isApproxCandidateEnabled('abc'), true);
    assert.equal(n.isApproxCandidateEnabled('  招聘会 '), true); // 规范化后 3 字符
  });
});

describe('VisibilityDerivationRules（C1.1 字段边界 + C6.8 发布过滤）', () => {
  const v = new VisibilityDerivationRules();
  const now = '2026-08-17T12:00:00.000Z';

  const base = {
    published: true,
    channelOpen: true,
    paused: false,
    terminated: false,
    now,
    visitor: 'ANONYMOUS' as const,
  };

  it('未发布 / 通道关闭 / 暂停 / 终态 / 截止已过 → 不可见', () => {
    assert.equal(v.derive({ ...base, published: false }).visible, false);
    assert.equal(v.derive({ ...base, channelOpen: false }).visible, false);
    assert.equal(v.derive({ ...base, paused: true }).visible, false);
    assert.equal(v.derive({ ...base, terminated: true }).visible, false);
    assert.equal(
      v.derive({ ...base, deadlineAt: '2026-08-17T11:00:00.000Z' }).visible,
      false,
    );
  });

  it('截止晚于服务端时刻 → 可见（半开区间语义）', () => {
    assert.equal(v.derive({ ...base, deadlineAt: '2026-08-18T00:00:00.000Z' }).visible, true);
  });

  it('字段投影按访问者类型收紧（C1.1：匿名最小、管理最多、绝不扩大）', () => {
    const anonymous = v.derive(base).projectedFields;
    const admin = v.derive({ ...base, visitor: 'CLUB_ADMIN' }).projectedFields;
    assert.ok(anonymous.includes('id') && anonymous.includes('name'));
    assert.ok(!anonymous.includes('status'));
    assert.ok(admin.includes('status'));
    // 匿名投影字段数 ≤ 管理投影字段数（绝不扩大）
    assert.ok(anonymous.length <= admin.length);
  });
});
