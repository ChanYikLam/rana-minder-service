/**
 * 展示可见范围投影策略（CFG-001，5.5.1；domain/services）。
 *
 * 三级可见范围：
 * - ANONYMOUS（未登录）：仅 名称/Logo/简介/公开招新说明；
 * - AUTHENTICATED（有效登录学生）：另加「主动公开」联系方式；
 * - MEMBER（本社团成员）：另加成员范围联系方式与内部说明。
 *
 * 硬性不变量：公开展示页不得含成员名单/部门关系/职位人员——投影结果
 * 结构性排除这些数据，且 projectPublic 断言输出键白名单。
 */

import type { ClubProfileSnapshot, ContactFieldSnapshot } from '../models/club-profile';

/** 观察者作用域：接口层由会话存在性与社团成员资格解析 */
export type ViewerScope = 'ANONYMOUS' | 'AUTHENTICATED' | 'MEMBER';

/** 公开基础信息（未登录即可见的部分） */
export interface PublicClubProfileView {
  readonly clubId: string;
  readonly displayName: string;
  readonly logoFileRef: string | null;
  readonly intro: string | null;
  readonly recruitmentNote: string | null;
}

/** 登录视图：公开视图 + 主动公开联系方式 */
export interface AuthenticatedClubProfileView extends PublicClubProfileView {
  readonly contacts: readonly ContactFieldSnapshot[];
}

/** 成员视图：登录视图 + 成员范围联系方式 + 内部说明 */
export interface MemberClubProfileView extends AuthenticatedClubProfileView {
  readonly internalNote: string | null;
}

/** 公开展示页允许的顶层键（CFG-001：不得含成员名单/部门关系/职位人员；导出供测试对照） */
export const PUBLIC_VIEW_ALLOWED_KEYS: readonly string[] = [
  'clubId',
  'displayName',
  'logoFileRef',
  'intro',
  'recruitmentNote',
];

function baseView(snapshot: ClubProfileSnapshot): PublicClubProfileView {
  return {
    clubId: snapshot.clubId,
    displayName: snapshot.displayName,
    logoFileRef: snapshot.logoFileRef,
    intro: snapshot.intro,
    recruitmentNote: snapshot.recruitmentNote,
  };
}

/**
 * 公开投影（公开展示页）：仅名称/Logo/简介/公开招新说明。
 *
 * 实现为「显式挑选五键」：快照中的联系方式/内部说明/修改历史等其余字段结构性
 * 不进入公开视图（CFG-001 公开展示页不得含成员名单/部门关系/职位人员）。
 */
export function projectPublicView(snapshot: ClubProfileSnapshot): PublicClubProfileView {
  return baseView(snapshot);
}

/** 按观察者作用域投影展示资料 */
export function projectClubProfile(
  snapshot: ClubProfileSnapshot,
  scope: ViewerScope,
): PublicClubProfileView | AuthenticatedClubProfileView | MemberClubProfileView {
  switch (scope) {
    case 'ANONYMOUS':
      return projectPublicView(snapshot);
    case 'AUTHENTICATED':
      return {
        ...baseView(snapshot),
        contacts: snapshot.contacts.filter((contact) => contact.visibility === 'PUBLIC'),
      };
    case 'MEMBER':
      return {
        ...baseView(snapshot),
        contacts: [...snapshot.contacts],
        internalNote: snapshot.internalNote,
      };
  }
}
