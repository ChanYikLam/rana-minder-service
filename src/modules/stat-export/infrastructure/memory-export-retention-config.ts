/**
 * 内存导出有效期配置桩（开发与单测用，5.4.4，EXP-003）。
 *
 * 缺省 24h = DEFAULT_EXPORT_VALIDITY_MS；提供 setValidityMs 测试/管理入口，
 * 便于验证"期限由超管配置"语义（生产适配器接 config 服务后由配置中心下发）。
 */

import { DEFAULT_EXPORT_VALIDITY_MS } from '../domain/models/export-task';
import {
  EXPORT_RETENTION_CONFIG_PORT,
  type ExportRetentionConfigPort,
} from '../application/ports/export-retention-config.port';

export class MemoryExportRetentionConfig implements ExportRetentionConfigPort {
  private validityMs = DEFAULT_EXPORT_VALIDITY_MS;

  /** 测试/管理入口：覆盖当前生效的有效期（毫秒） */
  setValidityMs(validityMs: number): void {
    this.validityMs = validityMs;
  }

  async resolveValidityMs(): Promise<number> {
    return this.validityMs;
  }
}

export { EXPORT_RETENTION_CONFIG_PORT, DEFAULT_EXPORT_VALIDITY_MS };
