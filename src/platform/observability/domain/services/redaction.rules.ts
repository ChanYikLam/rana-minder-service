/**
 * 脱敏规则——纯领域规则。
 *
 * 覆盖：ADR-011 §2.1、observability/README §6.1、AUD-013、AUD-014。
 *
 * 不做：I/O、HTTP、日志框架适配、配置加载——这些由 infrastructure/LogWriterAdapter
 * 承接。
 *
 * 位置：src/platform/observability/domain/services/（PR #32 §2.2 B；2026-08-18 由
 * src/modules/ops/domain/services/ 整体迁移）。
 */

export type RedactionDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'omit' }
  | { readonly kind: 'mask'; readonly hint?: 'path' }
  | { readonly kind: 'truncate'; readonly max: number };

// 完全禁止记录：键名命中即整字段丢弃。
// 涵盖报名正文、评价/评语、附件原始内容、审计原始负载（不替代业务审计）。
export const FORBIDDEN_KEY_PATTERNS: readonly RegExp[] = [
  /^form\.responses\./i,
  /^evaluation.*content$/i,
  /^comments?\./i,
  /^attachments?\.(content|raw|data)$/i,
  /^audit\.raw$/i,
];

// 强脱敏：值做不可逆遮蔽。
// 涵盖完整联系方式、令牌、密钥、连接字符串等（AUD-013、AUD-014）。
export const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /^phone$/i,
  /^mobile$/i,
  /^tel$/i,
  /^email$/i,
  /^idCard$/i,
  /^password$/i,
  /^secret$/i,
  /^token$/i,
  /^accessToken$/i,
  /^refreshToken$/i,
  /^jwt$/i,
  /^api[_-]?key$/i,
  /^accessKey$/i,
  /^secretKey$/i,
  /^privateKey$/i,
  /^casdoor\.(clientSecret|token|cookie)$/i,
  /^mail\.(password|user)$/i,
  /^storage\.(secretKey|accessKey|password)$/i,
  /^database\.password$/i,
  /^connectionString$/i,
  /^dsn$/i,
];

// 路径/URL 段脱敏命中：连接信息按"段名→首字母+***"处理（最小披露原则）。
// 例：/var/lib/postgres/data → /v***/l***/d***
export const PATH_KEY_PATTERNS: readonly RegExp[] = [/^path$/i, /^filePath$/i];

// 允许原样保留的字段白名单。命中 → 'allow'；未命中且不在敏感列表 → 走默认
// 'truncate'(max=200)。
// 涵盖：ID、时间戳、状态、版本、追踪编号等运维诊断所需事实。
export const SAFE_KEY_PATTERNS: readonly RegExp[] = [
  /^id$/i,
  /^[a-zA-Z][a-zA-Z0-9_]*Id$/i, // fooId、userId、recruitmentId 等
  /^_?trace(?:Id|ParentId)?$/i,
  /^state$/i,
  /^status$/i,
  /^category$/i,
  /^tier$/i,
  /^method$/i,
  /^code$/i,
  /^count$/i,
  /^total$/i,
  /^version$/i,
  /^attempt$/i,
  /^createdAt$/i,
  /^updatedAt$/i,
  /^createdBy$/i,
  /^updatedBy$/i,
  /^actor$/i,
  /^http\.method$/i,
  /^http\.statusCode$/i,
];

export const DEFAULT_TRUNCATE_MAX = 200;
export const PATH_SEGMENT_KEEP_FIRST = 1;

export function decide(key: string): RedactionDecision {
  if (FORBIDDEN_KEY_PATTERNS.some((p) => p.test(key))) {
    return { kind: 'omit' };
  }
  if (SAFE_KEY_PATTERNS.some((p) => p.test(key))) {
    return { kind: 'allow' };
  }
  if (SENSITIVE_KEY_PATTERNS.some((p) => p.test(key))) {
    return { kind: 'mask' };
  }
  if (PATH_KEY_PATTERNS.some((p) => p.test(key))) {
    return { kind: 'mask', hint: 'path' };
  }
  return { kind: 'truncate', max: DEFAULT_TRUNCATE_MAX };
}

export function redactValue(value: unknown, decision: RedactionDecision): unknown {
  switch (decision.kind) {
    case 'allow':
      return redactNested(value);
    case 'omit':
      return undefined;
    case 'mask':
      return maskPrimitive(value, decision.hint);
    case 'truncate':
      return truncatePrimitive(value, decision.max);
  }
}

export function redactRecord(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const decision = decide(k);
    if (decision.kind === 'omit') {
      continue;
    }
    out[k] = redactValue(v, decision);
  }
  return out;
}

// ----- 内部辅助 -----

function redactNested(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactNested);
  }
  if (value !== null && typeof value === 'object') {
    return redactRecord(value as Record<string, unknown>);
  }
  return value;
}

function maskPrimitive(value: unknown, hint?: 'path'): string {
  if (value === null || value === undefined) {
    return '';
  }
  const s = typeof value === 'string' ? value : String(value);
  if (hint === 'path') {
    return maskPath(s);
  }
  if (s.length <= 8) {
    return '***';
  }
  return `${s.slice(0, 4)}***[len=${s.length}]`;
}

function maskPath(path: string): string {
  return path.replace(/\/([^/]+)/g, (_match, segment: string) => {
    if (segment.length === 0) {
      return '/';
    }
    return `/${segment.slice(0, PATH_SEGMENT_KEEP_FIRST)}***`;
  });
}

function truncatePrimitive(value: unknown, max: number): string {
  if (value === null || value === undefined) {
    return '';
  }
  const s = typeof value === 'string' ? value : safeStringify(value);
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, max)}...[truncated]`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? String(v) : v));
  } catch {
    return '<unserializable>';
  }
}
