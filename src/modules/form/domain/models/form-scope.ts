/**
 * 表单作用域值对象（form 域；IFC-GEN-004 作用域类型落地）。
 *
 * 三类作用域（FORM-001/002）：
 * - platform：平台公共资料表与平台模板（超管维护）；
 * - club：社团表单（社团负责人/人事管理）；
 * - department：部门专属评价/反馈表（部门负责人管理）。
 *
 * 作用域是服务端冻结的业务对象归属，不由客户端自报（IFC-GEN-001）；
 * 仓储按作用域过滤（数据隔离，ADR-005），越界读取按不存在/无权处理。
 */

export type FormScopeKind = 'platform' | 'club' | 'department';

export interface FormScope {
  readonly kind: FormScopeKind;
  /** platform 为 null；club/department 为社团/部门稳定标识 */
  readonly ownerId: string | null;
}

export const PLATFORM_SCOPE: FormScope = { kind: 'platform', ownerId: null };

/** 构造并校验作用域（ownerId 缺失即拒绝） */
export function formScopeOf(kind: FormScopeKind, ownerId: string | null): FormScope {
  if (kind === 'platform') {
    return PLATFORM_SCOPE;
  }
  if (ownerId === null || ownerId.trim().length === 0) {
    throw new Error(`FormScope: ${kind} 作用域缺少 ownerId`);
  }
  return { kind, ownerId };
}

export function isFormScopeKind(value: string): value is FormScopeKind {
  return value === 'platform' || value === 'club' || value === 'department';
}

/** 序列化（scope, owner_id 两列） */
export function serializeScope(scope: FormScope): { scope: FormScopeKind; ownerId: string | null } {
  return { scope: scope.kind, ownerId: scope.ownerId };
}

/** 稳定的作用域键（幂等作用域与集合读上下文使用） */
export function scopeKeyOf(scope: FormScope): string {
  return scope.ownerId === null ? scope.kind : `${scope.kind}:${scope.ownerId}`;
}

export function isSameScope(a: FormScope, b: FormScope): boolean {
  return a.kind === b.kind && a.ownerId === b.ownerId;
}
