# RanaMinder 后端接口清单（HTTP 端点明细）

> 文档版本：v1.0
> 编制日期：2026-08-07
> 数据来源：
> - 前端最新 dev 分支代码 `rana-minder-web/src/mock/*`（`src/mock/index.ts`、`src/mock/recruitment-api.ts`、`src/mock/db-recruitment.ts`、`src/mock/db.ts`、`src/mock/db-organization.ts`、`src/mock/db-forms.ts`、`src/mock/notifications.ts`、`src/mock/db-corrections.ts`、`src/mock/db-audit.ts`）
> - 传输中立契约 [接口契约-v1.0.md](./接口契约-v1.0.md)（IFC-GEN / IFC-CMD / IFC-QRY / IFC-ERR / IFC-SM 等编号体系）
> - 状态机转换 [SRS-状态机转换明细-v1.0.md](./SRS-状态机转换明细-v1.0.md) 与 `src/mock/state-machines/transitions.ts`
> - 错误码映射 `src/mock/errors.ts`、请求信封 `src/services/client.ts`、`src/types/contracts/index.ts`
>
> 用途：为后端开发提供**已发布前端实际调用**的完整 HTTP 端点清单（方法、路径、参数、请求体、响应、权限、错误语义）。端点行为以 mock 层实现为准——mock 是前端运行时的唯一数据源，可视为「参考后端契约」。

## 目录

