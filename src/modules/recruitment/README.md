# 领域模块 · 普通招新

> 更新日期：2026-08-12
> 状态机：`SRS-SM-REC-001`（普通招新活动，9 条转换；IFC-SM-008）、`SRS-SM-REC-002`（报名通道，7 条转换；IFC-SM-009）、`SRS-SM-REC-003`（申请与修订，18 条转换；IFC-SM-010）、`SRS-SM-REC-004`（部门路径与结论，15 条转换；IFC-SM-011）、`SRS-SM-REC-005`（面试记录，13 条转换；IFC-SM-012）

## 核心职责

普通招新活动、报名通道、申请与修订、部门选拔路径与结论、社团统一面试记录的完整生命周期（ADR-002 §2.1；SRS-SM-REC-001 至 005）。与联合活动保持独立对象、申请与权限域，不可互相转换（REC-001、JNT-001）。

关键不变量：

- 同一学生同一活动只有一份申请，志愿属于这份申请；并发/重复点击不得生成第二份（REC-004 至 REC-006）。
- 发布后收紧规则必须先暂停报名，并为受影响申请开补救窗口；不自动淘汰既有申请（REC-007、REC-044）。
- 活动暂停与主阶段正交，冻结全部业务与截止并按暂停时长顺延；活动暂停只覆盖通道，不改写其自身状态（REC-003、REC-007）。
- 每轮次同一申请人最多一份有效面试记录；换时/请假/重排不占用轮次次数；作废是唯一例外且不删除原始事实（REC-010 至 REC-012、REC-041）。
- 已接受录取不可经招新流程撤销，后续关系变化统一转成员流程；接受与成员同步处理中的竞态由接受/取消单胜者收口（REC-026 至 REC-030、ORG-027）。
- 活动完成须通道关闭、全部路径终态且结果已发布、邀请全终态、无未完成成员同步；终态长期只读（REC-029、REC-031、REC-032、AUD-004）。

## 关键组件

| 组件 | 类型 | 职责 |
|---|---|---|
| `RecruitmentsController` | Controller（interfaces） | 活动创建/发布/暂停/恢复/完成/取消入口 |
| `ApplicationChannelController` | Controller（interfaces） | 通道开放/暂停/恢复/关闭/重开新窗口 |
| `ApplicationsController` | Controller（interfaces） | 草稿、提交、补充、退出、恢复窗口、身份异常处置 |
| `InterviewsController` | Controller（interfaces） | 选时、改期、出勤、开始、完成、作废、补面 |
| `PublishRecruitmentUseCase` | 应用命令（application/commands） | 发布配置快照冻结与合理性校验 |
| `CompleteRecruitmentUseCase` | 应用命令（application/commands） | 完成前置复核与归档只读锁定 |
| `SubmitApplicationUseCase` | 应用命令（application/commands） | 不可变提交修订＋资格/资料/表单快照原子保存 |
| `CreateRemedyWindowUseCase` | 应用命令（application/commands） | 规则收紧补救窗口、个人恢复窗口、身份异常顺延 |
| `ChooseInterviewSlotUseCase` | 应用命令（application/commands） | 容量＋时间占用＋唯一有效记录原子占用 |
| `RescheduleInterviewUseCase` | 应用命令（application/commands） | 原子释放旧占用并取得新占用，失败保持旧安排 |
| `VoidInterviewUseCase` | 应用命令（application/commands） | 无效面试作废与补面重排 |
| `PublishPathResultUseCase` | 应用命令（application/commands） | 候补转录取（与邀请模块联动）与结果发布 |
| `RecruitmentStateMachine` / `ChannelStateMachine` / `ApplicationStateMachine` / `PathStateMachine` / `InterviewStateMachine` | 状态机（domain/state-machines） | REC-001 至 005 转换门 |
| `ConflictFreeSlotPolicy` | 领域服务（domain/services） | 容量、时间冲突与跨活动重叠的半开区间判定 |
| `EligibilitySnapshotRule` | 领域服务（domain/services） | 提交时资格依据快照与约束（REC-043） |
| `InvitationPort` | 基础设施适配（infrastructure） | 跨模块调用邀请模块创建邀请（同成同败） |
| `TaskWriter` | 基础设施适配（infrastructure） | 向 job 模块登记截止/提醒/过期任务 |

## 对外接口

- HTTP 路由前缀：待传输适配评审；路径以接口契约为准，不得临时编造。活动管理、报名通道、本人申请、面试安排与记录、部门路径结果。
- 外部适配：PostgreSQL（权威状态/版本/历史/审计＋申请唯一与容量/时间占用约束）；job 模块执行截止、提醒与过期任务；invitation 模块创建录取邀请（同一原子边界）；read-model 消费发布事件进入公开目录。
- 关键外部调用：接受录取后的 Casdoor 成员关系写入由邀请与成员流程按 SRS-SM-ORG-002 收口，本模块只消费其回读结果（ORG-027）。

