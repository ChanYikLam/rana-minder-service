// no-spec-required 纯接口端口（无实现逻辑），由基础设施实现（postgres-profile-field-directory.spec.ts）与内存实现实际覆盖验证
/**
 * 平台批准的基本资料字段目录端口（identity 域；FORM-004、IDN-002）。
 *
 * 字段目录是平台级配置（4.1 收口：StaticProfileFieldDirectory → PostgreSQL 配置化目录）：
 * - 可编辑白名单字段（email/phone/college/grade）：学生本人可直接修改；
 * - 只读权威字段（studentId/name）：以 Casdoor 为权威，只读。
 *
 * 消费方：form 域自动带入白名单（FormProfileFieldDirectoryPort 经本端口适配）；
 * identity 的必填规则（RequiredFieldRulesPort）未来可同源扩展。目录变更属平台级
 * 配置，随配置版本发布（1.5）；enabled=false 的字段不进入自动带入白名单。
 */

/** 目录项 */
export interface ProfileFieldDirectoryEntry {
  /** 稳定字段名（须属于共享 profile-field 常量集合，禁止动态表单自定义字段进入） */
  readonly fieldId: string;
  /** 展示名 */
  readonly label: string;
  /** 权威字段只读（姓名/学号以 Casdoor 为权威） */
  readonly readOnly: boolean;
  /** 可编辑白名单字段（学生本人可直接修改） */
  readonly editable: boolean;
}

/** 平台批准的基本资料字段目录端口（读侧；管理侧属平台配置命令，另行接线） */
export interface ProfileFieldDirectoryPort {
  /** 当前启用的字段目录（按配置排序；空目录兜底返回内置 6 字段常量） */
  listApproved(): Promise<readonly ProfileFieldDirectoryEntry[]>;
}
