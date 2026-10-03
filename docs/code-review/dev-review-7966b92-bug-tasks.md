# dev 分支全量代码审查 · Bug 任务清单

- **审查对象**：`dev` 分支最新提交 `7966b92`（合并 PR #133 后），快照位于 `.worktrees/dev-review`
- **审查日期**：2026-08-24
- **审查范围**：非测试代码（排除 `*.spec.ts` / `*.test.ts` / `test/`），约 77,000 行 TypeScript
- **分级定义**：
  - **P0**：安全控制失效 / 数据丢失或损坏风险 / 全新环境必然不可用
  - **P1**：确定性功能缺陷（死锁、竞态、承诺与实现不符的防护、越权隐患接线）
  - **P2**：健壮性隐患（特定条件触发、部署形态相关、语义失真）
  - **P3**：风格 / 注释与实现不符 / 低危加固项

## 统计

| 级别 | 数量 | 编号 |
|------|------|------|
| P0 | 3 | BUG-001 ~ 003 |
| P1 | 4 | BUG-004 ~ 007 |
| P2 | 5 | BUG-008 ~ 012 |
| P3 | 6 | BUG-013 ~ 018 |

---

## P0（必须立即处理）

### BUG-001 [P0] 任务平台生产接线使用内存实现：重启丢任务意图、幂等去重失效
- **文件**：`src/platform/tasks/module.ts:49-55`
- **描述**：任务仓储是 Postgres 实现，但 `TASK_OUTBOX_STORE`、`IDEMPOTENCY_STORE`、`BATCH_STORE` 无条件绑定为内存实现，无任何环境开关，也无"临时方案"注释。
- **证据**：
  ```ts
  // module.ts:53-55
  { provide: TASK_OUTBOX_STORE, useExisting: InMemoryTransactionOutboxStore },
  { provide: IDEMPOTENCY_STORE, useExisting: InMemoryIdempotencyStore },
  { provide: BATCH_STORE, useExisting: InMemoryBatchStore },
  ```
  存储本体为 `Map`（`src/platform/tasks/outbox/in-memory-transactional-outbox.ts`、`src/platform/tasks/idempotency/in-memory-idempotency-store.ts:7`）。
- **影响**：① worker 重启 → outbox 待转发意图永久丢失（业务事务已提交但任务永不执行）；② 幂等记录清零 → 重启后重放任务造成重复副作用（重复通知/导出/Casdoor 同步）；③ 多 worker 部署时跨进程去重完全失效。"事务发件箱"的持久性承诺落空。
- **修复建议**：为 outbox/idempotency/batch 提供 Postgres 落表实现并设为默认；在落地前于启动时对非 dev 环境显式 fail-fast 阻止使用内存实现。
- **验收标准**：重启 worker 后待转发意图与幂等记录不丢失；双 worker 并发领取同一幂等键仅一次生效。

### BUG-002 [P0] 迁移执行器缺失：15 个迁移文件无任何执行路径，全新环境必然不可用
- **文件**：`src/database/migrations/*`（全部）；`package.json` scripts；`docker-compose.yml`
- **描述**：迁移文件导出 `up()/down()` 并声明登记表 `_migration_log`，但全仓不存在任何 runner/脚本消费它们：`MigrationQueryRunner` 接口零引用方；package.json 无 `migration:run`（docs/engineering/开发环境搭建指南-v1.0.md:55 引用了它）；compose/Dockerfile 不执行迁移；`scripts/dev/postgres-init.sql` 仅创建扩展。另注意存在两个同时间戳前缀迁移（`20260823000000_create-joint-tables.ts` 与 `20260823000000_create-audit-event-tables.ts`），未来实现 runner 时必须定义确定性的同戳排序规则。
- **影响**：全新环境无法建表 → 应用启动后所有 SQL 查询失败，系统整体不可用；迁移登记/回滚能力为零。
- **修复建议**：实现自定义 runner（按文件名字典序+同戳 tie-break），提供 `migration:run`/`migration:revert` 脚本，写入 `_migration_log`（version/applied_at/checksum），并在 CI 与 compose 初始化中接入。
- **验收标准**：空库执行一条命令完成全量建表且可重复执行（幂等）；两个同戳迁移顺序稳定。

