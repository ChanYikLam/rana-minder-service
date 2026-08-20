/**
 * 邮箱验证请求实体（IDN-011、IFC-TX-005）。
 *
 * 单次令牌：只保存令牌哈希（不存明文）、24 小时有效期、消费即失效；
 * 新请求使旧请求按安全策略失效或保持不可重复使用；过期与成功竞争只一个成功。
 */

import { randomBytes, createHash } from 'node:crypto';

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface EmailVerificationSnapshot {
  readonly id: string;
  readonly subjectId: string;
  readonly email: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly requestVersion: number;
  readonly createdAt: Date;
}

export type ConsumeResult =
  | { readonly ok: true; readonly singleUse: true }
  | { readonly ok: false; readonly reason: 'WRONG_TOKEN' | 'EXPIRED' | 'ALREADY_CONSUMED' };

export class EmailVerification {
  private constructor(private snapshot: EmailVerificationSnapshot) {}

  static fromSnapshot(snapshot: EmailVerificationSnapshot): EmailVerification {
    return new EmailVerification(snapshot);
  }

  /** 生成新请求：随机令牌 32 字节、24 小时有效；令牌原值返回（仅本次），库存哈希 */
  static issue(
    id: string,
    subjectId: string,
    email: string,
    requestVersion: number,
    now: Date,
  ): { verification: EmailVerification; token: string } {
    const token = randomBytes(32).toString('hex');
    const snapshot: EmailVerificationSnapshot = {
      id,
      subjectId,
      email,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + EMAIL_VERIFICATION_TTL_MS),
      consumedAt: null,
      requestVersion,
      createdAt: now,
    };
    return { verification: new EmailVerification(snapshot), token };
  }

  get id(): string {
    return this.snapshot.id;
  }

  get requestVersion(): number {
    return this.snapshot.requestVersion;
  }

  get expiresAt(): Date {
    return this.snapshot.expiresAt;
  }

  toSnapshot(): EmailVerificationSnapshot {
    return { ...this.snapshot };
  }

  isExpired(now: Date): boolean {
    return now.getTime() >= this.snapshot.expiresAt.getTime();
  }

  isConsumed(): boolean {
    return this.snapshot.consumedAt !== null;
  }

  /** 单次消费：令牌匹配、未过期、未使用才成功（R005 前置由应用层复核对象绑定与邮箱一致） */
  consume(token: string, now: Date): ConsumeResult {
    if (this.isConsumed()) {
      return { ok: false, reason: 'ALREADY_CONSUMED' };
    }
    if (this.isExpired(now)) {
      return { ok: false, reason: 'EXPIRED' };
    }
    if (!timingSafeEqualHex(this.snapshot.tokenHash, hashToken(token))) {
      return { ok: false, reason: 'WRONG_TOKEN' };
    }
    this.snapshot = { ...this.snapshot, consumedAt: now };
    return { ok: true, singleUse: true };
  }

  /** 被新请求取代：旧链接立即不可再使用（R004） */
  supersede(now: Date): void {
    if (this.snapshot.consumedAt === null) {
      this.snapshot = { ...this.snapshot, consumedAt: now };
    }
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}