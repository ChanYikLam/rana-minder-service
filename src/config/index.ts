/**
 * 配置层导出。入口：src/config。
 *
 * 类型 / 加载器 / DI 模块统一从本 barrel 导出；不导出 process.env 直接读取，
 * 调用方必须通过 RANA_MINDER_CONFIG token 注入并消费。
 */

export type {
  RanaMinderConfig,
  ServerConfig,
  DatabaseConfig,
  CasdoorConfig,
  StorageConfig,
  MailConfig,
  ObservabilityConfig,
  JobConfig,
} from './configuration';

export {
  ConfigLoadError,
  loadConfig,
  type LoadOptions,
} from './config.loader';

export {
  SecretRefError,
  isSecretRef,
  resolveSecret,
  type SecretRef,
} from './secret-ref';

export { RANA_MINDER_CONFIG } from './tokens';

export { ConfigurationModule } from './configuration.module';