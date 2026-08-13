# 领域模块 · 组织与授权

> 更新日期：2026-08-12
> 状态机：`SRS-SM-ORG-001`（社团接入，10 条转换；IFC-SM-004）、`SRS-SM-ORG-002`（Group 关系命令，8 条转换；IFC-SM-005）、`SRS-SM-ORG-003`（预约管理命令，13 条转换；IFC-SM-006）

## 核心职责

社团空间接入与启停、Group 稳定映射、职位权限模板与当前权限计算、Group 关系写入与预约管理命令（ADR-002 §2.1；SRS-SM-ORG-001 至 003）。Casdoor Group 是当前社团/部门/职位关系权威；本地只保存稳定映射、业务意图、处理中状态、回读与不可变历史（ORG-001、ORG-003、ORG-027）。

关键不变量：

- 不自动识别 Group；候选必须人工接入并二次确认；一个 Group 同一时刻只绑定一个社团空间，且只能配置为社团/部门/职位之一（ORG-004、ORG-005、ORG-011 至 ORG-019）。
- 启用中的社团至少保留一名负责人；撤销最后一人必须在同一操作中指定继任者，严禁零负责人窗口（ORG-024）。
- 关系变更在回读确认前不开放新权限；自动重试最长 15 分钟，之后失败保持原状态并保留人工重试（ORG-027、GOV-009）。
- 强制停用立即只读并暂停该社团全部自动截止/超时；重新启用按累计受阻时长一次性顺延冻结期限（ORG-028、ORG-010）。
- 权限只来自"职位 Group -> 已发布权限模板"受控映射加业务临时授权；Group 名称、客户端角色与历史职位不得授权（GOV-007）。
- 复合关系按领域目标图执行并补偿；部分成功不授予部分目标隐含的新权限（ORG-027、ORG-034、MEM-007/009）。

## 关键组件

| 组件 | 类型 | 职责 |
|---|---|---|
| `ClubsController` | Controller（interfaces） | 接入向导、启停、修复/重绑、重新启用、解除接入入口 |
| `RelationCommandsController` | Controller（interfaces） | 关系命令发起、进度查询、人工重试入口 |
| `AppointmentCommandsController` | Controller（interfaces） | 预约命令、暂停处置、重新确认、取消入口 |
| `CompleteOnboardingUseCase` | 应用命令（application/commands） | 向导校验与启用（映射合法、负责人连续性、二次确认） |
| `SuspendClubUseCase` / `ForceSuspendClubUseCase` | 应用命令（application/commands） | 普通/强制停用（后者记录暂停起点、暂停自动截止） |
| `RebindGroupUseCase` | 应用命令（application/commands） | 同步异常修复、重新绑定、待重新接入（目标均只到已停用） |
| `SubmitRelationCommandUseCase` | 应用命令（application/commands） | ORG-002 受理：保存意图、原关系快照与执行任务 |
| `HandleRelationReadbackUseCase` | 应用命令（application/commands） | 回读收口成功/失败/补偿，按命令版本裁决 |
| `ScheduleAppointmentUseCase` | 应用命令（application/commands） | 到达执行点复核前置条件并竞争执行租约 |
| `ConfirmAppointmentUseCase` | 应用命令（application/commands） | 发起人失权后由当前有权者重新确认或改期 |
| `ClubOnboardingStateMachine` / `RelationCommandStateMachine` / `AppointmentCommandStateMachine` | 状态机（domain/state-machines） | ORG-001/002/003 转换门 |
| `PermissionCalculator` | 领域服务（domain/services） | 从当前 Group 观测＋模板版本＋业务任务计算当前权限（同社团并集、范围受限） |
| `LastOwnerContinuityPolicy` | 领域服务（domain/services） | 最后负责人连续性与交接锚点规则（ORG-024） |
| `GroupAdapter` | 基础设施适配（infrastructure） | Casdoor Group 读写、写后定向读回与对账 |
| `RlsContextSetter` | 基础设施适配（infrastructure） | 命令事务前设置单目标 RLS 会话上下文（ADR-005） |
| `TaskWriter` | 基础设施适配（infrastructure） | 向 job 模块登记关系执行/调度/对账任务 |

