/**
 * 身份与会话域 HTTP 契约类型
 *
 * 端点事实基线：docs/specification/接口清单-HTTP端点-v1.0.md §4
 * 权威逻辑：docs/specification/接口契约-v1.0.md（IFC-SM-001~003）
 * 实现规则：docs/specification/接口实现规格-v1.0.md §5（API-AUTH-001~004）
 */

/** 工作空间角色（清单 §4 GET /api/me/clubs 角色枚举） */
export type WorkspaceRole =
  | 'super_admin'
  | 'club_leader'
  | 'hr'
  | 'department_leader'
  | 'interviewer'
  | 'member'
  | 'applicant';

/** GET /api/auth/session 响应 data.user */
export interface AuthUser {
  id: string;
  studentId: string;
  name: string;
  email: string;
  phone: string;
  avatar: string | null;
  emailVerified: boolean;
  profileComplete: boolean;
}

export interface ProfileGate {
  complete: boolean;
  emailVerified: boolean;
}

export interface AuthWorkspace {
  clubId: string;
  clubName: string;
  role: WorkspaceRole;
  permissions: string[];
  memberId?: string;
}

/** GET /api/auth/session 响应 data */
export interface AuthSession {
  user: AuthUser;
  profileGate: ProfileGate;
  degraded: boolean;
  degradedSince: string | null;
  permissions: string[];
  workspace: AuthWorkspace | null;
}

/** 资料同步状态（GET/PUT /api/auth/profile） */
export interface ProfileSyncStatus {
  email: 'synced';
  phone: 'pending' | 'synced';
}

/** GET /api/auth/profile 响应 data */
export interface Profile {
  version: number;
  studentId: string;
  name: string;
  email: string;
  phone: string;
  emailVerified: boolean;
  profileComplete: boolean;
  syncStatus: ProfileSyncStatus;
}

/** PUT /api/auth/profile 请求信封 input */
export interface SaveProfileInput {
  email?: string;
  phone?: string;
}

/** POST /api/auth/profile/send-email-code 响应 data */
export interface EmailCodeSent {
  sent: boolean;
  /** 秒 */
  expiresIn: number;
}

/** POST /api/auth/profile/verify-email 响应 data */
export interface EmailVerifiedResult {
  emailVerified: boolean;
}

/** POST /api/auth/profile/sync-conflict 请求 input */
export interface ProfileSyncConflictInput {
  field: 'name' | 'email' | 'phone' | 'studentId';
  chosenValue: string;
}

/** POST /api/auth/profile/sync-conflict 响应 data */
export interface ProfileSyncConflictResolution {
  studentId: string;
  name: string;
  email: string;
  phone: string;
  emailVerified: boolean;
  profileComplete: boolean;
}

/** POST /api/auth/reauth 响应 data */
export interface ReauthProof {
  proof: string;
  expiresAt: string;
}

/** GET /api/auth/casdoor/login-url 响应 data */
export interface CasdoorLoginUrl {
  loginUrl: string;
}

/** GET /api/me/clubs 响应 data */
export interface MeClubsResult {
  clubs: Array<{
    clubId: string;
    clubName: string;
    role: WorkspaceRole;
  }>;
}
