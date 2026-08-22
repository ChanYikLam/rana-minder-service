/**
 * 外部依赖最近结果记录装饰器（adapters/dep-latest/decorators.ts；T3）。
 *
 * 职责：把真实外部适配器（casdoor / mail / file-check / notify / backup）的每次
 * 外部 I/O 结果回填到 DepLatestRecorder，供 observability 状态页 DepLatestPort 读取。
 *
 * 边界：
 * - 只记录观测事实，不改变适配器返回结果；
 * - 成功/失败按规范化结果分类；错误摘要脱敏；
 * - 桩/未启用时不包装（无真实 I/O，不记录）。
 */

import type { CasdoorAdapter } from '../casdoor/casdoor-adapter';
import type { MailChannelAdapter } from '../mail/mail-channel-adapter';
import type { FileCheckPort } from '../../modules/file/infrastructure/file-check-port';
import type { NotifyAdapter } from '../notify/external-notify.adapter';
import type { BackupReportPort } from '../../platform/observability/backup-report/backup-report';
import type { DepLatestRecorder } from './dep-latest-recorder';
import type { DepName } from '../../platform/observability/status-page/dep-latest';
import type { ExternalResult } from '../../common/contracts/external-result';

function failed(result: ExternalResult<unknown>): boolean {
  return result.status !== 'SUCCESS' && result.status !== 'PARTIAL' && result.status !== 'CONFLICT';
}

function record(recorder: DepLatestRecorder, dep: DepName, result: ExternalResult<unknown>): void {
  recorder.record({
    dep,
    lastCheckedAt: result.timestamp,
    lastResult: failed(result) ? 'failure' : 'success',
    ...(failed(result) && result.error ? { lastError: result.error.message } : {}),
  });
}

/** 包装 Casdoor 适配器并记录结果。 */
export function trackCasdoor(base: CasdoorAdapter, recorder: DepLatestRecorder): CasdoorAdapter {
  return {
    async getUser(userId) {
      const r = await base.getUser(userId);
      record(recorder, 'casdoor', r);
      return r;
    },
    async updateUser(userId, patch) {
      const r = await base.updateUser(userId, patch);
      record(recorder, 'casdoor', r);
      return r;
    },
  };
}

/** 包装 Mail 适配器并记录结果。 */
export function trackMail(
  base: MailChannelAdapter,
  recorder: DepLatestRecorder,
): MailChannelAdapter {
  return {
    async sendVerificationEmail(input) {
      const r = await base.sendVerificationEmail(input);
      record(recorder, 'mail', r);
      return r;
    },
  };
}

/** 包装 FileCheck 适配器并记录结果（FileCheckResult 非 ExternalResult，转记录成功/失败）。 */
export function trackFileCheck(base: FileCheckPort, recorder: DepLatestRecorder): FileCheckPort {
  return {
    async check(file, bytes, declaredType) {
      const r = await base.check(file, bytes, declaredType);
      recorder.record({
        dep: 'file-check',
        lastCheckedAt: new Date(),
        lastResult: r.outcome === 'PASSED' ? 'success' : 'failure',
        ...(r.outcome !== 'PASSED' ? { lastError: r.sanitizedResult } : {}),
      });
      return r;
    },
  };
}

/** 包装 Notify 适配器并记录结果。 */
export function trackNotify(base: NotifyAdapter, recorder: DepLatestRecorder): NotifyAdapter {
  return {
    async send(input) {
      const r = await base.send(input);
      record(recorder, 'notify', r);
      return r;
    },
  };
}

/** 包装 Backup 适配器并记录结果（成功/失败按是否有最近备份）。 */
export function trackBackup(base: BackupReportPort, recorder: DepLatestRecorder): BackupReportPort {
  return {
    async lastBackup() {
      const r = await base.lastBackup();
      recorder.record({
        dep: 'backup',
        lastCheckedAt: new Date(),
        lastResult: r ? 'success' : 'failure',
        ...(r ? {} : { lastError: 'no-backup-record' }),
      });
      return r;
    },
    async lastRestore() {
      return base.lastRestore();
    },
    async recentBackups(limit) {
      return base.recentBackups(limit);
    },
    async recentRestores(limit) {
      return base.recentRestores(limit);
    },
  };
}
