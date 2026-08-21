import { Injectable, Logger } from '@nestjs/common';
import type { FileAccessAction } from '../domain/services/access-policy';
import { maskPrincipal } from '../domain/services/watermark-policy';

/** 访问审计端口注入令牌（AccessAuditPort 为接口，注入须用显式 token） */
export const ACCESS_AUDIT_PORT = Symbol('ACCESS_AUDIT_PORT');

/**
 * 访问审计事件（GOV-008、AUD-004：下载及敏感附件预览记录审计；不含正文）。
 *
 * 注意：`principalId` 为完整主体标识，供合规审计存证（安全存放、受限访问）；
 * 凡**输出到日志/可视化**的路径一律经 `maskPrincipal` 脱敏，不得打印完整标识
 * （与水印侧 GOV-008 脱敏口径一致）。
 */
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
    // 日志输出脱敏：完整 principalId 仅用于合规存证，不写入日志（GOV-008）
    this.logger.log(
      `附件访问审计：action=${event.action}, principal=${maskPrincipal(event.principalId)}, ` +
        `file=${event.fileId}, sensitive=${event.sensitive}, at=${event.occurredAt}`,
    );
  }
}
