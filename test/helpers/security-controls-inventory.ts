/**
 * 安全控制清单（P1-B / TST-SEC-*；CI-004 证据）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md
 * （26 威胁 / 38 控制目标，SEC-CTL-001~038）。威胁侧以 THR 桩位占额
 * （status=未执行）；控制侧分 code 与 process 两通道记账（见下），
 * 每项必须携带真实存在的证据（evidence 文件），禁止虚报。
 *
 * 分通道记账：
 * - codeControls = CONCRETE_CONTROLS（37 项，每项有可执行测试证据文件）
 * - processControls = PROCESS_CONTROLS（1 项 SEC-CTL-001，流程证据文档承载）
 *   codeControls + processControls === TOTAL_CONTROLS (38)
 *
 * 留白说明：SEC-CTL-001（事实追溯：所有放行必须能追溯到产品事实/SRS，
 * 无来源行为为零）属流程审计范畴，无法以代码可执行测试佐证，故登记为
 * process 通道流程证据（见 PROCESS_CONTROLS）而非代码证据。注意它与已
 * 登记的 **TST-SEC-CTL-01**（身份占位 fail-closed）分属不同编号体系，勿混淆。
 *
 * 棘轮：BASELINE_CONCRETE_CONTROLS 只许上调；新增控制必须带真实
 * evidence 文件路径（套件内断言存在），否则清单测试失败。
 */

import { resolveThreatIdsFromDoc, threatDisplayId } from './authority-docs';

export const TOTAL_THREATS = 26;
export const TOTAL_CONTROLS = 38;

