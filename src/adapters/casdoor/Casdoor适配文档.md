# Casdoor 统一适配 · Casdoor 认证、账号与 Group 适配开发指导

> 更新日期：2026-08-12
> 目录位置：src/adapters/casdoor/
> 权威依据：[ADR-009](../../../docs/architecture/ADR-009-Casdoor统一适配与事件对账机制.md)、[Casdoor集成契约-v1.0](../../../docs/specification/Casdoor集成契约-v1.0.md)、[接口契约-v1.0](../../../docs/specification/接口契约-v1.0.md)（IFC-TX-003）、[部署运维与恢复手册](../../../docs/operations/部署运维与恢复手册-v1.0.md)（OPS-DEP-003、§12.1）

## 核心职责

浏览器登录/回调之外所有 Casdoor 资料读取、账号状态核验、Group 查询与写入、事件接收和周期对账的唯一应用边界（ADR-009 §2.1）。领域模块和后台任务不得直接依赖具体 Casdoor SDK、HTTP 端点或响应结构；本适配只返回规范化外部结果、当前值、版本/时间依据和错误分类，不创造角色、权限或业务结论（ADR-009 §2.4）。

关键不变量：

- 写后收口以可信读回为准：超时、断连或响应不确定必须先定向读回再决定成功收口或幂等重试；HTTP 成功、事件到达或本地期望值不能替代可信回读（ADR-009 §2.3、CAS-WR-006/007）。
- 事件只触发可信刷新或对账，不是账号、字段或 Group 当前值的最终权威快照；周期对账兜底（ADR-009 §2.5/§2.6）。
- 登录、增强认证、高风险操作、恢复与权限敏感路径的实时可信核验不得只依赖事件、周期快照或缓存（ADR-009 §2.8）。
- Casdoor 不可用时只执行 IDN-009 与 SRS-FAIL-001 的 15 分钟最小降级，适配模块不得自行放宽（ADR-009 §2.8、CAS-FAIL-001）。
- 服务账号凭据只保留在服务端；超时、限流、重试、熔断、错误脱敏、追踪与审计关联由本适配统一处理（ADR-009 §2.9）。
- 未验证能力不得写成已存在接口：v3.108.0 未建立逐消息签名、时间戳、nonce 与稳定外部事件 ID 契约，Webhook 默认关闭，只能作为非权威刷新提示（ADR-009 §9、CAS-EVT-001 至 003）。

## 关键组件

| 组件 | 类型 | 职责 |
|---|---|---|
| `CasdoorUserAdapter` | 基础设施适配 | 当前身份解析与账号状态读取（CAS-READ-002/003）、重新认证证据核验（CAS-READ-006） |
| `CasdoorGroupAdapter` | 基础设施适配 | Organization/Group 定义与主体关系读取（CAS-READ-004/005）、Group 写入执行 |
| `CasdoorWriteService` | 基础设施适配 | 写后定向读回、有界重试、补偿与第三值识别（CAS-WR-006 至 012）；未确认前不开放新权限 |
| `CasdoorReconcileRunner` | 后台任务 | 周期全量对账：运行编号、范围、水位、分页扫描与差异候选（CAS-REC-005 至 009） |
| `CasdoorEventReceiver` | 入口组件 | Webhook 接收（默认关闭）：去重、受限触发定向读回；不直接改变业务状态（CAS-EVT-004/005） |
| `ExternalResult` / `ExternalError` | 公共类型 | 可信当前值/旧观测/不存在/不唯一/部分结果/不可用/不确定的分类与安全错误信息（CAS-FAIL-005） |

## 核心接口

CasdoorAdapter 核心接口：
- getUser(userId: string): Promise<ExternalResult<CasdoorUser>>
- updateUser(userId: string, patch: CasdoorUserPatch): Promise<ExternalResult<void>>
- getUserGroups(userId: string): Promise<ExternalResult<CasdoorGroup[]>>
- addGroupMembers(groupId: string, userIds: string[]): Promise<ExternalResult<void>>
- removeGroupMembers(groupId: string, userIds: string[]): Promise<ExternalResult<void>>

## 使用与准入规则

- 领域模块与后台任务只经本适配器调用 Casdoor；禁止直接使用具体 SDK、端点、响应结构，或把适配器错误冒充业务拒绝/成功。
- 发起写入前，调用方必须先在本地下游事务持久化业务意图、原快照、处理中状态、幂等依据与任务（CAS-WR-001）；本地提交失败不得调用 Casdoor。
- 每次外部调用前重新鉴权并复核对象版本、安全开关、删除状态与既有幂等结果；失权、版本变化或已有终局不执行外部副作用（CAS-WR-005）。
- 事件收件使用本地标识并只触发受限、去重、可审计的定向读回；不得借此创建身份、修改 Group、授撤权限或发送权益通知（CAS-EVT-005）。
- 只向调用方返回安全分类、可否重试与追踪编号；秘密、令牌、Cookie、验证码与完整外部响应不得进入日志、错误、任务载荷或审计。

## 核心逻辑摘要

- **三条正确性路径**：写后定向读回（每次写入以目标值/关系读回收口）、高风险实时读回（登录/增强认证/高风险命令/权限敏感请求在时效内实时核验，CAS-REC-002/003）、周期全量对账（兜底发现禁用/删除/资料变化/Group 人工修改，CAS-REC-005）。
- **写后收口**：读回目标值＝成功收口并开放权限；读回原值＝有界重试或按规则失败；第三值＝资料冲突待本人选择、Group 进入高优先级异常/补偿/人工核验，不自动覆盖（CAS-WR-008/009）；复合 Group 部分成功不得授予部分目标权限（CAS-WR-010/013）。
- **事件边界**：事件缺失/重复/乱序/迟到不破坏正确性，周期对账仍能发现全部应同步差异；事件不得提升为权威快照（ADR-009 §2.6、CAS-EVT-006）。
- **对账差异处置**：先成为候选差异，高影响差异定向读回后按字段权威、第三值冲突、Group 状态机、禁用与故障规则交领域模块处置；不直接覆盖本地不可变历史、业务意图或审计（CAS-REC-007 至 009）。
- **故障与降级**：不可确认时按 SRS-FAIL-001 最小白名单与 15 分钟边界降级；Group 写入自动重试最长 15 分钟，超时停止自动重试、通知并保留人工重试入口（CAS-WR-012）；恢复后先回读账号/Group 再重算授权（CAS-FAIL-001）。
- **能力验证门**：兼容基线 v3.108.0，部署前按 CAS-CAP-004 至 014 对学校真实实例验证；无法证明的能力标记"未知"并按风险失败关闭，不得用官方源码、文档或开发实例代替（OPS-DEP-003）。

## 典型调用链

Group 关系写入（后台）：领域事务原子保存业务意图＋原关系快照＋处理中状态＋幂等依据＋任务（第 3 类边界）→ job 领取并复核主体/作用域/版本/安全开关 → `CasdoorGroupAdapter` 写入 → `CasdoorWriteService` 定向读回目标关系 → 按读回值收口为成功/重试/补偿/高优先级异常 → 更新任务并通知相关角色。周期对账：`CasdoorReconcileRunner` 按水位分页扫描 → 与本地意图/观测比较形成候选差异 → 高影响差异定向读回 → 交领域模块处置。
