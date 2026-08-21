import type { FileCategory } from '../models/file-model';
import { FileState } from '../state-machines/file-state-machine';
import type { FileStateMachine } from '../state-machines/file-state-machine';

/**
 * 访问动作（IFC-FIL-005 预览/下载）。
 */
export const FileAccessAction = {
  PREVIEW: 'PREVIEW',
  DOWNLOAD: 'DOWNLOAD',
} as const;

export type FileAccessAction = (typeof FileAccessAction)[keyof typeof FileAccessAction];

/**
 * 访问实时上下文（FORM-008：附件每次访问重新检查当前角色、社团、部门、
 * 任务、联合关系和业务状态——由服务端入口在每个请求时重新构造，不缓存）。
 */
/** 目标对象所属作用域（服务端入口在鉴权时提供；用于领域层最小作用域校验）。
 * 与 `FileAccessContext` 中当前主体的作用域逐项比对，防止仅凭 roles 数组误放行。 */
export interface ObjectScope {
  /** 目标对象所属社团 */
  readonly clubId?: string;
  /** 目标对象所属部门 */
  readonly departmentId?: string;
  /** 目标对象所属任务 */
  readonly taskRef?: string;
  /** 目标对象所属联合关系 */
  readonly unionId?: string;
}

/** 访问实时上下文（FORM-008：附件每次访问重新检查当前角色、社团、部门、
 * 任务、联合关系和业务状态——由服务端入口在每个请求时重新构造，不缓存）。
 */
export interface FileAccessContext {
  readonly principalId: string | null;
  /**
   * 当前角色（每次访问重新获取）。
   *
   * 职责边界：领域层只做**最小作用域校验**（至少一个有效业务角色才可访问非本人/非
   * ownerOnly 附件，且当前主体作用域须覆盖目标对象作用域）；角色与目标对象的
   * **对象级匹配关系**（社团/部门/任务/联合关系等是否真正覆盖该附件所属业务对象）
   * 由**服务端入口**在构造本上下文时逐项判定并收敛进 roles——调用方必须据此正确
   * 构造 roles，领域层同时复核作用域是否匹配（双保险）。若 roles 为空 = 无权
   * （保守拒绝）。
   */
  readonly roles: readonly string[];
  /** 当前社团 */
  readonly clubId?: string;
  /** 当前部门 */
  readonly departmentId?: string;
  /** 当前任务 */
  readonly taskRef?: string;
  /** 联合关系 */
  readonly unionId?: string;
  /** 业务状态（招新报名窗口等；失权/停用/关闭拒绝） */
  readonly businessState: 'OPEN' | 'CLOSED' | 'SUSPENDED';
}

/** 鉴权结果 */
export interface AccessDecision {
  readonly allowed: boolean;
  /** 拒绝原因代码（IFC-ERR-003 当前无权 / IFC-ERR-011 安全限制） */
  readonly errorCode?: 'IFC-ERR-003' | 'IFC-ERR-011';
}

/** 鉴权拒绝异常（调用方不得继续；不静默放宽） */
export class FileAccessDeniedError extends Error {
  constructor(code: 'IFC-ERR-003' | 'IFC-ERR-011', message: string) {
    super(`${code}: ${message}`);
    this.name = 'FileAccessDeniedError';
  }
}

/** 访问策略输入（实时鉴权依据） */
export interface FileAccessRequest {
  readonly fileId: string;
  /** 文件当前状态（未检查/隔离/删除拒绝；复用状态机枚举） */
  readonly fileState: FileState;
  /** 文件类别（敏感判定：招新报名/面试材料等） */
  readonly category: FileCategory;
  /** 上传者（本人历史访问判定） */
  readonly uploaderId: string;
  /** 目标业务对象（本人历史访问时校验"仍有权查看对应历史提交"） */
  readonly target: { objectType: string; objectId: string; fieldKey: string } | null;
  /** 目标对象所属作用域（领域层最小作用域校验：当前主体作用域须覆盖目标对象） */
  readonly objectScope?: ObjectScope;
  /** 字段级限制（预览/下载；只能收紧不能扩大） */
  readonly fieldRestrictions: {
    previewable: boolean;
    downloadable: boolean;
  };
  /** 敏感附件（招新报名/面试材料；水印与审计触发） */
  readonly sensitive: boolean;
  /** 仅本人可访问（如私人材料）；false=可被有权业务角色访问 */
  readonly ownerOnly: boolean;
  /** 本人历史访问时，上传者是否仍有权查看对应历史提交（服务端入口校验后传入） */
  readonly uploaderHistoryVisible?: boolean;
}