/** 当前已具可执行证据的控制项基线（棘轮下限） */
export const BASELINE_CONCRETE_CONTROLS = 37;

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
  {
    id: 'TST-SEC-CTL-13',
    title: '审计只追加不可篡改：仓储无修改/删除入口，字段完整且敏感不落盘',
    evidence: [R('src/modules/audit/application/commands/audit-baseline.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-14',
    title: '错误码头禁：对外仅 code/message(+field)，不泄漏内部键与堆栈',
    evidence: [R('src/common/errors/error-formatter.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-15',
    title: '契约运行时面守恒：external-result/api-paths/api-error 漂移即失败',
    evidence: [R('src/common/contracts/contracts-runtime.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-16',
    title: '文件未核验不可绑定或访问：上传/检查/绑定 fail-closed 流',
    evidence: [
      R('src/modules/file/application/commands/lifecycle.spec.ts'),
      R('src/modules/file/application/commands/upload-flow.spec.ts'),
    ],
  },
  {
    id: 'TST-SEC-CTL-17',
    title: '通知投递失败留痕：转发失败不上抛、保留待重试不静默丢失',
    evidence: [R('src/platform/tasks/executors/handlers/notification-delivery.handler.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-18',
    title: '事务发件箱幂等转发：成功后不再重放（防重复副作用）',
    evidence: [R('src/platform/tasks/outbox/outbox.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-19',
    title: '任务重试策略有界：退避与上限策略化，非无限重试',
    evidence: [R('src/platform/tasks/retry-policy/retry-policy.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-20',
    title: '对账真实检测：Group 删除/失权/移动差异进入领域处置',
    evidence: [R('src/platform/tasks/executors/handlers/reconciliation.handler.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-21',
    title: '权限模板发布单胜者：previewVersion 冲突拒绝部分生效',
    evidence: [
      R(
        'src/modules/organization/interfaces/controllers/admin-permission-templates.controller.spec.ts',
      ),
    ],
  },
  {
    id: 'TST-SEC-CTL-22',
    title: '联合参与名单单向门：首次公布后新增/退出一律拒绝',
    evidence: [
      R('src/modules/joint/domain/state-machines/joint-participant.state-machine.spec.ts'),
    ],
  },
  {
    id: 'TST-SEC-CTL-23',
    title: '批量操作冻结目标与参数；部分成功保留、重试仅含原失败项',
    // 断言范围：controlled-batch.use-case.spec.ts 覆盖目标/参数冻结与
    // 部分成功保留；batch-rules.ts 为批量规则常量（冻结目标的单一事实源）
    evidence: [
      R('src/modules/organization/application/commands/controlled-batch.use-case.spec.ts'),
      R('src/platform/tasks/batch/batch-rules.ts'),
    ],
  },
  {
    id: 'TST-SEC-CTL-24',
    title: '外部调用意图先行持久化：迟到/超时先读回，不凭 HTTP 成功宣称成功',
    // 断言范围（与 CTL-18 共用 outbox.spec.ts）：CTL-24 侧重迟到/超时先
    // 读回不回放；CTL-18 侧重成功后不再重放（防重复副作用）
    evidence: [R('src/platform/tasks/outbox/outbox.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-25',
    title: '会话禁用/删除立即失效：账号访问状态机即时收敛',
    evidence: [
      R('src/modules/identity/domain/state-machines/account-access.state-machine.spec.ts'),
      R('src/modules/organization/interfaces/actor.spec.ts'),
    ],
  },
  {
    id: 'TST-SEC-CTL-26',
    title: '失效联动：投影缓存跨社团隔离且可失效重建',
    // 断言范围（与 CTL-12 共用 in-memory-projection-store.spec.ts）：
    // CTL-26 侧重失效重建；CTL-12 侧重跨社团隔离不串缓存
    evidence: [R('src/platform/read-model/projection/in-memory-projection-store.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-27',
    title: 'RLS 结构隔离 fail-closed：未接线 DB 适配器构造即抛错（不可静默绕过）',
    evidence: [R('src/adapters/db/not-wired-db.adapter.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-28',
    title: '工作单元事务边界：begin/setRls/commit/clearRls 全链路 + 异常 rollback 收口',
    evidence: [
      R('src/modules/file/infrastructure/file-unit-of-work.spec.ts'),
      R('src/modules/form/application/commands/form-lifecycle.spec.ts'),
    ],
  },
  {
    id: 'TST-SEC-CTL-29',
    title: '撤权先于清理：正式删除流程按清单推进且失败不恢复访问',
    // 断言范围（与 CTL-33/37 共用 deletion.spec.ts）：CTL-29 侧重撤权先于
    // 清理、失败不恢复访问
    evidence: [R('src/modules/audit/application/commands/deletion.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-30',
    title: '动态表单答案强类型校验：未知字段/类型混淆拒绝',
    evidence: [
      R('src/modules/form/domain/services/form-answer.validator.spec.ts'),
      R('src/modules/form/domain/services/form-field.validator.spec.ts'),
    ],
  },
  {
    id: 'TST-SEC-CTL-31',
    title: '表单提交服务端校验：隐藏字段由服务端重算，客户端提交不信任',
    evidence: [R('src/modules/form/application/commands/submission.use-cases.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-32',
    title: '秘密只保存引用或受控密文：config loader 强制主密钥外置',
    evidence: [R('src/config/config.loader.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-33',
    title: '正式删除跨存储清单推进：部分失败不宣称完成、未完成步骤幂等收敛',
    // 断言范围（与 CTL-29/37 共用 deletion.spec.ts）：CTL-33 侧重跨存储
    // 清单推进与部分失败幂等收敛；task-execution-pipeline.spec.ts 佐证任务链收口
    evidence: [
      R('src/modules/audit/application/commands/deletion.spec.ts'),
      R('src/platform/tasks/executors/task-execution-pipeline.spec.ts'),
    ],
  },
  {
    id: 'TST-SEC-CTL-34',
    title: '追踪编号不含个人信息或秘密：契约运行时面守恒',
    // 断言范围（与 CTL-15 共用 contracts-runtime.spec.ts）：CTL-34 侧重追踪
    // 编号不含个人信息/秘密；CTL-15 侧重契约运行时面（external-result/API 漂移）
    evidence: [R('src/common/contracts/contracts-runtime.spec.ts')],
  },
  {
    id: 'TST-SEC-CTL-35',
    title: '发布预检版本化：CI 门禁脚本存在且 spec 覆盖率棘轮生效',
    evidence: [R('scripts/ci/check-spec-coverage.sh')],
  },
  {
    id: 'TST-SEC-CTL-36',
    title: '状态机继承安全控制：全枚举矩阵验证确定性+终态闭合+拒绝纯度',
    evidence: [
      R('test/fixtures/state-machine-test-matrix.ts'),
      R('test/contract/tst-sm-six-facets.spec.ts'),
    ],
  },
  {
    id: 'TST-SEC-CTL-37',
    title: '到期清理先撤权并最终收敛：保留期清理命令实现',
    // 断言范围：deletion.spec.ts 覆盖临时清理/审计角色/逐项失败收敛；
    // retention-cleanup.command.ts 为保留期清理编排实现（fail-closed 占位）
    evidence: [
      R('src/modules/audit/application/commands/deletion.spec.ts'),
      R('src/modules/audit/application/commands/retention-cleanup.command.ts'),
    ],
  },
];

// ---- 流程证据（SEC-CTL-001；路径 2 轻量版：账目分通道）----

/** 流程证据条目（非代码测试，由可审计文档承载） */
export interface ProcessEvidenceEntry {
  readonly id: string;
  readonly title: string;
  /** 流程证据文档路径（必须存在，fs.existsSync 校验） */
  readonly evidenceDoc: string;
}

/**
 * SEC-CTL-001（事实追溯）为流程审计控制——其证据是需求追踪矩阵的
 * "逐事实全链路追踪"与"无来源映射=0"，而非代码单测。
 * 登记为 kind:'process' 以与代码证据分通道记账（路径 2 轻量方案）。
 */
export const PROCESS_CONTROLS: readonly ProcessEvidenceEntry[] = [
  {
    id: 'TST-SEC-CTL-001',
    title: '事实追溯：所有放行可追溯到产品事实/SRS，无来源行为为零',
    evidenceDoc: R('docs/specification/需求追踪矩阵-v1.0.md'),
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
