/**
 * 动态字段目录与字段定义类型（form 域；FORM-003、DATA-FRM-001/003、IFC-DATA-005）。
 *
 * 字段类型冻结 12 种（接口清单 §13 FormField.type，传输层事实基线）：
 * text/textarea/number/select/multi_select/radio/checkbox/date/datetime/file/image/array；
 * 照片→image、视频→普通 file、是/否→checkbox、评分未列入清单（不放开）。
 *
 * 固定业务骨架（FORM-001/07、SRS-INV-010）：动态字段不得替代用户、学号、社团、
 * 部门、职位、状态、任期、邀请、权限及提交人/业务对象/作用域/审批/时间/版本等
 * 强类型字段；与骨架标识冲突（大小写不敏感）的字段一律拒绝（GOV-003）。
 *
 * 字段权限（FORM-003、DATA-FRM-004）：对象级 permission 三档
 * （read_write/read_only/hidden），可按设计角色在对象权限内进一步收紧
 * （rolePermissions，只能收紧不能扩大）。
 */

export const FormFieldType = {
  TEXT: 'text',
  TEXTAREA: 'textarea',
  NUMBER: 'number',
  SELECT: 'select',
  MULTI_SELECT: 'multi_select',
  RADIO: 'radio',
  CHECKBOX: 'checkbox',
  DATE: 'date',
  DATETIME: 'datetime',
  FILE: 'file',
  IMAGE: 'image',
  ARRAY: 'array',
} as const;
export type FormFieldType = (typeof FormFieldType)[keyof typeof FormFieldType];

export const FIELD_TYPE_LIST: readonly FormFieldType[] = Object.values(FormFieldType);

export function isFormFieldType(value: string): value is FormFieldType {
  return (FIELD_TYPE_LIST as readonly string[]).includes(value);
}

export const FieldPermission = {
  READ_WRITE: 'read_write',
  READ_ONLY: 'read_only',
  HIDDEN: 'hidden',
} as const;
export type FieldPermission = (typeof FieldPermission)[keyof typeof FieldPermission];

/** 权限收紧偏序：read_write > read_only > hidden；角色权限只能 ≤ 对象权限 */
export const FIELD_PERMISSION_RANK: Record<FieldPermission, number> = {
  read_write: 2,
  read_only: 1,
  hidden: 0,
};

export function isFieldPermission(value: unknown): value is FieldPermission {
  return (
    typeof value === 'string' &&
    (value === 'read_write' || value === 'read_only' || value === 'hidden')
  );
}

export function canTighten(from: FieldPermission, to: FieldPermission): boolean {
  return FIELD_PERMISSION_RANK[to] <= FIELD_PERMISSION_RANK[from];
}

/** 字段级权限角色目录（FORM-003；超管/社团负责人/人事/部门负责人/面试官/提交者） */
export const FormDesignerRole = {
  SUBMITTER: 'submitter',
  INTERVIEWER: 'interviewer',
  DEPARTMENT_HEAD: 'departmentHead',
  CLUB_LEADER: 'clubLeader',
  PERSONNEL: 'personnel',
  SUPER_ADMIN: 'superAdmin',
} as const;
export type FormDesignerRole = (typeof FormDesignerRole)[keyof typeof FormDesignerRole];

export const FORM_DESIGNER_ROLE_LIST: readonly FormDesignerRole[] = Object.values(FormDesignerRole);

export function isFormDesignerRole(value: unknown): value is FormDesignerRole {
  return (
    typeof value === 'string' && (FORM_DESIGNER_ROLE_LIST as readonly string[]).includes(value)
  );
}

/** 系统对象选择（权限受控的人员/社团/部门对象字段；FORM-003） */
export const FormObjectType = {
  PERSON: 'person',
  CLUB: 'club',
  DEPARTMENT: 'department',
} as const;
export type FormObjectType = (typeof FormObjectType)[keyof typeof FormObjectType];

export function isFormObjectType(value: string): value is FormObjectType {
  return value === 'person' || value === 'club' || value === 'department';
}

/** 条件显示/条件必填操作符（系统安全配置能力，服务端按不可变版本重算，FORM-003） */
export const FieldConditionOperator = {
  EQUALS: 'equals',
  NOT_EQUALS: 'not_equals',
  IN: 'in',
  NOT_IN: 'not_in',
  EMPTY: 'empty',
  NOT_EMPTY: 'not_empty',
} as const;
export type FieldConditionOperator =
  (typeof FieldConditionOperator)[keyof typeof FieldConditionOperator];

