# 平台支撑 · Casdoor 统一适配

> 模块定位：平台级统一能力（ADR-009 §2.1）
> 职责：浏览器登录/回调之外所有 Casdoor 资料读取、账号状态核验、Group 查询/写入、事件接收和周期对账的唯一应用边界
> 上游权威：[ADR-009](../../../docs/architecture/ADR-009-Casdoor统一适配与事件对账机制.md)、[Casdoor 集成契约 v1.0](../../../docs/specification/Casdoor集成契约-v1.0.md)

## 1. 定位与责任

本模块向领域模块和后台任务提供传输中立的 Casdoor 适配端口，返回规范化结果
（可信当前值/旧观测/不存在/不唯一/部分结果/依赖不可用/响应不确定），不创造
角色、权限或业务结论（CAS-READ、CAS-GEN）。

关键不变量：

- 写后收口以可信读回为准；HTTP 成功、事件到达或本地期望值不能替代（CAS-WR-006/007）。
- Webhook 默认关闭；启用也只作为非权威刷新提示（CAS-EVT-001~007）。
- 15 分钟故障降级与禁用/删除立即生效由上层领域模块结合本模块结果执行（CAS-FAIL-001/002）。
- 未验证能力不得写成已存在接口（CAS-CAP-004~014）。

## 2. 关键组件

| 组件                                   | 类型                  | 职责                                           |
| -------------------------------------- | --------------------- | ---------------------------------------------- |
| `CasdoorReadPort` / `CasdoorWritePort` | application/contracts | 传输中立读写端口                               |
| `CasdoorReadService`                   | application           | 身份绑定、账号状态、Group 定义/关系读取        |
| `CasdoorWriteService`                  | application           | 写后定向读回、15 分钟有界重试、复合命令补偿    |
| `CasdoorReconcileService`              | application           | 周期全量对账分页扫描与完成度分类               |
| `CasdoorEventService`                  | application           | Webhook 默认关闭、静态秘密/限流/去重、刷新提示 |
| `InMemoryCasdoorStore`                 | infrastructure        | 开发/测试内存桩                                |
| `InMemoryMappingStore`                 | infrastructure        | 稳定映射内存桩                                 |

## 3. 权威与边界

| 本模块可以                             | 本模块禁止                          |
| -------------------------------------- | ----------------------------------- |
| 读取/写入 Casdoor 并返回规范化外部结果 | 自行创造角色、权限或业务结论        |
| 登记稳定映射与最近可信观测             | 把展示名称/Group 名称当全局唯一     |
| 执行写后定向读回、补偿与对账扫描       | 以 HTTP 成功/事件到达代替可信读回   |
| 在启用 Webhook 时触发受限刷新提示      | 默认开启 Webhook 或直接改变业务状态 |

## 4. 运行形态

- HTTP 入口不提供浏览器登录/回调（该职责由身份模块承接）。
- 周期对账与 Group 写入由后台任务模块调度，本模块只提供执行能力。
- 当前开发态为内存桩；真实实例接入前必须完成 CAS-CAP-004~014 能力验证。

## 5. 相关文档

- [ADR-009](../../../docs/architecture/ADR-009-Casdoor统一适配与事件对账机制.md)
- [Casdoor 集成契约 v1.0](../../../docs/specification/Casdoor集成契约-v1.0.md)
- [Casdoor 适配文档](../../adapters/casdoor/Casdoor适配文档.md)
