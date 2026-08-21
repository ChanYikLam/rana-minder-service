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
import type {
  ShortLivedAccess,
  SignedUrlProvider,
  TokenVerification,
} from '../../infrastructure/signed-url-provider';
import { ACCESS_AUDIT_PORT } from '../../infrastructure/access-audit-port';
import type { AccessAuditPort } from '../../infrastructure/access-audit-port';

/** 签发访问能力输入（IFC-FIL-005） */
export interface IssueAccessInput {
  readonly fileId: string;
  /** 实时上下文（服务端入口在每次请求时重新构造，不缓存） */
  readonly context: FileAccessContext;
  /** 文件与目标事实（当前状态/类别/上传者/字段限制/敏感标记） */
  readonly request: FileAccessRequest;
  /** 当前主体是否为上传者（本人历史访问）；主体验证与历史可见性由领域规则在策略内判定 */
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

/** 短时令牌消费异常（到期/已用/未知均拒绝；调用方不得继续取文件） */
export class ShortLivedAccessRejectedError extends Error {
  constructor(reason: NonNullable<TokenVerification['reason']>) {
    super(`${reason}: 短时访问令牌无效或已失效`);
    this.name = 'ShortLivedAccessRejectedError';
  }
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
 * - **本人历史访问**：仅当主体确为上传者且对应历史提交仍可见（`uploaderHistoryVisible`
 *   由服务端入口校验后随 request 传入）时，才可查看/下载自己的附件。
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
      throw new FileAccessDeniedError(decision.errorCode ?? 'IFC-ERR-003', '附件访问被拒绝');
    }

    // 安全格式在线预览；其他格式仅下载（不扩大权限）
    const effectiveAction =
      input.action === FileAccessAction.PREVIEW && !input.safeForPreview
        ? FileAccessAction.DOWNLOAD
        : input.action;

    // 降级后须按最终动作复核字段权限，防止绕过：
    // 例如字段配置 previewable=true、downloadable=false，请求非安全格式预览
    // 降级为下载时，若不复核则会签发下载地址，绕过下载限制（权限放大）。
    if (effectiveAction !== input.action) {
      const field = this.policy.checkFieldAccess(input.request, effectiveAction);
      if (!field.allowed) {
        throw new FileAccessDeniedError(field.errorCode ?? 'IFC-ERR-011', '附件访问被拒绝');
      }
    }

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

  /**
   * 消费短时访问令牌（IFC-FIL-005 取文件入口接入）。
   *
   * 兑现“短时失效 + 一次性语义”承诺：签发地址只是第一步，实际取文件/预览入口必须先
   * 调用本方法核验并消费令牌——到期（EXPIRED）、已被消费（USED）、未知（UNKNOWN）
   * 一律拒绝，旧链接/复用令牌不得继续访问。
   *
   * ⚠️ FORM-008 实时鉴权边界（评审提示）：本方法只核验一次性令牌的有效性，**不会**重新
   * 校验当前文件状态或主体授权。令牌在签发时已通过 `AccessPolicy.check` 实时鉴权，且默认
   * 有效期仅 5 分钟（`MAX_TTL_MS` 兜底 30 分钟），因此消费窗口被严格收紧；但若消费侧期望
   * 对“签发后、消费前文件被隔离/删除或主体失权”也严格拦截，应在调用本方法后、真正取字节前
   * 再按最新文件状态做一次复核（或直接基于最新状态重建访问能力）。
   *
   * @param token 从短时地址中解析出的一次性令牌
   * @returns 通过校验时返回关联的最小范围访问能力（供消费侧取文件/水印/动作）
   * @throws ShortLivedAccessRejectedError 令牌无效/已失效时，调用方不得继续取文件
   */
  async resolveAccess(token: string): Promise<ShortLivedAccess> {
    const verification: TokenVerification = await this.signedUrl.verify(token);
    if (!verification.valid || verification.access === undefined) {
      throw new ShortLivedAccessRejectedError(verification.reason ?? 'UNKNOWN');
    }
    return verification.access;
  }
}
