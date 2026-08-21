/**
 * 平台批准的基本资料字段目录实现（infrastructure；FORM-004）。
 *
 * 静态目录：identity 模块的可编辑白名单字段（email/phone/college/grade）与只读
 * 权威字段（studentId/name）。自动带入字段在表单内只读、不回写个人资料
 * （FORM-004）。identity 的目录变更属平台级配置，随 3.x 配置化目录接入后替换。
 */

import type { FormProfileFieldDirectoryPort } from '../application/ports/form-profile-field-directory.port';
import type { ProfileFieldDirectoryEntry } from '../application/ports/form-profile-field-directory.port';
import {
  EditableProfileField,
  AuthoritativeProfileField,
} from '../../../shared/models/profile-field';

const ENTRIES: readonly ProfileFieldDirectoryEntry[] = [
  { fieldId: EditableProfileField.EMAIL, label: '邮箱', readOnly: false },
  { fieldId: EditableProfileField.PHONE, label: '手机号', readOnly: false },
  { fieldId: EditableProfileField.COLLEGE, label: '学院', readOnly: false },
  { fieldId: EditableProfileField.GRADE, label: '年级', readOnly: false },
  { fieldId: AuthoritativeProfileField.STUDENT_ID, label: '学号', readOnly: true },
  { fieldId: AuthoritativeProfileField.NAME, label: '姓名', readOnly: true },
];

export class StaticProfileFieldDirectory implements FormProfileFieldDirectoryPort {
  async listApproved(): Promise<readonly ProfileFieldDirectoryEntry[]> {
    return ENTRIES;
  }
}
