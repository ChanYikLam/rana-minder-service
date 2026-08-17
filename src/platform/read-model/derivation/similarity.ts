/**
 * 近似相似度（C6.4/DATA-Q-009）。
 *
 * 权威说明：近似层由 PostgreSQL `pg_trgm.word_similarity()` 执行，
 * 方向为"用户输入片段 → 权威名称连续范围"，阈值显式固定 0.6，
 * 不得依赖数据库会话隐式默认值。
 *
 * 本模块为**应用侧降级/预览**实现（无 DB 时可用的确定性近似），
 * 不替代 PostgreSQL 权威近似；真实检索以基础设施实现为准。
 */
export interface SimilarityScorer {
  /** 相似度 0..1（方向：查询片段 → 权威名称） */
  similarity(query: string, candidateName: string): number;
}

/**
 * 降级实现：最长连续公共子串 / 查询长度（0..1）。
 *
 * 语义对齐"用户输入片段 → 权威名称连续范围"：查询文本在权威名称中
 * 的连续覆盖比例。仅用于分层排序的确定性近似，非权威 pg_trgm 值。
 */
export class LongestCommonSubstringScorer implements SimilarityScorer {
  similarity(query: string, candidateName: string): number {
    if (query.length === 0 || candidateName.length === 0) {
      return 0;
    }
    const lcs = longestCommonSubstring(query, candidateName);
    return lcs / query.length;
  }
}

/** 最长连续公共子串长度（简单动态规划，O(n*m)） */
function longestCommonSubstring(a: string, b: string): number {
  const dp: number[] = new Array(b.length + 1).fill(0);
  let max = 0;
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev + 1;
        max = Math.max(max, dp[j]);
      } else {
        dp[j] = 0;
      }
      prev = temp;
    }
  }
  return max;
}