export function isFieldConditionOperator(value: string): value is FieldConditionOperator {
  return (
    value === 'equals' ||
    value === 'not_equals' ||
    value === 'in' ||
    value === 'not_in' ||
    value === 'empty' ||
    value === 'not_empty'
  );
}

/** 选项目录（选项目录来自绑定不可变版本，答案引用选项稳定 id，DATA-Q-007） */
export interface FormFieldOption {
  readonly id: string;
  readonly label: string;
}

/** 条件表达式（只允许登记过的操作符与值形状，禁止任意表达式/脚本注入） */
export interface FormFieldCondition {
  readonly fieldId: string;
  readonly operator: FieldConditionOperator;
  readonly value?: unknown;
}

/** 类型专属校验配置（长度/数值范围/正则；正则服务端编译后执行，禁止任意代码） */
export interface FormFieldValidation {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: string;
}

/** 动态字段定义（稳定字段 id 为 JSONB 答案键控标识，DATA-Q-007） */
export interface FormFieldDefinition {
  /** 稳定字段标识：^[a-z][a-z0-9_]{0,63}$，且不得与固定业务骨架冲突 */
  readonly id: string;
  /** 展示标题（<= 100，防注入文本） */
  readonly title: string;
  readonly type: FormFieldType;
  readonly required: boolean;
  /** 类型校验过的默认值（客户端 JSON 直存一律拒绝，DATA-FRM-001） */
  readonly defaultValue?: unknown;
  readonly placeholder?: string;
  /** select/multi_select/radio 选项目录 */
  readonly options?: FormFieldOption[];
  /** select 系统对象选择（person/club/department，权限受控） */
  readonly objectType?: FormObjectType;
  readonly validation?: FormFieldValidation;
  /** 对象级字段权限（默认 read_write） */
  readonly permission: FieldPermission;
  /** 按角色收紧（只能 ≤ 对象权限） */
  readonly rolePermissions?: Partial<Record<FormDesignerRole, FieldPermission>>;
  /** 基本资料自动带入（来源必须是平台批准的基本资料字段目录；表单内只读） */
  readonly autoFill?: { readonly sourceFieldId: string };
  /** 条件显示（引用同一版本内前序稳定字段） */
  readonly condition?: FormFieldCondition;
  /** 条件必填 */
  readonly requiredIf?: FormFieldCondition;
  /** array 可重复经历列表/子表（最多一层嵌套，项目内仍以稳定子字段 id 键控） */
  readonly items?: FormFieldDefinition[];
}

/** 一个不可变版本内全部动态字段（fields JSONB 载荷） */
export type FormFieldSet = readonly FormFieldDefinition[];

/** 固定业务骨架标识（FORM-001/07、SRS-INV-010）；动态字段不得占用 */
export const SkeletonFieldId = {
  SUBMITTER: 'submitter',
  BUSINESS_OBJECT: 'business_object',
  SCOPE: 'scope',
  STATUS: 'status',
  APPROVAL: 'approval',
  TIME: 'time',
  VERSION: 'version',
  PERMISSION: 'permission',
  USER: 'user',
  STUDENT_ID: 'student_id',
  CLUB: 'club',
  DEPARTMENT: 'department',
  POSITION: 'position',
  TENURE: 'tenure',
  INVITATION: 'invitation',
} as const;
export type SkeletonFieldId = (typeof SkeletonFieldId)[keyof typeof SkeletonFieldId];

const SKELETON_ID_SET: ReadonlySet<string> = new Set<string>(
  Object.values(SkeletonFieldId).map((id) => id.toLowerCase()),
);

export function isSkeletonFieldId(id: string): boolean {
  return SKELETON_ID_SET.has(id.toLowerCase());
}

/** 业务表单族目录（固定业务骨架分族；4.4/4.5 引用） */
export const FormBusinessFamily = {
  PLATFORM_PROFILE: 'platform_profile',
  RECRUITMENT_APPLICATION: 'recruitment_application',
  JOINT_APPLICATION: 'joint_application',
  INTERVIEW_EVALUATION: 'interview_evaluation',
  MEMBERSHIP_APPLICATION: 'membership_application',
  GENERAL: 'general',
} as const;
export type FormBusinessFamily = (typeof FormBusinessFamily)[keyof typeof FormBusinessFamily];

export function isFormBusinessFamily(value: string): value is FormBusinessFamily {
  return Object.values(FormBusinessFamily).includes(value as FormBusinessFamily);
}