/**
 * 访问策略（FORM-008/IFC-FIL-005 纯规则）。
 *
 * 每次预览/下载按当前用户、对象、字段、任务、社团/联合关系和业务状态
 * 实时鉴权：失权、停用、隔离或删除后旧链接不得继续访问；
 * 字段可进一步限制预览/下载但不能扩大权限。
 */
export class AccessPolicy {
  constructor(private readonly stateMachine: FileStateMachine) {}

  /**
   * 实时鉴权。
   * @param context 当前请求实时上下文
   * @param request 文件与目标对象事实
   * @param action 预览/下载
   * @param principalIsUploader 当前主体是否为上传者（本人历史访问）
   */
  check(
    context: FileAccessContext,
    request: FileAccessRequest,
    action: FileAccessAction,
    principalIsUploader: boolean,
  ): AccessDecision {
    // 1) 主体与业务状态：未认证不可访问（公开附件由业务授权决定，此处保守）
    if (context.principalId === null) {
      return { allowed: false, errorCode: 'IFC-ERR-003' };
    }
    // 2) 业务状态：暂停/关闭 → 拒绝（招新报名窗口关闭等）
    if (context.businessState !== 'OPEN') {
      return { allowed: false, errorCode: 'IFC-ERR-003' };
    }
    // 3) 文件状态：未检查/隔离/失败/待清理/已清理 → 不可访问（IFC-FIL-005）
    //    复用状态机 isUnsafe 规则，避免魔法字符串漂移
    if (this.stateMachine.isUnsafe(request.fileState)) {
      return { allowed: false, errorCode: 'IFC-ERR-011' };
    }
    // 4) 本人历史访问：仅当 主体确为上传者 且 对应历史提交仍可见 时放行；
    //    权限判定下沉到领域规则，主体验证在策略内独立完成，防止调用方误传越权
    //    （设计豁免：本人仍可查看/下载自己仍可见的历史提交，不受角色失权影响；
    //     若历史提交已不可见则拒绝）
    if (principalIsUploader) {
      if (context.principalId !== request.uploaderId || !request.uploaderHistoryVisible) {
        return { allowed: false, errorCode: 'IFC-ERR-003' };
      }
      return this.checkFieldAccess(request, action);
    }
    // 5) 非本人：仅本人材料 → 拒绝；否则要求有权业务角色
    if (request.ownerOnly) {
      return { allowed: false, errorCode: 'IFC-ERR-003' };
    }
    // 业务角色访问：角色/社团/部门/任务/联合关系的**对象级匹配**由服务端入口逐项判定
    // 后收敛进 roles（见 FileAccessContext.roles 职责边界说明）；领域层在此做最小
    // 作用域校验——要求至少一个有效业务角色，且当前主体作用域覆盖目标对象作用域。
    // 即便调用方误构造了 roles，只要作用域不匹配也会被拒绝（双保险，防越权）。
    if (context.roles.length === 0) {
      return { allowed: false, errorCode: 'IFC-ERR-003' };
    }
    if (!this.withinObjectScope(context, request.objectScope)) {
      return { allowed: false, errorCode: 'IFC-ERR-003' };
    }
    return this.checkFieldAccess(request, action);
  }

  /**
   * 最小作用域校验：当目标对象声明了所属作用域（社团/部门/任务/联合关系）时，
   * 要求当前主体的对应作用域与之**一致**；目标对象未声明作用域（全局/无绑定）
   * 时放行（由 roles 与字段限制把关）。
   */
  private withinObjectScope(context: FileAccessContext, scope: ObjectScope | undefined): boolean {
    if (!scope) {
      return true;
    }
    if (scope.clubId !== undefined && context.clubId !== scope.clubId) {
      return false;
    }
    if (scope.departmentId !== undefined && context.departmentId !== scope.departmentId) {
      return false;
    }
    if (scope.taskRef !== undefined && context.taskRef !== scope.taskRef) {
      return false;
    }
    if (scope.unionId !== undefined && context.unionId !== scope.unionId) {
      return false;
    }
    return true;
  }

  /** 字段级限制（可进一步限制预览/下载但不能扩大权限） */
  checkFieldAccess(request: FileAccessRequest, action: FileAccessAction): AccessDecision {
    if (action === FileAccessAction.PREVIEW) {
      return request.fieldRestrictions.previewable
        ? { allowed: true }
        : { allowed: false, errorCode: 'IFC-ERR-011' };
    }
    return request.fieldRestrictions.downloadable
      ? { allowed: true }
      : { allowed: false, errorCode: 'IFC-ERR-011' };
  }
}
