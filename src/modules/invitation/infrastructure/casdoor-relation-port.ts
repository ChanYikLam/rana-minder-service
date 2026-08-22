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

/**
 * Casdoor 写后定向读回确认端口（ADR-009、IFC-TX-003）。
 *
 * 接受邀请后成员权限正式生效前，必须经 Casdoor 社团 Group 写入并**回读确认**；
 * 未回读确认前页面显示"成员身份生效处理中"，不得开放成员权限（REC-026、ORG-027）。
 */
export interface CasdoorRelationPort {
  /** 写入社团 Group 并回读确认 */
  writeAndReadBackGroup(
    clubId: string,
    principalId: string,
  ): Promise<CasdoorRelationResult>;
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
}
