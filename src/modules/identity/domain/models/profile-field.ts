/**
 * 资料字段目录（IDN-002/IDN-003/IDN-014/IDN-015）。
 *
 * 两类字段：
 * - 可编辑白名单字段（EDT-*）：学生本人可直接修改，本地立即生效并进入双向同步；
 * - 只读权威字段（RO-*）：姓名/学号以 Casdoor 为权威，学生只读；第三值冲突不进入
 *   本人选择（PRD-OPT-045、IDN-006/017），按 SRS-SM-IDN-003 直接收敛为 Casdoor 当前值。
 *
 * 约束：动态表单自定义字段不进入本目录，禁止写入 Casdoor（IDN-015）。
 */

export const EditableProfileField = {
  EMAIL: 'email',
  PHONE: 'phone',
  COLLEGE: 'college',
  GRADE: 'grade',
} as const;
export type EditableProfileField = (typeof EditableProfileField)[keyof typeof EditableProfileField];

/** 只读权威字段（Casdoor 权威，本地只读展示） */
export const AuthoritativeProfileField = {
  STUDENT_ID: 'studentId',
  NAME: 'name',
} as const;
export type AuthoritativeProfileField =
  (typeof AuthoritativeProfileField)[keyof typeof AuthoritativeProfileField];

export type ProfileField = EditableProfileField | AuthoritativeProfileField;

const EDITABLE_SET: ReadonlySet<string> = new Set<string>(Object.values(EditableProfileField));
const AUTHORITATIVE_SET: ReadonlySet<string> = new Set<string>(
  Object.values(AuthoritativeProfileField),
);

export function isEditableProfileField(value: string): value is EditableProfileField {
  return EDITABLE_SET.has(value);
}

export function isAuthoritativeProfileField(value: string): value is AuthoritativeProfileField {
  return AUTHORITATIVE_SET.has(value);
}

export function isProfileField(value: string): value is ProfileField {
  return isEditableProfileField(value) || isAuthoritativeProfileField(value);
}
