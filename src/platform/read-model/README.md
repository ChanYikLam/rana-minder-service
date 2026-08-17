# 平台支撑 · 派生入口与读模型

> 模块定位：平台支撑模块之一（ADR-002 §2.2）
> 职责：公开目录、全局个人中心、当前社团管理工作台的可重建投影
> 上游权威：[系统架构总览 v1.0](../../../docs/architecture/系统架构总览-v1.0.md)、[ADR-002](../../../docs/architecture/ADR-002-逻辑模块与状态机唯一责任基线.md)、[ADR-007](../../../docs/architecture/ADR-007-首版搜索与可重建缓存边界.md)、[接口契约 v1.0](../../../docs/specification/接口契约-v1.0.md)

## 事务边界对照（IFC-TX-001~008）

对照[接口契约 v1.0](../../../docs/specification/接口契约-v1.0.md)事务边界定义，标注本模块参与情况（✓=参与，--=不参与）。

| 边界         | 名称               | 本模块参与                               |
| ------------ | ------------------ | ---------------------------------------- |
| `IFC-TX-001` | 本地业务状态转换   | --                                       |
| `IFC-TX-002` | 直接权益与通知     | --                                       |
| `IFC-TX-003` | Casdoor 外部写入   | --                                       |
| `IFC-TX-004` | 文件上传/检查/绑定 | --                                       |
| `IFC-TX-005` | 通知渠道投递       | --                                       |
| `IFC-TX-006` | 受控批量           | --                                       |
| `IFC-TX-007` | 正式删除           | --                                       |
| `IFC-TX-008` | 派生刷新与重建     | ✓ 派生刷新/重建（经 job 持久化任务执行） |

注：派生刷新/重建经 job 模块持久化任务执行，本模块自身无 worker 侧组件、不得自行异步写库。

## 1. 定位与责任

本模块为前端提供三类只读入口，全部由各领域权威对象**派生**得到：

- **公开目录**：未认证可读的"找社团"与"找活动"搜索入口（`REC-047` 语义）；
- **全局个人中心**：聚合本人事项和当前仍有权的角色型事项（`IFC-QRY-003`）；
- **当前社团管理工作台**：固定当前社团的管理数据入口（`IFC-QRY-003`）。

本模块**不拥有任何业务状态**，不保存可独立修改的"目录状态"，不授予访问权。

## 2. 关键组件

| 组件                          | 类型                            | 职责                                                                  |
| ----------------------------- | ------------------------------- | --------------------------------------------------------------------- |
| `PublicDirectoryController`   | Controller（interfaces）        | 未认证可读的"找社团""找活动"搜索入口                                  |
| `PersonalCenterController`    | Controller（interfaces）        | 全局个人中心查询入口（本人事项+当前有权角色型事项）                   |
| `WorkbenchController`         | Controller（interfaces）        | 当前社团管理工作台查询入口（固定当前社团）                            |
| `PublicDirectoryQueryService` | 查询用例（application/queries） | 公开目录派生查询：搜索规范化、可见性派生、字段投影                    |
| `PersonalCenterQueryService`  | 查询用例（application/queries） | 个人中心聚合：本人事项+角色型事项，失权后失效                         |
| `WorkbenchQueryService`       | 查询用例（application/queries） | 工作台聚合：固定当前社团管理数据，逐对象重验授权                      |
| `SearchNormalizer`            | 领域服务（domain/services）     | 搜索文本规范化（NFC->大小写折叠->再 NFC->去空白->压缩）、分层排序规则 |
| `VisibilityDerivationRules`   | 领域服务（domain/services）     | 可见性派生规则：发布状态、访问者类型、字段投影（纯函数）              |
| `CacheKeyBuilder`             | 领域服务（domain/services）     | 缓存键构造：必须包含社团/协作域/访问者范围维度                        |
| `PostgresReadRepository`      | 基础设施适配（infrastructure）  | PostgreSQL 查询与索引、pg_trgm 检索实现                               |
| `RebuildableCacheAdapter`     | 基础设施适配（infrastructure）  | 可重建缓存载体：丢失/过期/清空时可回源，可替换                        |

### 当前实现组件（与代码一致）

