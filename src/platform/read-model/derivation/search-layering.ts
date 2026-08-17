import { LongestCommonSubstringScorer } from './similarity';
import type { SimilarityScorer } from './similarity';

/**
 * 搜索匹配分层（C6.3/ADR-007 §8）。
 *
 * 固定三层，近似候选不得超过任何直接命中：
 * 1. EXACT    —— 稳定标识或名称精确命中；
 * 2. SUBSTRING—— 中文连续子串命中；
 * 3. FUZZY    —— 错别字近似候选（相似度 ≥ 阈值；不足 3 个有效字符不启用）。
 *
 * 近似候选排序固定（C6.5）：word_similarity() 降序 → 规范化名称稳定顺序
 * → 对象 UUID；不引入热度/个性化信号。
 */
export const SearchMatchLayer = {
  EXACT: 'EXACT',
  SUBSTRING: 'SUBSTRING',
  FUZZY: 'FUZZY',
  NONE: 'NONE',
} as const;

export type SearchMatchLayer = (typeof SearchMatchLayer)[keyof typeof SearchMatchLayer];

/** 搜索候选（权威名称必须已经规范化：SearchNormalizer.normalize 输出） */
export interface SearchCandidate {
  /** 对象稳定标识（UUID；排序次级键，IFC-DATA-001） */
  readonly objectId: string;
  /** 规范化后的权威名称（分层比较用） */
  readonly normalizedName: string;
}

/** 分层结果 */
export interface LayeredMatch {
  readonly candidate: SearchCandidate;
  readonly layer: SearchMatchLayer;
  /** 相似度 0..1（EXACT/SUBSTRING 恒为 1；FUZZY 为相似度值） */
  readonly similarity: number;
}

/**
 * 搜索分层规则（纯函数）。
 *
 * @param fuzzyThreshold 近似阈值（默认 0.6，与 pg_trgm 显式固定值一致）
 */
export class SearchLayering {
  constructor(
    private readonly scorer: SimilarityScorer = new LongestCommonSubstringScorer(),
    private readonly fuzzyThreshold = 0.6,
  ) {}

  /**
   * 对候选集分层并排序。
   *
   * @param normalizedQuery 已规范化的查询文本
   * @param candidates      候选集（名称已规范化）
   * @returns 非 NONE 的分层结果：EXACT → SUBSTRING → FUZZY；
   *          FUZZY 数量不超过直接命中（EXACT+SUBSTRING）数量；
   *          同层按 similarity 降序 → normalizedName → objectId。
   */
  layer(
    normalizedQuery: string,
    candidates: readonly SearchCandidate[],
  ): readonly LayeredMatch[] {
    const all = candidates.map((c) => this.classify(normalizedQuery, c));
    const exact = all.filter((r) => r.layer === SearchMatchLayer.EXACT);
    const substring = all.filter((r) => r.layer === SearchMatchLayer.SUBSTRING);
    // 不足 3 个有效字符不启用近似层（C6.3）
    const enableFuzzy = normalizedQuery.length >= 3;
    const fuzzy = enableFuzzy ? all.filter((r) => r.layer === SearchMatchLayer.FUZZY) : [];

    // 近似候选不得超过任何直接命中（C6.3）：fuzzy 数量 ≤ 直接命中数量
    const directCount = exact.length + substring.length;
    const cappedFuzzy = fuzzy.slice(0, Math.max(0, directCount));

    const rank = (layer: SearchMatchLayer, items: readonly LayeredMatch[]): LayeredMatch[] =>
      items
        .filter((r) => r.layer === layer)
        .sort(
          (a, b) =>
            b.similarity - a.similarity ||
            a.candidate.normalizedName.localeCompare(b.candidate.normalizedName) ||
            a.candidate.objectId.localeCompare(b.candidate.objectId),
        );

    return [...rank(SearchMatchLayer.EXACT, exact), ...rank(SearchMatchLayer.SUBSTRING, substring), ...rank(SearchMatchLayer.FUZZY, cappedFuzzy)];
  }

  private classify(normalizedQuery: string, candidate: SearchCandidate): LayeredMatch {
    if (candidate.normalizedName === normalizedQuery) {
      return { candidate, layer: SearchMatchLayer.EXACT, similarity: 1 };
    }
    if (candidate.normalizedName.includes(normalizedQuery)) {
      return { candidate, layer: SearchMatchLayer.SUBSTRING, similarity: 1 };
    }
    const similarity = this.scorer.similarity(normalizedQuery, candidate.normalizedName);
    if (similarity >= this.fuzzyThreshold) {
      return { candidate, layer: SearchMatchLayer.FUZZY, similarity };
    }
    return { candidate, layer: SearchMatchLayer.NONE, similarity };
  }
}
