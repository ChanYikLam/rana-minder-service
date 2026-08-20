/**
 * 状态页授权端口——仅当前有效超管可访问（ADR-011 §6.3 / observability/
 * README §6.3）。
 *
 * 路径：src/platform/observability/status-page/（PR #32 §2.2 B）。
 *
 * 接口契约：
 * - assertSuperAdmin(actor)：若当前请求主体不是有效超管则抛 Forbidden。
 *   实际超管判定在 identity/authorization 模块就绪后由 IdentityStatusPage
 *   Authorizer 注入；本 MR 仅注册桩实现。
 *
 * 桩实现策略：默认 Register=RejectAllStatusPageAuthorizer（拒绝所有访问），
 * 直到真实身份模块接入为止——满足"fail-closed"安全姿态。在开发环境如需临时
 * 放行，可替换为 AlwaysAllowStatusPageAuthorizer（首版导出，便于本地调试）。
 *
 * 注意：AllowAll 桩**不得**进入任何带真实身份/凭据的环境；本 MR 仅在测试
 * 与本地开发中允许注入。
 */

export interface StatusPageActor {
  readonly userId?: string;
  readonly roles?: readonly string[];
}

export class StatusPageForbiddenError extends Error {
  constructor(message = 'status page is restricted to current super admin (ADR-011 §6.3)') {
    super(message);
    this.name = 'StatusPageForbiddenError';
  }
}

export interface StatusPageAuthorizer {
  assertSuperAdmin(actor: StatusPageActor | undefined): void;
}

export class RejectAllStatusPageAuthorizer implements StatusPageAuthorizer {
  assertSuperAdmin(_actor: StatusPageActor | undefined): void {
    throw new StatusPageForbiddenError();
  }
}

export class AlwaysAllowStatusPageAuthorizer implements StatusPageAuthorizer {
  assertSuperAdmin(_actor: StatusPageActor | undefined): void {
    // 仅用于本地开发/集成测试；不得进入真实身份环境。
  }
}
