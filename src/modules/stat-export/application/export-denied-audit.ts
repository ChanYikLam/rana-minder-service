/**
 * 拒绝路径审计辅助（STAT-002 可追踪约束）。
 *
 * 端口契约（ports/export-authorization.port.ts ExportAuditPort）声明
 * "允许/拒绝均记录，特权更须留痕"，outcome 亦支持 'denied'；全链路须同时记录
 * allowed 与 denied——越权导出尝试（IFC-ERR-003/004）、停用封锁（IFC-ERR-006）、
 * 重认证不足（IFC-ERR-002）、幂等冲突（IFC-ERR-009）等安全相关拒绝在审计日志无痕迹，
 * 无法回溯滥用/攻击尝试。本助手统一构造 outcome='denied' 的审计条目，
 * 供申请/重试/删除命令与下载控制器共用，保证拒绝留痕口径一致。
 *
 * reason 取 ExportError 的稳定错误码 + 面向用户的可披露消息（errors.ts 契约），
 * 不包含敏感数据，可安全落审计。
 */

import type {
  ExportAuditAction,
  ExportAuditEntry,
  ExportPrincipal,
} from './ports/export-authorization.port';
import { ExportError } from './errors';

/** 构造一条拒绝（denied）审计条目 */
export function deniedAuditEntry(
  at: string,
  action: ExportAuditAction,
  ref: {
    readonly principal: ExportPrincipal | null;
    /** principal 未解析时的兜底身份（如控制器仅有 actor.userId） */
    readonly fallbackPrincipalId?: string;
    readonly clubId: string | null;
    readonly jointActivityId: string | null;
    readonly datasetType: string | null;
    readonly exportId: string | null;
    readonly purpose: string | null;
  },
  err: ExportError,
): ExportAuditEntry {
  return {
    at,
    action,
    principalId: ref.principal?.userId ?? ref.fallbackPrincipalId ?? 'unknown',
    privileged: ref.principal?.kind === 'platform_super_admin',
    clubId: ref.clubId,
    jointActivityId: ref.jointActivityId,
    datasetType: ref.datasetType,
    exportId: ref.exportId,
    purpose: ref.purpose,
    outcome: 'denied',
    reason: `${err.code}: ${err.message}`,
  };
}
