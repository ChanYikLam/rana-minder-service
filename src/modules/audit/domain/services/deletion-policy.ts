/**
 * 正式删除策略（AUD-005~010；纯规则）。
 *
 * - 正式删除**仅超管**（IFC-ERR-003）；
 * - 必填原因（IFC-ERR-005）；展示受影响对象清单 + **二次确认**（AUD-005/009）；
 * - 用户仍有成员关系/有效邀请/进行中活动时**须先结束业务关系**（AUD-008）；
 * - **不建设匿名化**（AUD-010）：无匿名编号/身份字段清除保留统计流程；
 *   不得用普通编辑/纠错/删除接口变相匿名化（完整删除不属于匿名化）；
 * - 不自动删 Casdoor 账号/Group/Claims，不能召回已发邮件（AUD-006/008）。
 */
export const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

/**
 * 正式删除用途（结构化白名单；I1 评审意见——防自由文本措辞绕过合规校验）。
 * 不包含任何匿名化类用途：不建设匿名化（AUD-010），完整删除不属于匿名化。
 */
export const DeletionPurpose = {
  /** 用户申请删除其本地数据 */
  USER_REQUEST: 'USER_REQUEST',
  /** 法律/合规要求 */
  LEGAL_REQUIREMENT: 'LEGAL_REQUIREMENT',
  /** 数据质量纠错（违规内容/重复数据） */
  DATA_QUALITY: 'DATA_QUALITY',
  /** 保留策略违规数据处置 */
  RETENTION_VIOLATION: 'RETENTION_VIOLATION',
} as const;

export type DeletionPurpose = (typeof DeletionPurpose)[keyof typeof DeletionPurpose];

const ALLOWED_PURPOSES: readonly string[] = Object.values(DeletionPurpose);

/** 前置失败（IFC-ERR-003 无权 / IFC-ERR-005 输入无效 / IFC-ERR-006 前置失败 / IFC-ERR-015 结果不可见 / IFC-ERR-016 内部提交失败） */
export class DeletionPolicyError extends Error {
  constructor(
    code: 'IFC-ERR-003' | 'IFC-ERR-005' | 'IFC-ERR-006' | 'IFC-ERR-015' | 'IFC-ERR-016',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'DeletionPolicyError';
  }
}

/** 正式删除策略（纯规则） */
export class DeletionPolicy {
  /** 仅超管（AUD-005） */
  assertSuperAdmin(roles: readonly string[]): void {
    if (!roles.includes(SUPER_ADMIN_ROLE)) {
      throw new DeletionPolicyError('IFC-ERR-003', '仅超级管理员可执行正式删除');
    }
  }

  /** 必填原因（AUD-005） */
  assertReason(reason: string): void {
    if (reason.trim().length === 0) {
      throw new DeletionPolicyError('IFC-ERR-005', '正式删除必须填写原因');
    }
  }

  /** 二次确认（AUD-005/009：展示受影响对象清单后确认） */
  assertConfirmed(confirmed: boolean): void {
    if (!confirmed) {
      throw new DeletionPolicyError('IFC-ERR-005', '正式删除需要二次确认');
    }
  }

  /**
   * 业务关系前置（AUD-008）：成员关系/有效邀请/进行中活动必须**先结束**。
   * 返回未结束的业务关系清单；非空则拒绝删除（不自动结束）。
   */
  assertBusinessRelationsEnded(activeRelations: readonly { kind: string; ref: string }[]): void {
    if (activeRelations.length > 0) {
      const list = activeRelations.map((r) => `${r.kind}:${r.ref}`).join(', ');
      throw new DeletionPolicyError('IFC-ERR-006', `须先结束业务关系再删除（${list}）`);
    }
  }

  /**
   * 删除用途白名单校验（I1 评审意见）：结构化用途枚举，防自由文本措辞绕过；
   * 白名单不含匿名化类用途（不建设匿名化，AUD-010；完整删除不属于匿名化）。
   */
  assertPurposeAllowed(purpose: string): void {
    if (!ALLOWED_PURPOSES.includes(purpose)) {
      throw new DeletionPolicyError(
        'IFC-ERR-005',
        '不支持的删除用途（白名单：USER_REQUEST/LEGAL_REQUIREMENT/DATA_QUALITY/RETENTION_VIOLATION）；不建设匿名化',
      );
    }
  }
}
