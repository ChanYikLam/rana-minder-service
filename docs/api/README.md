# RanaMinder API 接口源（Apifox / Postman 统一管理）

本目录维护后端 HTTP 接口的**统一接口源**，供 Apifox / Postman 一键导入后集中管理、调试。

## 文件说明

| 文件 | 说明 |
| --- | --- |
| `openapi.yaml` | OpenAPI 3.0.3 规格（YAML，推荐导入 Apifox） |
| `openapi.json` | OpenAPI 3.0.3 规格（JSON，推荐导入 Postman） |
| `../../scripts/generate-openapi.js` | 生成脚本：静态解析 `src` 下全部控制器，自动产出上述两份文件 |

> 两份文件内容完全一致，仅格式不同。**均为生成产物，请勿手工编辑**；控制器路由变化后重新生成即可。

## 快速开始

### 1. 导入到 Apifox

1. 打开 Apifox → 左侧「项目」→ 进入目标项目（或新建项目）。
2. 点击顶部「导入数据」→ 选择「OpenAPI / Swagger」。
3. 选择文件 `docs/api/openapi.yaml`（或粘贴文件内容）。
4. 导入后 Apifox 自动生成：
   - **接口文档**：按模块（audit / config / file / form / identity / invitation / job / joint / membership / notification / observability / organization / recruitment / stat-export）分目录；
   - **接口调试**：每个端点可直接发送请求；
   - **数据模型**：`ApiSuccess` / `ApiError` / `ApiRequestEnvelope` 等组件与可解析的 DTO Schema。

### 2. 导入到 Postman

1. 打开 Postman → 左上角「Import」。
2. 拖入 `docs/api/openapi.json`（或选择文件）。
3. 导入后 Postman 生成 Collection：每个模块一个 Folder，端点按路径组织，可立即调试。

## 调试前准备

### 环境变量 / 服务地址

规格中已声明两个 Server：

- `http://localhost:3000` —— 本地开发（`pnpm start:dev`）
- `http://localhost:8080` —— Docker 开发环境（`docker-compose.dev.yml`）

在 Apifox「环境管理」或 Postman「Environments」中按需选择/覆盖 Base URL。

### 认证（Bearer Token）

除公开端点（如 `GET /api/explore/clubs/{clubId}/profile`、`GET /api/auth/casdoor/login-url`）外，接口一律要求：

```
Authorization: Bearer <token>
```

获取方式：访问 `GET /api/auth/casdoor/login-url` 获取 Casdoor 登录地址，完成登录后由
`GET /api/auth/session?code=...&state=...` 建立会话并返回令牌。

Apifox 可在「环境变量」中定义 `token`，并在接口调试的「Auth」选择 **Bearer Token** 引用；
Postman 可在 Collection 级设置 Authorization 或使用环境变量 `{{token}}`。

## 通用契约速览（导入后即可对照调试）

| 契约 | 说明 |
| --- | --- |
| 成功响应 | `ApiSuccess`：`{ "code": 0, "data": ... }`，`code` 恒为 0 |
| 失败响应 | `ApiError`：仅含 `code / message / supportId / fieldErrors`（IFC-ERR-001~017） |
| 请求信封 | `ApiRequestEnvelope`：POST/PUT/DELETE 顶层仅 `action / targetId / expectedVersion / idempotencyKey / input` 五键，业务字段位于 `input` 内 |
| 文件上传 | 例外：`POST /api/files/upload` 为 FormData 直传，无信封 |
| 路径参数 | `:clubId` 等占位符已转为 `{clubId}`，导入后为必填路径参数 |
| 错误码 | `IFC-ERR-001` 未认证（401）→ `IFC-ERR-017` 请求体解析失败（400），详见 `docs/specification/接口契约-v1.0.md` §8 |

## 重新生成接口源

控制器路由、守卫、DTO 变更后，重新生成：

```bash
pnpm api:openapi
# 或
node scripts/generate-openapi.js
```

生成脚本会：

- 扫描 `src/modules/**` 与 `src/platform/**` 下全部带 `@Controller` 的控制器；
- 提取 `@Get/@Post/@Put/@Patch/@Delete` 路由、`@Param/@Query/@Body`、`@UseGuards`（→ bearerAuth 安全声明）、`@HttpCode` 与 JSDoc 摘要；
- 尽力将命名 DTO（同文件 interface/type/class + `src/common/contracts` + 全局类型索引）解析为 JSON Schema 组件；
- 输出 `openapi.yaml` 与 `openapi.json`。

> 提示：若某端点请求体仅标注为 `ApiRequestEnvelope`，说明该控制器按统一信封解析
> （`@Body() body: unknown`），业务字段结构请以 `docs/specification/接口清单-HTTP端点-v1.0.md`
> 对应条目与 `src/common/contracts/*.contracts.ts` 为准。