### BUG-003 [P0] 会话吊销链路只写不读：禁用账号的 JWT 在剩余有效期内持续可用
- **文件**：`src/modules/identity/interfaces/nest/oidc-session-provider.ts:37-72`；`src/modules/identity/infrastructure/postgres-session-revocation.ts:20-28`
- **描述**：账号禁用/删除事件会调用 `invalidateSessions()` 更新 `auth_sessions.revoke_version`（设计依据 IDN-008"立即终止全部会话"），但：① 认证解析 `resolveSession()` 只做 JWT 验签（24h exp），从不读取吊销版本；② `auth_sessions` 表全仓无任何 INSERT（会话是无状态 JWT，从不落行）→ 该 UPDATE 恒命中 0 行。
- **证据**：
  ```ts
  // oidc-session-provider.ts:42-44 — 仅验签，无吊销校验
  const { payload } = await jwtVerify(token, this.config.sessionSecret, { algorithms: ['HS256'] });
  ```
- **影响**：被禁用/删除账号的既有令牌最长 24 小时内仍可通过认证并携带其旧权限，安全回收机制整体失效（写侧断裂 + 读侧缺失双重缺陷）。
- **修复建议**：在 `resolveSession` 中接入吊销检查（按主体比对 account_access 的 `session_revoke_version` 或查 auth_sessions），或在 JWT 中加入版本号声明并在解析时与权威表比对；同时明确 auth_sessions 是否需要真实写入。
- **验收标准**：禁用账号后 ≤5 秒内该主体所有令牌请求返回 401。

---

## P1（本迭代内必须修复）

### BUG-004 [P1] 恢复重放永不可达：EXECUTING 幂等记录导致任务永久卡在 LEASED↔PENDING 循环
- **文件**：`src/platform/tasks/idempotency/recovery-replay.ts:28-39`；`src/platform/tasks/executors/task-execution-pipeline.ts:40-46,149-157`
- **描述**：pipeline 先 `tryClaim`（此时任务租约为刚取到的新租约）再调用 `convergeBeforeExecution`；后者判断 EXECUTING 记录对应任务的租约是否过期时，用 `findByIntentId` 取回的是**当前这次刚领的新租约**——恒未过期 → 恒 `allowed:false` → 回写 PENDING。下一轮调度重复同一循环。
- **证据**：
  ```ts
  // recovery-replay.ts:29-34 — fresh 是本次刚 claim 的行，leaseUntil 必然 > now
  const fresh = await this.repository.findByIntentId(task.intentId);
  const leaseExpired = fresh === null || ... || new Date(fresh.lease.leaseUntil).getTime() <= now.getTime();
  if (leaseExpired === false) return { allowed: false };
  ```
  ```ts
  // task-execution-pipeline.ts:46-50 先 claim 后收敛
  const claim = await this.leases.tryClaim(...); ...
  const convergence = await this.convergence.convergeBeforeExecution(leased, now);
  ```
- **影响**：worker 崩溃后留下 EXECUTING 记录的任务永远无法恢复重放（每轮空转占用调度配额）；`recovery-replay.ts:35-38` 的恢复分支成为死代码。
- **修复建议**：将过期判断改为基于**崩溃前任期**的证据（如幂等记录记录 leaseVersion/executingSince，或比较任务 `updated_at` 与记录 `updatedAt`），claim 前预检 + claim 后二次确认；补充"崩溃后恢复重放"集成测试。
- **验收标准**：模拟 handler 执行中进程崩溃，重启后该任务恰好被执行一次。

### BUG-005 [P1] 批量逐项鉴权与任务前置检查是无条件放行的 Development 实现，且在生产模块无条件接线
- **文件**：`src/platform/tasks/batch/batch-authorization.ts:16-24`；`src/platform/tasks/executors/task-precondition.ts:11-14`；`src/platform/tasks/module.ts:57-58`
- **描述**：`DevelopmentBatchItemAuthorization.verify()` 恒返回 `{ok:true}`，`DevelopmentTaskPrecondition.verify()` 同样恒放行；两者经 `useExisting` 无条件注入生产 IoC。批量编排器逐项调用该鉴权口（`batch-orchestrator.ts:107`）。
- **影响**：当前批处理子系统尚无业务调用方故暂不可利用，但任何模块一旦接入批次命令即形成逐项鉴权绕过；前置条件检查形同虚设。
- **修复建议**：实现真实的按操作类型×业务类型×条目归属校验；在真实实现就绪前，对非 dev 环境注入 fail-closed（默认拒绝）实现。
- **验收标准**：非授权主体构造的批次项在执行期被 REJECTED；dev 行为由显式环境变量控制。

