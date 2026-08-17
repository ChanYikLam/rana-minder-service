/**
 * 派生投影类型（read-model 支撑的可重建投影）。
 *
 * 权威依据：ADR-002 §2.2、系统架构总览 v1.0（派生入口与读模型）。
 * 本模块只承担这三类可重建投影；搜索/统计投影由 stat-export 等协作。
 */
export const ProjectionType = {
  /** 公开目录：未认证可读的"找社团"与"找活动"搜索入口（REC-047 语义） */
  PUBLIC_DIRECTORY: 'PUBLIC_DIRECTORY',
  /** 全局个人中心：聚合本人事项和当前仍有权的角色型事项（IFC-QRY-003） */
  PERSONAL_CENTER: 'PERSONAL_CENTER',
  /** 当前社团管理工作台：固定当前社团的管理数据入口（IFC-QRY-003） */
  CLUB_WORKBENCH: 'CLUB_WORKBENCH',
} as const;

export type ProjectionType = (typeof ProjectionType)[keyof typeof ProjectionType];

/**
 * 投影格式版本。
 *
 * 投影结构（字段布局/语义）变化时递增；旧格式版本的缓存、索引或投影
 * 不得冒充新格式结果（IFC-TX-008"旧水位不覆盖新结果"的格式侧约束）。
 */
export type ProjectionFormatVersion = string; // 形如 'v1'
