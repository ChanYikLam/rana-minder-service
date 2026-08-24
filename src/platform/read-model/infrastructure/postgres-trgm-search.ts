/**
 * 搜索检索基础设施（C6.4/DATA-Q-009）。
 *
 * 权威近似层由 PostgreSQL `pg_trgm.word_similarity()` 执行：
 * - 方向：用户输入片段 → 权威名称连续范围；
 * - 阈值：**显式固定 0.6**（不得依赖数据库会话隐式默认值）；
 * - 排序：word_similarity() 降序 → 规范化名称稳定顺序 → 对象 UUID（C6.5）。
 *
 * 本文件提供检索端口契约与 PostgreSQL 实现模板（SQL 与索引 DDL）。
 * 数据源接入属基础设施任务：实现后经依赖注入替换占位（未接入时
 * 明确不可用，不伪造结果——IFC-QRY-009.8）。
 */

/** 检索命中 */
export interface SearchHit {
  readonly objectType: string;
  readonly objectId: string;
  /** 权威展示名称 */
  readonly name: string;
  /** 相似度（pg_trgm word_similarity，0..1） */
  readonly similarity: number;
}

/** 检索模式（C6.3 分层：精确/连续子串为直接命中；近似为第三层） */
export type SearchMode = 'EXACT' | 'SUBSTRING' | 'FUZZY';

/** 检索选项 */
export interface SearchIndexQuery {
  readonly mode: SearchMode;
  /** 已规范化的查询文本（SearchNormalizer 输出） */
  readonly normalizedQuery: string;
  readonly limit: number;
  /** 近似阈值（FUZZY 时显式传值，默认 0.6，不依赖 DB 隐式默认） */
  readonly fuzzyThreshold?: number;
}

/** 检索索引端口（infrastructure 实现；索引不得成为授权来源，IFC-DATA-012） */
export interface SearchIndexPort {
  search(query: SearchIndexQuery): Promise<readonly SearchHit[]>;
}

/** 近似阈值常量（与 pg_trgm 显式固定值一致；DATA-Q-009） */
export const FUZZY_SIMILARITY_THRESHOLD = 0.6;

/**
 * PostgreSQL pg_trgm 检索实现模板。
 *
 * 接入说明（基础设施任务）：read_model_search_index 为派生检索表，
 * normalized_name 由版本化规范化函数（NFC→折叠→NFC→去空白→压缩）生成，
 * HTTP/后台只提交原始文本（read-model README §6.1）。
 */
export class PostgresTrgmSearchRepository implements SearchIndexPort {
  /** 检索表 DDL（pg_trgm 扩展 + GIN 索引 + 规范化名称列） */
  static readonly DDL = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS read_model_search_index (
  object_type   text        NOT NULL,
  object_id     uuid        NOT NULL,
  name          text        NOT NULL,
  normalized_name text      NOT NULL,
  scope_json    jsonb       NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (object_type, object_id)
);

CREATE INDEX IF NOT EXISTS idx_rm_search_name_gin
  ON read_model_search_index USING GIN (normalized_name gin_trgm_ops);
`;

  /** 近似检索：word_similarity >= 显式阈值，排序固定（C6.5） */
  static readonly SQL_FUZZY = `
SELECT object_type, object_id, name,
       word_similarity($1, normalized_name) AS similarity
FROM read_model_search_index
WHERE word_similarity($1, normalized_name) >= $2
ORDER BY word_similarity($1, normalized_name) DESC, normalized_name, object_id
LIMIT $3;
`;

  /** 精确命中（C6.3 第一层） */
  static readonly SQL_EXACT = `
SELECT object_type, object_id, name, 1::float4 AS similarity
FROM read_model_search_index
WHERE normalized_name = $1
ORDER BY normalized_name, object_id
LIMIT $2;
`;

  /** 中文连续子串命中（C6.3 第二层） */
  static readonly SQL_SUBSTRING = `
SELECT object_type, object_id, name, 1::float4 AS similarity
FROM read_model_search_index
WHERE normalized_name LIKE '%' || $1 || '%'
ORDER BY normalized_name, object_id
LIMIT $2;
`;

  async search(_query: SearchIndexQuery): Promise<readonly SearchHit[]> {
    // 基础设施任务：注入数据源后执行对应 SQL 模板。
    // 未接入时明确不可用，不伪造结果（IFC-QRY-009.8）。
    throw new Error('IFC-ERR-UNAVAILABLE: PostgreSQL 检索索引未接入');
  }
}