### BUG-006 [P1] DbAdapter 承诺的连接归还兜底 ROLLBACK 不存在：漏回滚的事务悬挂在池连接上
- **文件**：`src/adapters/db/postgres-db-adapter.ts:14`（头注释）；全文无 `pool.on('release', ...)`
- **描述**：头注释声称"对未提交即释放的连接由归还钩子兜底 ROLLBACK"，但代码从未注册 release 钩子；`clearRlsContext` 的兜底仅在调用方主动调用时生效。
- **影响**：应用层任何一条异常路径漏调 rollback（如 commit 与 rollback 之间抛错未被包裹），事务将随连接归还池而保持打开——下一个借用者继承该事务上下文与行锁，读到未提交数据或阻塞，造成难以排查的数据一致性事故。
- **修复建议**：注册 `pool.on('release')` 钩子检测未收口事务并 ROLLBACK + 告警；或封装"execute-in-tx"高阶函数使 commit/rollback 不可能被遗漏。
- **验收标准**：人为构造漏 rollback 的调用，日志出现告警且池内连接无可悬挂事务。

### BUG-007 [P1] 登出不吊销令牌：仅清 Cookie，JWT 在剩余有效期内可重放
- **文件**：`src/modules/identity/interfaces/nest/casdoor-session.controller.ts:194-206`
- **描述**：`DELETE /api/auth/logout` 只下发 `Max-Age=0` 清 Cookie，不调用任何吊销机制；配合 BUG-003（无读取侧校验），登出后的令牌仍可用于 API 调用直至 24h 过期。
- **影响**：共享设备/令牌泄露场景下"退出登录"不产生实际安全效果。
- **修复建议**：短期：登出时维护主体级 denylist 或推进 revoke_version（与 BUG-003 一并修）；长期：会话服务端化（auth_sessions 落行）。
- **验收标准**：登出后用原 token 调用受保护端点返回 401。

---

## P2（下一迭代修复）

### BUG-008 [P2] OIDC nonce 存储为进程内存：多实例部署登录随机失败
- **文件**：`src/modules/identity/interfaces/nest/casdoor-session.controller.ts:63`（`new InMemoryOidcNonceStore()`）
- **描述**：nonce 签发与消费在同一进程 Map 中。多副本 + LB 把回调路由到另一实例 → "nonce not issued" 登录失败；实例重启丢 in-flight nonce。
- **修复建议**： nonce 存储改共享存储（DB/Redis），或签名 state（HMAC + 短 TTL）替代服务端台账。

### BUG-009 [P2] 数据库 SSL 关闭证书校验（rejectUnauthorized:false）
- **文件**：`src/adapters/db/postgres-db-adapter.ts:88`
- **描述**：`ssl: poolConfig.ssl ? { rejectUnauthorized: false } : false` 接受任意证书，链路可被中间人。
- **修复建议**：支持配置 CA 证书路径并默认校验；仅在显式声明的开发开关下允许跳过。

### BUG-010 [P2] 通知投递处理器对未知 intent 只告警并标记成功
- **文件**：`src/platform/tasks/executors/handlers/notification-delivery.handler.ts:47-50`
- **描述**：payload 既非 deliver_inbox 也非 retry_channel 时 `logger.warn` 后正常返回 → 任务被置 COMPLETED，坏数据被静默吞掉。
- **修复建议**：抛 `TaskExecutionError(retryable:false)` 使其进入 MANUAL_INTERVENTION。

### BUG-011 [P2] Outbox 毒丸意图无限重试：无尝试计数/退避/死信
- **文件**：`src/platform/tasks/outbox/task-intent-outbox.ts:19-35`
- **描述**：单条转发失败仅 warn 后 continue，下轮继续从头重试同一毒丸意图，无最大尝试次数与死信转移。
- **修复建议**：记录 attempt_count，超限转 DEAD 状态并告警。

### BUG-012 [P2] worker 停机不等待进行中的调度轮次
- **文件**：`src/platform/tasks/worker-entry/tasks-worker.ts:42-48`
- **描述**：`stop()` 仅清定时器与置标志，不 await 正在执行的 `runOnce`；容器停止时正在执行的处理器被硬切，任务落入 UNCERTAIN——而恢复重放又因 BUG-004 卡死，二者叠加放大故障。
- **修复建议**：保存 in-flight promise，stop() 中带超时 await；与 BUG-004 一并验证。

---

