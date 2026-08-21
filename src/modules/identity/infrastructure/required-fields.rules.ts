/**
 * 平台必填资料规则（infrastructure；config 模块边界占位，IDN-019）。
 *
 * config 模块未接入前返回静态配置（默认空：无平台级必填收紧）；
 * 接入后按"字段 + 生效日期 + 规则版本"提供（生效前提醒、生效后未补全者
 * 全系统只读，资料门重算 R006）。
 */

import type {
  RequiredFieldRulesPort,
  PlatformRequiredField,
} from '../application/ports/required-field-rules.port';

export class StaticRequiredFieldRules implements RequiredFieldRulesPort {
  constructor(private readonly fields: readonly PlatformRequiredField[] = []) {}

  async getPlatformRequiredFields(_now: Date): Promise<readonly PlatformRequiredField[]> {
    return this.fields;
  }
}
