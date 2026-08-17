/**
 * 公开探索域 HTTP 契约类型
 *
 * 端点事实基线：docs/specification/接口清单-HTTP端点-v1.0.md §6
 * 逻辑契约：IFC-QRY-002（列表/搜索）、IFC-QRY-001（单对象详情）
 */

import type { FormField, FormVersion } from './forms.contracts';

/** 搜索命中分层 */
export type MatchLayer = 'exact' | 'substring' | 'fuzzy';

/** GET /api/explore/clubs 响应 item */
export interface ExploreClubItem {
  id: string;
  name: string;
  description: string;
  memberCount: number;
  logo: null;
  layer: MatchLayer;
}

/** GET /api/explore/clubs 响应 data */
export interface ExploreClubsResult {
  items: ExploreClubItem[];
  nextCursor: string | null;
}

export type ExploreActivityType = 'recruitment' | 'joint';

/** 公开活动目录 item（GET /api/explore/activities） */
export interface CatalogActivity {
  id: string;
  clubId: string;
  clubName: string;
  title: string;
  type: ExploreActivityType;
  status: string;
  /** 派生字段：channelStatus==='open' 且 status 非终态且 deadline > now */
  enrolling: boolean;
  deadline: string;
  description: string;
  layer: MatchLayer;
}

/** GET /api/explore/activities 响应 data */
export interface ExploreActivitiesResult {
  items: CatalogActivity[];
  history: CatalogActivity[];
  nextCursor: string | null;
  queryAt: string;
}

/** 普通招新活动公开详情（GET /api/explore/activities/:id） */
export interface ExploreRecruitmentActivityDetail {
  id: string;
  clubId: string;
  clubName: string;
  title: string;
  type: 'recruitment';
  status: string;
  channelStatus: string;
  historical: boolean;
  deadline: string;
  description: string;
  departments: Array<{ id: string; name: string }>;
  formId: string | null;
  eligibility: { colleges: string[]; grades: string[] };
  volunteerRules: { min: number; max: number };
  allowAdjustmentDefault: boolean;
}

/** 公开报名表单（GET /api/explore/activities/:id/form、/api/explore/joint/:id/form） */
export interface ExploreFormDetail {
  id: string;
  clubId: string | null;
  title: string;
  status: 'published';
  versions: FormVersion[];
}

/** 联合活动公开详情（GET /api/explore/joint/:id） */
export interface ExploreJointActivityDetail {
  id: string;
  title: string;
  type: 'joint';
  status: string;
  channelStatus: string;
  deadline: string;
  description: string;
  formId: string | null;
  sharedAgreement: string;
  clubs: Array<{ id: string; name: string; departments: Array<{ id: string; name: string }> }>;
  participants: Array<{ id: string; name: string }>;
  clubName: string;
}

export type { FormField };
