/**
 * 内存 `pg` 解析桩（test/data 专用；本地 pg 包不可安装/不可解析场景）。
 *
 * 背景：src/adapters/db/postgres-db-adapter.ts 静态 `import { Pool } from 'pg'`，
 * 而 migrate.ts 又静态引用该适配器。为在不触碰磁盘 pg 包的前提下加载真实
 * migrate.ts，migrate-loader 通过临时补丁把模块解析名 `pg` 重定向到本文件。
 *
 * 安全性：runMigrations 只消费 DbAdapter 形状的方法，从不构造 PostgresDbAdapter
 * （构造函数才会 `new Pool(...)`），故本桩永远不被实例化，仅需保证具名导出存在。
 */

/** 占位类型：仅供解析成功，测试路径不会实例化（runMigrations 不构造连接池）。 */
export class Pool {}
