# 领域模块 · 联合活动

> 更新日期：2026-08-12
> 状态机：`SRS-SM-JNT-001`（联合活动，12 条转换；IFC-SM-013）、`SRS-SM-JNT-002`（参与社团关系，9 条；IFC-SM-014）、`SRS-SM-JNT-003`（联合申请，7 条；IFC-SM-015）、`SRS-SM-JNT-004`（联合单次面试记录，15 条；IFC-SM-016）、`SRS-SM-JNT-005`（参与社团结论，16 条；IFC-SM-017）、`SRS-SM-JNT-006`（联合报名通道，9 条；IFC-SM-018）

## 核心职责

两个及以上平等社团的临时跨社团协作域：参与确认、锁定名单、联合申请、共享单次面试、参与社团独立结论与联合报名通道（ADR-002 §2.1；JNT-001、JNT-002）。无牵头社团，成立前不开放跨社团资料；跨社团能力只来自联合协作域授权（JNT-003、JNT-030），参与名单首次公布后永久锁定，通道变化与紧急停用不得绕过（JNT-004、JNT-005、JNT-007、JNT-023）。

## 关键组件

| 组件 | 类型 | 职责 |
|---|---|---|
| `JointActivityController` | Controller（interfaces） | 活动发起/确认/公布/取消/结束、参与社团与报名通道 HTTP 入口，建立协作域授权上下文 |
| `JointInterviewController` | Controller（interfaces） | 共享排期、出勤、评价、作废与补面 HTTP 入口 |
| `JointApplicationController` | Controller（interfaces） | 联合申请草稿/提交（共享同意证据、服从调剂）HTTP 入口 |
| `PublishJointActivity`、`VoidJointInterview`、`ConfirmConclusionReview`、`ForceEndJointActivity` | 应用命令（application/commands） | 状态机转换用例；跨对象/跨模块原子副作用在用例层编排 |
| `JointActivityDetailQuery`、`JointInterviewScheduleQuery` | 查询用例（application/queries） | 详情与当前可操作项、共享排期聚合 |
| `JointActivity`、`JointApplication`、`JointInterviewRecord`、`ClubConclusion`、`JointChannel` | 领域模型（domain/models） | 强类型对象、版本、正交标志（面试作废待复核）、期限/窗口 |
| `JointActivityStateMachine` 等 6 个 | 状态机（domain/state-machines） | 六个状态机的转换、前置条件与拒绝规则 |
| `JointRepository`、`CollaborationScopeAdapter` | 基础设施适配（infrastructure） | 权威对象持久化访问；联合协作域授权判定适配 |

## 对外接口

- HTTP 路由前缀：`/joint/*`；路径以接口契约为准，不得临时编造。活动、参与、申请、面试、结论、通道六组入口。
- 外部适配：核心状态均为 PostgreSQL 本地权威；权限判定依赖 organization 模块（协作域授权、当前角色，跨边界校验见系统架构总览 §4.2）；创建前置含联合安全开关（GOV-004）。
- 关键外部调用：不直接写 Casdoor（成员生效经 invitation/membership 模块）；截止/提醒/结束确认由 job 模块按版本幂等执行；通知事实与目录刷新经 notification/read-model；强制结束、特权查看属高风险命令，需 GOV-007 重新认证。

## 核心逻辑摘要

- `JNT-001`：草拟/待确认（DRAFT_PENDING_CONFIRMATION）-> 全体确认->已成立（ESTABLISHED）-> 首次公布->已公布（PUBLISHED）（名单永久锁定；公布与首次开放报名分别留痕，JNT-029）-> 全活动首份邀请->邀请阶段（INVITATION_PHASE）（此后禁止取消，JNT-018、JNT-024）-> 全部邀请终态->待结束确认（PENDING_COMPLETION_CONFIRMATION）-> 收齐确认->已结束（ENDED）；首邀前可全体一致取消，任一非终态可由超管强制结束（JNT-019）。
- `JNT-002`：锁定随首次公布同事务固化；停用/恢复按区间版本独立结算，恢复按停用时长顺延期限（JNT-023）；锁定后新增、替换、主动退出一律拒绝（JNT-005、JNT-009）。状态含拟参与（INTENDING）、已确认（CONFIRMED）、确认失效待重确认（CONFIRMATION_EXPIRED_PENDING_RECONFIRM）、首次公布后锁定（LOCKED_AFTER_PUBLICATION）。
- `JNT-003`：提交必须携带共享同意证据与锁定名单快照，缺同意不得开放协作域（JNT-006、JNT-007、GOV-005）；单社团停用只暂停访问，不改变同意与锁定名单。状态含草稿（DRAFT）、已提交（SUBMITTED）。
- `JNT-004`：全社团共享一份记录，作废/补面不创建第二份对象（JNT-010）；选时/改期以容量＋版本同一提交边界防超卖（JNT-011、REC-046）；作废为跨对象原子提交：面试＋全部未锁定结论＋未接受邀请及期限版本同一事务，冻结剩余时长，接受/到期与作废单胜者竞争（JNT-015）。状态含待选择（PENDING_SELECTION）、已安排（SCHEDULED）、进行中（IN_PROGRESS）、已完成（COMPLETED）、已作废（VOIDED）。
- `JNT-005`：每社团独立版本，接受后锁定不可普通改判（JNT-013、JNT-016）；补面后仅本社团可复核：保留续跑冻结剩余时长，修改则关闭旧邀请重新发出（JNT-010、JNT-015）。状态含未形成（NOT_FORMED）、可编辑（EDITABLE）、邀请待处理（INVITATION_PENDING）、已接受锁定（ACCEPTED_LOCKED）、已归档锁定（ARCHIVED_LOCKED）。
- `JNT-006`：暂停废止旧截止，恢复/重开必须同命令携带合法新截止、不继承剩余时长；旧截止任务按截止版本幂等忽略；邀请阶段与首邀不阻止重开（JNT-004）。状态含未开放（NOT_OPEN）、开放（OPEN）、暂停（PAUSED）、已关闭（CLOSED）。
- 事务边界：成立/公布/确认/结束为本地领域命令（边界 1，`IFC-TX-001`）；权益变化经通知事实（边界 2，`IFC-TX-002`）；跨状态机联动按转换明细的原子副作用执行，不因模块分开降为最终一致。
- 拒绝示例：未全体确认不成立不公布（IFC-ERR-006 业务前置条件失败）；非参与社团追溯资料或发加入邀请被拒（IFC-ERR-003 当前无权 / IFC-ERR-004 作用域不匹配）；主观评分争议不作废、缺原因不作废（IFC-ERR-006 业务前置条件失败 / IFC-ERR-005 输入无效）；失权后不得继续操作（IFC-ERR-003 当前无权）。

## 典型调用链

`JointActivityController 首次公布` -> `PublishJointActivity` 用例（全体确认、名单、报名时间、共享说明完整校验）-> `JointActivityStateMachine` 已成立->已公布 ＋ `JNT-002` 全体关系锁定（同一数据库事务原子提交）-> 通知事实写入 notification、目录投影刷新经 read-model -> 提交后 job 执行确认轮次截止与提醒任务，任务按活动版本幂等。
