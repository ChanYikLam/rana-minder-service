/**
 * 邮件发件身份领域模型（NTF-008、NTF-009；需求发现 08「邮件署名与回复地址」）。
 *
 * 规则（产品行为已冻结）：
 * - 平台邮件使用平台当前展示名称；社团独立邮件使用该社团当前展示名称；
 * - 联合活动共同事件和超级管理员操作使用平台名称，社团独立结论与邀请使用相应社团名称；
 * - HTML 模板不能覆盖或伪装发件人身份；
 * - 回复地址固定为实际发信账号，不另设可指向任意地址的 Reply-To；
 * - 更换发信账号必须重新通过测试邮件，成功后只影响后续邮件，
 *   历史投递保留原身份（由渠道尝试的 senderIdentity 快照保证）。
 */

/** 通知作用域类型（与 NotificationScope 对齐） */
export type SenderScopeType = 'CLUB' | 'PLATFORM' | 'JOINT';

/** 解析后的发件身份（发送管道唯一可信来源） */
export interface SenderIdentity {
  /** 发件人展示名（平台名或社团名） */
  readonly displayName: string;
  /** 实际发信账号（SMTP 登录账号 / 信封 From） */
  readonly fromAddress: string;
  /**
   * 回复地址：固定等于实际发信账号（NTF-009.4）。
   * 领域层拒绝任何与 fromAddress 不同的 replyTo。
   */
  readonly replyTo: string;
}

/** 发件身份解析输入 */
export interface ResolveSenderIdentityInput {
  readonly scopeType: SenderScopeType;
  /** 社团当前展示名（CLUB 作用域必填） */
  readonly clubDisplayName: string | null;
  /** 平台当前展示名 */
  readonly platformDisplayName: string;
  /** 社团发信账号（来自该社团自己的已验证配置；不能借用其他社团） */
  readonly clubFromAddress: string | null;
  /** 平台发信账号（平台级已验证配置） */
  readonly platformFromAddress: string | null;
}

/** 发件身份解析结果 */
export type SenderIdentityResolution =
  | { readonly ok: true; readonly identity: SenderIdentity }
  | { readonly ok: false; readonly reason: string };

/**
 * 按作用域解析发件身份（NTF-008）。
 * CLUB 作用域必须使用该社团自己的发信账号与展示名；
 * PLATFORM/JOINT 使用平台账号与平台展示名。
 * 无有效账号时解析失败 → 只能发站内信（NTF-006）。
 */
export function resolveSenderIdentity(input: ResolveSenderIdentityInput): SenderIdentityResolution {
  if (input.scopeType === 'CLUB') {
    if (!input.clubFromAddress) {
      return { ok: false, reason: '社团无有效发信配置，只能发站内信' };
    }
    if (!input.clubDisplayName) {
      return { ok: false, reason: '社团展示名缺失' };
    }
    return {
      ok: true,
      identity: {
        displayName: input.clubDisplayName,
        fromAddress: input.clubFromAddress,
        // 回复地址固定为实际发信账号（NTF-009）
        replyTo: input.clubFromAddress,
      },
    };
  }
  if (!input.platformFromAddress) {
    return { ok: false, reason: '平台无有效发信配置，只能发站内信' };
  }
  return {
    ok: true,
    identity: {
      displayName: input.platformDisplayName,
      fromAddress: input.platformFromAddress,
      replyTo: input.platformFromAddress,
    },
  };
}

/**
 * 校验模板内容未试图覆盖/伪装发件人身份（NTF-008.3）。
 *
 * 模板正文出现邮件头注入样式的 From/Sender/Reply-To/Bcc 等声明
 * 即视为越权覆盖，返回违规列表；空数组表示通过。
 * 发送管道以本函数结果决定回退平台安全默认模板。
 */
export function findIdentityOverrideAttempts(templateBody: string): readonly string[] {
  const violations: string[] = [];
  // 安全优先口径：模板任何位置出现头声明样式片段即视为越权
  // （误报可由管理员改写文案规避；漏报会引入身份伪装风险）
  const headerPatterns: ReadonlyArray<[RegExp, string]> = [
    [/\bfrom\s*:/gi, 'From'],
    [/\bsender\s*:/gi, 'Sender'],
    [/\breply-to\s*:/gi, 'Reply-To'],
    [/\bbcc\s*:/gi, 'Bcc'],
    [/\bcc\s*:/gi, 'Cc'],
  ];
  for (const [pattern, label] of headerPatterns) {
    if (pattern.test(templateBody)) {
      violations.push('模板试图声明邮件头 ' + label + '（发件身份不可被模板覆盖）');
    }
  }
  return violations;
}
