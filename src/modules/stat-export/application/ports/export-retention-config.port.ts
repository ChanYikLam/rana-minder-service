/**
 * 导出有效期配置端口（5.4.4，EXP-003：导出文件默认保留 24 小时，期限由超管配置）。
 *
 * 生成成功时由生成命令解析本端口得到 validityMs，传给任务聚合
 * markGenerationSucceeded 计算 expiresAt；过期扫描
 * （export-expiry-sweep.command）按 expiresAt 收敛。缺省 24h =
 * DEFAULT_EXPORT_VALIDITY_MS（86400000，与领域层单一来源一致）。
 *
 * 生产适配器接 config 服务（超管可配置项）；内存桩见 MemoryExportRetentionConfig，
 * 提供 setValidityMs 测试/管理入口。
 */

import { DEFAULT_EXPORT_VALIDITY_MS } from '../../domain/models/export-task';

export interface ExportRetentionConfigPort {
  /** 解析当前生效的导出有效期（毫秒）；缺省 24h（EXP-003） */
  resolveValidityMs(): Promise<number>;
}

export const EXPORT_RETENTION_CONFIG_PORT = Symbol('EXPORT_RETENTION_CONFIG_PORT');

/** 缺省有效期再导出（应用层消费方免于直接依赖领域模型路径亦可取到同一常量） */
export { DEFAULT_EXPORT_VALIDITY_MS };
