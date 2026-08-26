/**
 * Cookie Secure 判定（interfaces/nest；BUG-016）。
 *
 * 背景：会话 Cookie 的 Secure 属性决定其是否仅经 HTTPS 传输。此前实现信任
 * 请求头 `x-forwarded-proto`，而该头可被客户端伪造，攻击者可借此诱导客户端
 * 经明文 HTTP 传输会话令牌（会话劫持）。
 *
 * 修复策略（BUG-016）：Secure 由服务端配置驱动，不信任客户端请求头。
 * - 生产环境（NODE_ENV=production）：始终 Secure（HTTPS 在反向代理处终止，
 *   应用层无法可靠判定）。
 * - 非生产环境：仅依赖 Express 的 req.secure（须正确配置 trust proxy 才可信）。
 */

import { type Request as ExpressRequest } from 'express';

/**
 * 判定会话 Cookie 是否应带 Secure 属性。
 *
 * @param env NODE_ENV 环境变量值
 * @param reqSecure Express 的 req.secure（信任代理正确配置时才有意义）
 */
export function isSecureRequest(env: string | undefined, reqSecure: boolean): boolean {
  // 生产环境始终 Secure（HTTPS 终止于反向代理，应用层无法可靠判定）
  if (env === 'production') return true;
  return reqSecure;
}

/** 从请求与当前环境求值 Secure 判定的便捷封装（供 controller 使用）。 */
export function secureFromRequest(req: ExpressRequest): boolean {
  return isSecureRequest(process.env['NODE_ENV'], req.secure);
}
