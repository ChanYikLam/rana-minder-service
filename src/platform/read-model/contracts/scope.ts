/**
 * 投影作用域（DATA-DER-001"源作用域"；IFC-QRY-009"作用域维度"）。
 *
 * 缓存键、投影记录与水位都必须携带 社团/协作域/主体/访问者 范围维度，
 * 防止跨作用域命中（read-model README §6.2：缓存键必须包含
 * 社团/协作域/访问者范围维度）。
 */
export interface ProjectionScope {
  /** 作用域类型：普通社团 / 联合域 / 平台 / 主体个人 */
  readonly kind: 'CLUB' | 'UNION' | 'PLATFORM' | 'SUBJECT';
  /** 普通社团作用域：社团稳定标识（UUIDv7） */
  readonly clubId?: string;
  /** 联合域作用域：联合域稳定标识 */
  readonly unionId?: string;
  /** 主体个人作用域：主体稳定标识（个人中心） */
  readonly subjectId?: string;
  /** 访问者类型（公开入口字段投影依据，见 VisitorType） */
  readonly visitor?: VisitorType;
}

/**
 * 访问者类型。
 *
 * 公开入口允许未认证读取，但输出必须按当前访问者类型执行字段投影
 * （read-model README §6.3）。
 */
export const VisitorType = {
  /** 未认证 */
  ANONYMOUS: 'ANONYMOUS',
  /** 已认证（普通用户） */
  AUTHENTICATED: 'AUTHENTICATED',
  /** 当前社团成员 */
  CLUB_MEMBER: 'CLUB_MEMBER',
  /** 当前社团管理角色 */
  CLUB_ADMIN: 'CLUB_ADMIN',
  /** 平台超级管理员 */
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
} as const;

export type VisitorType = (typeof VisitorType)[keyof typeof VisitorType];
