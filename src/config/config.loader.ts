import * as zod from 'zod';

export const appConfigSchema = zod.object({
  app: zod.object({
    port: zod.number().int().positive().default(3000),
  }),
  database: zod.object({
    url: zod.string().min(1).default('postgresql://localhost:5432/ranaminder'),
  }),
});

export type AppConfig = zod.infer<typeof appConfigSchema>;

/**
 * 加载单文件外置配置（ADR-010）。
 *
 * 首版最小实现：从环境变量读取并做结构校验；
 * 后续按 ADR-010 改为只读挂载的单文件配置 + 启动前结构校验
 * （未知字段、缺失必需项失败关闭）。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw = {
    app: { port: env.APP_PORT !== undefined ? Number(env.APP_PORT) : undefined },
    database: { url: env.DATABASE_URL },
  };
  return appConfigSchema.parse(raw);
}
