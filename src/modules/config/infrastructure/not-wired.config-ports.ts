/**
 * config 跨模块能力端口的未接线桩（infrastructure）。
 *
 * 语义对齐 joint/membership 既有约定（NotWiredJointNotification 等）：3.x 通知
 * 事实同事务接线与审计写入器共享事务接线落地前，先以端口接缝固化调用点——
 * 命令层在变更成功后必须 await 端口（NotWired 即时返回）；届时替换 DI 绑定，
 * 命令与测试不改。
 *
 * - NotWiredConfigNotification：CFG-002/005 权益影响通知（NTF-002/NTF-005）
 * - NotWiredConfigAudit：CFG-001 展示资料修改审计、CFG-003 分界规则变更审计
 */

import type { ClubProfileFieldChange } from '../domain/models/club-profile';
import type { PolicyKey } from '../domain/models/scoped-policy';
import type { ConfigKind } from '../domain/models/config-version';

/** 权益影响通知端口（CFG-002/CFG-005；IFC-TX-002 同事务语义随 3.x 接线收口） */
export interface ConfigNotificationPort {
  /** 策略默认值变化且该键 affectsStudentRights=true 时必须通知受影响学生 */
  notifyPolicyChange(input: {
    scope: 'PLATFORM' | 'CLUB';
    clubId: string | null;
    key: PolicyKey;
    oldValue: number;
    newValue: number;
    changedBy: string;
    effectiveAt: Date;
  }): Promise<void>;

  /** 配置版本发布改变学生权益或管理员权限时必须通知 */
  notifyConfigPublished(input: {
    rootId: string;
    kind: ConfigKind;
    versionNumber: number;
    publishedBy: string;
    highRisk: boolean;
  }): Promise<void>;
}

export class NotWiredConfigNotification implements ConfigNotificationPort {
  async notifyPolicyChange(): Promise<void> {
    /* noop until 3.x notification-facts wiring（NTF-002） */
  }
  async notifyConfigPublished(): Promise<void> {
    /* noop until 3.x notification-facts wiring（NTF-005/CFG-005） */
  }
}

/** 配置审计端口（CFG-001 修改留痕和审计；CFG-003 分界规则变更须审计） */
export interface ConfigAuditPort {
  recordProfileChange(input: {
    clubId: string;
    by: string;
    onBehalf: boolean;
    at: Date;
    changes: readonly ClubProfileFieldChange[];
  }): Promise<void>;

  recordBoundaryChange(input: {
    by: string;
    at: Date;
    from: { month: number; day: number; timeZone: string };
    to: { month: number; day: number; timeZone: string };
  }): Promise<void>;
}

export class NotWiredConfigAudit implements ConfigAuditPort {
  async recordProfileChange(): Promise<void> {
    /* noop until shared-transaction audit wiring（AUD-003 同事务契约收口） */
  }
  async recordBoundaryChange(): Promise<void> {
    /* noop until shared-transaction audit wiring（CFG-003 变更审计收口） */
  }
}
