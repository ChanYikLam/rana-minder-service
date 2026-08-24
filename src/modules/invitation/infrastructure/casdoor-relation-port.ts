import { Injectable } from '@nestjs/common';

/** Casdoor 关系适配注入令牌（CasdoorRelationPort 为接口，注入须用显式 token） */
export const CASDOOR_RELATION_PORT = Symbol('CASDOOR_RELATION_PORT');

/** Casdoor 写入+回读结果（JNT-016、ORG-027） */
export interface CasdoorRelationResult {
  /** 写入/回读整体成功 */
  readonly ok: boolean;
  /** 定向回读确认（未确认不开放权限） */
  readonly confirmed: boolean;
  /** 技术原因（脱敏） */
  readonly reason?: string;
}

/** 组合关系回读结果（MEM-018/ORG-027：社团 Group + 可选初始部门分别确认） */
export interface CasdoorCompositeResult {
  /** 社团 Group 回读确认 */
  readonly groupConfirmed: boolean;
  /** 初始部门回读确认（未指定部门时恒为 true） */
  readonly departmentConfirmed: boolean;
  /** 技术原因（脱敏） */
  readonly reason?: string;
}

/**
 * Casdoor 写后定向读回确认端口（ADR-009、IFC-TX-003）。
 *
 * 接受邀请后成员权限正式生效前，必须经 Casdoor 社团 Group 写入并**回读确认**；
 * 未回读确认前页面显示"成员身份生效处理中"，不得开放成员权限（REC-026、ORG-027）。
 * 常规入社邀请（MEM-004）使用组合关系：社团及可选部门**全部回读确认**才成功。
 */
export interface CasdoorRelationPort {
  /** 写入社团 Group 并回读确认 */
  writeAndReadBackGroup(clubId: string, principalId: string): Promise<CasdoorRelationResult>;
  /** 写入社团 Group 及可选初始部门并分别回读（组合；部分确认时按组合补偿） */
  writeAndReadBackRelations(
    clubId: string,
    principalId: string,
    departmentId?: string | null,
  ): Promise<CasdoorCompositeResult>;
}

/** 占位实现（开发期直接确认；真实接入由 3.3 Casdoor 适配/适配器模块提供） */
@Injectable()
export class DefaultCasdoorRelationPort implements CasdoorRelationPort {
  async writeAndReadBackGroup(
    _clubId: string,
    _principalId: string,
  ): Promise<CasdoorRelationResult> {
    // 开发期占位：直接确认（生产由 Casdoor 适配器写入并回读）
    return { ok: true, confirmed: true };
  }

  async writeAndReadBackRelations(
    _clubId: string,
    _principalId: string,
    _departmentId?: string | null,
  ): Promise<CasdoorCompositeResult> {
    // 开发期占位：社团与部门均直接确认
    return { groupConfirmed: true, departmentConfirmed: true };
  }
}
