/**
 * 联合审计端口（joint 应用层；纠错审计独立于成员流程，JNT-001/005）。
 *
 * 终态活动的纠错审计、已接受锁定结论的改写均经此端口留痕，不进入普通业务写命令。
 */

export interface JointAuditInput {
  readonly activityId: string;
  readonly actorId: string;
  readonly action: string;
  readonly target: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string;
  readonly at: Date;
}

export interface JointAuditPort {
  record(input: JointAuditInput): Promise<void>;
}

export class NotWiredJointAudit implements JointAuditPort {
  async record(): Promise<void> {
    /* noop until 3.x wiring */
  }
}
