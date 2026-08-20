/**
 * 平台必填资料规则端口（config 模块边界，1.5 配置与发布；IDN-019）。
 *
 * 平台新增必填字段按"字段 + 生效日期"收紧资料门：生效前提醒、生效后未补全者
 * 全系统只读（资料门重算 R006）；规则版本与资料版本同一版本边界竞争重算。
 * 实现由 config 模块提供（当前未接入，M1 由测试替身覆盖）。
 */

export interface PlatformRequiredField {
  /** 稳定字段名（须属于可编辑白名单字段目录） */
  readonly field: string;
  /** 生效日期（生效前不收紧资料门） */
  readonly effectiveAt: Date;
  /** 规则版本（新必填字段生效与用户补齐提交以同一版本边界重算） */
  readonly ruleVersion: number;
}

export interface RequiredFieldRulesPort {
  /** 当前生效的平台必填字段（含生效日期与规则版本） */
  getPlatformRequiredFields(now: Date): Promise<readonly PlatformRequiredField[]>;
}