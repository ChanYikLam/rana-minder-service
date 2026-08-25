/**
 * audit 模块 DI 标识符（应用层用例/查询 token；字符串常量约定同 config）。
 *
 * 控制器经 Nest 注入这些 token；module.ts 中以 useExisting 别名绑定到应用层
 * 用例/查询类（不改动领域/应用/基础设施层）。
 */

export const AUDIT_QUERY = 'AUD_AUDIT_QUERY';
export const CORRECTION_STATUS_QUERY = 'AUD_CORRECTION_STATUS_QUERY';
export const SAVE_CORRECTION_DRAFT_COMMAND = 'AUD_SAVE_CORRECTION_DRAFT_COMMAND';
export const SUBMIT_CORRECTION_COMMAND = 'AUD_SUBMIT_CORRECTION_COMMAND';
export const DECIDE_CORRECTION_COMMAND = 'AUD_DECIDE_CORRECTION_COMMAND';
export const WITHDRAW_CORRECTION_COMMAND = 'AUD_WITHDRAW_CORRECTION_COMMAND';
