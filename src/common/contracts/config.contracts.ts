/**
 * 配置与统计 HTTP 契约类型
 *
 * 端点事实基线：docs/specification/接口清单-HTTP端点-v1.0.md §14.1/§14.2
 * 逻辑契约：配置版本不可变、已发布不可覆盖（SRS-SM-FORM? 不适用，见 data 文档 config_versions）
 */

/** GET /api/org/:clubId/config 响应 data */
export interface ClubConfig {
  clubName: string;
  clubDescription: string;
  requireEmailVerification: boolean;
  requireProfileComplete: boolean;
  maxMembers: number;
  allowSelfExit: boolean;
  /** 学年开始月份 */
  academicYearStart: number;
}

/** POST /api/org/:clubId/config 请求 input（任意键透传，后端按 ConfigSchema 校验） */
export type ClubConfigInput = Partial<ClubConfig>;

/** POST /api/org/:clubId/config 响应 data */
export interface ClubConfigSaved extends ClubConfig {
  version: number;
  savedAt: string;
}

/** 统计摘要 item */
export interface StatsSummaryItem {
  label: string;
  value: number;
  trend: 'up' | 'flat' | 'down';
  trendValue: number;
}

/** GET /api/org/:clubId/stats、GET /api/admin/stats 响应 data */
export interface StatsResult {
  summary: StatsSummaryItem[];
  departmentDistribution: Array<{ name: string; count: number }>;
}
