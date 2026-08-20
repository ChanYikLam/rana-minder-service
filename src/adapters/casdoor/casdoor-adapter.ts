/**
 * Casdoor 统一适配边界接口（adapters/casdoor/ 实现；ADR-009 §2.1）。
 *
 * 权威来源：src/adapters/casdoor/Casdoor适配文档.md。
 * 领域模块与后台任务只经本接口调用 Casdoor，不直接依赖 SDK/HTTP/响应结构；
 * 本接口只声明传输中立操作并返回规范化 ExternalResult。
 *
 * 约束：
 * - 写后定向读回是唯一成功收口（CAS-WR-006/007）；HTTP 成功/事件到达不得替代可信回读；
 * - 事件只触发可信刷新或对账，不是账号/字段当前值的最终权威快照（ADR-009 §2.5）；
 * - 服务账号凭据只保留在服务端；超时、限流、重试、熔断、脱敏与追踪由适配实现统一处理。
 */

import type { ExternalResult } from '../../common/contracts/external-result';

/** Casdoor 用户稳定主体与账号观测（CAS-READ-002/003） */
export interface CasdoorUser {
  readonly id: string;
  readonly name: string | null;
  /** 学号（稳定主体字段） */
  readonly studentId: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly college: string | null;
  readonly grade: string | null;
  /** 账号当前状态（ACTIVE/DISABLED/DELETED/UNVERIFIABLE 由适配映射） */
  readonly state: string;
  /** 外部可验证版本/更新时间（仅作观测证据） */
  readonly externalVersion: string | null;
}

/** Casdoor 用户资料字段写回补丁（CAS-WR-*） */
export interface CasdoorUserPatch {
  readonly email?: string;
  readonly phone?: string;
  readonly college?: string;
  readonly grade?: string;
}

export interface CasdoorAdapter {
  /** 读取用户当前观测（CAS-READ-002/003；账号状态/资料字段的事实来源） */
  getUser(userId: string): Promise<ExternalResult<CasdoorUser>>;
  /** 资料字段写回（CAS-WR-*；写后定向读回由调用方按 CAS-REC-001 收口） */
  updateUser(userId: string, patch: CasdoorUserPatch): Promise<ExternalResult<void>>;
}
