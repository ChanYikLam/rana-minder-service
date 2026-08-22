/**
 * 模块会话适配器工厂（B3 会话地基）。
 *
 * identity 模块的 AUTH_SESSION_PROVIDER 返回 AuthSession（subjectId/now/mailCapable），
 * 各领域模块自己的会话类型（FormAuthSession / RecruitmentAuthSession / …）是
 * 同一形状的子集。本工厂为每个模块的 token 生成一个薄适配器，把 identity 的
 * 解析结果映射到模块自有类型，避免每个模块重复写适配类。
 *
 * 用法（在每个模块的 provider 中）：
 *   useFactory: (identitySession) => adaptSessionProvider(identitySession),
 *   inject: [AUTH_SESSION_PROVIDER],
 */

import type { AuthSessionProvider } from '../modules/identity/interfaces/nest/auth-session';

export interface MinimalSessionProvider<S extends { readonly subjectId: string; readonly now: Date }> {
  resolveSession(request: unknown): Promise<S | null>;
}

export function adaptSessionProvider<S extends { readonly subjectId: string; readonly now: Date }>(
  identitySession: AuthSessionProvider,
): MinimalSessionProvider<S> {
  return {
    resolveSession: async (request: unknown) => {
      const session = await identitySession.resolveSession(request as never);
      if (session === null) return null;
      return { subjectId: session.subjectId, now: session.now } as S;
    },
  };
}