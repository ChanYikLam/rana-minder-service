# 领域模块 · 邀请与成员激活

> 更新日期：2026-08-12
> 状态机：`SRS-SM-INV-001`（普通/联合邀请，18 条转换；IFC-SM-019）、`SRS-SM-MEM-004`（常规入社邀请，12 条转换；IFC-SM-023）

## 核心职责

普通录取邀请、联合录取/加入邀请与常规入社邀请的创建、接受与成员生效编排（ADR-002 §2.1）。邀请接受是不可逆事实（REC-026、JNT-016）；实际成员状态由 membership 模块拥有，本模块保存接受事实、有效期、冻结区间与同步意图，不直接推进成员经历（MEM-018）。

## 关键组件

| 组件 | 类型 | 职责 |
|---|---|---|
| `InvitationController` | Controller（interfaces） | 邀请创建/接受/拒绝/撤回/重发 HTTP 入口 |
| `RoutineInvitationController` | Controller（interfaces） | 常规入社邀请创建/撤回/重发 HTTP 入口 |
| `AcceptInvitation`、`WithdrawInvitation`、`ReissueInvitation`、`ActivateMemberIntention` | 应用命令·查询用例（application/commands、application/queries） | 状态转换用例；接受时与结论锁定、全活动首邀事件同事务编排 |
| `ResolveSyncTask` | 应用命令·查询用例（application/commands、application/queries） | 同步重试/补偿/高优先级异常处置（先回读后收口） |
| `InvitationStatusQuery`、`InvitationListQuery` | 应用命令·查询用例（application/commands、application/queries） | 当前状态、期限冻结与可操作项 |
| `Invitation`、`RoutineInvitation` | 领域模型·状态机（domain/models、domain/state-machines） | 三类强类型邀请对象、接受事实、剩余时长与不可变历史 |
| `InvitationStateMachine`、`RoutineInvitationStateMachine` | 领域模型·状态机（domain/models、domain/state-machines） | `INV-001`、`MEM-004` 转换、正交标志与拒绝规则 |
| `InvitationRepository`、`CasdoorAdapter`、`JobTaskWriter` | 基础设施适配（infrastructure） | 权威对象持久化；Casdoor 写入/回读适配；成员生效任务写入（事务发件箱） |

## 对外接口

- HTTP 路由前缀：`/invitation/*`；路径以接口契约为准，不得临时编造。邀请与常规入社邀请入口。
- 外部适配：邀请状态为 PostgreSQL 本地权威；Casdoor 适配器负责 Group 写入与可信回读（ADR-009）；job 模块执行成员生效编排与到期截止任务；membership 模块负责生效收口与退出/移除（本模块不推进成员状态）。
- 关键外部调用：接受命令在本地事务内写终态＋通知事实＋成员生效任务；任务执行时经 Casdoor 写入并回读，未回读确认前不开放权限（JNT-016、ORG-027）。

## 核心逻辑摘要

- `INV-001`：新建（NEW）->待处理（PENDING）->已接受（ACCEPTED）/已拒绝（REJECTED）/已撤回（WITHDRAWN）/已过期（EXPIRED）/强制失效（FORCE_INVALIDATED）；已接受不可逆，不得恢复待处理、撤回或删除接受历史（REC-026、JNT-016）；接受与撤回/到期单胜者竞争（IFC-GEN-007）。
- 三种强类型对象不得混批、不得互相改型：普通录取邀请（REC-024、REC-045）、联合录取邀请、联合加入邀请（仅服从联合调剂时，JNT-014、JNT-027）；共享统一状态机但对象、权限与幂等键独立。
- 联合邀请正交标志"面试作废待复核"：作废事务关闭接受入口、保存作废时刻/原截止/严格大于零的剩余时长，冻结期间不推进到期（JNT-010、JNT-015）；期间仍可本人拒绝、发出社团撤回且保留终态历史；保留结论恢复＝恢复时刻＋冻结剩余时长，修改重发＝新完整有效期；冻结区间只结算一次（JNT-005 联动复核）。
- `MEM-004`：待处理（PENDING）->已接受待生效（ACCEPTED_PENDING_ACTIVATION）->（Casdoor 社团及初始部门全部回读确认）->已生效（ACTIVATED）；失败->同步失败待重试（SYNC_FAILED_PENDING_RETRY）->无法补偿转高优先级同步异常；接受时回读已是成员->目标已成为成员（MEM-018）；接受只允许整体接受，不可拆分。
- 事务边界：接受及跨模块联动为本地事务（边界 1/2，`IFC-TX-001/002`）；成员生效编排为 Casdoor 外部写入（边界 3，`IFC-TX-003`）；到期为受信任系统命令（`IFC-CMD-005`），活动/社团暂停冻结期限时不得到期（REC-038、JNT-023）。
- 强制失效：活动取消、普通强制完成或联合强制结束使全部待处理邀请原子失效，已接受邀请不受影响（REC-030、REC-033、JNT-019、JNT-024）。
- 拒绝示例：部门负责人/面试官发邀请（IFC-ERR-003 当前无权；REC-045 复核前置、MEM-018）、目标已是成员（IFC-ERR-006 业务前置条件失败）、同社团同对象重复待处理邀请（IFC-ERR-009 幂等冲突）、已拒绝/过期/撤回后不得复活旧邀请（IFC-ERR-007 状态冲突）、已接受后强制失效（IFC-ERR-007 状态冲突）。

## 典型调用链

`InvitationController 接受联合邀请` -> `AcceptInvitation` 用例（本人、待处理且无待复核标志、资料/邮箱门、部门 Group 可用）-> `InvitationStateMachine` 校验 -> 同一数据库事务原子提交：邀请已接受（不可逆）＋结论锁定（跨模块编排）＋通知事实＋成员生效任务 -> job 领取任务执行 Casdoor 写入->可信回读->membership 收口成员经历生效；回读未确认前不开放权限，失败按重试/补偿/高优先级异常规则收口。