## P3（择机处理）

### BUG-013 [P3] DbConnectionManager 为桩实现却仍注册在全局模块
- **文件**：`src/database/db-connection-manager.ts:6-20`；`src/database/database.module.ts:9`
- 真实连接池在 `PostgresDbAdapter`；桩仅打日志，易误导后续开发者从错误位置取连接。建议删除或改为聚合门面。

### BUG-014 [P3] postgres-db-adapter 注释错位与 allowExitOnIdle 生产语义存疑
- **文件**：`src/adapters/db/postgres-db-adapter.ts:93-96`
- 兜底回滚注释挂在 `idleTimeoutMillis` 上（实为 BUG-006 所述未实现的钩子）；`allowExitOnIdle:true` 在长驻进程中语义需复核。

### BUG-015 [P3] tryClaim/updateAfterExecution 用模板插值拼状态常量
- **文件**：`src/platform/tasks/infrastructure/postgres-task-repository.ts:237-238,298`
- `${TaskStatus.COMPLETED}` 为编译期常量非注入风险，但与全仓参数化风格不一致，建议统一 `$n` 占位或白名单校验。

### BUG-016 [P3] Cookie Secure 判定信任 x-forwarded-proto
- **文件**：`src/modules/identity/interfaces/nest/casdoor-session.controller.ts:166,199`
- 依赖反代正确清洗该头；建议在配置层固化外部协议（server.externalProto），避免依赖逐跳头。

### BUG-017 [P3] 会话签名密钥由 Casdoor clientSecret 直接派生
- **文件**：`src/modules/identity/interfaces/nest/session-secret.ts`（经 casdoor-session.controller.ts:229 调用）
- 密钥复用面扩大：clientSecret 泄露即会话伪造。建议独立密钥源（独立 env/KMS）。

### BUG-018 [P3] 日志脱敏规则仅覆盖精确键名，嵌套路径疑似漏匹配
- **文件**：`src/platform/observability/domain/services/redaction.rules.ts:17-48`
- `/^email$/i` 等规则对 `user.email` 这类嵌套键是否生效取决于匹配器是否按键名分段匹配（本次未验证 matcher 实现）。若为整路径匹配则大量嵌套敏感字段漏脱敏，需升级验证并补测试。

---

## 待确认（下一轮审查优先项）

以下区域本轮因**子代理委派通道故障**（12+36 个子代理全部启动失败，最小探针亦失败）未能深读，仅做了模式级扫描，未见明显问题但不作结论：

1. **joint 名额并发**：application 层未检索到 `FOR UPDATE`/quota 字样——名额上限控制在何处、是否防超卖，需专项确认。
2. **membership / organization 关系命令**：入边出边双向一致性、部门树环检测的实现完整性。
3. **audit 归档流程**：归档事务原子性与重跑幂等（append-only 本身已确认无 UPDATE/DELETE 路径 ✓）。
4. **stat-export 异步导出产物下载鉴权**、**file 模块存储适配器内部**（未发现 path.join 直拼用户输入 ✓，但存储实现未深读）。
5. **casdoor webhook 签名校验**、freshness 判定、reconcile 冲突解决。
6. **read-model rebuild**：未发现 checkpoint 关键字——崩溃恢复语义需专项确认。
7. **config zod schema 与实际使用字段一致性**、必填项 fail-fast。

## 已验证无问题的方面（抽样）

- 手写 SQL 参数化：全仓未发现把用户输入拼进 SQL 语句的点（唯一插值为编译期枚举常量与 `$n` 占位符序号构造）。
- 空 catch 吞异常：未发现。
- form 提交唯一约束：`ON CONFLICT DO NOTHING` + 显式 409 映射（`postgres-form-submission.repository.ts:102-122`）✓
- 报名通道四态状态机：转换矩阵完整、CLOSED→OPEN 重开守卫正确（`application-channel.state-machine.ts`）✓
- 任务领取原子性：单条条件 UPDATE + lease_version 守卫 + 终态排除（`postgres-task-repository.ts:214-274`）✓
- 组织/统计接口层鉴权：fail-closed 锁死（生产拒绝 x-actor-id），form 有真实会话守卫 ✓

---

*生成方式说明：因委派子系统故障，本文档由主审 agent 以风险驱动方式逐模块人工审查产出；所有 P0/P1 发现均经过源码逐行核实（含行号）。建议委派通道恢复后按"待确认"清单补齐二轮审查。*
