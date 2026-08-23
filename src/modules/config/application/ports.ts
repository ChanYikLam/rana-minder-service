/**
 * config 应用层端口（CFG-001，5.5.1；依赖倒置边界）。
 *
 * - ClubProfileRepositoryPort：展示资料聚合持久化（当前 InMemory，PostgreSQL 仓储
 *   随 CFG-002~005 切片接入）；
 * - ClubProfileAuthorizationPort：管理授权判定，返回管理身份而非布尔——'OWNER'
 *   （负责人/人事，含 club:config:manage）或 'PLATFORM'（平台超管代改），null 即
 *   无权（fail-closed）。由实现方负责映射 PermissionCatalog 与超管判定，用例据此
 *   推导 onBehalf 留痕语义，不采纳请求方自报的「代改」声明；
 * - ClubMembershipPort：社团成员资格判定（公开投影三级可见范围用）；
 * - ClubAccessInfoPort：Casdoor Group 绑定对应关系查询（超管后台展示「展示名↔Group
 *   名」对照；接入信息归组织模块，本模块只读回显、不保存）。
 *
 * DI token 字符串常量统一定义在 ../tokens.ts（与 recruitment 模块约定一致）。
 */

import type { ClubProfileSnapshot } from '../domain/models/club-profile';

/** 展示资料仓储端口：按社团 ID 存取聚合快照 */
export interface ClubProfileRepositoryPort {
  load(clubId: string): Promise<ClubProfileSnapshot | null>;
  save(snapshot: ClubProfileSnapshot): Promise<void>;
}

/** 管理身份：OWNER=负责人/人事本人修改；PLATFORM=平台超管代改 */
export type ClubProfileManageRole = 'OWNER' | 'PLATFORM';

export interface ClubProfileAuthorizationPort {
  /** 返回主体对该社团展示资料的管理身份；无权返回 null（不抛错，由用例转 CFG_FORBIDDEN） */
  canManageAs(clubId: string, subjectId: string): Promise<ClubProfileManageRole | null>;
}

export interface ClubMembershipPort {
  isMember(clubId: string, subjectId: string): Promise<boolean>;
}

/** Casdoor Group 绑定对应关系（只读回显）；组织模块暴露绑定查询前恒为 null */
export interface ClubAccessInfoPort {
  getAccessInfo(clubId: string): Promise<{
    casdoorGroupId: string;
    casdoorGroupName: string;
  } | null>;
}
