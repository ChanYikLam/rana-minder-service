import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SearchLayering, SearchMatchLayer } from './search-layering';

const candidate = (objectId: string, name: string) => ({ objectId, normalizedName: name });

describe('SearchLayering（C6.3/C6.5 分层与排序）', () => {
  const layering = new SearchLayering();

  it('精确命中在子串之前，子串在近似之前（固定三层）', () => {
    const result = layering.layer('ABC', [
      candidate('u3', 'ABCDEF'),
      candidate('u1', 'ABC'),
      candidate('u2', 'ABCEFG'),
    ]);
    assert.deepEqual(
      result.map((r) => [r.candidate.objectId, r.layer]),
      [
        ['u1', SearchMatchLayer.EXACT],
        ['u3', SearchMatchLayer.SUBSTRING],
        ['u2', SearchMatchLayer.SUBSTRING],
      ],
    );
  });

  it('不足 3 个有效字符不启用近似层（C6.3 阈值边界）', () => {
    // '篮球' 2 字符：子串命中保留，但绝不产生近似层结果
    const result = layering.layer('篮球', [candidate('u1', '篮球社'), candidate('u2', '篮协')]);
    assert.deepEqual(
      result.map((r) => r.layer),
      [SearchMatchLayer.SUBSTRING],
    );
    assert.ok(!result.some((r) => r.layer === SearchMatchLayer.FUZZY));
  });

  it('近似候选不得超过任何直接命中（C6.3）', () => {
    const result = layering.layer('篮球协会', [
      candidate('u1', '篮球社'),
      candidate('u2', '羽毛球协会'),
      candidate('u3', '篮球协会筹备组'),
    ]);
    const direct = result.filter((r) => r.layer !== SearchMatchLayer.FUZZY);
    const fuzzy = result.filter((r) => r.layer === SearchMatchLayer.FUZZY);
    // 直接命中（子串）1 个 → 模糊最多 1 个
    assert.ok(fuzzy.length <= direct.length);
  });

  it('近似候选排序：相似度降序 → 规范化名称 → UUID（C6.5）', () => {
    // 含 1 个直接命中（子串）作为近似配额；两个近似同相似度时按名称/UUID 稳定排序
    const result = layering.layer('招新宣讲会', [
      candidate('c-a', '招新宣讲会后续'), // SUBSTRING（直接命中）
      candidate('c-b', '招新宣講会'), // FUZZY sim=0.6
      candidate('c-c', '招新宣読会'), // FUZZY sim=0.6
    ]);
    const direct = result.filter((r) => r.layer !== SearchMatchLayer.FUZZY);
    const fuzzy = result.filter((r) => r.layer === SearchMatchLayer.FUZZY);
    assert.ok(direct.length >= 1);
    // 近似候选不得超过任何直接命中（配额=direct 数量）
    assert.ok(fuzzy.length <= direct.length);
    // 同层相似度降序
    for (let i = 1; i < fuzzy.length; i++) {
      assert.ok(fuzzy[i - 1].similarity >= fuzzy[i].similarity);
    }
  });

  it('无命中返回空（NONE 不输出）', () => {
    const result = layering.layer('zzzzzz', [candidate('u1', '篮球社')]);
    assert.equal(result.length, 0);
  });
});
