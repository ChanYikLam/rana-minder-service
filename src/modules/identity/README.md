# 领域模块 · 身份与资料

> 更新日期：2026-08-12
> 状态机：`SRS-SM-IDN-001`（账号访问，6 条转换；IFC-SM-001）、`SRS-SM-IDN-002`（资料写入门，8 条转换；IFC-SM-002）、`SRS-SM-IDN-003`（资料同步，12 条转换；IFC-SM-003）

## 核心职责

身份绑定与账号访问状态、资料门与邮箱验证、白名单资料与 Casdoor 双向同步及第三值冲突处理（ADR-002 §2.1）。Casdoor 为账号状态与资料字段的当前权威；本地只保存稳定映射、资料版本、同步意图、冲突快照与审计证据（IDN-001 至 IDN-020）。

关键不变量：

- 账号禁用/删除事件立即终止会话与新权限，但完整保留本地历史（IDN-008、GOV-009）。
- Casdoor 暂不可确认仅允许 15 分钟最小白名单：公开页面、本人基础资料只读、编辑故障前既有草稿的非附件字段；禁止新建草稿、改个人资料、正式提交、调用 Casdoor 或推进任何业务状态（IDN-009、NFR-003）。
- 资料修改本地立即生效，白名单字段进入同步；同步失败不丢弃修改（IDN-006、IDN-014 至 IDN-016）。
- 邮箱验证 24 小时有效期、重发频率受限；新邮箱验证成功前旧邮箱保持有效（IDN-011、NTF-005）。
- 新必填字段按生效日收紧资料门；范围性缺失只降级为分范围受限，不构成平台级不可写（IDN-019、FORM-011）。

## 关键组件

| 组件 | 类型 | 职责 |
|---|---|---|
| `ProfilesController` | Controller（interfaces） | 本人资料读写、资料门状态与受限范围查询 |
| `AccountAccessController` | Controller（interfaces） | 账号访问/降级窗口状态查询与白名单能力判定 |
| `SaveProfileUseCase` | 应用命令·查询用例（application/commands、application/queries） | 保存资料新版本、重算全部资料门、生成同步意图 |
| `EmailVerificationUseCase` | 应用命令·查询用例（application/commands、application/queries） | 发送/重发验证邮件，消费验证链接（单次令牌、24 小时） |
| `HandleAccountStatusEventUseCase` | 应用命令·查询用例（application/commands、application/queries） | 接收禁用/删除/暂不可确认事件与对账结果，推进 IDN-001 |
| `ApplyProfileSyncStepUseCase` | 应用命令·查询用例（application/commands、application/queries） | 被 job 同步任务逐次调用：执行写入、回读收口、回退或转冲突 |
| `AccountAccessStateMachine` | 领域模型·状态机（domain/models、domain/state-machines） | IDN-001 转换门（有效/禁用/删除/暂不可确认） |
| `ProfileWriteGateStateMachine` | 领域模型·状态机（domain/models、domain/state-machines） | IDN-002 复合派生门（待补充/待邮箱验证/可写/分范围受限），含资料门重算规则 |
| `ProfileSyncStateMachine` | 领域模型·状态机（domain/models、domain/state-machines） | IDN-003 同步链路（待同步/重试中/待读回核验/冲突待本人选择/已回退） |
| `CasdoorUserAdapter` | 基础设施适配（infrastructure） | 账号状态读取（CAS-READ-003）、资料写回与定向读回（CAS-WR-*、CAS-REC-001） |
| `ProfileSyncTaskWriter` | 基础设施适配（infrastructure） | 向 job 模块登记同步/读回/对账任务 |

## 对外接口

- HTTP 路由前缀：待传输适配评审；路径以接口契约为准，不得临时编造。资料读写、邮箱验证、账号访问状态、降级窗口处置。
- 外部适配：Casdoor 适配器（写后定向读回是唯一成功收口，CAS-WR-006/007）；PostgreSQL 保存本地权威状态、版本、历史与任务意图；job 模块执行同步/读回/对账任务；邮件适配只登记验证邮件渠道意图。
- 关键外部调用：Casdoor 资料写入 API → 写后定向读回；周期全量对账（CAS-REC-005 至 009）；外界事件（即使启用 Webhook）只能作为受限刷新提示（CAS-EVT-*）。

## 核心逻辑摘要

- 账号访问（IDN-001）：`有效（ACTIVE） → 禁用（DISABLED）/ 删除（DELETED）/ Casdoor 暂不可确认（UNVERIFIABLE）`；降级起点与 15 分钟窗口由服务端按故障起点判定，客户端不可延长；恢复以回读版本收口，恢复与禁用竞争以 Casdoor 当前值为准（IDN-008、IDN-009）。
- 资料写入门（IDN-002）：`待补充（PENDING_COMPLETION）/ 待邮箱验证（PENDING_EMAIL_VERIFICATION） → 可写（WRITABLE）/ 分范围受限（PARTIALLY_RESTRICTED）`，复合派生，不建独立审批状态；补齐最后一项必填即重算；分范围限制作用域键唯一、多限制并集生效、单独解除（IDN-019）。
- 资料同步（IDN-003）：`已同步（SYNCED） → 待同步（PENDING_SYNC） → 重试中（RETRYING） → 连续 24 小时失败 → 待读回核验（PENDING_READBACK_VERIFICATION）`；核验读回＝目标值则成功收口、＝修改前值则回退（`已回退（ROLLED_BACK）`，保留失败新值与全部尝试）、第三值→`同步冲突待本人选择（CONFLICT_PENDING_USER_CHOICE）`；姓名/学号等只读权威字段例外，直接收敛为 Casdoor 值。回退前必须先可信读回，防止把已成功写入制造成不一致（IDN-007、IDN-020）。
- 事务归属：账号事件与资料写入门为本地业务状态转换（IFC-TX-001）；同步链路为 Casdoor 外部写入（IFC-TX-003）；验证邮件为渠道投递（IFC-TX-005）。
- 幂等与并发：命令声明资料版本，旧版本拒绝（IFC-ERR-008 版本冲突）；同一用户＋字段＋目标版本只创建一个冲突快照与一个读回任务；重复成功回调返回原结果，迟到回调不得覆盖更新版本。
- 拒绝示例：降级窗口内新登录、超 15 分钟、非本人草稿、含附件操作一律拒绝且无副作用（IFC-ERR-006 业务前置条件失败 / IFC-ERR-011 安全限制）；非本人资料操作拒绝（IFC-ERR-003 当前无权 / IFC-ERR-004 作用域不匹配）；读回不明时不得宣称恢复、回退或进入冲突选择（IFC-ERR-013 外部结果不确定）；Casdoor 不可用时降级而非伪成功（IFC-ERR-012 依赖不可用）。

## 典型调用链

`ProfilesController 保存资料` → `SaveProfileUseCase` 校验字段/版本并重算资料门 → 本地原子提交（资料新版本＋同步意图＋必要审计与通知事实）→ 登记同步任务到 job → 后台 `ApplyProfileSyncStepUseCase` → Casdoor 写入 → 定向读回 → 按读回值收口为已同步 / 已回退 / 同步冲突待本人选择（本人提交新选择后重新进入待同步）。
