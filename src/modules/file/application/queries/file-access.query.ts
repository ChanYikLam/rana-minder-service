import { Inject, Injectable } from '@nestjs/common';
import {
  AccessPolicy,
  FileAccessAction,
  FileAccessDeniedError,
} from '../../domain/services/access-policy';
import type { FileAccessContext, FileAccessRequest } from '../../domain/services/access-policy';
import { WatermarkPolicy } from '../../domain/services/watermark-policy';
import type { WatermarkDecision } from '../../domain/services/watermark-policy';
import { SIGNED_URL_PROVIDER } from '../../infrastructure/signed-url-provider';
import type { ShortLivedAccess, SignedUrlProvider } from '../../infrastructure/signed-url-provider';
import { ACCESS_AUDIT_PORT } from '../../infrastructure/access-audit-port';
import type { AccessAuditPort } from '../../infrastructure/access-audit-port';

/** 签发访问能力输入（IFC-FIL-005） */
export interface IssueAccessInput {
  readonly fileId: string;
  /** 实时上下文（服务端入口在每次请求时重新构造，不缓存） */
  readonly context: FileAccessContext;
  /** 文件与目标事实（当前状态/类别/上传者/字段限制/敏感标记） */
  readonly request: FileAccessRequest;
  /** 当前主体是否为上传者（本人历史访问：调用方已校验历史提交仍有权） */
  readonly principalIsUploader: boolean;
  /** 请求动作 */
  readonly action: FileAccessAction;
  /** 是否安全格式（可在线预览；否则即使请求预览也降级为仅下载，不扩大权限） */
  readonly safeForPreview: boolean;
  /** 短时有效期（毫秒；默认 5 分钟） */
  readonly ttlMs?: number;
}

/** 签发结果 */
export interface IssuedAccess {
  readonly access: ShortLivedAccess;
  readonly watermark: WatermarkDecision;
}

/**
 * 附件访问查询用例（FileAccessQuery，IFC-FIL-005/FORM-008）。
 *
 * - **每次访问实时鉴权**：按当前用户、对象、字段、任务、社团/联合关系和业务
 *   状态重新判定（失权、停用、隔离或删除后旧链接不得继续访问）；
 * - **短时访问地址**：不提供永久公开链接，只生成短时最小范围地址；
 *   安全格式在线预览，其他格式仅下载（请求预览但非安全格式 → 降级为下载）；
 *   字段可进一步限制预览/下载但不能扩大权限；
 * - **水印与审计**：敏感附件（招新报名/面试材料）预览/下载默认加查看者+时间
 *   水印；下载及敏感附件预览记录审计（GOV-008、AUD-004）；
 * - **本人历史访问**：上传者在仍有权查看对应历史提交时可查看/下载自己的附件。
 */
@Injectable()
export class FileAccessQuery {
  constructor(
    private readonly policy: AccessPolicy,
    private readonly watermark: WatermarkPolicy,
    @Inject(SIGNED_URL_PROVIDER) private readonly signedUrl: SignedUrlProvider,
    @Inject(ACCESS_AUDIT_PORT) private readonly audit: AccessAuditPort,
  ) {}

  async issueAccess(input: IssueAccessInput): Promise<IssuedAccess> {
    // 实时鉴权（每次访问）
    const decision = this.policy.check(
      input.context,
      input.request,
      input.action,
      input.principalIsUploader,
    );
    if (!decision.allowed) {
      throw new FileAccessDeniedError(
        decision.errorCode ?? 'IFC-ERR-003',
        '附件访问被拒绝',
      );
    }

    // 安全格式在线预览；其他格式仅下载（不扩大权限）
    const effectiveAction =
      input.action === FileAccessAction.PREVIEW && !input.safeForPreview
        ? FileAccessAction.DOWNLOAD
        : input.action;

    // 水印（敏感附件默认加：查看者 + 时间）
    const now = new Date().toISOString();
    const watermark = this.watermark.decide(
      input.request.category,
      input.request.target?.fieldKey ?? '',
      input.request.sensitive,
      input.context.principalId ?? '',
      now,
    );

    // 短时地址（最小范围）
    const access = await this.signedUrl.issue(input.fileId, effectiveAction, {
      ttlMs: input.ttlMs,
      watermarkContent: watermark.required ? watermark.content : undefined,
    });

    // 审计：下载及敏感附件预览
    if (
      effectiveAction === FileAccessAction.DOWNLOAD ||
      (effectiveAction === FileAccessAction.PREVIEW && input.request.sensitive)
    ) {
      await this.audit.report({
        action: effectiveAction,
        principalId: input.context.principalId ?? '',
        fileId: input.fileId,
        sensitive: input.request.sensitive,
        token: access.token,
        occurredAt: now,
      });
    }
    return { access, watermark };
  }
}
