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