| 组件                                               | 位置                                   | 职责                                                                                                |
| -------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ReadModelQueryService`                            | query/query-service.ts                 | 查询编排：授权 → 读投影 → 回源重建/明确不可用；游标绑投影类型/作用域/筛选（v2）                     |
| `QueryEntryRegistry`                               | query/entry-registry.ts                | 入口登记目录（IFC-QRY-008）：筛选键/值类型/操作符/空值/枚举/排序/分页/作用域/匿名；未知项一律拒绝   |
| `DirectoryQueryService`                            | query/directory-query.ts               | 公开目录入口（C3.1）：匿名可读、单一筛选键（name/activityType/signupStatus/deadline/deadlineRange） |
| `PersonalCenterQueryService`                       | query/me-query.ts                      | 个人中心入口（C3.2）：作用域强制本人（subjectId=principalId），kind 筛选                            |
| `WorkbenchQueryService`                            | query/workbench-query.ts               | 工作台入口（C3.3）：作用域强制 clubId；verifyObject 逐对象重验（C6.11）                             |
| `SearchNormalizer`                                 | derivation/search-normalizer.ts        | 搜索文本规范化固定顺序（C6.6）                                                                      |
| `SearchLayering`                                   | derivation/search-layering.ts          | 搜索分层（C6.3/C6.5）：精确→连续子串→近似；近似不超直接命中；排序固定                               |
| `SimilarityScorer`                                 | derivation/similarity.ts               | 近似相似度（C6.4 应用侧降级；权威 pg_trgm 0.6 由基础设施执行）                                      |
| `VisibilityDerivationRules`                        | derivation/visibility-derivation.ts    | 可见性派生：发布状态/访问者类型/字段投影（纯函数）                                                  |
| `DeadlineFilterRule`                               | derivation/deadline-filter.ts          | 截止筛选（C6.7）：平台时区自然日窗口 TODAY/3DAYS/7DAYS + CUSTOM 起止                                |
| `ClubDirectoryRule` / `ActivityDirectoryRule`      | projection/public-directory/           | 找社团（C6.1）/找活动（C6.2，首次公布语义 C6.8）子规则                                              |
| `ProjectionStore`(+内存实现)                       | projection/                            | 可重建投影载体：save/load/invalidate/clear/TTL 过期（C2.1）                                         |
| `CacheInvalidationService`                         | invalidation/                          | 失效服务：标记投影失效 + 索引失效（C4.2）+ 登记重算意图                                             |
| `RefreshHandler`                                   | refresh/refresh-handler.ts             | 消费 A 的 recompute：旧水位不覆盖新结果、失败上报 ops（C5.3）                                       |
| `ObjectAuthorizationPort`(+占位)                   | contracts/authorization-port.ts        | 对象级授权端口（C6.9-C6.11 逐对象重验；占位 fail-closed）                                           |
| `OpsTelemetryPort`(+占位)                          | contracts/ops-telemetry-port.ts        | ops 遥测端口（C5.3 技术证据；占位日志）                                                             |
| `SearchIndexPort` / `PostgresTrgmSearchRepository` | infrastructure/postgres-trgm-search.ts | pg_trgm 检索端口与 PostgreSQL 实现模板（SQL/DDL；未接入明确不可用）                                 |

## 3. 权威与边界

| 本模块可以                                | 本模块禁止                     |
| ----------------------------------------- | ------------------------------ |
| 读取各领域模块的权威对象并按查询派生响应  | 保存可独立推进的业务状态       |
| 持有可重建的派生投影/缓存（丢失后可回源） | 从缓存、投影或旧索引授权       |
| 触发派生刷新/重建任务（经 job 模块）      | 跨社团合并管理数据或过滤作用域 |
| 按当前访问者类型做字段投影                | 把派生数据滞后当作"新权威结果" |

核心不变量：

1. 派生查询的业务状态来自权威对象当前行（`IFC-QRY-004`、接口契约 §9.1）。
2. 派生数据不得成为授权、状态、唯一性或恢复事实（`IFC-DATA-012`）。
3. 集合只读：仅服务端冻结有限集合；详情与执行逐对象重验（`IFC-QRY-002/003`）。
4. 管理工作台固定当前社团，打开、筛选、详情和命令均重新授权（接口契约 §9.6）。
5. 派生失败或滞后时只能安全回源、转可追踪异步任务或明确不可用（接口契约 §9.8）。

## 4. 运行形态

- 查询走 HTTP 入口（`PublicDirectoryController`、`PersonalCenterController`、`WorkbenchController`）。
- 派生刷新/重建经 job 模块持久化任务执行（`IFC-TX-008`）；本模块自身无 worker 侧组件。
- 本模块不自行异步写库，重建意图一律登记到 job 模块由后台执行单元领取。

## 5. 分层落位

```
interfaces/     查询 Controller 与 DTO：只做请求适配，不做授权结论
application/    queries/ 派生查询用例：组装授权上下文、编排回源、触发刷新
domain/         投影与筛选规则：搜索规范化、可见性派生、排序规则（纯函数）
infrastructure/ PostgreSQL 查询与索引、可重建缓存、pg_trgm 检索实现
```

- **interfaces**：接收查询参数并交给 application；不直接访问数据库或缓存。
- **application**：以目标对象为锚点建立授权上下文；决定"回源查询"还是"读派生投影"。
- **domain**：承载不依赖框架的业务规则（见第 6 节），可独立单测。
- **infrastructure**：实现查询载体与缓存载体，可替换，不携带业务结论。

## 6. 开发必须遵守的规则

### 6.1 搜索（ADR-007 §8 收口说明）

- 提供"找社团"（按社团展示名称）与"找活动"（按活动名称）两个独立模式，同一时刻不组合两个名称条件。
- 首版所有对象均不提供拼音或首字母搜索。
- 结果分层固定为：稳定标识或名称精确命中 → 中文连续子串命中 → 错别字近似候选；近似候选不得超过任何直接命中。
- 近似层使用 PostgreSQL `pg_trgm` 的 `word_similarity()`，方向为"用户输入片段 → 权威名称连续范围"，阈值显式固定为 `0.6`，不得依赖数据库会话隐式默认值。
- 第三层候选排序：`word_similarity()` 降序 → 规范化名称稳定顺序 → 对象 UUID。
- 搜索文本规范化顺序固定为：NFC → Unicode 大小写折叠 → 再次 NFC → 去首尾 Unicode 空白 → 内部连续空白压缩为一个 U+0020。不折叠标点、简繁体、全角/半角。
- 规范化必须由 PostgreSQL 中显式版本化的规范化函数执行，应用侧预览不得成为可信写入值；HTTP/后台只提交原始文本。
- 筛选：报名截止时间提供"今日截止 / 3 日内 / 7 日内 / 自定义起止"，由服务端按平台时区自然日转换；"正在报名"按查询时公开资格、通道开放、无暂停/终态覆盖且截止晚于服务端时刻共同派生，不是持久状态。

### 6.2 派生与缓存（ADR-007）

- 允许使用可重建缓存：全部丢失/过期/清空时必须能从权威来源得到相同正确结果；缓存故障只影响性能，不改变业务结果。
- 禁止只保存在缓存中的内容：当前成员/部门/职位关系、授权结果、业务状态、草稿/正式提交、幂等记录、任务与租约、通知事实、审计、删除清单、文件检查状态、Casdoor 同步结果。
- 可缓存候选：不可变表单版本、低频公开配置、可重建统计等——是否缓存、键、TTL 与淘汰由实现按访问模式决定。
- 可见范围收紧、权限模板发布、业务状态变化、事实纠错、正式删除必须触发对应失效；无法证明安全失效的敏感/个性化结果不得缓存。
- 缓存键必须包含社团/协作域/访问者范围维度，防止跨作用域命中。

### 6.3 授权与安全

- 每次受保护请求都执行当前服务端授权，缓存命中不得跳过用户、对象、操作、作用域和状态检查。
- 公开入口允许未认证读取，但输出必须按当前访问者类型执行字段投影；只有发布后的普通招新、首次公布后的联合活动才能进入公开结果。
- 个人中心只聚合本人事项和当前仍有权的角色型事项；每项携带真实作用域和稳定目标引用，失权后旧链接、缓存和入口同时失效。

## 7. 与相邻模块协作

| 协作对象                                                 | 关系                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 各领域模块（identity/organization/recruitment/joint 等） | 只读其权威对象；不得写入任何领域状态                                           |
| job 模块                                                 | 派生刷新/重建意图经 job 持久化任务执行（`IFC-TX-008`）；本模块不得自行异步写库 |
| ops 模块                                                 | 重建失败、失效失败等技术证据进入脱敏日志与内置状态，不由本模块自行断言         |
| 权限/授权能力                                            | 由组织与授权模块判定；本模块只承接判定结果                                     |

## 8. 测试要求

- 冷缓存、缓存清空、过期、并发失效、多实例短暂不一致；
- 权限撤销、可见范围收紧、纠错、删除后旧派生结果失效；
- 搜索分层与近似阈值边界（含不足 3 个有效字符不启用近似层）、规范化顺序；
- 权威库不可用时不得返回"假新鲜"派生结果；
- 缓存键缺失作用域、跨社团命中等负向场景；
- 派生失败/滞后时只能回源、转任务或明确不可用，不能扩大数据范围。

## 9. 相关文档

- [ADR-002 逻辑模块与状态机唯一责任基线](../../../docs/architecture/ADR-002-逻辑模块与状态机唯一责任基线.md)
- [ADR-007 首版搜索与可重建缓存边界](../../../docs/architecture/ADR-007-首版搜索与可重建缓存边界.md)
- [接口契约 v1.0（§9 派生查询、搜索、筛选、个人中心与工作台）](../../../docs/specification/接口契约-v1.0.md)
- [数据模型与约束 v1.0](../../../docs/specification/数据模型与约束-v1.0.md)
