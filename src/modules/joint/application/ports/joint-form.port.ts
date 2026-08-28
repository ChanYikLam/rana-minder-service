/**
 * 联合表单端口（joint 应用层；复用 4.x Form/Questionnaire 服务，JNT-003）。
 *
 * 联合申请须挂接统一表单模板（需用户明确勾选共享信息同意），不自动沿用其他活动同意。
 */

export interface JointFormRefDto {
  readonly formId: string;
  readonly submissionId: string;
  readonly versionNumber: number;
}

import type { Pool } from 'pg';

export interface JointFormPort {
  /** 校验表单提交存在且版本有效；返回规整后的引用 */
  resolveSubmission(input: {
    formId: string;
    submissionId: string;
    versionNumber: number;
  }): Promise<JointFormRefDto | null>;
  /** 读取提交时用户显式勾选的共享信息同意标记 */
  resolveConsent(input: {
    formId: string;
    submissionId: string;
  }): Promise<{ consentSnapshotHash: string } | null>;
}

export class NotWiredJointForm implements JointFormPort {
  async resolveSubmission(): Promise<JointFormRefDto | null> {
    return null;
  }
  async resolveConsent(): Promise<{ consentSnapshotHash: string } | null> {
    return null;
  }
}

/** 联调真实实现（2026-08-27）：查 form_submissions 校验提交存在且版本有效 */
export class FormBackedJointForm implements JointFormPort {
  constructor(private readonly pool: Pool) {}
  async resolveConsent(): Promise<{ consentSnapshotHash: string } | null> {
    return null;
  }
  async resolveSubmission(input: {
    formId: string;
    submissionId: string;
    versionNumber: number;
  }): Promise<JointFormRefDto | null> {
    const result = await this.pool.query<{
      id: string;
      form_id: string;
      version_number: string | number;
    }>(
      `SELECT id, form_id, version_number
         FROM public.form_submissions
        WHERE id = $1 AND form_id = $2 AND version_number = $3
          AND status IN ('SUBMITTED', 'PUBLISHED')`,
      [input.submissionId, input.formId, input.versionNumber],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      formId: row.form_id,
      submissionId: row.id,
      versionNumber: Number(row.version_number),
    };
  }
}
