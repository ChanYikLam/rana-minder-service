# 领域模块 · 动态表单

> 更新日期：2026-08-12
> 状态机：`SRS-SM-FORM-001`（表单定义/模板，8 条转换）、`SRS-SM-FORM-002`（表单提交，9 条转换）

## 核心职责

表单定义、不可变发布版本、提交、修订、字段权限与业务快照；动态答案采用关系骨架＋JSONB 混合存储（ADR-006）。关键不变量：固定业务骨架（身份、权限、状态、审批、任期、关系）不可被动态字段替代或改变工作流含义（ADR-002 §2.1、FORM-001/002）；已发布版本不可覆盖，旧提交可按原版本长期还原（FORM-005、FORM-012）。

## 关键组件

| 组件 | 类型 | 职责 |
|---|---|---|
| `FormDefinitionController` / `FormSubmissionController` | Controller | 表单设计/发布/停用、草稿保存、提交与修订的 HTTP 路由与请求适配 |
| `CreateFormDraftCommand`、`UpdateFormDraftCommand`、`RunPreviewTestCommand`、`PublishFormVersionCommand`、`DeprecateFormVersionCommand`、`ReuseFormVersionCommand` | 应用命令·查询用例 | SM-FORM-001 各转换的用例编排（application/commands、application/queries） |
| `SaveSubmissionDraftCommand`、`MigrateDraftCommand`、`RequestSubmitCommand`、`CompleteSubmitCommand`（检查通过收口）、`OpenRevisionCommand`、`LockSubmissionCommand`、`RequestCorrectionCommand`、`CleanupDraftCommand` | 应用命令·查询用例 | SM-FORM-002 各转换的用例编排 |
| `FormDefinitionModel`、`FormVersionModel`、`FormSubmissionModel`、`FormRevisionModel` | 领域模型·状态机 | 表单根与不可变版本、提交骨架与可还原修订快照（domain/models、domain/state-machines） |
| `FormDefinitionStateMachine`、`FormSubmissionStateMachine`、`FormDraftMigrator`、`FieldPermissionRule` | 领域模型·状态机 | 转换前置校验、草稿跨版本迁移、字段级权限收紧与条件校验规则（纯规则，不依赖存储） |
| `FormDefinitionQueryService`、`SubmissionQueryService` | 应用命令·查询用例 | 当前指针/版本树、提交与修订详情查询（IFC-QRY-001/002），回源权威、不从缓存或通知推断授权 |
| `FormDefinitionRepository`、`FormSubmissionRepository`、`AnswerSnapshotStore` | 基础设施适配 | PostgreSQL 关系骨架与 JSONB 答案快照读写、版本与唯一性约束落地（infrastructure） |

## 对外接口

- HTTP 路由命名空间（具体 URL 未冻结，由[接口实现规格 v1.0 §6](../../../docs/specification/接口实现规格-v1.0.md) 落地后冻结；以[接口清单-HTTP端点-v1.0](../../../docs/specification/接口清单-HTTP端点-v1.0.md) 为传输层事实基线）：表单定义设计/发布/停用/复用/克隆、草稿保存/迁移/清理、正式提交、修订与锁定、字段权限与业务快照。
- 外部依赖：PostgreSQL JSONB（动态答案快照）；文件模块的上传初始化与检查状态（经由文件模块应用命令，不直接访问对象存储）；权益变化时同事务保存通知事实（IFC-TX-002）。
- 关键外部调用：提交前核验全部必需文件通过检查，检查服务不可用或未通过不得放行（FORM-007、GOV-008、NFR-003）。

## 核心逻辑摘要

- SM-FORM-001：`新建 → 草稿 → 预览/测试 → 草稿（可发布）→ 已发布不可变版本 → 已停用`。测试结果绑定草稿版本，草稿变更使通过标志失效；发布原子创建不可变版本并切换当前使用指针，并发发布只一个成为当前版本，失败时旧版本完整有效（IFC-GEN-007）。修改、回滚或复用必须基于来源版本新建草稿重新发布；已停用版本直接恢复一律拒绝（FORM-002、FORM-005、CFG-005）。
- 停用只阻止新提交入口，既有提交、附件、历史与停用状态完整保留，不改绑任何活动快照；复制模板只含结构、字段与校验，不含提交、附件、人员信息或原社团对象引用，副本独立演进（FORM-010）。
- SM-FORM-002：`新建 → 草稿 → 扫描/校验中 → 正式提交 → 可编辑修订 / 业务锁定 → 事实纠错`；草稿可删除/清理，正式提交绑定附件后不可覆盖。
- 事务边界归属：草稿/发布为第 1 类（IFC-TX-001）；正式提交与文件绑定为第 4 类（IFC-TX-004）；权益通知为第 2 类（IFC-TX-002）。
- 幂等与回读：草稿乐观版本，旧版本编辑拒绝；提交幂等键＋草稿版本唯一，同一待提交快照只成功一次；检查通过回调幂等。扫描/校验中必须等全部文件检查通过且业务状态、期限二次有效才收口，否则回到草稿/可编辑修订并显示原因（FORM-004、FORM-007、FORM-011）。
- 草稿迁移：打开旧草稿迁移到最新已发布版本；相同稳定字段标识旧答案自动带入，新增必填字段必须补填，不兼容类型变更必须创建新字段，删除/隐藏字段不带入本次提交（FORM-005、FORM-006）。
- 拒绝示例：直接恢复已停用版本、覆盖或改绑历史提交/附件/活动快照、固定骨架变更、秘密字段或代码注入（GOV-003）、字段权限越权（只能收紧）、业务锁定后普通编辑、任一文件未通过检查时宣称提交成功。
- 数据生命周期协作：导出只含操作者当前可查看的提交与字段，附件单独选择并受下载权限控制；归档后普通编辑关闭，查看范围跟随归档角色权限；事实纠错追加纠错记录或新修订，原答案、附件与审计保留（需求发现 07、AUD-001/002）。

## 典型调用链

`FormSubmissionController 请求正式提交` → `RequestSubmitCommand` 冻结待提交快照并创建文件检查任务 → 文件检查服务回调 `CompleteSubmitCommand` → 领域校验（状态/期限/文件全部可用/版本匹配）→ 同一本地事务原子创建不可变提交修订、资料快照、答案与附件绑定并推进所属业务命令（第 4 类边界）→ 权益通知事实同事务保存 → 渠道投递在提交后执行。