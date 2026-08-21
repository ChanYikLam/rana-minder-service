/**
 * 表单域设计权限端口（form 域；FORM-002、GOV-003）。
 *
 * 设计/发布权限分级：
 * - 超管：平台公共资料表与平台模板（并可停用违规表单，GOV-003）；
 * - 社团负责人/人事管理员：本社团报名、成员申请与社团级评价表；
 * - 部门负责人：仅本部门评价/反馈表；
 * - 普通成员/面试官：只能填写（4.1.2），不能设计发布。
 *
 * organization 模块（3.2）接入前失败关闭（NotWiredFormDesignPermission），
 * 不得因无法核验而放行设计操作；3.2 合并后由 organization 实现替换绑定。
 */

import type { FormScope } from '../../domain/models/form-scope';

export interface FormDesignActor {
  readonly subjectId: string;
}

export interface FormDesignPermissionPort {
  /** 是否可设计/发布/停用/复用该作用域表单 */
  canDesign(actor: FormDesignActor, scope: FormScope): Promise<boolean>;
  /** 是否平台特权操作者（平台表单、模板库审核，GOV-003 超管停用） */
  canManagePlatform(actor: FormDesignActor): Promise<boolean>;
}
