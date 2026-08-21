/**
 * 邮箱验证请求存储端口（IDN-011/IFC-TX-005 实体持久化边界）。
 *
 * 只保存令牌哈希（不存明文），24 小时有效、消费即失效；新请求取代旧请求原子落库。
 */

import type { EmailVerificationSnapshot } from '../../domain/models/email-verification';

export interface EmailVerificationRepository {
  /** 载入指定验证请求（不存在返回 null） */
  load(id: string): Promise<EmailVerificationSnapshot | null>;
  /** 保存（新建或覆盖，原子）；返回受影响行数（0 = 已有已消费记录被守卫拒绝，供消费方判定并发） */
  save(snapshot: EmailVerificationSnapshot): Promise<number>;
  /** 查最近一次同主体同邮箱的验证请求（重发频率判定；无则 null） */
  findLatestBySubjectAndEmail(
    subjectId: string,
    email: string,
  ): Promise<EmailVerificationSnapshot | null>;
  /** 查最近一次同主体的验证请求（requestVersion 单调递增依据；无则 null） */
  findLatestBySubject(subjectId: string): Promise<EmailVerificationSnapshot | null>;
}
