/**
 * 安全控制清单（P1-B / TST-SEC-*；CI-004 证据）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md
 * （26 威胁 / 38 控制目标）。威胁侧以 THR 桩位占额（status=未执行），
 * 控制侧仅登记**当前仓库已有可执行证据**的条目（evidence 必须存在）；
 * 未登记部分由 TOTAL_CONTROLS - concrete 显式留缺口，禁止虚报。
 *
 * 棘轮：BASELINE_CONCRETE_CONTROLS 只许上调；新增控制必须带真实
 * evidence 文件路径（套件内断言存在），否则清单测试失败。
 */

import { resolveThreatIdsFromDoc, threatDisplayId } from './authority-docs';

export const TOTAL_THREATS = 26;
export const TOTAL_CONTROLS = 38;

/** 当前已具可执行证据的控制项基线（棘轮下限） */
export const BASELINE_CONCRETE_CONTROLS = 12;

export interface SecurityControlEntry {
  /** TST-SEC-CTL-xx */
  readonly id: string;
  readonly title: string;
  /** 可执行证据套件/实现（相对仓库根，必须存在） */
  readonly evidence: readonly string[];
}

const R = (p: string): string => p;

export const CONCRETE_CONTROLS: readonly SecurityControlEntry[] = [
  {
    id: 'TST-SEC-CTL-01',
    title: '身份占位 fail-closed：生产拒绝伪造 x-actor-id',
    evidence: [R('src/modules/organization/interfaces/actor.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-02',
    title: '外部错误脱敏：密钥/令牌/Authorization 不入日志与错误摘要',
    evidence: [
      R('src/adapters/redaction.spec.ts'),
      R('src/platform/observability/logging/sanitizer.spec.ts'),
    ],
  },
  {
    id: 'TST-SEC-CTL-03',
    title: 'Casdoor Basic 凭据仅服务端组装且不回显明文',
    evidence: [R('src/adapters/casdoor/http-casdoor.adapter.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-04',
    title: 'Webhook 默认关闭；启用须静态秘密匹配',
    evidence: [R('src/platform/casdoor/domain/webhook-policy.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-05',
    title: '通知接口鉴权守卫（无会话拒绝）',
    evidence: [R('src/modules/notification/interfaces/notification-auth.guard.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-06',
    title: '状态页授权 fail-closed（RejectAll 缺省拒绝）',
    evidence: [R('src/platform/observability/status-page/status-page-authorizer.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-07',
    title: '写后读回门控：不以 HTTP 成功宣称成功（防假成功/UNCERTAIN 滥用）',
    evidence: [R('src/platform/casdoor/application/casdoor-write.service.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-08',
    title: '审计脱敏边界：audit.*/permission.* 等前缀键拒绝入审计',
    evidence: [R('src/platform/observability/audit-link/audit-boundary.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-09',
    title: '任务幂等键与追踪编号强制区分（防关联混淆/重放歧义）',
    evidence: [R('src/platform/tasks/idempotency/idempotency.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-10',
    title: '单执行租约互斥：并发双 worker 单胜者（防重复执行越权副作用）',
    evidence: [R('src/platform/tasks/lease/lease.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-11',
    title: '查询入口负向校验：未知筛选/操作符/游标复用一律拒绝',
    evidence: [R('src/platform/read-model/query/query-entry.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-12',
    title: '投影作用域隔离：跨社团缓存绝不命中',
    evidence: [R('src/platform/read-model/projection/in-memory-projection-store.spec.ts')],
  },
];

/**
 * 威胁桩位：按权威威胁模型文档的 SEC-THR 编号逐项生成，状态一律"未执行"。
 *
 * 编号来源不再硬编码，而是解析 docs/specification/安全设计与实现级威胁模型-v1.0.md
 * 的威胁目录表（SEC-THR-001 ~ 026）；文档增删威胁时，桩位随之变化，
 * 相关断言会显式失败，而不是静默通过（防虚报 / 防漂移）。
 */
export function threatStubs(): readonly { id: string; status: '未执行' }[] {
  return resolveThreatIdsFromDoc().map((thr) => ({
    id: `TST-SEC-THR-${threatDisplayId(thr)}`,
    status: '未执行' as const,
  }));
}