1. [通用契约](#1-通用契约)
2. [角色与权限速查](#2-角色与权限速查)
3. [端点总览表](#3-端点总览表)
4. [身份与会话（auth）](#4-身份与会话auth)
5. [组织工作空间（org context/dashboard）](#5-组织工作空间)
6. [公开探索（explore）](#6-公开探索explore)
7. [通知（notifications）](#7-通知notifications)
8. [个人中心（me）](#8-个人中心me)
9. [文件（files）](#9-文件files)
10. [成员生命周期（members）](#10-成员生命周期members)
11. [普通招新（recruitment）](#11-普通招新recruitment)
12. [联合活动（joint）](#12-联合活动joint)
13. [动态表单（forms）](#13-动态表单forms)
14. [组织配置 / 统计 / 导出 / 批量（org 杂项）](#14-组织配置--统计--导出--批量)
15. [平台管理（admin）](#15-平台管理admin)
16. [事实纠错与审计（corrections / audit）](#16-事实纠错与审计)
17. [附录：mock 专用端点与演示开关](#17-附录mock-专用端点与演示开关)

---

## 1. 通用契约

### 1.1 请求信封

所有 POST / PUT / DELETE 请求体统一信封（`src/services/client.ts`）：

```json
{
  "action": "string?",           // 可选，业务动作标识
  "targetId": "string?",         // 可选，目标对象标识
  "expectedVersion": "number?",  // 可选，乐观锁版本（profile 保存、表单草稿保存使用）
  "idempotencyKey": "string?",   // 可选，幂等键（表单提交使用；其余端点由客户端自动生成）
  "input": { "..." }             // 业务字段（各端点见下）
}
```

- 业务字段一律在 `body.input` 内；mock 层部分端点（recruitment-api 域、通知偏好、邮件配置）兼容 `{ input }` 与平铺两种写法。
- `expectedVersion` 不匹配 → `409 IFC-ERR-008`；`idempotencyKey` 相同请求幂等返回（`IFC-ERR-009` 语义）。
- **文件上传例外**：`POST /api/files/upload` 直接发送 `FormData`，无信封包装。

### 1.2 响应信封

```json
// 成功
{ "code": 0, "data": { "..." } }        // data 可为 null
// 失败（对应 HTTP 状态码）
{ "code": "IFC-ERR-xxx", "message": "脱敏文案", "supportId": "MOCK-XXXX", "fieldErrors": { "字段": ["原因"] }? }
// 任务式（202）
{ "code": "IFC-ERR-013|IFC-ERR-014", "data": { "taskId": "...", "status": "processing" } }
```

### 1.3 错误码与 HTTP 状态映射（`src/mock/errors.ts`，17 类）

| 码 | HTTP | 含义 | 典型使用点 |
|---|---|---|---|
| IFC-ERR-001 | 401 | 未认证 | 会话失效 |
| IFC-ERR-002 | 401 | 高风险操作需重新认证 | 权限模板发布、保留策略发布/执行、正式删除（reauthProof 失效） |
| IFC-ERR-003 | 403 | 无权限 | 各域 forbidden() |
| IFC-ERR-004 | 403 | 作用域越界 | 工作空间不可访问 |
| IFC-ERR-005 | 422 | 输入不合法 | 缺发布原因、删除原因等 |
| IFC-ERR-006 | 422 | 前置条件不满足 / 业务拒绝 | 状态机拒绝、业务校验（招新/联合/成员域主要错误） |
| IFC-ERR-007 | 409 | 状态冲突 | 纠错处置（非 submitted/overdue）；个别端点以 422 携带 fieldErrors 返回 |
| IFC-ERR-008 | 409 | 版本 / 影响预览冲突 | 表单 expectedVersion、模板/保留策略/删除 previewVersion |
| IFC-ERR-009 | 409 | 幂等键冲突 | 表单提交 |
| IFC-ERR-010 | 409 | 资源竞争 | 预留 |
| IFC-ERR-011 | 403 | 安全限制 | 账号禁用（会话拒绝建立） |
| IFC-ERR-012 | 503 | 依赖服务不可用 | 文件不存在或已过期（部分文件端点 404 也复用此码） |
| IFC-ERR-013 | 202 | 外部结果不确定 | 任务式响应 |
| IFC-ERR-014 | 202 | 结果处理中 | 任务式响应 |
| IFC-ERR-015 | 404 | 不存在或不可见 | 对象不存在；部门负责人越界伪装 404 |
| IFC-ERR-016 | 500 | 安全提交失败 | withStatus 兜底 |
| IFC-ERR-017 | 400 | 请求体解析失败 | 请求体非法 |

### 1.4 分页与列表

- 列表统一 `{ items: [...], nextCursor: string | null }`；当前所有端点 `nextCursor` 恒为 `null`（游标分页为契约预留，未启用）。
- 列表常用 query：`cursor`、`limit`、`search`/`q`、`status`、`unreadOnly` 等，见各端点。

### 1.5 路径参数约定

- 路径参数（`:clubId`、`:activityId` 等）由 mock 层 `withStatus` 合并进 `query`；后端实现按 REST 路径参数解析即可。
- mock 切换身份：`?_mock_user=leader|hr|interviewer|member|applicant|candidate`（演示专用，后端不需要）。

### 1.6 认证与会话（Casdoor）

- 登录由 Casdoor 完成（`GET /api/auth/casdoor/login-url` 获取跳转地址），回调后前端请求 `GET /api/auth/session` 建立会话。
- 高风控操作（权限模板发布、保留策略发布/执行、正式删除）需先 `POST /api/auth/reauth` 获取一次性 `proof`（TTL 10 分钟，消费即失效），随请求 `input.reauthProof` 提交。

---

## 2. 角色与权限速查

来源：`src/mock/auth.ts` 角色权限集、各 handler 鉴权辅助函数。

| 角色 | 权限要点 |
|---|---|
| super_admin（平台超管） | `platform:club:manage`（社团接入/治理）、`platform:config:manage`（配置/模板/保留策略/通知偏好）、`platform:delete:execute`（删除/运维/邮件配置/kill-switch/outbox）、`platform:audit:view`（审计/纠错）、`platform:export:execute` |
| club_leader（社团负责人） | `club:recruitment:manage`、`club:joint:manage`、`club:member:manage`、`club:appointment:manage`、`club:resignation:approve`、`club:batch:execute`、`club:transition:manage`、`club:invite:manage`、`club:export:execute`、`club:config:manage`、`club:interview:view/evaluate`、`club:audit:view` 等 |
| hr（人事） | 同负责人（无 `club:email:config`） |
| department_leader（部门负责人） | 数据范围限定本部门（成员列表/任命/审批/统计等）；仅 `club:member:manage`，无 Full 管理权 |
| interviewer（面试官） | `club:interview:view`、`club:interview:evaluate` |
| member（成员） | `club:member:view-self` 等基础权限 |
| applicant（申请人） | 报名侧能力（按学号解析申请人档案） |

临时面试官任务折算（ORG-037）：持有 active 任务即获得 `club:interview:view` + `club:interview:evaluate` 折算权限。

---

## 3. 端点总览表

> 完整清单共 **269 个端点**（以 mock 源码 `url: + method:` 提取为准）。

| 域 | 端点数 | 章节 |
|---|---|---|
| 身份与会话 auth | 13 | [§4](#4-身份与会话auth) |
| 组织工作空间 org | 2 | [§5](#5-组织工作空间) |
| 公开探索 explore | 7 | [§6](#6-公开探索explore) |
| 通知 notifications | 6 | [§7](#7-通知notifications) |
| 个人中心 me | 18 | [§8](#8-个人中心me) |
| 文件 files | 4 | [§9](#9-文件files) |
| 成员生命周期 members | 23 | [§10](#10-成员生命周期members) |
| 普通招新 recruitment | 63 | [§11](#11-普通招新recruitment) |
| 联合活动 joint | 45 | [§12](#12-联合活动joint) |
| 动态表单 forms | 22 | [§13](#13-动态表单forms) |
| 组织配置/统计/导出/批量 | 15 | [§14](#14-组织配置--统计--导出--批量) |
| 平台管理 admin | 41 | [§15](#15-平台管理admin) |
| 事实纠错与审计 corrections/audit | 12 | [§16](#16-事实纠错与审计) |
| mock 专用（非契约） | 3 | [§17](#17-附录mock-专用端点与演示开关) |

---

## 4. 身份与会话（auth）

### GET /api/auth/session
**说明**：获取当前登录会话（IDN 域；SRS-FAIL-001 降级模式时输出 15 分钟白名单窗口起点）
**Query**：`_mock_user`（mock 专用，可选）
**Body input**：无
**响应 data**：
```
{
  user: { id, studentId, name, email, phone, avatar, emailVerified, profileComplete },
  profileGate: { complete, emailVerified },
  degraded: boolean,
  degradedSince: string|null,   // degraded 时 ISO 时间；否则 null
  permissions: string[],        // 角色权限 ∪ 有效临时面试官任务折算（ORG-037）
  workspace: { clubId, clubName, role, permissions, memberId? }|null  // 无社团归属返回 null
}
```
**权限/角色**：登录用户（账号 `disabled: true` 时拒绝建立会话）
**错误/备注**：账号禁用 → 403 `IFC-ERR-011`「账号已被禁用，请联系平台管理员」

### DELETE /api/auth/logout / POST /api/auth/logout
**说明**：退出登录（清空会话，双方法同语义）
**Body input**：无
**响应 data**：`null`
**权限/角色**：登录用户

### GET /api/auth/profile
**说明**：读取当前用户资料（含版本号与 Casdoor 双向同步状态）
**响应 data**：
```
{ version: number, studentId, name, email, phone: string,
  emailVerified, profileComplete: boolean,
  syncStatus: { email: 'synced', phone: 'pending'|'synced' } }
```
**权限/角色**：登录用户

### PUT /api/auth/profile
**说明**：保存用户资料白名单字段（乐观锁 + 资料门联动，保存即置位 profileComplete）
**Body input**（信封）：`input: { email?: string, phone?: string }`；顶层 `expectedVersion?: number`
**响应 data**：同 GET profile（`version` +1，`syncStatus.phone='pending'`）
**权限/角色**：登录用户
**错误/备注**：`expectedVersion` 不匹配 → 409 `IFC-ERR-008`，body 含 `currentData: { email, phone }`；同版本重复提交必 409

### POST /api/auth/profile/send-email-code
**说明**：发送邮箱验证码（IDN-011 重发通道）
**响应 data**：`{ sent: true, expiresIn: 300 }`（秒）
**权限/角色**：登录用户

### POST /api/auth/profile/verify-email
**说明**：校验邮箱验证码（通过后 emailVerified 落库，profileGate 联动翻转）
**Body input**：`input: { code: string }`
**响应 data**：`{ emailVerified: true }`
**错误/备注**：验证码错误/过期 → 422 `IFC-ERR-007` + `fieldErrors: { code: [...] }`（注意此端点 007 以 422 返回）

### POST /api/auth/profile/sync-conflict
**说明**：解决资料与 Casdoor 同步冲突（选择一方值后返回最新资料快照）
**Body input**：`input: { field: 'name'|'email'|'phone'|'studentId', chosenValue: string }`
**响应 data**：`{ studentId, name, email, phone, emailVerified, profileComplete }`
**错误/备注**：field 不在白名单 → 422 `IFC-ERR-006`

### POST /api/auth/reauth
**说明**：重认证，签发一次性 proof 凭证（高风控操作二次校验，TTL 10 分钟）
**响应 data**：`{ proof: 'reauth-<userId>-<ts>', expiresAt: ISO }`
**权限/角色**：登录用户

### GET /api/auth/casdoor/login-url
**说明**：获取 Casdoor 登录跳转地址
**Query**：`user`: string（mock 指定演示身份，默认 leader）
**响应 data**：`{ loginUrl: '...' }`
**权限/角色**：公开

### GET /api/me/clubs
**说明**：当前用户参与的社团列表（多角色工作空间入口）
**响应 data**：`{ clubs: [{ clubId, clubName, role }] }`
**权限/角色**：登录用户
**角色枚举**：`super_admin | club_leader | hr | department_leader | interviewer | member | applicant`

---

## 5. 组织工作空间

### GET /api/org/:clubId/context
**说明**：进入社团工作空间的上下文（角色 + 权限 + 成员 id）
**Query**：`clubId`（路径）
**响应 data**：
```
{ clubId, clubName, role, permissions: string[], memberId: string|null }
```
**权限/角色**：该社团成员；无归属 → 403 `IFC-ERR-004`「工作空间不可访问」

### GET /api/org/:clubId/dashboard
**说明**：社团工作台（待办聚合 + 指标）
**Query**：`clubId`（路径）
**响应 data**：
```
{
  club: { id, name },
  role: string,
  permissions: string[],
  metrics: { pendingReviews, pendingInterviews, pendingResults, syncErrors },
  todos: [{ id, type: 'application_review'|'interview_schedule'|'invitation_pending', title, count }],
  recentActivities: []
}
```
**权限/角色**：该社团成员

---

## 6. 公开探索（explore）

### GET /api/explore/clubs
**说明**：公开社团目录（REC-047，仅启用社团）
**Query**：`q`: string（名称关键词，可空）
**响应 data**：`{ items: [{ id, name, description, memberCount, logo: null, layer: 'exact'|'substring'|'fuzzy' }], nextCursor: null }`
**权限/角色**：公开
**备注**：名称分层：精确 → 中文连续子串 → Levenshtein 编辑距离 ≤1 近似；有效字符 <3 只做前两层

### GET /api/explore/activities
**说明**：公开活动目录（REC-047 当前/历史分区；`enrolling` 为派生字段）
**Query**：`q`（标题关键词）、`type: 'all'|'recruitment'|'joint'`、`status: 'all'|'enrolling'`、`range: ''|'today'|'3d'|'7d'|'custom'`、`deadlineFrom`/`deadlineTo`（range=custom 时生效）
**响应 data**：
```
{
  items: [CatalogActivity],    // 当前分区（招新 in_progress/paused + 联合已发布非终态）
  history: [CatalogActivity],  // 终态分区
  nextCursor: null, queryAt: ISO
}
CatalogActivity = { id, clubId, clubName, title, type: 'recruitment'|'joint', status,
                    enrolling: boolean, deadline, description, layer }
```
**权限/角色**：公开
**备注**：`enrolling` 派生：channelStatus==='open' 且 status 非终态且 deadline > now

### GET /api/explore/activities/:id
**说明**：普通招新活动公开详情
**响应 data**：
```
{ id, clubId, clubName, title, type: 'recruitment', status, channelStatus,
  historical: boolean, deadline, description, departments: [{id,name}], formId,
  eligibility: { colleges, grades }, volunteerRules: { min, max }, allowAdjustmentDefault }
```
**权限/角色**：公开
**错误/备注**：仅 status ∈ {in_progress, paused, completed, cancelled} 可见，否则 404 `IFC-ERR-015`

### GET /api/explore/activities/:id/form
**说明**：公开报名表单（US-REC-08，仅开放状态可读）
**响应 data**：
```
{ id, clubId, title, status: 'published',
  versions: [{ version, status, publishedAt, fields: [FormField] }] }
```
**错误/备注**：仅 status ∈ {in_progress, paused} 可见，否则 404 `IFC-ERR-015`

### GET /api/explore/joint/:id
**说明**：联合活动公开详情（JNT-004/JNT-029，仅已首次公布可读）
**响应 data**：
```
{ id, title, type: 'joint', status, channelStatus, deadline, description, formId,
  sharedAgreement, clubs: [{ id, name, departments }], participants: [{ id, name }],
  clubName: 'A、B' }
```
**错误/备注**：读取前自动推进 deadline；仅 `status==='published'` 可见，否则 404 `IFC-ERR-015`

### GET /api/explore/joint/:id/form
**说明**：联合活动共享报名表（公开，无「意向部门」select）
**响应 data**：同 activities/:id/form（`clubId: null`、`type: 'joint'`）
**错误/备注**：仅 published 可见，否则 404 `IFC-ERR-015`

---

## 7. 通知（notifications）

### GET /api/notifications
**说明**：站内信列表（动态内存库，业务操作实时 push，已读/未读真实落状态）
**Query**：`unreadOnly: 'true'`
**响应 data**：
```
{ items: [{ id, userId, type, title, body, read: boolean, createdAt: ISO,
            link: string|null, clubName: string|null }], nextCursor: null }
type ∈ application | interview | invitation | conclusion | system | member | transition | correction
```
**权限/角色**：登录用户（仅本人通知）

### GET /api/notifications/unread-count
**说明**：未读通知数量（红点角标）
**响应 data**：`{ count: number }`

### POST /api/notifications/:id/read
**说明**：单条通知标记已读
**响应 data**：`null`

### POST /api/notifications/read-all
**说明**：全部标记已读
**响应 data**：`null`

### GET /api/me/notifications/preferences
**说明**：我的通知偏好（P1-009 真实落库，按用户）
**响应 data**：`{ preferences: Record<kind, boolean>, savedAt: null }`

### POST /api/me/notifications/preferences
**说明**：更新我的通知偏好
**Body input**：`{ <kind>: boolean, ... }`（未知 kind/非 boolean 忽略）
**响应 data**：`{ preferences, savedAt: ISO }`

---

## 8. 个人中心（me）

### GET /api/me/todo
**说明**：个人待办聚合（待处理录取邀请 + 面试时间确认 + 常规入社邀请）
**响应 data**：
```
{ items: [{ id, type: 'invitation'|'interview', title, description,
            deadline: string, link: '/me/...' }], nextCursor: null }
```
**权限/角色**：申请人/候选人视角
**备注**：仅展示 `pending_acceptance` 邀请与 `pending_selection` 面试；`link` 为前端路由

### GET /api/me/ongoing
**说明**：进行中报名（普通招新 + 联合）
**响应 data**：
```
{ items: [{ id, type: 'application'|'joint', title, description, submittedAt,
            link, activityId, status }], nextCursor: null }
```
**备注**：仅 status ∈ {submitted, revision_requested, identity_anomaly}

### GET /api/me/history
**说明**：历史报名（已退出/未通过）
**响应 data**：`{ items: [{ id, type: 'application', title, result: '未通过'|'已退出', completedAt }], nextCursor: null }`
**备注**：仅 status ∈ {exited, not_qualified}

### GET /api/me/schedule
**说明**：我的日程（申请人面试 + 面试官任务合并）
**响应 data**：
```
{ items: [
  { id, title, activityTitle, time, location, interviewerName, status, role: 'applicant', applicantName: '' },
  { id: 't-<id>', title, activityTitle, time, location, interviewerName: '', status, role: 'interviewer', applicantName }
], nextCursor: null }
```
**权限/角色**：申请人（scheduled/pending_selection）+ 面试官本人（scheduled/in_progress/leave/late）

### GET /api/me/interviews/tasks
**说明**：面试官任务列表（本人视角，含时间冲突检测）
**响应 data**：
```
{ items: [{ id, type: 'recruitment', activityId, activityTitle, clubId, clubName,
            applicantId, applicantName, roundId, roundName, status, startAt, endAt,
            attendance, conflict: { conflict: boolean, detail?: string } }], nextCursor: null }
```
**权限/角色**：具备面试职能者（`interviewerIds` 含本人）

### GET /api/me/interviews/recruitment/:interviewId
**说明**：我的普通招新面试详情（含可选时段）
**响应 data**：
```
{ id, activityId, activityTitle, roundId, roundName, applicantName, status,
  scheduledTime, endTime, interviewers: [], attendance, invalidReason, version,
  availableSlots: [{ id, time, endAt, capacity, booked }] }
```
**权限/角色**：仅面试本人（非本人 403）

### POST /api/me/interviews/recruitment/:interviewId/book
**说明**：预约/改期面试（本人；成功推送「面试时间已确认」站内信）
**Body input**：`input: { slotId: string }`
**响应 data**：完整 `RecInterview`（status='scheduled'）
**错误/备注**：slotId 缺失 422；时段不存在 404；满员/冲突/轮次未开放/选时已截止 422；状态机 SM-REC-005（scheduled→reschedule、leave/late/absent→rearrange、pending_selection→select）

### POST /api/me/interviews/recruitment/:interviewId/leave
**说明**：面试请假（本人；释放 slot）
**响应 data**：`RecInterview`（status/attendance='leave'，slotId/startAt/endAt=null）
**错误/备注**：仅 `scheduled` 可请假，否则 422

### GET /api/me/interviews/joint/:jointId
**说明**：我的联合面试详情（含可选时段与剩余名额）
**响应 data**：
```
{ id, jointId, jointTitle, applicantName, status, scheduledTime, endTime,
  attendance, invalidReason, attempt, version,
  availableSlots: [{ id, time, endAt, capacity, booked, available }] }
```
**权限/角色**：仅本人

### POST /api/me/interviews/joint/:jointId/book
**说明**：预约/改期联合面试（本人，执行选时截止校验）
**Body input**：`input: { slotId: string }`
**响应 data**：完整 `JointInterview`（status='scheduled'）

### POST /api/me/interviews/joint/:jointId/leave
**说明**：联合面试请假（本人）
**响应 data**：`null`
**错误/备注**：仅 `scheduled` 可请假，否则 422

### GET /api/me/invitations/recruitment/:invitationId
**说明**：普通招新录取邀请详情（本人视角）
**响应 data**：
```
{ id, activityId, activityTitle, clubName, applicantName, status, sentAt, acceptedAt,
  expiredAt, departmentName, casdoorSync: 'none'|'processing'|'confirmed'|'failed' }
```
**权限/角色**：登录用户（非本人 403；不存在 404）

### POST /api/me/invitations/recruitment/:invitationId/respond
**说明**：接受/拒绝录取邀请（本人；accept 后 casdoorSync='processing'）
**Body input**：`input: { action: 'accept'|'reject' }`
**响应 data**：完整 `RecInvitation`
**错误/备注**：状态机 SM-INV-001（仅 pending_acceptance 可转）；过期 → status='expired' + 422

### GET /api/me/invitations/joint/:invitationId
**说明**：联合录取邀请详情（本人视角）
**响应 data**：
```
{ id, jointId, jointTitle, clubName, applicantName, type: 'admit'|'join',
  status, sentAt, acceptedAt, expiredAt, reviewFlag: boolean, casdoorSync }
```

### POST /api/me/invitations/joint/:invitationId/respond
**说明**：接受/拒绝联合邀请（本人；accept 后结论 accepted_locked + casdoorSync='processing'）
**Body input**：`input: { action: 'accept'|'reject' }`
**响应 data**：完整 `JointInvitation`
**错误/备注**：`reviewFlag=true` 时 accept → 422「补面结论待复核，暂不可接受」（reject 允许并回滚结论至 evaluating）；过期 422

### GET /api/me/invitations/membership
**说明**：我的常规入社邀请列表（被邀请人本人）
**响应 data**：
```
{ items: [{ id, clubId, clubName, candidateName, departmentId, departmentName,
            status, sentAt, expiredAt, acceptedAt }], nextCursor: null }
```

### GET /api/me/invitations/membership/:invitationId
**说明**：单条入社邀请详情
**响应 data**：`{ id, clubId, clubName, candidateId, candidateName, departmentId, departmentName, status, sentAt, expiredAt, acceptedAt }`
**权限/角色**：被邀请人本人（非本人 403；不存在 404）

### POST /api/me/invitations/membership/:invitationId/respond
**说明**：接受/拒绝入社邀请
**Body input**：`input: { action: 'accept'|'reject' }`
**响应 data**：`{ id, status, acceptedAt? }`（accept → 'accepted_pending_sync'；reject → 'rejected'）
**错误/备注**：非 sent/pending_acceptance → 422；已过期 → 'expired' + 422

### POST /api/me/invitations/membership/:invitationId/sync-confirm
**说明**：Casdoor 回读确认（接受后生效，幂等创建成员）
**响应 data**：`{ id, status: 'effective' }`
**错误/备注**：仅 accepted_pending_sync 可确认；同号存在 exiting/pending_effective 记录 → 422 要求先完成原流程

---

## 9. 文件（files）

### GET /api/files/:fileId
**说明**：文件元数据（预览前读取）
**响应 data**：
```
{ id, name, size, mimeType, status: 'clean'|'approved', uploadedAt, checkedAt, downloadUrl: null }
```
**权限/角色**：登录用户
**错误/备注**：fileId 非 `file-` 前缀 → 404 `IFC-ERR-012`

### POST /api/files/:fileId/download
**说明**：发起文件下载（签发 1 小时有效下载地址）
**响应 data**：`{ fileId, status: 'downloaded', downloadUrl: '/api/mock-files/<fileId>.csv', expiresAt: ISO(now+1h) }`

### POST /api/files/upload
**说明**：文件上传（**FormData 直传，无信封**；3 秒安全检查后返回 fileId）
**响应 data**：`{ fileId: 'file-<ts>-<rand>', name, size, mimeType, status: 'clean', uploadedAt }`
**权限/角色**：登录用户

---

## 10. 成员生命周期（members）

> 状态机：SM-MEM-001（成员经历）、SM-MEM-002（职位关系）、SM-MEM-003（部门关系申请）、SM-MEM-004（入社邀请）、SM-ORG-003（预约管理命令）、SM-ORG-004（批量）。
> 鉴权辅助：`resolveMemberId`（成员 id 按「用户 × 社团」解析）、`departmentScopeFor`（部门负责人数据范围=本部门）、`canManageMembers`（club:member:manage）、`canManageMembersFull`（排除部门负责人）、`canAppointments`（club:appointment:manage）、`canApproveResignation`（club:resignation:approve）。

### 10.1 成员列表与详情

#### GET /api/org/:clubId/members
**说明**：成员列表 + 统计 + 待办计数（MEM-001；静态路由，需排在 :memberId 之前）
**Query**：`search`（姓名包含/学号精确，空则全量）
**响应 data**：
```
{
  items: [{ id, name, studentId, email, phone,
            positions: [{ departmentId, departmentName, title, status }],  // 仅 active
            department, title, status, joinedAt: 'YYYY-MM-DD', exitedAt: string|null }],
  stats: { total, active, exited, byDepartment: [{ id, name, count }], zeroDepartment },
  pendingCounts: { departmentApply, appointments, transition },
  nextCursor: null
}
```
**权限/角色**：部门负责人仅见本部门（列表与统计同范围）

#### GET /api/org/:clubId/members/:memberId
**说明**：成员档案详情（职位/任期/部门史/异常）
**响应 data**：
```
{ id, clubId, studentId, name, email, phone, status, joinedAt, exitedAt,
  positions: [{ id, departmentId, departmentName, title, startDate, endDate,
                status: 'active'|'pending_confirmation'|'transferring'|'suspended'|'ended' }],
  tenures: [{ id, departmentName, title, startDate, endDate, endReason }],
  departmentHistory: [{ id, action: 'join'|'leave'|'transfer', departmentName, at }],
  anomalies: [{ id, kind: 'casdoor_mismatch'|'external_change', message, createdAt }] }
```
**权限/角色**：部门负责人仅本部门（越界返回 404 伪装，避免越权探测）；普通成员可查看自己
**错误/备注**：不存在或越界 → 404 `IFC-ERR-015`

### 10.2 任命/调岗/免职（预约命令，P-MEM-04 / SM-ORG-003）

#### GET /api/org/:clubId/members/appointments
**说明**：任命操作台——候选成员 + 可选职位层级 + 命令列表
**响应 data**：
```
{ items: [{ id, name, studentId, department, title, status }],   // 仅 active 成员
  departments, titles,                                            // 按角色限制可选层级
  commands: [{ id, action: 'appoint'|'transfer'|'dismiss', memberId, memberName,
               departmentId, departmentName, title, scheduledAt: string|null,
               status: 'pending_exec'|'initiator_lost_rights'|'precondition_failed'|'reconfirmed'
                       |'cancelled'|'executing'|'executed'|'exec_failed',
               createdAt, createdBy, executedAt, failReason }] }
```
**权限/角色**：`club:appointment:manage`（社团负责人/人事；部门负责人仅本部门）
**备注**：titles 层级——部门负责人 ['干事']；hr ['干事','副部长','部长']；负责人 ['干事','副部长','部长','副负责人']（'负责人' 仅走换届流程）

#### POST /api/org/:clubId/members/appointments
**说明**：发起任命/调岗/免职命令（立即或预约）
**Body input**：`input: { action: 'appoint'|'transfer'|'dismiss', memberId, departmentId: string|null, title: string|null, scheduledAt: string|null }`
**响应 data**：`{ id, status: 'pending_exec' }`
**错误/备注**：目标成员不存在 422；dismiss 末位负责人 422「最后一名负责人不能无交接离任」；部门负责人仅可任命本部门且 title 限 '干事'

#### POST /api/org/:clubId/members/appointments/:commandId/execute
**说明**：执行预约命令（生效或失败留痕）
**响应 data**：`{ id, status: 'executed'|'exec_failed', failed: boolean, message?: string }`
**备注**：SM-ORG-003：pending_exec/reconfirmed →executing→executed；exec_failed 可重试；首次执行可演示失败；生效副作用（SM-MEM-002）写 tenure + departmentHistory；Casdoor Group 同步失败写 `syncWarning`

#### POST /api/org/:clubId/members/appointments/:commandId/cancel
**说明**：取消预约命令
**响应 data**：`{ id, status: 'cancelled' }`
**错误/备注**：仅 pending_exec/initiator_lost_rights/precondition_failed 可取消（reconfirmed 无取消转换）；命令不存在 422

#### POST /api/org/:clubId/members/appointments/:commandId/reconfirm
**说明**：重新确认预约命令（失去权限/前置条件丢失后的恢复）
**Body input**：`input: { scheduledAt?: string }`
**响应 data**：`{ id, status: 'reconfirmed' }`

### 10.3 部门关系申请（join/leave/transfer，SM-MEM-003）

#### GET /api/org/:clubId/members/department-apply
**说明**：部门关系申请列表
**响应 data**：
```
{ items: [{ id, applicantId, applicantName, type: 'join'|'leave'|'transfer',
            currentDept, targetDeptId, targetDeptName, reason,
            status: 'under_review'|'approved_pending_exec'|'executing'|'effective'
                    |'exec_failed'|'rejected'|'withdrawn',
            submittedAt, decidedAt, decidedBy, rejectReason }],
  departments, nextCursor: null }
```
**权限/角色**：部门负责人仅见本部门目标申请

#### POST /api/org/:clubId/members/department-apply
**说明**：发起部门关系申请
**Body input**：`input: { type: 'join'|'leave'|'transfer', targetDeptId, reason }`
**响应 data**：`{ id, status: 'under_review', submittedAt }`
**权限/角色**：操作者须为成员（解析不到 → 403）

#### POST /api/org/:clubId/members/department-apply/:applicationId/decide
**说明**：审批申请（批准/驳回）
**Body input**：`input: { decision: 'approve'|'reject', rejectReason?: string }`
**响应 data**：`{ id, status: 'approved_pending_exec'|'rejected' }`
**权限/角色**：`club:member:manage`；部门负责人仅本部门；不能审批自己的申请
**错误/备注**：非 under_review → 422；reject 必填原因

#### POST /api/org/:clubId/members/department-apply/:applicationId/execute
**说明**：执行已批准的申请（生效）
**响应 data**：`{ id, status: 'effective'|'exec_failed', failed: boolean, message?: string }`
**错误/备注**：仅 approved_pending_exec 可执行；exec_failed 可重试；生效写职位与 departmentHistory

#### POST /api/org/:clubId/members/department-apply/:applicationId/withdraw
**说明**：撤回申请
**响应 data**：`{ id, status: 'withdrawn' }`
**权限/角色**：申请人本人或 `club:member:manage`
**错误/备注**：仅 under_review 可撤回

### 10.4 辞职（MEM-005）

#### GET /api/org/:clubId/members/resignation
**说明**：辞职申请列表
**响应 data**：
```
{ items: [{ id, clubId, memberId, memberName, departmentName, title, reason,
            status: 'under_review'|'approved'|'rejected'|'withdrawn',
            submittedAt, decidedAt, decidedBy, syncWarning? }], nextCursor: null }
```
**权限/角色**：`club:resignation:approve`（负责人/人事）；部门负责人仅本部门

#### POST /api/org/:clubId/members/resignation
**说明**：成员提交辞职申请
**Body input**：`input: { reason }`
**响应 data**：`{ id, status: 'under_review', submittedAt }`
**错误/备注**：reason 空白 → 422 + `fieldErrors: { reason: [...] }`

#### POST /api/org/:clubId/members/resignation/:requestId/decide
**说明**：审批辞职
**Body input**：`input: { decision: 'approve'|'reject' }`
**响应 data**：`{ id, status: 'approved'|'rejected' }`
**错误/备注**：approve 时末位负责人 → 422；批准后 SM-MEM-001 active→exiting，写 tenure + syncWarning

### 10.5 成员退出（管理员移除，MEM-002）

#### GET /api/org/:clubId/members/exit
**说明**：成员退出列表（成员 + 辞职申请）
**响应 data**：`{ items: [{ id, name, studentId, department, title, status, joinedAt, exitedAt }], resignations: [...], nextCursor: null }`
**权限/角色**：`club:member:manage`（含部门负责人，按部门过滤）

#### POST /api/org/:clubId/members/exit
**说明**：管理员直接移除成员
**Body input**：`input: { memberId, reason?: string }`
**响应 data**：`{ memberId, status: 'removed' }`
**错误/备注**：reason 必填；不能移除自己；末位负责人拒绝；生效后 active 职位置 ended

### 10.6 常规入社邀请（管理端，SM-MEM-004）

#### GET /api/org/:clubId/members/invite
**说明**：入社邀请列表（管理端）
**响应 data**：
```
{ items: [{ id, candidateId, candidateName, candidateStudentId, departmentId,
            departmentName, status: 'sent'|'pending_acceptance'|'accepted_pending_sync'
                     |'effective'|'sync_failed'|'sync_anomaly'|'withdrawn'|'rejected'
                     |'expired'|'target_already_member',
            sentAt, expiredAt, acceptedAt, withdrawnAt }], nextCursor: null }
```

#### POST /api/org/:clubId/members/invite
**说明**：发送入社邀请
**Body input**：`input: { candidateId, departmentId: string|null, expireDays?: number }`（expireDays 默认 7）
**响应 data**：`{ id, status: 'sent', sentAt }`
**权限/角色**：`club:member:manage` 且非部门负责人（Full）
**错误/备注**：候选不存在/已是成员/已有待处理邀请 → 422

#### GET /api/org/:clubId/members/invite/candidates
**说明**：候选用户搜索（姓名连续子串/学号精确）
**Query**：`search`
**响应 data**：`{ items: [{ id, studentId, name, email, phone, isMember: false }] }`

#### POST /api/org/:clubId/members/invite/:invitationId/withdraw
**说明**：撤回邀请
**响应 data**：`{ id, status: 'withdrawn', withdrawnAt }`
**权限/角色**：`club:member:manage`（Full）
**错误/备注**：仅 sent/pending_acceptance 可撤回

### 10.7 换届（ORG-001/017）

#### GET /api/org/:clubId/members/transition
**说明**：换届信息（可编辑方案 + 执行结果）
**响应 data**：
```
{ currentLeader: { id, name, title },
  candidates: [{ memberId, name, currentTitle, proposedTitle, department }],
  appointments: [{ ... }],
  canExecute, executedAt: string|null,
  results: [{ memberId, name, action, targetTitle, success, message }],
  syncFailures: [{ memberId, memberName, title, active, error }],
  failOn: 'none'|'partial' }
```
**备注**：单例 transitionState（不按 clubId 区分）

#### POST /api/org/:clubId/members/transition
**说明**：执行换届（晋升候选 + 任命 + 负责人同步）
**响应 data**：`{ executedAt, results, finishedAt: null, syncFailures }`
**权限/角色**：`club:member:manage`（Full）
**错误/备注**：已执行/无职位变化 → 422

#### POST /api/org/:clubId/members/transition/plan
**说明**：保存换届方案（草稿）
**Body input**：`input: { candidates?: [...], appointments?: [...] }`
**响应 data**：`{ saved: true }`
**权限/角色**：`club:member:manage`（Full）

#### POST /api/org/:clubId/members/transition/retry
**说明**：重试换届失败项
**响应 data**：`{ results }`
**错误/备注**：未执行过/无失败项 → 422

### 10.8 受控批量（ORG-037）

#### GET /api/org/:clubId/batch/candidates
**说明**：批量候选列表（复用招新申请中可执行对象）
**响应 data**：`{ items: [{ id, name, studentId, department, status }], nextCursor: null }`（status ∈ submitted|revision_requested）
**权限/角色**：`club:batch:execute`

#### GET /api/org/:clubId/batch/interviewers
**说明**：批量分配面试官的目标候选
**响应 data**：`{ items: [{ id, name }] }`
**权限/角色**：`club:batch:execute`

#### POST /api/org/:clubId/batch/execute
**说明**：批量操作执行（确定性逐项结果）
**Body input**：`input: { memberIds: string[], action: string, interviewerId?: string }`
**响应 data**：`{ results: [{ memberId, success: boolean, message }], completedAt, auditRef: 'BATCH-<ts>' }`
**权限/角色**：`club:batch:execute`
**备注**：action='assign_interviewer' 逐项校验 identity_anomaly / 未排期 / 未指定面试官

---

## 11. 普通招新（recruitment）

> 状态机：SM-REC-001（活动）、SM-REC-002（通道）、SM-REC-003（申请）、SM-REC-004（部门路径）、SM-REC-005（面试）、SM-INV-001（邀请）。
> 权限：管理操作需 `club:recruitment:manage`；面试读/评价需 `club:interview:view|evaluate` 或 active 临时面试官任务；平台强制结束需 `platform:delete:execute`。
> 状态枚举：活动 `draft|in_progress|paused|completed|cancelled|force_completed|archived`；通道 `not_open|open|paused|closed`；申请 `draft|submitted|revision_requested|revised|exited|adjustment_overdue|identity_anomaly|not_qualified|accepted`；面试 `pending_selection|scheduled|leave|late|absent|in_progress|completed|cancelled|invalidated`；邀请 `pending_acceptance|accepted|rejected|withdrawn|expired`（另见领域类型 recruitment.ts）。
> 错误语义：状态机守卫失败与业务校验一律 **422 `IFC-ERR-006`**（不用 409）；乐观锁以资源 `version` 字段承载（mock 不强制比对）。

### 11.1 报名侧（公开申请）

#### GET /api/activity/recruitment/:activityId/apply
**说明**：申请人本人视角获取自己的报名申请（US-REC-08）
**响应 data**：`{ id, activityId, status, preferences, allowAdjustment, answers, formVersion, submittedAt, withdrawnAt, identityAnomalyAt, recoveryWindowDeadline, adjustmentDeadline, adjustmentReason, notQualifiedReason, paths, version }`
**权限/角色**：申请人档案可解析（否则 403）
**错误/备注**：未提交 → 404 `IFC-ERR-015`

#### POST /api/activity/recruitment/:activityId/apply
**说明**：提交报名申请（SM-REC-003 draft→submitted）
**Body input**：`input: { preferences: [{ departmentId }], allowAdjustment: boolean, answers? }`
**响应 data**：完整 `RecApplication` + 推送 application 通知
**错误/备注**：422 覆盖：活动非 in_progress、通道未开放、已截止、志愿重复/越界（volunteerRules.min~max）、志愿不在开放部门、已接受/身份异常不可提交、exited 需有效恢复窗口；本社团成员报名 → 422

#### POST /api/activity/recruitment/:activityId/draft
**说明**：保存报名草稿（无申请则创建 draft）
**Body input**：`input: { answers? }`
**响应 data**：`{ activityId, status: 'draft', savedAt, ...RecApplication }`
**错误/备注**：已提交需先撤销；身份异常不可保存

#### POST /api/activity/recruitment/:activityId/apply/withdraw
**说明**：撤销提交回到草稿（SM-REC-003 submitted→draft）
**响应 data**：`RecApplication`（status='draft'，paths 清空）
**错误/备注**：仅通道开放未截止且未排期/无结论可用；撤销时删除 pending_selection 面试、过期 pending_acceptance 邀请

#### POST /api/activity/recruitment/:activityId/withdraw
**说明**：退出招新（二次确认；SM-REC-003 submitted→exited）
**Body input**：`input: { confirm?: boolean }`
**响应 data**：`null`
**错误/备注**：accepted 不可退出（走成员退出流程）；confirm 非 true → 422；退出后取消未完结面试与待处理邀请

### 11.2 活动管理

#### GET /api/org/:clubId/recruitment
**说明**：招新活动列表（管理视角）
**响应 data**：`{ items: [{ id, clubId, title, status, channelStatus, deadline, applicantCount, createdAt }], nextCursor: null }`
**权限/角色**：`club:recruitment:manage` 或 `club:interview:view|evaluate`
**备注**：临时面试官仅见其任务活动

#### POST /api/org/:clubId/recruitment
**说明**：创建招新活动（REC-007；初始 draft/not_open）
**Body input**：`input: { title, description?, deadline?, departments?: [{id,name}], formId? }`
**响应 data**：完整 `RecActivity`（window={seq:1,deadline}，conclusionMode='club_unified'，volunteerRules={min:1,max:1}，version=1）
**权限/角色**：`club:recruitment:manage`

#### GET /api/org/:clubId/recruitment/:activityId
**说明**：活动详情（管理视角）
**响应 data**：
```
{ id, clubId, clubName, title, description, status, channelStatus, deadline,
  deadlineVersion, window: { seq, deadline }, formId, formVersion,
  departments: [{id,name}], eligibility: { colleges, grades },
  volunteerRules: { min, max }, allowAdjustmentDefault, conclusionMode,
  applicantCount, interviewCount, invitationCount,
  publishedAt, completedAt, cancelledAt, createdAt, version }
```
**权限/角色**：canManageRec 或 canInterview；活动域收敛（非管理须持任务）

#### PUT /api/org/:clubId/recruitment/:activityId
**说明**：更新活动基础信息（仅 draft/in_progress/paused 生效）
**Body input**：`title/description/departments/eligibility/volunteerRules/formId/formVersion/conclusionMode`
**响应 data**：`RecActivity`（version+1）
**备注**：终态下更新静默不生效

#### POST /api/org/:clubId/recruitment/:activityId/publish
**说明**：发布活动（SM-REC-001 draft→in_progress）
**响应 data**：`RecActivity`（publishedAt 写入）
**错误/备注**：无开放部门/志愿规则无效/状态机拒绝 → 422

#### POST /api/org/:clubId/recruitment/:activityId/pause
**说明**：暂停活动（记录暂停前通道）
**Body input**：`input: { reason?: string }`（必填）
**响应 data**：`null`

#### POST /api/org/:clubId/recruitment/:activityId/resume
**说明**：恢复活动（deadline 按暂停时长顺延，恢复暂停前通道）
**响应 data**：`null`

#### POST /api/org/:clubId/recruitment/:activityId/complete
**说明**：正常结束活动（SM-REC-001 →completed）
**响应 data**：`null`
**错误/备注**：前置：通道 closed、无未终结申请路径、无待处理邀请；完成后活动级任务全部 expire

#### POST /api/org/:clubId/recruitment/:activityId/cancel
**说明**：取消活动（→cancelled）
**Body input**：`input: { reason?: string, confirmAcceptedSync?: boolean }`
**响应 data**：`null`
**错误/备注**：reason 必填；存在 accepted+processing 邀请且未 confirmAcceptedSync 时拒绝；通道置 closed、未完结面试 cancelled、pending 邀请 expired

#### POST /api/org/:clubId/recruitment/:activityId/channel
**说明**：报名通道操作（SM-REC-002）
**Body input**：`input: { action: 'open'|'close'|'pause'|'resume'|'reopen', reason?, newDeadline? }`
**响应 data**：`null`
**错误/备注**：close 必填 reason；open/reopen/resume 必填 newDeadline 且须严格晚于当前；仅 in_progress 活动可重开

### 11.3 轮次（rounds）

#### GET /api/org/:clubId/recruitment/:activityId/rounds
**说明**：轮次列表（含 slot 余量）
**响应 data**：
```
{ items: [{ id, name, status: 'open'|'closed'|'cancelled', mode: 'club_unified'|'dept_separate',
            selectDeadline, slots: [{ id, roundId, startAt, endAt, capacity, taken, available }],
            bookedCount }], nextCursor: null }
```

#### POST /api/org/:clubId/recruitment/:activityId/rounds
**说明**：创建轮次
**Body input**：`input: { name, mode, selectDeadline, slots: [{ startAt, endAt, capacity }] }`
**响应 data**：`RecRound`（status='open'）
**错误/备注**：活动终态不可新建

#### PUT /api/org/:clubId/recruitment/:activityId/rounds/:roundId
**说明**：更新轮次名称/选时截止
**Body input**：`input: { name?, selectDeadline? }`
**响应 data**：`RecRound`
**错误/备注**：已有排期的轮次不可修改（只能取消）

#### POST /api/org/:clubId/recruitment/:activityId/rounds/:roundId/cancel
**说明**：取消轮次（级联取消该轮面试、释放 slot、轮次级任务 expire）
**Body input**：`input: { reason?: string }`（必填）
**响应 data**：`null`

#### POST /api/org/:clubId/recruitment/:activityId/rounds/:roundId/skip
**说明**：跳轮/免试（REC-013；面试记 cancelled + skipReason）
**Body input**：`input: { applicantId?: string, reason?: string }`（均必填）
**响应 data**：`null`
**错误/备注**：面试已开始/完成不可跳

#### POST /api/org/:clubId/recruitment/:activityId/rules/tighten
**说明**：收紧招新规则（REC-007/044：暂停通道 + 为 submitted 申请人开补救窗口）
**Body input**：`input: { reason?: string, deadlineDays?: number }`（deadlineDays 1~30）
**响应 data**：`{ affectedCount, affected: [{ applicantId, applicantName, adjustmentDeadline }] }`

### 11.4 报名申请管理

#### GET /api/org/:clubId/recruitment/:activityId/applications
**说明**：报名申请列表（管理视角）
**Query**：`status?`（枚举过滤）
**响应 data**：`{ items: [RecApplicationRow], nextCursor: null }`
**备注**：逾期推进：submitted 且 adjustmentDeadline 已过 → adjustment_overdue

#### GET /api/org/:clubId/recruitment/:activityId/applications/:applicantId
**说明**：申请详情（含表单答案与部门路径）
**响应 data**：
```
{ ...RecApplication,
  paths: { departmentId: { departmentId, departmentName, order,
    source: 'volunteer'|'adjustment',
    status: 'pending'|'evaluating'|'hold'|'decided'|'waitlist'|'published',
    decided: 'admit'|'not_admit'|null, labelSetBy, waitlist, holdDeadline,
    publishedAt, version } } }
```

#### POST /api/org/:clubId/recruitment/:activityId/applications/:applicantId/adjustment
**说明**：处理调整逾期（REC-044：extend 延长窗口 / not_qualified 资格不符）
**Body input**：`input: { action: 'extend'|'not_qualified', reason?, newDeadline? }`
**响应 data**：`RecApplication`
**错误/备注**：仅 adjustment_overdue 或带 adjustmentDeadline 的申请可处理；extend 默认 +7 天且须晚于当前

#### POST /api/org/:clubId/recruitment/:activityId/applications/:applicantId/supplement
**说明**：要求补充材料（SM-REC-003 submitted→revision_requested）
**Body input**：`input: { requirement?: string, deadline?: string }`
**响应 data**：`null`

#### POST /api/org/:clubId/recruitment/:activityId/applications/:applicantId/not-qualified
**说明**：公布不通过（→not_qualified，级联取消待面试）
**Body input**：`input: { reason?: string }`（必填）
**响应 data**：`null`

#### POST /api/org/:clubId/recruitment/:activityId/applications/:applicantId/identity-anomaly
**说明**：标记身份异常（→identity_anomaly）
**响应 data**：`null`
**错误/备注**：draft/submitted/revision_requested/revised 可标记

#### POST /api/org/:clubId/recruitment/:activityId/applications/:applicantId/identity-anomaly/recover
**说明**：恢复身份异常（identity_anomaly→submitted）
**响应 data**：`null`

#### POST /api/org/:clubId/recruitment/:activityId/applications/:applicantId/recovery-window
**说明**：为已退出申请人创建恢复报名窗口
**Body input**：`input: { deadline?: string }`（必填，须晚于当前）
**响应 data**：`null`
**错误/备注**：仅已退出申请可建；已有有效窗口拒绝

#### POST /api/org/:clubId/recruitment/:activityId/applications/:applicantId/paths/:departmentId/decision
**说明**：部门路径决策（SM-REC-004：admit/not_admit/hold）
**Body input**：`input: { decision: 'admit'|'not_admit'|'hold', holdDeadline? }`
**响应 data**：`null`
**错误/备注**：hold 必须设置处理期限

#### POST /api/org/:clubId/recruitment/:activityId/applications/:applicantId/paths/:departmentId/label
**说明**：部门意向标记（SM-REC-004 set_label）
**Body input**：`input: { label?: boolean }`
**响应 data**：`null`
**权限/角色**：`club:recruitment:manage`；部门负责人仅能操作正式志愿本部门的申请人
**错误/备注**：不能设置自己的标签；label=true → decided+admit+labelSetBy

#### POST /api/org/:clubId/recruitment/:activityId/applications/:applicantId/paths/:departmentId/waitlist
**说明**：加入/移出候补名单
**Body input**：`input: { on?: boolean }`
**响应 data**：`null`

#### POST /api/org/:clubId/recruitment/:activityId/applications/:applicantId/paths/:departmentId/publish
**说明**：发布部门结论（需先 decided/waitlist）
**响应 data**：`null`

### 11.5 面试管理

#### GET /api/org/:clubId/recruitment/:activityId/interviews
**说明**：面试列表（管理视角；按面试工作区过滤，轮次级任务仅见其轮次）
**响应 data**：
```
{ items: [{ id, activityId, activityTitle, roundId, roundName, applicantId,
            applicantName, studentId, status, slotId, scheduledTime, endTime,
            attendance, invalidReason, skipReason, version }], nextCursor: null }
```

#### GET /api/org/:clubId/recruitment/:activityId/interviews/:interviewId
**说明**：面试详情（管理视角）
**响应 data**：`{ ...同上, interviewers: [{ id, name }], cancelReason }`

#### POST /api/org/:clubId/recruitment/:activityId/interviews/book
**说明**：管理代预约/改期面试（自动分配该社团默认面试官）
**Body input**：`input: { applicantId?, roundId?, slotId? }`（applicantId、slotId 必填）
**响应 data**：`RecInterview`（status='scheduled'）+ 推送「面试已排期」通知
**错误/备注**：轮次非 open/已满员/时间冲突（跨普通+联合活动全局冲突检测）→ 422；管理员豁免选时截止；改期原子释放旧 slot

#### POST /api/org/:clubId/recruitment/:activityId/interviews/:interviewId/start
**说明**：开始面试（scheduled→in_progress，记 actualStartAt）
**响应 data**：`RecInterview`

#### POST /api/org/:clubId/recruitment/:activityId/interviews/:interviewId/complete
**说明**：完成面试（in_progress→completed，attendance='present'）
**响应 data**：`RecInterview`

#### POST /api/org/:clubId/recruitment/:activityId/interviews/:interviewId/attendance
**说明**：出勤登记（leave/late/absent；释放 slot）
**Body input**：`input: { event: 'leave'|'late'|'absent' }`
**响应 data**：`RecInterview`（slotId/startAt/endAt 置 null）

#### POST /api/org/:clubId/recruitment/:activityId/interviews/:interviewId/invalidate
**说明**：作废面试（须填原因；已开始需谨慎确认）
**Body input**：`input: { reason?: string }`（必填）
**响应 data**：`RecInterview`
**错误/备注**：completed/in_progress 也可作废；actualStartAt 已置时拒绝

### 11.6 面试官任务（REC-013 / ORG-037）

#### GET /api/org/:clubId/recruitment/:activityId/interviewers
**说明**：面试官任务列表（默认职能 + 临时任务）
**响应 data**：
```
{ defaultReviewers: [{ id, name, source: 'default' }],
  tasks: [{ id, clubId, activityId, kind, scope: 'activity'|'round', roundId,
            roundName, userId, userName, status: 'active'|'revoked'|'expired',
            createdAt, revokedAt, revokedBy }] }
```
**权限/角色**：`club:recruitment:manage`

#### POST /api/org/:clubId/recruitment/:activityId/interviewers
**说明**：指派临时面试官（活动级或轮次级）
**Body input**：`input: { userId?, userName?, scope?: 'activity'|'round', roundId? }`
**响应 data**：`InterviewerTask`（status='active'）+ 推送「您被指派为临时面试官」
**错误/备注**：已存在活动级任务/该轮次已存在有效任务 → 422

#### GET /api/org/:clubId/recruitment/:activityId/interviewers/candidates
**说明**：临时面试官候选（本社团当前角色成员）
**响应 data**：`{ items: [{ id, name, role }] }`

#### POST /api/org/:clubId/recruitment/:activityId/interviewers/:taskId/revoke
**说明**：撤销临时面试官任务
**响应 data**：`InterviewerTask`（status='revoked'）
**错误/备注**：跨社团/跨活动校验；已失效拒绝

### 11.7 评价与结论（REC-015）

#### GET /api/org/:clubId/recruitment/:activityId/reviews
**说明**：评价列表（按申请人派生、多作者；首评前隔离 REC-015）
**响应 data**：
```
{ items: [{ id, applicantId, applicantName, departmentName,
            status: 'pending'|'published'|'concluded'|'evaluating',
            rating, comment, concludedAt, concludedBy, peerViewLocked,
            reviews: [{ authorName, authorRole, comment, version, createdAt, updatedAt }],
            myRating, myComment }], nextCursor: null }
```
**权限/角色**：canManageRec 或 canInterview；非管理且本人未提交时 peerViewLocked=true、reviews 空数组

#### POST /api/org/:clubId/recruitment/:activityId/reviews/:reviewId/conclude
**说明**：提交/更新评价（轮次关闭锁定）
**Body input**：`input: { rating?: number, comment?: string }`
**响应 data**：`{ id, status: 'concluded', rating, comment, concludedAt }`
**权限/角色**：非管理须是该申请人未取消面试的 interviewerIds 之一，否则 403
**错误/备注**：活动结束/轮次 closed 锁定；多次提交追加 history

#### POST /api/org/:clubId/recruitment/:activityId/reviews/publish
**说明**：统一发布结论
**响应 data**：`{ publishedCount }`
**错误/备注**：无可发布结论 → 422；成功后推送 conclusion 通知

### 11.8 录取邀请（SM-INV-001）

#### GET /api/org/:clubId/recruitment/:activityId/invitations
**说明**：录取邀请列表（管理视角）
**响应 data**：`{ items: [{ id, activityId, applicantId, applicantName, departmentId, departmentName, status, sentAt, acceptedAt, expiredAt, casdoorSync, version }], nextCursor: null }`

#### GET /api/org/:clubId/recruitment/:activityId/invitations/:invitationId
**说明**：邀请详情（管理视角，结构同列表项）

#### POST /api/org/:clubId/recruitment/:activityId/invitations
**说明**：创建录取邀请（需先形成该部门 admit 决定）
**Body input**：`input: { applicantId?, departmentId?, expireDays? }`（expireDays 默认 7）
**响应 data**：`RecInvitation`（status='pending_acceptance'）+ 推送 invitation 通知
**错误/备注**：未形成 admit 决定/已有待处理邀请 → 422

#### POST /api/org/:clubId/recruitment/:activityId/invitations/:invitationId/withdraw
**说明**：撤回邀请（pending_acceptance→withdrawn）
**响应 data**：`null`

#### POST /api/org/:clubId/recruitment/:activityId/invitations/:invitationId/reissue
**说明**：重发邀请（rejected/withdrawn/expired→pending_acceptance，生成新邀请）
**Body input**：`input: { expireDays?: number }`
**响应 data**：新 `RecInvitation`

#### POST /api/org/:clubId/recruitment/:activityId/invitations/:invitationId/sync
**说明**：确认成员同步（Casdoor；accepted+processing → 建成员 → confirmed）
**响应 data**：`RecInvitation`（casdoorSync='confirmed'）
**错误/备注**：成员创建失败保持 processing 可重试

### 11.9 其他

#### GET /api/org/:clubId/recruitment/list
**说明**：招新活动列表（列表页补充 handler）
**响应 data**：`{ items: [{ id, title, status, channelStatus, deadline, applicantCount, createdAt }], nextCursor: null }`（status 显示别名 'published'、channelStatus 显示别名 'closed'）

#### POST /api/admin/recruitment/:activityId/force-complete
**说明**：平台强制结束活动（SM-REC-001 →force_completed）
**权限/角色**：`platform:delete:execute`
**备注**：见 admin 域 §15.6 平台强制操作（详情在 `recruitment-api.ts`）

---

## 12. 联合活动（joint）

> 状态机：SM-JNT-001（活动）、SM-JNT-002（参与社团）、SM-JNT-003（联合申请）、SM-JNT-004（联合面试）、SM-JNT-005（结论）、SM-JNT-006（通道）、SM-INV-001（邀请）。
> 枚举：活动 `draft|confirmed|published|invite_phase|closing_confirm|closed|cancelled|force_closed`；社团 `invited|accepted|confirm_pending|locked|force_suspended`；通道 `not_open|open|paused|closed`；申请 `draft|submitted|archived`；结论 `pending|evaluating|invite_pending|accepted_locked|archived`；面试 `pending_selection|scheduled|leave|late|absent|in_progress|completed|invalidated|cancelled_archived|completed_archived`；邀请 `pending_acceptance|accepted|rejected|withdrawn|expired`；邀请 type `admit`（志愿录取）|`join`（服从调剂）。
> 关键语义：JNT-029 首次公布/首开（channelOpenedAt 写入后不变）；首次公布即名单永久锁定；firstInviteAt 发出后不可取消活动；时间惰性推进 autoAdvanceJointDeadlines（读取时触发）。

### 12.1 活动管理

#### GET /api/org/:clubId/joint
**说明**：联合活动列表（管理视角）
**响应 data**：
```
{ items: [{ id, title, status, channelStatus, deadline, participantClubs: string[],
            applicantCount, confirmRound, confirmDeadline, createdAt, version,
            myClubStatus: JointClubStatus|null }], nextCursor: null }
```
**权限/角色**：`club:joint:manage`（被 force_suspended 的社团失权）
**备注**：仅返回 clubs 含本 clubId 的活动

#### POST /api/org/:clubId/joint
**说明**：创建联合活动（发起方自动 accepted）
**Body input**：`input: { title?, description?, clubIds?: string[], confirmDeadline?, sharedAgreement? }`
**响应 data**：完整 `JointActivity`（status='draft'，channelStatus='not_open'）
**错误/备注**：clubIds 少于 2、发起方不在名单、标题为空、confirmDeadline 不晚于当前 → 422

#### GET /api/org/:clubId/joint/list
**说明**：联合活动列表（列表页专用，宽松口径）
**响应 data**：`{ items: [{ id, title, status, channelStatus, participants: string[], applicantCount, createdAt }], nextCursor: null }`
**权限/角色**：在 :clubId 拥有任意角色即可

#### GET /api/org/:clubId/joint/:jointId
**说明**：活动详情（管理视角）
**响应 data**：
```
{ ...JointRow,
  description, sharedAgreement: { version, text },
  participants: [{ clubId, clubName, status, confirmedAt, confirmedBy }],
  cancelConfirmRound, cancelConfirmDeadline, endConfirmRound, endConfirmDeadline,
  publishedAt, firstInviteAt, closedAt, forceClosedAt }
```
**错误/备注**：不存在 → 404 `IFC-ERR-015`

#### POST /api/org/:clubId/joint/:jointId/publish
**说明**：首次公布（SM-JNT-001 confirmed→published；锁定名单、自动开通通道）
**响应 data**：无（`{ code: 0 }`）
**错误/备注**：须全部社团确认后才能首次公布；公布后社团全部 locked，channelOpenedAt 写入

#### POST /api/org/:clubId/joint/:jointId/cancel
**说明**：取消活动（全员收集制：所有参与社团提交才真正 cancelled）
**Body input**：`input: { confirm?: boolean, reason?: string }`
**响应 data**：无
**错误/备注**：已发出第一份邀请后不可取消；收齐后 cancelled + 面试 cancelled_archived

#### POST /api/org/:clubId/joint/:jointId/withdraw
**说明**：参与社团退出（仅 draft 期可用；SM-JNT-002 →removed）
**响应 data**：无
**错误/备注**：已首次公布名单永久锁定 → 422

#### POST /api/org/:clubId/joint/:jointId/confirm
**说明**：社团确认参与（invited/confirm_pending→accepted；全部确认后活动→confirmed）
**响应 data**：完整 `JointActivity`
**错误/备注**：不在名单/已锁定/确认期限已过 → 422

#### POST /api/org/:clubId/joint/:jointId/clubs
**说明**：调整参与社团名单（draft 期可多次，重置确认状态）
**Body input**：`input: { clubIds: string[], newDeadline?: string }`
**响应 data**：无
**错误/备注**：少于 2 个 → 422；已公布锁定

#### POST /api/org/:clubId/joint/:jointId/channel
**说明**：联合通道统一操作（SM-JNT-006）
**Body input**：`input: { action: 'open'|'pause'|'resume'|'extend'|'close'|'reopen', deadline?, reason? }`
**响应 data**：无
**错误/备注**：close 必填 reason；open/reopen 须传 deadline（严格晚于当前）；extend 仅 open 可延长；resume 顺延暂停时长

#### GET /api/org/:clubId/joint/:jointId/close
**说明**：结束信息面板（结束确认前聚合）
**响应 data**：
```
{ id, title, status,
  participants: [{ clubId, clubName, status, concludedCount, invitationSent, endConfirmed }],
  totalApplicants, endConfirmRound, endConfirmDeadline, canClose }
```

#### POST /api/org/:clubId/joint/:jointId/close/start
**说明**：进入结束确认阶段（SM-JNT-001 invite_phase→closing_confirm）
**响应 data**：无
**错误/备注**：须已发出邀请且无待处理邀请

#### POST /api/org/:clubId/joint/:jointId/close
**说明**：提交本社团结束确认（全员收集后 →closed 归档）
**响应 data**：无
**错误/备注**：非 closing_confirm/已提交过 → 422；收齐后面试 completed_archived、非 accepted_locked 结论 archived

### 12.2 联合申请

#### GET /api/org/:clubId/joint/:jointId/applications
**说明**：联合申请列表（管理视角）
**响应 data**：
```
{ items: [{ id, jointId, applicantId, applicantName, applicantStudentId,
            status: 'draft'|'submitted'|'archived', consented, consentAt,
            agreementVersion, allowJointAdjustment, volunteerClubIds: string[],
            volunteerClubSnapshot, agreementClubSnapshot, submittedAt, version }],
  nextCursor: null }
```

#### GET /api/org/:clubId/joint/:jointId/applications/:applicantId
**说明**：申请详情（管理视角）
**响应 data**：同列表行 + `answers: Record<string,unknown>`、`formVersion`

#### GET /api/activity/joint/:jointId/apply
**说明**：我的联合申请（申请人本人视角）
**响应 data**：完整 `JointApplication`（含 preferences、answers、formVersion）
**错误/备注**：未提交 → 404

#### POST /api/activity/joint/:jointId/apply
**说明**：提交联合报名（SM-JNT-003 draft→submitted；需先保存草稿）
**Body input**：`input: { consented: boolean, allowJointAdjustment: boolean, volunteerClubIds?: string[], answers?: object, preferences?: [{departmentId, departmentName}] }`
**响应 data**：完整 `JointApplication`
**错误/备注**：通道未开放/已截止/拒绝共享/未建草稿 → 422；成功后自动创建 pending_selection 面试（attempt:1）与各社团 pending 结论

#### POST /api/activity/joint/:jointId/draft
**说明**：保存联合报名草稿（首次自动建档）
**Body input**：`input: { answers?, volunteerClubIds?, allowJointAdjustment?, consented?, preferences? }`
**响应 data**：完整 `JointApplication`
**错误/备注**：未首次公布 → 422；volunteerClubIds 过滤为参与社团子集；preferences 以服务端部门权威反查

#### POST /api/activity/joint/:jointId/withdraw
**说明**：撤销提交（submitted→draft）
**响应 data**：完整 `JointApplication`（consented 等清空）
**错误/备注**：已排期面试/已有非 pending 结论 → 422；副作用删除未排期面试、pending 结论过期

### 12.3 联合面试

#### GET /api/org/:clubId/joint/:jointId/slots
**说明**：联合面试时段列表（容量/余量）
**响应 data**：`{ items: [{ id, startAt, endAt, capacity, available }], nextCursor: null }`

#### GET /api/org/:clubId/joint/:jointId/interviews
**说明**：联合面试列表（按申请人聚合，内嵌各社团评价，US-JNT-03 跨社互见）
**响应 data**：
```
{ items: [{ id, jointId, applicantId, applicantName, status, slotId,
            scheduledTime, endTime, attendance, invalidReason, attempt, version,
            reviews: [{ clubId, clubName, rating, comment, concludedAt,
                        author, authorRole, version }] }], nextCursor: null }
```

#### POST /api/org/:clubId/joint/:jointId/interviews/book
**说明**：管理代预约/改期（可指定任意 applicantId）
**Body input**：`input: { applicantId?: string, slotId?: string }`
**响应 data**：完整 `JointInterview`（status='scheduled'）
**错误/备注**：满员/申请不存在/全局时间冲突/状态机拒绝 → 422；改期自动释放旧时段

#### POST /api/org/:clubId/joint/:jointId/interviews/:applicantId/start
**说明**：开始联合面试（scheduled→in_progress）
**响应 data**：无

#### POST /api/org/:clubId/joint/:jointId/interviews/:applicantId/complete
**说明**：完成联合面试（in_progress→completed，attendance='present'）
**响应 data**：无

#### POST /api/org/:clubId/joint/:jointId/interviews/:applicantId/attendance
**说明**：出席登记（leave/late/absent，释放时段）
**Body input**：`input: { event: 'leave'|'late'|'absent' }`
**响应 data**：无

#### POST /api/org/:clubId/joint/:jointId/interviews/:applicantId/invalidate
**说明**：作废联合面试（结论标 reviewFlag=true，待处理邀请冻结剩余时长）
**Body input**：`input: { reason?: string }`（必填）
**响应 data**：无
**错误/备注**：accepted_locked 结论不联动

### 12.4 联合结论（US-JNT-03）

#### GET /api/org/:clubId/joint/:jointId/conclusions
**说明**：联合结论列表（申请人 × 参与社团 全量交叉行，跨社实时互见）
**响应 data**：
```
{ items: [{ id, applicantId, applicantName, clubId, clubName,
            status: 'pending'|'concluded'|'invite_pending'|'accepted_locked',
            conclusion: 'admit'|'not_admit'|null, reviewFlag,
            rating: number|null, comment, concludedAt: string|null,
            version, authorName, authorRole, history, versions: JointConclusionVersion[],
            myClub: boolean }], nextCursor: null }
```

#### POST /api/org/:clubId/joint/:jointId/conclusions/:applicantId/set
**说明**：设置本社团结论（SM-JNT-005 modify，可反复改判）
**Body input**：`input: { conclusion: 'admit'|'not_admit' }`
**响应 data**：完整 `JointConclusion`
**错误/备注**：accepted_locked 锁定/活动已结束/存在待处理邀请 → 422

#### POST /api/org/:clubId/joint/:jointId/conclusions/:applicantId/review
**说明**：补面后复核结论（keep 保留 / modify 改判并重发邀请）
**Body input**：`input: { action: 'keep'|'modify', newConclusion?: 'admit'|'not_admit' }`
**响应 data**：无
**错误/备注**：面试须 completed；reviewFlag=false → 422「该结论无需复核」

#### POST /api/org/:clubId/joint/:jointId/conclusions/:conclusionId/evaluate
**说明**：提交/修改本社团评价（评分+评语，历史留痕）
**Body input**：`input: { rating?: number, comment?: string }`
**响应 data**：
```
{ id, status: 'concluded', rating, comment, concludedAt,
  author, authorRole, version, history: [...] }
```
**权限/角色**：`club:joint:manage` 或 canInterviewJoint（默认面试职能或有效临时任务）
**错误/备注**：终态活动锁定；仅可操作本社团结论行

### 12.5 联合邀请（JNT-031）

#### GET /api/org/:clubId/joint/:jointId/invitations
**说明**：联合邀请列表（管理视角）
**响应数据**：`{ items: [{ id, jointId, applicantId, applicantName, clubId, clubName, type: 'admit'|'join', status, sentAt, acceptedAt, expiredAt, reviewFlag, casdoorSync, version }], nextCursor: null }`

#### POST /api/org/:clubId/joint/:jointId/invitations
**说明**：创建联合邀请（type 按是否志愿社团自动判定；首份发出时活动→invite_phase）
**Body input**：`input: { applicantId?, clubId?, expireDays? }`（expireDays 默认 7）
**响应 data**：完整 `JointInvitation`（status='pending_acceptance'）
**错误/备注**：非志愿社团需 allowJointAdjustment=true；已有待处理邀请去重；创建后结论→invite_pending

#### POST /api/org/:clubId/joint/:jointId/invitations/:invitationId/withdraw
**说明**：撤回邀请（→withdrawn；结论回 evaluating、inviteId 清空）
**响应 data**：无

#### POST /api/org/:clubId/joint/:jointId/invitations/:invitationId/sync
**说明**：确认邀请生效（casdoor 建成员，processing→confirmed）
**响应 data**：无
**错误/备注**：仅 accepted+processing；志愿部门须落在该社团 departments 内

### 12.6 联合面试官任务（JNT-031 / ORG-037）

#### GET /api/org/:clubId/joint/:jointId/interviewers
**说明**：面试官任务列表
**响应 data**：`{ defaultReviewers: [{ id, name, source: 'default' }], tasks: [InterviewerTaskRow（roundName='联合面试'）] }`

#### POST /api/org/:clubId/joint/:jointId/interviewers
**说明**：指派临时联合面试官（kind='joint'，scope='activity'）
**Body input**：`input: { userId?, userName? }`
**响应 data**：完整 `InterviewerTask`
**错误/备注**：已存在活动级任务 → 422；成功后通知被指派者

#### GET /api/org/:clubId/joint/:jointId/interviewers/candidates
**说明**：可指派候选人（本社团全部成员）
**响应 data**：`{ items: [{ id, name, role }] }`

#### POST /api/org/:clubId/joint/:jointId/interviewers/:taskId/revoke
**说明**：撤销临时任务
**响应 data**：完整 `InterviewerTask`（status='revoked'）

### 12.7 平台管理（joint）

#### GET /api/admin/joint
**说明**：平台联合活动列表（含强制关闭/停用状态）
**响应 data**：
```
{ items: [{ id, title, status, participants: string[], applicantCount,
            canForceClose, clubs: [{ clubId, clubName, suspended }] }], nextCursor: null }
```
**权限/角色**：mock 未校验（契约应为平台管理员）

#### POST /api/admin/joint/:jointId/force-close
**说明**：平台强制关闭（SM-JNT-001 →force_closed）
**Body input**：`input: { reason?: string }`（必填）
**响应 data**：无
**权限/角色**：`platform:delete:execute`
**副作用**：通道 closed、pending 邀请 expired、面试 cancelled_archived、非 locked 结论 archived

#### POST /api/admin/joint/:jointId/clubs/:clubId/force-suspend
**说明**：平台紧急停用参与社团（SM-JNT-002 locked→force_suspended；停用社团即失权）
**响应 data**：无
**权限/角色**：`platform:delete:execute`

#### POST /api/admin/joint/:jointId/clubs/:clubId/re-enable
**说明**：平台恢复被停用社团（force_suspended→locked）
**响应 data**：无
**权限/角色**：`platform:delete:execute`

---

## 13. 动态表单（forms）

> 状态机：SM-FORM-001（定义态 draft→published→deprecated→reuse→draft）、SM-FORM-002（提交态 draft→checking→submitted）。
> FormField.type 12 种：`text|textarea|number|select|multi_select|radio|checkbox|date|datetime|file|image|array`；permission：`read_write|read_only|hidden`。
> 乐观锁：designer save 校验 `expectedVersion`，不匹配 → **409 `IFC-ERR-008`**；提交类接口用 `idempotencyKey` 幂等。

### 13.1 社团表单

#### GET /api/org/:clubId/forms
**说明**：社团表单列表
**响应 data**：`{ items: [{ id, title, status: 'draft'|'published'|'deprecated'|'archived', version, updatedAt }], nextCursor: null }`

#### GET /api/org/:clubId/forms/:formId
**说明**：表单定义详情（报名表）
**响应 data**：
```
{ id, title, status, clubId,
  versions: [{ version, status: 'draft'|'published'|'deprecated', publishedAt: string|null,
               fields: [FormField] }] }
```
**错误/备注**：不存在 → 422 `IFC-ERR-006`

#### POST /api/org/:clubId/forms/versions/:formId/submit
**说明**：表单版本提交（SM-FORM-002，幂等，按版本快照还原）
**Body input**：`input: { formData?: Record<string,unknown>, version?: number, idempotencyKey?: string }`
**响应 data**：完整 `FormSubmission = { id, formId, version, idempotencyKey, fields, data, status: 'submitted', submittedAt }`
**错误/备注**：版本未发布 → 422；同 idempotencyKey 幂等返回

#### POST /api/org/:clubId/forms/:formId/submissions
**说明**：表单提交（兼容信封或平铺）
**Body input**：`{ version?: number, answers?: Record<string,unknown>, idempotencyKey?: string }`（version/answers 必填）
**响应 data**：`{ id, formId, version, status: 'submitted', submittedAt }`

#### GET /api/org/:clubId/forms/designer/:formId
**说明**：设计器编辑态（最新草稿，无则回退已发布）
**响应 data**：`{ id, title, status, fields: FormField[], version }`

#### POST /api/org/:clubId/forms/designer/:formId/save
**说明**：保存草稿（已发布版本不可覆盖；expectedVersion 乐观锁）
**Body input**：`input: { fields: FormField[], version?: number, expectedVersion?: number }`
**响应 data**：`{ id, version, status: 'draft', savedAt }`
**错误/备注**：expectedVersion 不匹配 → **409 `IFC-ERR-008`**；已发布不可覆盖/已停用 → 422

#### POST /api/org/:clubId/forms/designer/:formId/publish
**说明**：发布草稿（仅草稿版本可发布）
**Body input**：`input: { version?: number }`
**响应 data**：`{ id, version, status: 'published', publishedAt }`

#### POST /api/org/:clubId/forms/designer/:formId/deprecate
**说明**：停用（published→deprecated，历史保留）
**响应 data**：`{ id, status: 'deprecated', deprecatedAt }`

#### POST /api/org/:clubId/forms/designer/:formId/reuse
**说明**：复用（deprecated→draft；最新已是草稿直接复用，否则 version+1 新建草稿）
**响应 data**：`{ id, status: 'draft', version }`

#### POST /api/org/:clubId/forms/designer/:formId/clone
**说明**：克隆（生成独立草稿，不携带提交数据）
**Body input**：`input: { title?: string }`（缺省「原标题（副本）」）
**响应 data**：`{ id, title, status: 'draft', version: 1 }`

### 13.2 平台表单（admin）

- `GET /api/admin/forms`：平台表单列表（clubId=null 的表单），`{ items: [{ id, title, status, version, scope: 'platform', updatedAt }], nextCursor: null }`
- `GET /api/admin/forms/:formId`：平台表单定义详情（同 org 版结构）
- `GET /api/admin/forms/designer/:formId`：设计器编辑态
- `POST /api/admin/forms/designer/:formId/save`：保存草稿（expectedVersion 冲突 409 `IFC-ERR-008`）
- `POST /api/admin/forms/designer/:formId/publish`：发布
- `POST /api/admin/forms/designer/:formId/deprecate`：停用
- `POST /api/admin/forms/designer/:formId/reuse`：复用
- `POST /api/admin/forms/designer/:formId/clone`：克隆（新 id 前缀 `pform-`）
- `POST /api/admin/forms/versions/:formId/submit`：表单版本提交（idempotencyKey 幂等）

> 平台表单端点与 org 版共享同一套 formdb 逻辑，请求/响应结构一致（admin 版无 clubId 维度）。

---

## 14. 组织配置 / 统计 / 导出 / 批量

### 14.1 组织配置

#### GET /api/org/:clubId/config
**说明**：读取社团配置
**响应 data**：
```
{ clubName, clubDescription, requireEmailVerification: true, requireProfileComplete: true,
  maxMembers: 200, allowSelfExit: true, academicYearStart: 9 }
```

#### POST /api/org/:clubId/config
**说明**：保存社团配置（回显）
**Body input**：`input: {...}`（任意键透传）
**响应 data**：`{ ...input, version: 2, savedAt: ISO }`

### 14.2 统计

#### GET /api/org/:clubId/stats
**说明**：统计数据（部门负责人按本部门范围）
**响应 data**：
```
{ summary: [{ label, value, trend: 'up'|'flat'|'down', trendValue }],
  departmentDistribution: [{ name, count }] }
```

### 14.3 导出（EXP-001 / EXP-003，任务式）

> 导出为异步任务：POST 创建（status='generating'）→ 轮询 status → completed（24h 内可下载）→ POST download 签发 1 小时下载地址。

#### GET /api/org/:clubId/exports
**说明**：导出任务列表
**响应 data**：
```
{ items: [{ id, clubId, type, status: 'generating'|'completed', createdAt,
            completedAt: string|null, expiredAt: string|null, downloadUrl: string|null,
            fileSize, scope, includeContact: boolean, includeFiles: boolean }],
  nextCursor: null }
```
**权限/角色**：`club:export:execute`；部门负责人仅见本部门作用域任务

#### POST /api/org/:clubId/exports
**说明**：创建导出任务（高危；异步 3 秒后 completed）
**Body input**：`input: { type?: string, includeContact?: boolean, includeFiles?: boolean }`
**响应 data**：完整 `ExportTask`（status='generating'）
**权限/角色**：`club:export:execute`；scope = 部门负责人「本部门名」/ 其余「全社团」

#### GET /api/org/:clubId/exports/:id/status
**说明**：任务状态查询（轮询用）
**响应 data**：`{ id, status, downloadUrl, fileSize, completedAt, expiredAt }`
**权限/角色**：`club:export:execute`；作用域不符 403；不存在 404

#### POST /api/org/:clubId/exports/:id/download
**说明**：导出下载（实时校验权限与作用域）
**响应 data**：`{ fileId: id, status: 'downloaded', downloadUrl: '/api/mock-files/<id>.csv', expiresAt: +1h }`

#### GET /api/admin/exports
**说明**：平台导出任务列表：`{ items: [{ id, clubId, type, status, createdAt, completedAt, expiredAt, downloadUrl, fileSize }], nextCursor: null }`

#### POST /api/admin/exports
**说明**：创建平台导出任务
**响应 data**：`{ id: 'exp-<ts>', clubId: '', type: '全平台导出', status: 'generating', createdAt, completedAt: null, expiredAt: null, downloadUrl: null, fileSize: 0 }`
**权限/角色**：`platform:export:execute`

#### GET /api/admin/exports/:id/status / POST /api/admin/exports/:id/download
**说明**：平台任务状态 / 下载（结构同 org 版）

### 14.4 邮件配置与通知偏好（org 域，P1-009 / US-NTF-01/02）

#### GET /api/org/:clubId/notifications/email-config
**说明**：读取社团 SMTP 配置（脱敏，不含密钥）
**响应 data**：`{ smtpHost, smtpPort, smtpUser, fromName, encryption: 'ssl'|'tls'|'none', verified: boolean, lastTestPassedAt: string|null, keyRotatedAt: string|null }`
**权限/角色**：`club:config:manage`

#### POST /api/org/:clubId/notifications/email-config
**说明**：保存 SMTP 配置（未通过测试不可保存）
**Body input**：`{ smtpHost, smtpPort?, smtpUser, fromName, encryption? }`
**响应 data**：配置 + `savedAt`
**权限/角色**：`club:config:manage`
**错误/备注**：未 verified → 422 `IFC-ERR-006`（不落库）

#### POST /api/org/:clubId/notifications/email-config/test
**说明**：发送测试邮件（通过后 verified=true）
**响应 data**：`{ status: 'sent', sentAt, to }`
**权限/角色**：`club:config:manage`

#### POST /api/org/:clubId/notifications/email-config/rotate-key
**说明**：密钥轮换（轮换后需重新测试）
**响应 data**：`{ rotated: true, rotatedAt, verified: false }`

#### GET /api/org/:clubId/notifications/preferences
**说明**：社团通知偏好（按用户真实落库）
**响应 data**：`{ preferences: Record<kind, boolean>, savedAt: null }`

#### POST /api/org/:clubId/notifications/preferences
**说明**：更新通知偏好
**Body input**：`{ <kind>: boolean, ... }`（未知 kind 忽略）
**响应 data**：`{ preferences, savedAt: ISO }`

#### GET /api/org/:clubId/notifications/kill-switch
**说明**：社团级通知紧急关闭状态
**响应 data**：`{ active, scope: 'platform'|'club'|null, clubId, reason, operatorName, stoppedAt, droppedCount }`
**权限/角色**：`club:config:manage`

#### POST /api/org/:clubId/notifications/kill-switch
**说明**：开/关社团级熔断（active=true 幂等保留首次 stoppedAt）
**Body input**：`{ active: boolean, reason?: string }`
**响应 data**：更新后 KillSwitchState

---

## 15. 平台管理（admin）

> 鉴权卡点：`platform:club:manage`（社团接入/治理）、`platform:config:manage`（配置/模板/保留策略/通知偏好）、`platform:delete:execute`（删除/运维/邮件配置/kill-switch/outbox）、`platform:audit:view`（审计与纠错）、`platform:export:execute`（导出）。

### 15.1 社团接入与治理（US-ORG-01/03，仅平台超管）

#### GET /api/admin/clubs
**说明**：社团接入注册表列表（实时计算 hasActiveBusiness）
**响应 data**：
```
{ items: [{
  clubId, clubName, description,
  status: 'wizard_pending'|'enabled'|'suspended'|'sync_abnormal_ro'|'pending_rebind',
  groupId: string|null, groupName: string|null, mappingVersion, wizardStep,
  leaderName: string|null, memberCount, createdAt, boundAt: string|null,
  importedAt: string|null, importedCount,
  wizard: { selectedGroupId, leaderGroupId, email, deptGroups, roleGroups, leaderRoleGroup }|null,
  freezeExtensionMs, readonly, hasActiveBusiness,
  syncEvents: [{ id, kind: 'group_lost'|'repair'|'rebind'|'disconnect'|'reaccess'
                      |'suspend'|'recover'|'import', at, note }]
}], nextCursor: null }
```
**权限/角色**：`platform:club:manage`

#### POST /api/admin/clubs/wizard
**说明**：从既有 Casdoor Group 创建社团接入（ORG-005：创建即 wizard_pending）
**Body input**：`input: { groupId, name, description?, leaderGroupId, email?, deptGroups?, roleGroups?, leaderRoleGroup? }`
**响应 data**：`{ id, status: 'wizard_pending', wizardStep: 2, createdAt }`
**错误/备注**：邮箱格式/Group 用途非 club/重复绑定/负责人层级校验/社团名重复 → 422

#### POST /api/admin/clubs/wizard/save-step
**说明**：向导分步保存（save_step 事件）
**Body input**：`input: { clubId, step?, selectedGroupId?, leaderGroupId?, email?, deptGroups?, roleGroups?, leaderRoleGroup? }`
**响应 data**：完整 `ClubAccessItem`
**错误/备注**：任一步失败保持未启用且不产生部分权限

#### POST /api/admin/clubs/wizard/complete
**说明**：完成校验并启用（→enabled，mappingVersion+1）
**Body input**：`input: { clubId }`
**响应 data**：完整 `ClubAccessItem`（boundAt 写入）

#### POST /api/admin/clubs/:clubId/import
**说明**：接入时既有成员导入
**Body input**：`input: { memberIds: string[] }`
**响应 data**：完整 `ClubAccessItem`（importedCount/importedAt 写入）
**错误/备注**：空列表/成员不在 Group 内/状态非 wizard_pending|enabled → 422

#### POST /api/admin/clubs/:clubId/normal-suspend
**说明**：普通停用（存在进行中业务时拒绝）
**Body input**：`input: { reason }`
**响应 data**：完整 `ClubAccessItem`（status='suspended'，readonly=true）
**错误/备注**：hasActiveBusiness（招新 in_progress/paused、联合 published/invite_phase/closing_confirm）阻止

#### POST /api/admin/clubs/:clubId/force-suspend
**说明**：紧急停用（只读 + 期限暂停，不被进行中业务阻止）
**Body input**：`input: { reason }`
**响应 data**：完整 `ClubAccessItem`（status='suspended'，readonly=true）

#### POST /api/admin/clubs/:clubId/recover
**说明**：恢复启用（冻结期限按停用时长顺延）
**响应 data**：完整 `ClubAccessItem`（status='enabled'，readonly=false）

#### POST /api/admin/clubs/:clubId/disconnect
**说明**：解除接入（→pending_rebind；普通角色失权，超管保留修复入口）
**响应 data**：完整 `ClubAccessItem`（groupId/leaderGroupId/leaderName=null，wizardStep=0，readonly=true）

#### POST /api/admin/clubs/:clubId/repair
**说明**：修复原 Group 并对账通过（统一先进入已停用）
**响应 data**：完整 `ClubAccessItem`（status='suspended'，readonly=false）
**错误/备注**：原 Group 已不存在 → 提示改走重新绑定

#### POST /api/admin/clubs/:clubId/rebind
**说明**：重新绑定新 Group（统一先进入已停用；mappingVersion+1）
**Body input**：`input: { groupId }`
**响应 data**：完整 `ClubAccessItem`（status='suspended'）

#### POST /api/admin/clubs/:clubId/reaccess
**说明**：从 pending_rebind 重新接入（统一先进入已停用）
**Body input**：`input: { groupId }`
**响应 data**：完整 `ClubAccessItem`（status='suspended'）

### 15.2 Group 目录

#### GET /api/admin/groups
**说明**：Group 目录（SM-ORG-001 唯一数据源，仅社团级候选）
**响应 data**：
```
{ items: [{ id, name, stableId, path, parentId, purpose: 'club',
            boundClubId: string|null, memberCount }] }
```
**权限/角色**：`platform:club:manage`

#### GET /api/admin/groups/search
**说明**：分层搜索（精确 → 连续子串 → 受控近似）
**Query**：`q`
**响应 data**：
```
{ items: [{ id, name, stableId, path, parentId, purpose, boundClubId,
            memberCount, match: 'exact'|'substring'|'fuzzy', score: 1|0.8|0.6 }],
  threshold: 3 }
```

#### GET /api/admin/groups/:groupId
**说明**：Group 详情（成员 + 可用负责人职位 Group）
**响应 data**：
```
{ id, name, stableId, path, parentId, purpose, boundClubId,
  members: [{ id, name }],
  leaderGroups, departments, positions }
```
**错误/备注**：不存在 → 404 `IFC-ERR-015`

### 15.3 权限模板（US-CFG-01 / SRS-INV-019，不可变版本）

#### GET /api/admin/config/permission-templates
**说明**：权限模板列表（草稿 + 已发布并存）
**响应 data**：`{ items: [{ id, name, permissions: string[], status: 'published'|'draft', version, draftVersion: number|null }] }`
**权限/角色**：`platform:config:manage`

#### POST /api/admin/config/permission-templates
**说明**：新建权限模板（直接进入草稿）
**Body input**：`input: { name, permissions: string[] }`
**响应 data**：`{ id, name, permissions, version: 0, draftVersion: 1, status: 'draft' }`
**错误/备注**：名称/权限为空 → 422

#### POST /api/admin/config/permission-templates/:templateId/save
**说明**：保存草稿（draftVersion 递增，不可变版本）
**Body input**：`input: { name, permissions: string[] }`
**响应 data**：`{ id, name, permissions, status: 'draft', version, draftVersion, savedAt }`

#### GET /api/admin/config/permission-templates/:templateId/diff
**说明**：差异预览（旧发布版 vs 草稿）
**响应 data**：`{ added: string[], removed: string[], affectedGroups: string[], affectedMembers: number, previewVersion }`
**错误/备注**：无草稿 → 422

#### POST /api/admin/config/permission-templates/:templateId/publish
**说明**：发布草稿（重认证 + 差异预览 + 二次确认 + 原因；失败保留旧版）
**Body input**：`input: { reauthProof, previewVersion, reason }`
**响应 data**：`{ id, status: 'published', version, publishedAt, auditRef }`
**错误/备注**：401 `IFC-ERR-002`（reauthProof 无效）；409 `IFC-ERR-008`（previewVersion 不符）；422 缺原因/仅草稿可发布

### 15.4 平台配置

#### GET /api/admin/config
**说明**：读取平台配置：`{ clubName, clubDescription, requireEmailVerification, requireProfileComplete, maxMembers, allowSelfExit, academicYearStart }`

#### POST /api/admin/config
**说明**：保存平台配置（回显 + version=2 + savedAt）

### 15.5 数据保留策略（US-AUD-04，P1-010 真实执行器）

#### GET /api/admin/retention
**说明**：保留策略列表（草稿 + 已发布并存）+ 最近执行记录
**响应 data**：
```
{ policies: [{ id, scope, retentionDays, action: 'auto_delete'|'archive'|'keep',
               status: 'active'|'draft', version, updatedAt, publishedAt: string|null }],
  draftVersion: number|null,
  lastExecution: { runId, executedAt, results: [...] }|null }
```
**权限/角色**：`platform:config:manage`

#### POST /api/admin/retention
**说明**：新建保留策略草稿
**Body input**：`input: { scope, retentionDays, action? }`
**响应 data**：`{ id: 'rp-draft-...', scope, retentionDays, action, status: 'draft', version, updatedAt, publishedAt: null }`
**错误/备注**：范围必填/天数须正整数/该范围已有草稿 → 422

#### POST /api/admin/retention/:policyId/publish
**说明**：发布草稿为 active（重认证 + 原因 + 预览 + 二次确认；缩短期限 ≥7 天缓冲），写平台审计
**Body input**：`input: { reason, reauthProof, previewVersion }`
**响应 data**：
```
{ id, scope, retentionDays, action, status: 'active', version, updatedAt,
  publishedAt, bufferDays: 7|0, notice: string|null, auditRef }
```
**错误/备注**：401 `IFC-ERR-002`；409 `IFC-ERR-008`（previewVersion 不符）；422 缺原因；404 策略不存在

#### GET /api/admin/retention/:policyId/preview
**说明**：发布预览（previewVersion 自增）
**响应 data**：`{ scope, fromDays, toDays, action, affectedObjects: { records, members }, bufferDays, previewVersion }`

#### POST /api/admin/retention/execute
**说明**：批量执行器（对每个 active 策略扫描到期数据处置，逐策略写审计）
**Body input**：`input: { reason, reauthProof }`
**响应 data**：`{ runId, executedAt, results: [...], totalExecuted, auditRef }`
**错误/备注**：401 `IFC-ERR-002`；422 缺原因

### 15.6 平台强制操作

#### POST /api/admin/recruitment/:activityId/force-complete
**说明**：平台强制结束招新活动（SM-REC-001 →force_completed）
**权限/角色**：`platform:delete:execute`
**说明**：详见 [§11 普通招新](#11-普通招新recruitment)（handler 位于 recruitment-api.ts）

#### POST /api/admin/joint/:jointId/force-close 等
**说明**：见 [§12.7 平台管理（joint）](#127-平台管理joint)

### 15.7 正式删除（SRS-INV-002，platform:delete:execute）

#### GET /api/admin/delete/preview
**说明**：正式删除影响预览（不可恢复提示 + previewVersion）
**Query**：`scope?`（默认 'club'）
**响应 data**：
```
{ scope: 'club',
  targets: [{ id, label, type: '社团'|'活动', recordCount, memberCount }],
  totalRecords, totalMembers,
  warning: '删除后不可恢复，相关数据将被永久清除',
  previewVersion: 4 }
```
**权限/角色**：仅平台超级管理员（`platform:delete:execute`）

#### POST /api/admin/delete/execute
**说明**：正式删除执行（重认证 + 预览版本 + 原因 + 二次确认）
**Body input**：`input: { targetIds: string[], reason, reauthProof, previewVersion }`
**响应 data**：`{ results: [{ targetId, success: true, stores: ['数据库','附件','索引'] }], completedAt, auditRef }`
**错误/备注**：401 `IFC-ERR-002`；409 `IFC-ERR-008`（previewVersion 不符）；422 缺原因/目标仍存在活跃关系

### 15.8 运维与统计

#### GET /api/admin/ops-status
**说明**：运维状态总览
**响应 data**：
```
{ appVersion, uptime,
  dependencies: [{ name, status: 'healthy'|'degraded', latency }],
  taskQueue: { pending, processing, failed },
  lastCheckAt }
```
**权限/角色**：`platform:delete:execute`

#### GET /api/admin/stats
**说明**：平台统计
**响应 data**：`{ summary: [{ label, value, trend, trendValue }], departmentDistribution: [{ name, count }] }`

### 15.9 通知平台管理（P1-009 / US-NTF-01/02）

> 与 org 版邮件配置结构一致；平台级鉴权 `platform:delete:execute`（isPlatformAdmin）。

- `GET /api/admin/notifications/email-config`：平台 SMTP 配置（脱敏）
- `POST /api/admin/notifications/email-config`：保存（未测试通过拒绝，422 `IFC-ERR-006`）
- `POST /api/admin/notifications/email-config/test`：测试邮件（verified=true）
- `POST /api/admin/notifications/email-config/rotate-key`：密钥轮换
- `GET/POST /api/admin/notifications/preferences`：平台默认通知偏好（8 类 kind 布尔）
- `GET/POST /api/admin/notifications/kill-switch`：平台级通知总开关（active=true 幂等保留首次 stoppedAt，droppedCount 累计）
- `GET /api/admin/notifications/templates`：通知模板目录
  ```
  { items: [{ kind, title, body, emailSubject?, emailBody?,
              channel: ['inbox']|['inbox','email'], link: string|null, dedupKey: string|null }] }
  ```
- `GET /api/admin/notifications/email-outbox`：邮件发送记录（最近 50 条）：`{ items: [{ id, toUserId, toEmail, subject, body, kind, clubId: string|null, sentAt }] }`

---

## 16. 事实纠错与审计

> 纠错状态机 SM-AUD-001：`submitted → approved|rejected|withdrawn`；逾期末处置视为 `overdue`；guard：仅 submitted/overdue 可批/可撤，否则 **409 `IFC-ERR-007`**。
> CorrectionRecord：`{ id, targetType, targetId, reason, evidence, status: 'submitted'|'overdue'|'approved'|'rejected'|'withdrawn', submittedAt, submitterName, decidedBy?, decidedAt?, withdrawnBy?, withdrawnAt?, auditTrail: [{ action: 'submit'|'approve'|'reject'|'withdraw', actorName, at, note? }] }`

### 16.1 个人中心（me）

- `GET /api/me/corrections`：我的纠错列表（仅本人提交）
- `POST /api/me/corrections`：发起纠错。Body input：`{ targetType, targetId, reason, evidence }`
- `POST /api/me/corrections/:correctionId/decide`：批准/拒绝（需当前工作空间 `club:audit:view`）。Body input：`{ decision }`
- `POST /api/me/corrections/:correctionId/withdraw`：撤回（仅提交人本人，403 非本人）

### 16.2 社团域（org）

- `GET /api/org/:clubId/audit/corrections`：纠错列表（权限 `club:audit:view`）
- `POST /api/org/:clubId/audit/corrections`：发起纠错（写 scope=org 审计）
- `POST /api/org/:clubId/audit/corrections/:correctionId/decide`：批准/拒绝（`club:audit:view`；409 状态冲突）
- `POST /api/org/:clubId/audit/corrections/:correctionId/withdraw`：撤回（仅提交人本人）
- `GET /api/org/:clubId/audit/logs`：社团域审计日志（`search?` 过滤 actorName/action/detail）：`{ items: [{ id, actorName, action, targetType, targetId, detail, createdAt, scope: 'org' }], nextCursor: null }`

### 16.3 平台域（admin）

- `GET /api/admin/audit/logs`：平台域审计日志（仅 scope='platform'），权限 `platform:audit:view`
- `GET /api/admin/audit/corrections`：平台纠错列表（倒序）
- `POST /api/admin/audit/corrections`：发起纠错（写 scope=platform 审计）
- `POST /api/admin/audit/corrections/:correctionId/decide`：批准/拒绝（409 状态冲突）
- `POST /api/admin/audit/corrections/:correctionId/withdraw`：撤回（仅提交人本人）

> 通用：decide/withdraw 失败语义——404 不存在、409 `IFC-ERR-007` 状态冲突、403 非本人/无权限。

---

## 17. 附录：mock 专用端点与演示开关

以下端点**不属于后端契约**，仅 mock 演示/测试使用，后端无需实现：

- `POST /api/mock/degraded`、`GET /api/mock/degraded`：SRS-FAIL-001 降级模式开关（演示脚本触发）
- `GET /api/mock-files/:fileId`：CSV 附件直出（供 download 返回的 downloadUrl 使用，正则 `^(file-|exp-)[\w.-]+\.csv$`）
- `?_mock_user=` / `?_mock_error=IFC-ERR-xxx` / `?_mock_club=` 等查询参数：mock 身份切换与错误注入

---

## 附录 A：状态机索引（实现参考）

| 状态机 | 主题 | 转换摘要（详见 [SRS-状态机转换明细-v1.0.md](./SRS-状态机转换明细-v1.0.md)） |
|---|---|---|
| SM-REC-001 | 招新活动 | draft→in_progress→paused⇄in_progress→completed/cancelled；force_completed；archived |
| SM-REC-002 | 招新通道 | not_open→open⇄paused→closed；reopen_with_deadline |
| SM-REC-003 | 招新申请 | draft⇄submitted→revision_requested⇄revised→exited→submitted(恢复窗口)；adjustment_overdue；identity_anomaly→recover；not_qualified；accepted |
| SM-REC-004 | 部门路径 | pending→evaluating⇄hold→decided⇄waitlist→published |
| SM-REC-005 | 招新面试 | pending_selection→scheduled⇄leave/late/absent→scheduled(改期)→in_progress→completed；invalidated；cancelled |
| SM-INV-001 | 录取邀请 | pending_acceptance→accepted/rejected/withdrawn/expired；accepted→casdoor_sync→effective/sync_failed；rejected/withdrawn/expired→reissue→pending_acceptance |
| SM-JNT-001 | 联合活动 | draft→confirmed→published→invite_phase→closing_confirm→closed；collect_cancel→cancelled；force_close→force_closed |
| SM-JNT-002 | 联合参与社团 | invited/confirm_pending→accepted→locked；withdraw→removed；force_suspend→force_suspended→re_enable→locked |
| SM-JNT-003 | 联合申请 | draft⇄submitted→archived(活动终局) |
| SM-JNT-004 | 联合面试 | pending_selection→scheduled⇄leave/late/absent→in_progress→completed（author_evaluate 自环）；invalidated→rearrange→scheduled；终局→cancelled_archived/completed_archived |
| SM-JNT-005 | 联合结论 | pending→evaluating⇄modify→invite_pending⇄(邀请终局)→evaluating；accept→accepted_locked（永锁）；终局→archived |
| SM-JNT-006 | 联合通道 | not_open→first_open→open⇄paused；extend；manual_close/deadline_reached→closed；reopen_with_deadline |
| SM-MEM-001 | 成员经历 | non_member→pending_effective→active→exiting→exited；external_removed→exited/sync_anomaly |
| SM-MEM-002 | 职位关系 | active⇄transferring→active/ended；end_change→ended |
| SM-MEM-003 | 部门关系申请 | under_review→approved_pending_exec→executing→effective/exec_failed→retry；reject/withdraw |
| SM-MEM-004 | 入社邀请 | sent→pending_acceptance→accepted_pending_sync→effective；sync_failed→retry；sync_anomaly；reject/withdraw/expire/already_member |
| SM-ORG-003 | 预约管理命令 | pending_exec→executing→executed；initiator_lost_rights→reconfirmed；precondition_failed→reconfirmed；exec_failed→retry→executing；cancel |
| SM-FORM-001 | 表单定义 | draft→published→deprecated→reuse→draft；clone |
| SM-FORM-002 | 表单提交 | draft→checking→submitted（幂等） |
| SM-AUD-001 | 事实纠错 | submitted→approved/rejected/withdrawn；overdue 视同 submitted |

## 附录 B：通知模板 kind 枚举

`application | interview | invitation | conclusion | system | member | transition | correction`（8 类，站内信 inbox / 邮件 email 双通道；推送带 dedupRef 幂等去重，5 分钟窗口去重 + kill-switch 熔断）。

## 附录 C：领域类型速查

- 成员：`non_member|pending_effective|active|exiting|exited|sync_anomaly`（+ removed 直接移除旁路）
- 职位：`active|pending_confirmation|transferring|suspended|ended`
- 面试 attendance：`none|leave|late|absent|present`
- 邀请 casdoorSync：`none|processing|confirmed|failed`
- 导出任务：`generating|completed`（下载地址 24h 内有效，download 后签发 1h 地址）
- 表单：定义态 `draft|published|deprecated|archived`；提交态 `draft|checking|submitted|deleted|revision|locked`
- 文件：`uploading|uploaded|checking|quarantined|approved|rejected|deleted`

> 本文档为后端开发的接口实现清单；若与 [接口契约-v1.0.md](./接口契约-v1.0.md)（传输中立逻辑契约）或需求文档冲突，以后者为准，并回改本文档。
