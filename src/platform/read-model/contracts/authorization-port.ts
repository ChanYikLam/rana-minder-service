import { Injectable } from '@nestjs/common';

/** 对象授权端口注入令牌（ObjectAuthorizationPort 为接口，注入须用显式 token） */
export const OBJECT_AUTHORIZATION_PORT = Symbol('OBJECT_AUTHORIZATION_PORT');

/** 授权判定动作（详情/执行/命令等；R2：每次受保护请求都执行当前服务端授权） */
export type AuthorizationAction = 'VIEW' | 'EXECUTE' | 'COMMAND';

/**
 * 对象级授权端口（C6.9-C6.11 接线点；IFC-QRY-002/003、接口契约 §9.6）。
 *
 * 授权判定由组织与授权模块完成；read-model 只承接判定结果。
 * - 查询入口：集合查询以 grantedScopes（QueryAuthContext）为准；
 * - 详情/执行/命令：经本端口**逐对象重验**（工作台打开/筛选/详情/命令
 *   均重新授权；个人中心失权后旧链接/缓存/入口同时失效）。
 */
export interface ObjectAuthorizationPort {
  /**
   * 校验主体对目标对象的动作授权。
   * @param principalId 主体稳定标识
   * @param object 目标对象（权威对象类型 + 稳定标识）
   * @param action 动作
   * @returns true=授权；false=拒绝（调用方不得继续）
   */
  verify(
    principalId: string,
    object: { objectType: string; objectId: string },
    action: AuthorizationAction,
  ): Promise<boolean>;
}

/**
 * 占位实现：一律拒绝（fail-closed）。
 *
 * 领域授权模块实现前，任何"逐对象重验"都不得放行——宁可拒绝不可越权
 * （R2 不从投影授权；无法证明授权成立即拒绝）。
 */
@Injectable()
export class RejectAllObjectAuthorization implements ObjectAuthorizationPort {
  async verify(
    _principalId: string,
    _object: { objectType: string; objectId: string },
    _action: AuthorizationAction,
  ): Promise<boolean> {
    return false;
  }
}
