/**
 * 跨模块同事务上下文（shared；ADR-004 §2.7 本地原子提交边界的跨模块扩展）。
 *
 * 背景：各领域模块的 UnitOfWork 各自 `db.beginTransaction()` 产生彼此独立的
 * TransactionContext，业务事务窗口内的跨模块写（审计 append、通知事实保存）
 * 无法复用同一事务提交/回滚。本文件提供进程内"当前业务事务"的传播通道：
 *
 * - 业务方（如 ConfigUnitOfWork.run）在事务窗口内经 runWithCrossModuleTx 登记
 *   当前事务与归属方；
 * - 跨模块适配器/仓储（audit/notification 持久层）在自开事务前先经
 *   borrowCrossModuleTx 探测：存在登记则直接借用该 TransactionContext 执行读写
 *   ——不 begin、不 commit/rollback、不覆盖 RLS 上下文，提交边界完全归持有者；
 *   借用段内任何失败沿原异常向上传播，由持有者整体回滚（AUD-003/IFC-TX-002
 *   同事务契约由此成立）。
 *
 * 传播基于 AsyncLocalStorage：同一异步链（一次 HTTP 请求 / 一个任务执行）
 * 内可见；并发请求、定时任务之间互不串扰。无登记时消费方保持既有行为
 * （自开短事务并原子收口），存量调用路径零变化。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { TransactionContext } from './db-adapter';

/** 已登记的跨模块事务帧：tx 由业务方 UoW 持有，owner 仅用于诊断断言 */
export interface CrossModuleTxFrame {
  readonly tx: TransactionContext;
  readonly owner: string;
}

const storage = new AsyncLocalStorage<CrossModuleTxFrame>();

/**
 * 在「以 tx 为当前跨模块事务」的作用域内执行 fn。
 * 业务方UnitOfWork 在事务窗口内调用；fn 抛错时原样上抛（登记自动随作用域销毁）。
 */
export function runWithCrossModuleTx<T>(
  owner: string,
  tx: TransactionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run({ tx, owner }, fn);
}

/**
 * 借用当前跨模块事务（消费者探测入口）。
 * 返回 null 表示当前不在任何业务事务作用域内——消费方应按既有方式自开短事务；
 * 返回帧时须直接使用 frame.tx 并放弃本地 begin/commit/rollback/RLS 干预。
 */
export function borrowCrossModuleTx(consumer: string): CrossModuleTxFrame | null {
  void consumer; // 参数保留用于日志诊断点（当前不打印；未来接入可观测性时不改签名）
  return storage.getStore() ?? null;
}
