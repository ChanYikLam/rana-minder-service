# 数据库代码审查报告（登录/报名/面试）v1.0

> 审查分支：`review/db-code-audit`（基于本地 `dev`，含 14 个领先 `origin/dev` 的联调提交 + 后续修复）
> 范围：identity 模块（登录）/ recruitment 模块（club application）/ recruitment 模块（interview application）的 PG 实现层 + Orchestration
> 方法：3 个并行子代理深度审查 + 1 次本地合成（login 子代理超时/失败，作者自补）
> 报告归档：`/tmp/audit-login.md`、`/tmp/audit-application.md`、`/tmp/audit-interview.md`（项目本地路径）

---

## 一、汇总（按严重度）

| 严重度 | 计数 | 主要来源 |
|---|---|---|
| critical | **1** | 账号访问 save 覆盖（C1） |
| high | **8** | 应用层 5 + 面试 3 |
| medium | **26** | 应用层 10 + 面试 10 + 登录 6 |
| low | **23** | 应用层 10 + 面试 9 + 登录 4 |

---

## 二、按主题合并的 Top 15（跨域可合并修）

### Top 1. **账号状态 save DO UPDATE 无 CAS** [critical, identity]
- `postgres-account-access.repository.ts:60-66`：save 无 `WHERE state_version = $expectedVersion`，覆盖任何旧 state。
- **修复**：save 升级为 `UPDATE ... SET state = $2, state_version = state_version+1 WHERE subject_id = $1 AND state_version = $expectedVersion RETURNING subject_id`；0 行 → identityErrors.versionConflict()。

### Top 2. **Recruitment B2 幂等键未消费** [high, application]
- `submit-application.use-case.ts:107-113`：envelope 已解析 `idempotencyKey`，但用例未消费；唯一兜底是 `uq_applications_applicant_channel` → 同键重放返 REC_CONFLICT 422。
- **修复**：在用例内解析 envelope 后 `idempotencyKey`，先查 `recruitment_idempotency` 命中即返回（feat 分支已在 nest 层实现；dev 缺）；**迁移到 dev 分支**。

### Top 3. **session-identity.account_access INSERT DO NOTHING 保留陈旧禁用** [high, identity]
- `postgres-session-identity.repository.ts:97-103`：登录路径写 `INSERT ... ON CONFLICT DO NOTHING`——DISABLED 行永远不变。
- **修复**：改为 `DO UPDATE SET state = EXCLUDED.state, last_trusted_observation_at = now()`（前提 ensureAndRead 前已确认 Casdoor state = ACTIVE）。

### Top 4. **DB CHECK 缺 `ON_LEAVE`/`LATE`/`ABSENT` 状态** [high, interview]
- 20260822000000_create-recruitment-tables.ts：interview_records CHECK 不含出勤三态；状态机允许但 PG 拒绝写入。
- **修复**：新迁移 `20260828XXXXXXX_expand_interview_status_check.sql`：`ALTER TABLE interview_records DROP CONSTRAINT ck_interview_records_status; ADD CONSTRAINT ck_interview_records_status CHECK (status IN (...))` 增加三态。

### Top 5. **choose-interview-slot 无并发约束——同面试官同时段可双排** [high, interview]
- `choose-interview-slot.use-case.ts`（interview-slot.use-case.ts:69-123）：仓储 INSERT 依赖 `UNIQUE (application_id, round_id)`，未对 `(round_id, interviewer_id, scheduled_at)` 加约束。
- **修复**：新迁移 partial unique index `CREATE UNIQUE INDEX uq_interview_round_interviewer_slot ON interview_records (round_id, interviewer_id, scheduled_at) WHERE status NOT IN ('VOIDED','CANCELLED') AND scheduled_at IS NOT NULL;`。

### Top 6. **org-recruitment.canSubmitApplication fail-open** [high, application]
- `org-recruitment-authorization.ts:33-36`：`primaryRoleAt === ''` 为 true 即允许报名。
- **修复**：契约"本社团成员不可报名"→ 改成"非本社团成员 + 非 disabled + 业务资格校验"——本意一致，但实现太依赖上游 guard；建议合并到 use case 或加显式条件 `primaryRoleAt === '' && not current member`。当前依赖 ORG-029 super-admin / recruitment guard 时 fail-closed 安全，但 ORG_DB_REAL=0 时 OrgBackedRecruitmentAuthorization 装载失败导致逻辑失效——需在 dev 部署文档标注。

### Top 7. **account_access row lock 空表场景失效（同 H3 弱化）** [high→medium, application]
- 见 interview 报告 H1：`interview_records` 同样空表场景 SELECT FOR UPDATE 失效。
- **修复**：用 `pg_advisory_xact_lock(hashtext(subjectId))` 在事务开始时获取应用层 advisory lock，串行化并发操作。

### Top 8. **仓储 save 列清单漂移——saveActivity 缺新列** [medium, application]
- `postgres-recruitment.repository.ts:225, 234-240`：saveActivity SELECT/INSERT 不含 20260827100000 新增的 `departments`/`form_id`/`allow_adjustment_default`。新列写入会被静默忽略。
- **修复**：补齐 INSERT 列清单 + SELECT 列清单（同步用 `RETURNING *` 或显式列）。

### Top 9. **revisions JSONB 全量替换而非增量追加** [medium, application]
- `postgres-recruitment.repository.ts:344-368`：仓储以快照值整体 UPDATE `revisions`，丢失并发追加。
- **修复**：用 `jsonb_set(revisions, '{N}', new_rev)` 增量追加，或在应用层维护 + 仓储 JSONB_cat。

