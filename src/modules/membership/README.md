# 领域模块 · 成员生命周期

> 更新日期：2026-08-12
> 状态机：`SRS-SM-MEM-001`（成员经历，9 条转换）、`SRS-SM-MEM-002`（部门/职位关系，8 条）、`SRS-SM-MEM-003`（部门关系申请，8 条）

## 核心职责

成员经历、部门/职位关系、部门关系申请、任期、换届、退出与移除（ADR-002 §2.1）。当前社团/部门/职位关系以 Casdoor Group 回读为权威，本地保存业务意图、处理中状态与不可变历史（系统架构总览 §6）；外部 Casdoor 直接变更以回读收口、追加外部变更历史且不自动改回（MEM-016）。

## 关键组件

| 组件 | 类型 | 职责 |
|---|---|---|
| `MembershipController` | Controller | 成员经历、退出/移除 HTTP 入口 |
| `DepartmentRelationController` | Controller | 部门/职位关系变更、结束、同步异常修复入口 |
| `DepartmentApplicationController` | Controller | 部门关系申请提交/撤回/审批入口 |
| `ApproveDeparture`、`RemoveMember`、`ChangeDepartmentRelation`、`ApproveDepartmentApplication` | 应用命令（application/commands） | 状态转换用例；加入部门＋任职/跨部门调动为单一业务命令（MEM-009） |
| `MemberPeriodQuery`、`DepartmentRelationQuery` | 应用查询（application/queries） | 经历时间线、当前关系与可操作项 |
| `MembershipPeriod`、`DepartmentRelation`、`DepartmentApplication` | 领域模型（domain/models） | 经历段、关系段、申请与不可变历史 |
| `membership-period.machine`、`department-relation.machine`、`department-application.machine` | 领域状态机（domain/state-machines） | 三个状态机转换、连续性/自审等前置规则 |
| `membership-repository`、`casdoor-group-adapter`、`job-writer` | 基础设施适配（infrastructure） | 权威对象持久化；Group 写入/回读/外部变更对账；关系任务与换届批次 |

## 对外接口

- HTTP 路由命名空间（具体 URL 未冻结，由[接口实现规格 v1.0 §6](../../../docs/specification/接口实现规格-v1.0.md) 落地后冻结；以[接口清单-HTTP端点-v1.0](../../../docs/specification/接口清单-HTTP端点-v1.0.md) 为传输层事实基线）：成员经历查询、退出/移除、部门/职位关系变更、部门关系申请提交/撤回/审批、换届受控批量。
- 外部适配：PostgreSQL 本地权威（意图、快照、历史）；Casdoor Group 适配器（写入、可信回读、外部变更检测，ADR-009）；job 模块（关系写入/补偿、换届受控批量）；organization 模块（负责人连续性判定、Group 映射）。
- 关键外部调用：每次变更先持久化处理中意图与任务，job 执行写入→回读→成功/补偿/异常收口；回读确认前新权限不生效（ORG-027）。

## 核心逻辑摘要

- `MEM-001`：接受/任命→成员生效处理中→Casdoor 社团及组合部门全部回读确认→当前成员；退出/移除→退出处理中→级联移除全部部门/职位并回读→历史成员；历史成员重入必须新建经历段（MEM-013）；计划结束时间不自动卸任（MEM-012）；外部直接移除社团 Group 以回读收口，残留子级关系转同步异常且不自动删除（MEM-016）。
- `MEM-002`：变更处理中→回读确认→当前有效；部分写入先补偿到原关系，补偿失败转同步异常并最小权限（MEM-009、ORG-027）；复合调岗失败不得只完成一半（MEM-009）；外部增删关系以 Casdoor 当前值为准、不自动改回，非法状态转同步异常（MEM-016）。
- `MEM-003`：待审批→已批准待执行→执行处理中→（关系写入回读成功）→已生效；自审排除，部门无负责人时回退负责人/人事审批（MEM-017、ORG-036）；执行失败保持原关系，人工重试沿用原批准与业务幂等键，不重复审批。
- 全局约束：最后负责人连续性——退出/移除/换届后社团必须至少一名负责人，无交接即拒绝（MEM-002、MEM-008、ORG-024）；任何人不得通过移除入口处理自己；退出审批排除自审。
- 事务边界：申请/审批/撤回为本地事务（边界 1，`IFC-TX-001`）；关系写入与退出执行为 Casdoor 外部写入（边界 3，`IFC-TX-003`）；年度换届为受控批量（边界 6，`IFC-TX-006`）：先新增并逐项回读确认全部新任，再移除旧任；新任失败整体撤回保持旧任，旧任移除部分失败进入部分异常、不撤销新任（MEM-011）。
- 幂等与收口：级联步骤逐项幂等、同一经历段/关系段只结束一次；失败重试必须先回读再执行；人工重试重新鉴权且不重复审批决定（MEM-002、ORG-027）。
- 拒绝示例：非成员跨范围变更、最后负责人无交接、审批人审批自己、计划时间到达自动卸任、按历史一键重放全部关系。

## 典型调用链

`DepartmentRelationController 发起复合调岗` → `ChangeDepartmentRelation` 用例（当前成员资格、层级权限、加入＋退出组合明确确认）→ `department-relation.machine` 校验 → 同一数据库事务原子：变更处理中＋原关系快照＋Casdoor Group 写入任务 → job 执行写入→可信回读→当前有效；部分写入→补偿回原关系→仍失败转同步异常并保持最小权限。