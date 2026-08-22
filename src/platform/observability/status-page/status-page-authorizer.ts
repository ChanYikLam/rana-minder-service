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
  /** 同步判断接口：无异步核验时直接抛/通过。 */
  assertSuperAdmin(actor: StatusPageActor | undefined): void;
  /** 异步核验接口：接入真实超管判定（T5）后使用，返回 Promise。 */
  assertSuperAdminAsync(actor: StatusPageActor | undefined): Promise<void>;
}

export class RejectAllStatusPageAuthorizer implements StatusPageAuthorizer {
  assertSuperAdmin(_actor: StatusPageActor | undefined): void {
    throw new StatusPageForbiddenError();
  }

  async assertSuperAdminAsync(_actor: StatusPageActor | undefined): Promise<void> {
    throw new StatusPageForbiddenError();
  }
}

export class AlwaysAllowStatusPageAuthorizer implements StatusPageAuthorizer {
  assertSuperAdmin(_actor: StatusPageActor | undefined): void {
    // 仅用于本地开发/集成测试；不得进入真实身份环境。
  }

  async assertSuperAdminAsync(_actor: StatusPageActor | undefined): Promise<void> {
    // 仅用于本地开发/集成测试；不得进入真实身份环境。
  }
}

/**
 * 真实超管判定授权器（T5）。
 *
 * 委托 identity/authorization 的 SUPER_ADMIN_VERIFIER 核验当前请求主体是否为
 * 有效超管（ADR-011 §6.3 / SEC-*）。核验器 fail-closed：无法核验时一律拒绝。
 */
export interface SuperAdminVerifierPortLike {
  isSuperAdmin(subjectId: string): Promise<boolean>;
}

export class IdentityStatusPageAuthorizer implements StatusPageAuthorizer {
  constructor(private readonly verifier: SuperAdminVerifierPortLike) {}

  assertSuperAdmin(actor: StatusPageActor | undefined): void {
    if (!actor?.userId) {
      throw new StatusPageForbiddenError();
    }
    // 同步路径不做异步核验：避免误放行，保守拒绝并提示走异步接口。
    throw new StatusPageForbiddenError();
  }

  async assertSuperAdminAsync(actor: StatusPageActor | undefined): Promise<void> {
    if (!actor?.userId) {
      throw new StatusPageForbiddenError();
    }
    try {
      const ok = await this.verifier.isSuperAdmin(actor.userId);
      if (!ok) {
        throw new StatusPageForbiddenError();
      }
    } catch (err) {
      // 核验器异常/不可用：按 fail-closed 拒绝，不向状态页暴露内部错误（最小披露）。
      if (err instanceof StatusPageForbiddenError) {
        throw err;
      }
      throw new StatusPageForbiddenError();
    }
  }
}
