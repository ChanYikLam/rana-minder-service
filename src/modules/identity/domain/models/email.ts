/**
 * Email 值对象（IDN-011 邮箱验证上下文）。
 *
 * 构造时完成基础结构校验与规范化（trim + 小写，域名为空拒绝）；
 * 业务前置校验（重复、频率、平台发信能力）由应用层/策略负责。
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class Email {
  private constructor(readonly value: string) {}

  static of(raw: string): Email {
    const normalized = raw.trim().toLowerCase();
    if (normalized.length === 0 || normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
      throw new EmailFormatError(normalized);
    }
    return new Email(normalized);
  }

  equals(other: Email): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}

export class EmailFormatError extends Error {
  constructor(value: string) {
    super(`email format invalid`);
    this.name = 'EmailFormatError';
    void value;
  }
}