## 对外接口

- HTTP 路由前缀：待传输适配评审；路径以接口契约为准，不得临时编造。社团空间管理、关系命令、预约命令、当前权限查询。
- 外部适配：Casdoor Group（写后定向读回收口，CAS-WR-*）；PostgreSQL（本地意图/原关系快照/任务/审计＋选择性 RLS 单目标上下文，ADR-005、ADR-014）；job 模块执行关系写入、调度截止与对账。
- 关键外部调用：Group 成员增删 -> 逐目标写后回读；复合命令按登记的目标关系图分步执行；周期全量对账检测 Group 删除/移动/失权。

## 核心逻辑摘要

- 社团接入（ORG-001）：`向导未完成（ONBOARDING_INCOMPLETE） -> 已启用（ENABLED）`；`已启用（ENABLED）或已停用（SUSPENDED） --对账确认异常-> 同步异常只读（SYNC_ANOMALY_READONLY）`（保留历史与原映射、冻结期限）；修复/重绑/重新接入只到`已停用（SUSPENDED）`；重新启用为独立命令，按最早未结算受阻起点一次性顺延并保存对账结果（ORG-006、ORG-010、ORG-013、ORG-028）。
- 关系命令（ORG-002）：`待执行（PENDING_EXECUTION） -> 处理中（PROCESSING） -> 回读确认成功（READBACK_CONFIRMED）`；15 分钟内有界重试且每次先回读；超时未确认->`失败保持原状态（FAILED_ORIGINAL_PRESERVED）`->人工重试前重新鉴权并重读实际关系（`待人工重试 PENDING_MANUAL_RETRY`）；复合部分成功必须按领域规则逆序补偿，补偿未确认前不授新权限（ORG-027、ORG-034）。
- 预约管理（ORG-003）：`新建 -> 待执行（PENDING_EXECUTION） -> 执行中（EXECUTING） -> 已生效（EFFECTIVE）`；调度执行与取消/重新确认以同一命令版本＋执行租约竞争；发起人失权->`发起人失权暂停待重新确认（INITIATOR_REVOKED_PENDING_RECONFIRM）`；业务前置条件失效->`业务前置条件失效暂停待处置（PRECONDITION_INVALID_PENDING_RESOLUTION）`（可取消或条件恢复后按原内容重确认新时间）；新调度版本提交后旧调度永久失效（ORG-039、MEM-004、MEM-010）。
- 事务归属：接入/启停/重启用与权限模板发布为本地业务状态转换（IFC-TX-001）；关系写入为 Casdoor 外部写入（IFC-TX-003）；预约到期与截止为系统命令（IFC-CMD-005）；涉及权益的转换同时保存通知事实（IFC-TX-002）。
- 幂等与并发：命令声明对象版本与作用域，同一目标处理中冲突命令拒绝（IFC-ERR-007 状态冲突）；每个外部步骤独立幂等并关联同一业务命令；回调、人工重试与恢复重放共享同一收口规则。
- 拒绝示例：零负责人（IFC-ERR-006 业务前置条件失败）、重复绑定（IFC-ERR-007 状态冲突）、普通停用存在进行中业务（IFC-ERR-006）、回读无法证明原关系保持（IFC-ERR-013 外部结果不确定）、失败后仍断言成功（IFC-ERR-016 内部提交失败）、跨社团访问拒绝（IFC-ERR-004 作用域不匹配 / IFC-ERR-015 结果不可见）--一律拒绝并保持原状态。

## 典型调用链

`RelationCommandsController 任命` -> `SubmitRelationCommandUseCase`（权限模板->成员前提->最后负责人连续性->高风险确认）-> 原子提交（意图＋原关系快照＋审计＋执行任务）-> job 关系任务 -> Casdoor 分步写入 -> 定向读回 -> `HandleRelationReadbackUseCase` 收口成功并按新关系重算权限；失败按 15 分钟窗口重试，超时转人工重试。