## 核心逻辑摘要

- 活动（REC-001）：`新建（NEW） -> 草稿（DRAFT） -> 进行中（IN_PROGRESS）（±暂停）-> 已完成（COMPLETED）/ 已取消（CANCELLED）`；强制完成由超级管理员发起并固定影响集合；取消时已接受邀请的成员同步转为独立任务继续处理（REC-030、REC-033）。
- 通道（REC-002）：`未开放（NOT_OPEN） -> 开放（OPEN） ↔ 暂停（PAUSED） -> 已关闭（CLOSED）`；活动终态与通道关闭原子联动；已关闭可重开新窗口（新截止严格晚于重开时刻并拒绝旧截止任务）；活动终态导致的关闭不可重开（REC-003、REC-007）。
- 申请（REC-003）：`草稿（DRAFT） -> 已提交（SUBMITTED） ↔ 待补充（PENDING_SUPPLEMENT）`；退出->业务终态（BUSINESS_TERMINATED），截止后由管理员开个人恢复窗口；规则收紧->补救窗口，逾期->`调整逾期待处理（ADJUSTMENT_OVERDUE_PENDING）`（可延长/恢复原规则/明确资格不符）；账号异常->`身份异常（IDENTITY_ANOMALY）`（冻结个人期限），恢复顺延，核实后由负责人或人事发布资格失效等结论（REC-006、REC-009、REC-038、REC-044）。
- 部门路径（REC-004）：`未建立（NOT_ESTABLISHED） -> 考察中（UNDER_REVIEW）（±暂缓 DEFERRED）-> 内部决定（INTERNAL_DECISION）/ 候补（WAITLIST） -> 已发布终态（PUBLISHED_FINAL）`；内部决定不通知申请人，发布才通知；部门 Group 异常只暂停本部门路径；已发布可修改重发布（邀请未接受且活动未结束），归档后仅纠错（REC-016 至 REC-018、REC-024、REC-031、REC-039）。
- 面试（REC-005）：`待选择（PENDING_SELECTION） -> 已安排（SCHEDULED） -> 进行中（IN_PROGRESS） -> 已完成（COMPLETED）`；请假/迟到/缺席正交；作废（VOIDED）保留原记录并可补面；容量/时间占用与改期释放+取得在同一原子边界，最后名额竞争只一个成功（REC-011、REC-012、REC-046）。
- 事务归属：申请/路径/面试/通道为本地领域命令（IFC-TX-001），权益类同事务保存通知事实与收件人快照（IFC-TX-002）；截止与提醒属系统命令并遵循任务租约；候补转邀请与邀请创建/通知事实同一边界。
- 幂等与并发：申请＋草稿双版本控制；最后名额、改期、退出与接受竞争只一个成功；截止任务按窗口/截止版本幂等，活动整体暂停期间截止冻结并顺延。
- 拒绝示例：名额已满、时间冲突（IFC-ERR-010 业务竞争冲突）、重复有效记录（IFC-ERR-007 状态冲突 / IFC-ERR-009 幂等冲突）、旧版本提交（IFC-ERR-008 版本冲突）、已接受邀请后退出（IFC-ERR-007 状态冲突）、通道关闭后普通修改（IFC-ERR-007）、跨社团访问拒绝（IFC-ERR-004 作用域不匹配 / IFC-ERR-015 结果不可见）--一律拒绝并保持原状态。

## 典型调用链

`InterviewsController 选时` -> `ChooseInterviewSlotUseCase`（`ConflictFreeSlotPolicy` 校验容量与跨活动重叠）-> 本地原子提交（容量占用＋时间占用＋通知事实＋审计）-> 提交后渠道投递与面试安排派生刷新；`PublishPathResultUseCase` 将候补转录取时经 `InvitationPort` 与邀请模块创建邀请同事务提交，邀请接受后的 Casdoor 关系收口走邀请/成员流程与 ORG-002。

## 相关文档

- [ADR-002 逻辑模块与状态机唯一责任基线](../../../docs/architecture/ADR-002-逻辑模块与状态机唯一责任基线.md)
- [SRS 状态机转换明细（SRS-SM-REC-001~005）](../../../docs/specification/SRS-状态机转换明细-v1.0.md)
- [接口契约 v1.0](../../../docs/specification/接口契约-v1.0.md)
- [数据模型与约束 v1.0](../../../docs/specification/数据模型与约束-v1.0.md)
- [SRS v1.0（REC 需求事实）](../../../docs/specification/SRS-v1.0.md)
