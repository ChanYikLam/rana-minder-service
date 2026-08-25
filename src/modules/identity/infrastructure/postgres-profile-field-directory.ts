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

/** 目录查询独立事务的 RLS 上下文（目录表 policy 放行全部；FORM-004 白名单平台级配置） */
const DIRECTORY_RLS_SCOPE = { kind: 'unprotected' } as const;

@Injectable()
export class PostgresProfileFieldDirectory implements ProfileFieldDirectoryPort {
  constructor(private readonly db: DbAdapter) {}

  async listApproved(): Promise<readonly ProfileFieldDirectoryEntry[]> {
    // 自建独立事务：本实现被 form 域跨模块调用（form 跑在 FormUnitOfWork 事务内，
    // 不得读取 IdentityUnitOfWork.active——无 identity 事务时 getter 抛错）。
    // 只读查询独立收口，不参与调用方事务（评审 4.1 Critical：跨模块事务上下文错配）。
    const tx = await this.db.beginTransaction();
    try {
      await this.db.setRlsContext(tx, DIRECTORY_RLS_SCOPE);
      const rows = await this.db.query<DirectoryRow>(
        tx,
        `SELECT field_id, label, read_only, editable
           FROM profile_field_directory
          WHERE enabled = true
          ORDER BY sort_order ASC`,
        [],
      );
      await this.db.commit(tx);
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
      await this.db.rollback(tx).catch(() => undefined);
      return FALLBACK_ENTRIES;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }
}
