# common/contracts · 传输层契约类型

> 更新日期：2026-08-17
> 目录位置：src/common/contracts/
> 权威依据：docs/specification/接口实现规格-v1.0.md（API-GEN/API-AUTH/API-ERR/API-TX）、docs/specification/接口清单-HTTP端点-v1.0.md（端点事实基线）、docs/specification/接口契约-v1.0.md（IFC-*）

## 定位

本目录集中维护 **HTTP 传输层 TypeScript 类型契约**（请求信封、响应信封、错误码、分页，以及 14 个端点域的类型形状），供各模块 `interfaces` 层 Controller/DTO 与前端适配器对齐使用。

- 这些类型只表达“前端已经调用、后端必须兼容”的传输层形状；**不新增产品行为、不替代领域模型、不承载业务规则**。
- 与上游冲突时，按[接口实现规格 v1.0 §1.2](../../../docs/specification/接口实现规格-v1.0.md) 的权威顺序处理，并回改本目录。
- 文件上传例外：`POST /api/files/upload` 为 FormData 直传，无信封（见 `files.contracts.ts`）。

## 文件索引

| 文件 | 对应端点域 | 清单章节 |
|---|---|---|
| `api-envelope.ts` | 通用请求/响应/任务/列表信封 | §1.1/§1.2/§1.4 |
| `api-error.ts` | 17 类错误码与 HTTP 状态映射 | §1.3、接口实现规格 §7 |
| `pagination.ts` | 游标分页契约 | §1.4、接口实现规格 §9 |
| `api-paths.ts` | API 路径常量与路径构造纯函数 | §1.5、接口实现规格 §6 |
| `auth.contracts.ts` | 身份与会话 auth | §4 |
| `explore.contracts.ts` | 公开探索 explore | §6 |
| `notifications.contracts.ts` | 通知 notifications（含邮件配置/熔断） | §7、§14.4、§15.9 |
| `me.contracts.ts` | 个人中心 me | §8 |
| `files.contracts.ts` | 文件 files | §9 |
| `org.contracts.ts` | 组织工作空间 org context/dashboard | §5 |
| `members.contracts.ts` | 成员生命周期 members | §10 |
| `recruitment.contracts.ts` | 普通招新 recruitment | §11 |
| `joint.contracts.ts` | 联合活动 joint | §12 |
| `forms.contracts.ts` | 动态表单 forms | §13 |
| `config.contracts.ts` | 组织配置与统计 | §14.1/§14.2 |
| `exports.contracts.ts` | 统计与导出 exports | §14.3 |
| `admin.contracts.ts` | 平台管理 admin | §15 |
| `audit.contracts.ts` | 事实纠错与审计 corrections/audit | §16 |

## 使用与准入规则

- **使用**：模块 `interfaces` 层定义 DTO/响应类型时优先从本目录导入；Controller 返回值与请求解析以这些类型为传输层基线。
- **可以放进来**：与端点事实一一对应的传输层类型、枚举字面量、请求/响应形状、列表/分页/信封类型。
- **禁止放进来**：领域实体、状态机规则、业务校验逻辑、SQL、外部适配器实现、秘密、运行时副作用；这些分别归 `src/modules/*/domain`、`src/database`、`src/adapters`。
- **运行时校验**：TypeScript 类型不能代替运行时验证（ADR-013 §2.6）；HTTP 输入、配置文件、Casdoor 回读、任务载荷、JSONB 答案等跨信任边界数据必须使用运行时校验原语（`common/RuntimeValidators` 待实现）后再进入用例。
- **未覆盖端点**：清单 §17 的 mock 专用端点（`/api/mock*`、`/api/mock-files*`）不属于后端契约，本目录不定义。

## 典型调用链

`Controller`（模块 interfaces 层）→ 使用本目录类型解析信封/响应 → `Mapper.toCommand(input, actor)` → application 用例；错误经全局 ExceptionFilter 以 `api-error.ts` 的 17 类错误码输出。

## 相关文档

- [接口实现规格 v1.0](../../../docs/specification/接口实现规格-v1.0.md)
- [接口清单-HTTP端点-v1.0](../../../docs/specification/接口清单-HTTP端点-v1.0.md)
- [接口契约 v1.0](../../../docs/specification/接口契约-v1.0.md)
- [后端工程约定 v1.0](../../../docs/engineering/后端工程约定-v1.0.md)
