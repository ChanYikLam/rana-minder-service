import { Injectable, Logger } from '@nestjs/common';
import type { ObjectLocation } from '../domain/models/file-model';

/** 清理引用复核端口注入令牌（CleanupReferenceGuardPort 为接口，注入须用显式 token） */
export const CLEANUP_REFERENCE_GUARD = Symbol('CLEANUP_REFERENCE_GUARD');

/**
 * 物理删除前的引用复核端口（FORM-009、IFC-FIL-009）。
 *
 * 孤儿/受控清理逐项物理删除前，须确认目标对象**不再被任何有效访问路径引用**。
 * 本文件命令只持有待清理文件的 cleanupQueue，无法感知对象是否仍被其他活跃文件或
 * 有效访问路径引用（并发接管/绑定/替换竞争下的误删风险）。由仓储/审计层实现跨文件
 * 引用完整性检查：仍被引用的对象不得物理删除，保持待清理待后续复核。
 *
 * 占位实现默认无活动引用（开发期放行）；生产 PostgreSQL 仓储接入后，应基于
 * `(objectType, objectId, fieldKey)` 与对象定位做全库引用核对。
 */
export interface CleanupReferenceGuardPort {
  /**
   * 判断对象是否仍被有效访问路径/活跃文件引用。
   * @returns true = 仍被引用（不得物理删除）；false = 无有效引用（可安全删除）
   */
  hasActiveReference(location: ObjectLocation): Promise<boolean>;
}

/**
 * 占位实现：审计/仓储引用复核接入前的过渡实现。
 *
 * 占位期**默认 fail-closed（未知引用视为仍被引用）**：占位实现无法做全库引用完整性
 * 核对，若一律放行（视为无引用），则物理删除前的防御性引用复核在并发接管/绑定
 * 竞争下完全失效，可能误删仍被有效访问路径引用的原件（FORM-009）。
 * 因此占位期对任何对象保守判定为"仍被引用"（拒绝物理删除），
 * 待生产 PostgreSQL 仓储接入后基于全库引用做真实核对放行。
 */
@Injectable()
export class LogOnlyCleanupReferenceGuard implements CleanupReferenceGuardPort {
  private readonly logger = new Logger(LogOnlyCleanupReferenceGuard.name);

  async hasActiveReference(location: ObjectLocation): Promise<boolean> {
    // 占位：无法真实核对全库引用，故 fail-closed（视为仍被引用，拒绝物理删除）。
    // 生产接入真实引用完整性检查后，对确无引用的对象返回 false 放行。
    this.logger.log(
      `清理引用复核（占位 fail-closed）：role=${location.bucketRole}, kind=${location.objectKind}`,
    );
    return true;
  }
}
