import { Injectable, Logger } from '@nestjs/common';
import type { FileAccessAction } from '../domain/services/access-policy';

/** 访问审计端口注入令牌（AccessAuditPort 为接口，注入须用显式 token） */
export const ACCESS_AUDIT_PORT = Symbol('ACCESS_AUDIT_PORT');

/** 访问审计事件（GOV-008、AUD-004：下载及敏感附件预览记录审计；脱敏，不含正文） */
export interface AccessAuditEvent {
  readonly action: FileAccessAction;
  readonly principalId: string;
  readonly fileId: string;
  /** 是否敏感附件（招新报名/面试材料等） */
  readonly sensitive: boolean;
  /** 一次性访问令牌（关联，不持久授权） */
  readonly token: string;
  readonly occurredAt: string;
}

/**
 * 访问审计端口（审计模块接入后持久化；本端口只提交脱敏事件）。
 */
export interface AccessAuditPort {
  report(event: AccessAuditEvent): Promise<void>;
}

/** 占位实现：脱敏日志（审计模块接入后替换为持久化审计） */
@Injectable()
export class LogOnlyAccessAudit implements AccessAuditPort {
  private readonly logger = new Logger(LogOnlyAccessAudit.name);

  async report(event: AccessAuditEvent): Promise<void> {
    this.logger.log(
      `附件访问审计：action=${event.action}, principal=${event.principalId}, ` +
        `file=${event.fileId}, sensitive=${event.sensitive}, at=${event.occurredAt}`,
    );
  }
}
