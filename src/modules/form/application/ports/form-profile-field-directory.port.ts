/**
 * 平台批准的基本资料字段目录端口（form 域；FORM-004）。
 *
 * 自动带入只能从平台批准的基本资料字段目录带入（不能读取任意 Casdoor Claim 或
 * 未授权业务数据）；目录项即 identity 模块的可编辑白名单字段与只读权威字段
 * （email/phone/college/grade/studentId/name）。表单内自动带入字段只读，
 * 不回写个人资料（FORM-004）；正式提交时保存资料快照（4.1.2）。
 */

export interface ProfileFieldDirectoryEntry {
  readonly fieldId: string;
  readonly label: string;
  /** 权威字段只读（姓名/学号以 Casdoor 为权威） */
  readonly readOnly: boolean;
}

export interface FormProfileFieldDirectoryPort {
  listApproved(): Promise<readonly ProfileFieldDirectoryEntry[]>;
}
