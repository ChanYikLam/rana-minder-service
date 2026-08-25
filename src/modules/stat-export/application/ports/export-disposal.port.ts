/**
 * 导出文件处置端口（5.4.4，AUD-009：删除对象存储文件）。
 *
 * 触发场景（均须清理已生成的导出文件，不得因任务状态收敛而残留可访问副本）：
 * - 申请人提前删除（export-delete.command byApplicant，转换 9）；
 * - 正式删除清单联动命中（applyFormalDelete / 失权撤销，转换 6/10，AUD-009）；
 * - 有效期到期清理（export-expiry-sweep.command，EXP-003）。
 *
 * 生产适配器接对象存储删除接口；内存桩见 InMemoryExportFileStore（记录 disposed
 * 引用供断言）。dispose 失败不阻断业务失效（调用方 best-effort + 留日志），残留
 * 文件由下一轮过期扫描或正式删除联动兜底（AUD-009 includeTerminal 已覆盖 EXPIRED）。
 */

export interface ExportDisposalPort {
  /** 按对象存储引用删除文件；引用不存在时视为已删除（幂等），不抛错 */
  dispose(fileRef: string): Promise<void>;
}

export const EXPORT_DISPOSAL_PORT = Symbol('EXPORT_DISPOSAL_PORT');
