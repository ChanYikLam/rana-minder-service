/**
 * PostgreSQL 平台批准的基本资料字段目录（infrastructure；4.1 收口）。
 *
 * 配置化目录替代原静态实现（StaticProfileFieldDirectory）：读 profile_field_directory
 * 表（迁移 20260826000000 种子内置 6 字段）；enabled=false 不进入自动带入白名单。
 * 空目录/表不可用时兜底返回内置常量（与迁移种子一致，FORM-004 自动带入不失效）。
 * 管理侧（平台增删/排序/停用）属平台配置命令，随配置版本发布另行接线。
 */

import { Injectable } from '@nestjs/common';
import type { DbAdapter } from '../../../shared/db-adapter';
import type { IdentityUnitOfWork } from './unit-of-work';
import {
  EditableProfileField,
  AuthoritativeProfileField,
} from '../../../shared/models/profile-field';
import type {
  ProfileFieldDirectoryEntry,
  ProfileFieldDirectoryPort,
} from '../application/ports/profile-field-directory.port';

interface DirectoryRow {
  field_id: string;
  label: string;
  read_only: boolean;
  editable: boolean;
}

/** 内置兜底目录（与迁移 20260826000000 种子一致） */
const FALLBACK_ENTRIES: readonly ProfileFieldDirectoryEntry[] = [
  { fieldId: EditableProfileField.EMAIL, label: '邮箱', readOnly: false, editable: true },
  { fieldId: EditableProfileField.PHONE, label: '手机号', readOnly: false, editable: true },
  { fieldId: EditableProfileField.COLLEGE, label: '学院', readOnly: false, editable: true },
  { fieldId: EditableProfileField.GRADE, label: '年级', readOnly: false, editable: true },
  {
    fieldId: AuthoritativeProfileField.STUDENT_ID,
    label: '学号',
    readOnly: true,
    editable: false,
  },
  { fieldId: AuthoritativeProfileField.NAME, label: '姓名', readOnly: true, editable: false },
];

@Injectable()
export class PostgresProfileFieldDirectory implements ProfileFieldDirectoryPort {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: IdentityUnitOfWork,
  ) {}

  async listApproved(): Promise<readonly ProfileFieldDirectoryEntry[]> {
    try {
      const rows = await this.db.query<DirectoryRow>(
        this.uow.active,
        `SELECT field_id, label, read_only, editable
           FROM profile_field_directory
          WHERE enabled = true
          ORDER BY sort_order ASC`,
        [],
      );
      if (rows.length === 0) {
        return FALLBACK_ENTRIES;
      }
      return rows.map((r) => ({
        fieldId: r.field_id,
        label: r.label,
        readOnly: r.read_only,
        editable: r.editable,
      }));
    } catch {
      // 表不可用（迁移未执行/只读降级）时兜底内置目录，自动带入白名单不失效（FORM-004）
      return FALLBACK_ENTRIES;
    }
  }
}