### Top 10. **无 FK 防护——applicant_id/club_id/department_id 跨实体漂移** [medium, application]
- 20260822000000：无 FK（accepting dev "fast iteration" 注释）。
- **修复**：production 迁移加 FK + 约束检查（adm-srv 也有 FK）。

### Top 11. **min/max_choices 无 DDL CHECK** [medium, application]
- channel 表 min/max choices CHECK 缺失；"每部门上限"功能完全缺失（profile gate）。
- **修复**：CHECK + 业务校验。

### Top 12. **status CHECK 缺 NOT_STARTED** [medium, application]
- application_channel CHECK 不含 NOT_STARTED；状态机可推到 NOT_STARTED 但 PG 拒绝。
- **修复**：补迁移。

### Top 13. **OidcAuthSessionProvider.resolveSession 每次请求跨事务读** [high, identity]
- 见 login H2：每个受保护请求走独立 `beginTransaction` + `SELECT`，未复用主请求 uow。
- **修复**：把 revocation 读下沉到 AuthGuard 注入的 uow.run(unprotected) 中。

### Top 14. **interview_records 读取无 clubId 隔离** [medium, interview]
- `loadInterviewsByRound` 按 round 查，应用层负责加 clubId 过滤——错漏时跨社团读。
- **修复**：仓储 `loadInterviewsByClub(clubId, roundId)` 显式带 clubId + JOIN activities 校验。

### Top 15. **applyRecord 重复/选举竞态** [medium, interview]
- `recordEvaluation` 并发追加 evaluations 数组无 CAS（repository 无 expected_version 入参）。
- **修复**：evaluations 行级锁或 evaluation_id 唯一索引。

---

## 三、各域独立报告索引

### Identity（登录域）
- 总评：1 critical / 3 high / 6 medium / 4 low
- 报告：`/tmp/audit-login.md`（146 行，10 文件）
- 重点：Top 1/3/13；其余 medium/low 见原文

### Recruitment Club Application（报名域）
- 总评：0 critical / 5 high / 10 medium / 10 low
- 报告：`/tmp/audit-application.md`（299 行，13 文件 + 上下文）
- 重点：Top 2/6/8/9/10/11/12；dev 分支已知缺口（A2/B2/C5）单列

### Recruitment Interview（面试域）
- 总评：0 critical / 3 high / 10 medium / 9 low
- 报告：`/tmp/audit-interview.md`（287 行）
- 重点：Top 4/5/7/14/15

---

## 四、跨域系统性问题

1. **事务边界与 RLS 一致性 OK**——所有写路径均在 `uow.run` 单事务内；RLS 作用域与意图匹配。
2. **乐观锁在 PG 层落地不彻底**——profile（identity）有 version CAS；application/recruitment 仓储多数缺 CAS；interview evaluations 无 CAS。**应统一：每个聚合根仓储 save 都应接受 expectedVersion + UPDATE ... WHERE version=?**。
3. **JSONB 列缺 CHECK 与 GIN**——fields/restrictions/revisions/qualify_snapshot/evaluations 全部无 CHECK 或 GIN 索引。需新迁移添加 schema 校验 + 关键字段索引（query 路径有需要时）。
4. **审计路径分散**——多仓储 `void events` 注释 + IdentityAuditPort 应用层调用，缺乏统一审计包装层。建议在 IdentityUnitOfWork / RecruitmentUnitOfWork 内置审计 hook。
5. **Migrations ↔ 代码漂移**——saveActivity 列漂移（Top 8）只是冰山一角；建议建 CI 校验（解析每个仓储 SQL 涉及的列 → 与最新 migration 列比对）。

---

## 五、dev 分支已知缺口（不属本次审查问题，仅作记录）

- A2 草稿/撤销/退出端点未实现（feat/gdmu-casdoor-integration 已实现）
- B2 提交幂等键重放未实现（feat 分支已实现）
- C5 preferences 缺 departmentName（feat 分支已实现）
- A4 权限接线（feat 分支已完整实现 + 真实 SSO 验证）
- membership 仓储 PostgreSQL 化（仍是 InMemory）
- MembershipCasdoorPort 真实 HTTP 适配（仍是 dev 桩）
- email-verification send 全链 Mailpit 渲染验证（端点 + 守卫已验证；邮件正文模板需人工联调）

---

## 六、建议优先级（可并入后续任务）

### 必做（影响数据完整性 / 安全）
1. account_access save CAS（H1） ← dev branch
2. session-identity account_access upsert（H3） ← dev branch
3. interview_records status CHECK + 并发 unique index（Top 4/5） ← dev branch
4. submit 幂等键消费（Top 2） ← dev 分支 + feat 合并
5. saveActivity 列清单同步（Top 8） ← dev branch

### 应做（性能 / 可观测性）
6. revocation read 跨事务优化（H2/13）
7. interview loadInterviewsByClub（Top 14）
8. JSONB GIN 索引 + CHECK
9. account_access save 加 audit hook 统一封装

### 可缓（边界 / 未来）
10. FK 约束（Top 10）
11. min/max_choices CHECK（Top 11）
12. channel CHECK NOT_STARTED（Top 12）
13. CI 校验：仓储 SQL 列 ↔ Migration 列一致性

---

## 七、产物清单

| 文件 | 位置 | 用途 |
|---|---|---|
| 本报告 | `docs/审查报告-登录-报名-面试-v1.0.md` | 总览与 Top-15 |
| Login 报告 | `/tmp/audit-login.md` | identity 域 146 行详细 |
| Application 报告 | `/tmp/audit-application.md` | 招新报名域 299 行详细 |
| Interview 报告 | `/tmp/audit-interview.md` | 面试申请域 287 行详细 |
| 审查分支 | `review/db-code-audit`（local）/ 推送后 `origin/review/db-code-audit` | 代码改动 0，纯审查 |
