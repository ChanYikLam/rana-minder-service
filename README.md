# RanaMinder Service

> 高校学生社团人员管理系统 · 后端服务

RanaMinder 是一套面向高校学生社团的人员生命周期管理系统，覆盖身份与资料、社团组织与授权、普通招新、联合面试、邀请与成员激活、成员换届、动态表单、文件管理、站内通知、纠错审计、统计导出与平台配置等完整业务域。

## 技术栈

- **运行时**：Node.js + NestJS + TypeScript（ADR-013）
- **主数据库**：PostgreSQL 18.x，单库单 Schema（ADR-006、ADR-014）
- **身份认证**：Casdoor v3.108.0 统一适配（ADR-009）
- **对象存储**：S3 兼容（ADR-008）
- **应用形态**：模块化单体，HTTP 应用与后台任务独立启动入口（ADR-001）

## 仓库结构

```
rana-minder-service/
├── docs/                  需求与设计基线文档（权威来源）
├── src/                   后端源码
│   ├── modules/           15 个逻辑模块（12 领域 + 3 平台支撑）
│   ├── common/            公共组件与错误脱敏
│   ├── shared/            跨模块通用能力
│   ├── config/            配置加载
│   ├── database/          数据持久化、迁移与实体
│   ├── adapters/          基础设施适配（db/casdoor/mail/storage）
│   ├── 启动入口文档.md
│   └── ...
├── test/                  集成测试与验收证据
├── scripts/
│   ├── ci/                CI 检查脚本（文档链接、许可证登记）
│   └── dev/               开发环境脚本（postgres 扩展初始化）
├── Dockerfile             后端镜像构建（双入口，见 Docker 镜像构建规范）
├── .dockerignore          镜像构建上下文排除规则（秘密防护）
├── docker-compose.dev.yml 开发环境依赖服务编排（PG18/MinIO/Casdoor/Mailpit）
├── .cnb.yml               CI 流水线配置（cnb.cool 云原生构建）
└── README.md              本文件
```

## 模块清单

| 类型 | 模块 | 状态机 |
|---|---|---|
| 领域 | identity（身份与资料） | SRS-SM-IDN-001~003 |
| 领域 | organization（组织与授权） | SRS-SM-ORG-001~003 |
| 领域 | recruitment（普通招新） | SRS-SM-REC-001~005 |
| 领域 | joint（联合活动） | SRS-SM-JNT-001~006 |
| 领域 | invitation（邀请与成员激活） | SRS-SM-INV-001、SRS-SM-MEM-004 |
| 领域 | membership（成员生命周期） | SRS-SM-MEM-001~003 |
| 领域 | form（动态表单） | SRS-SM-FORM-001~002 |
| 领域 | file（文件） | SRS-SM-FILE-001 |
| 领域 | notification（通知） | SRS-SM-NTF-001 |
| 领域 | audit（纠错、审计与数据生命周期） | SRS-SM-AUD-001 |
| 领域 | stat-export（统计与导出） | SRS-SM-EXP-001 |
| 领域 | config（配置与发布） | - |
| 平台支撑 | read-model（派生入口与读模型） | - |
| 平台支撑 | job（后台任务与批量编排） | SRS-SM-ORG-004 |
| 平台支撑 | ops（运维与可观测性） | - |

共 29 个状态机、306 条转换、8 类事务边界。

## 文档导航

权威文档位于 `docs/`，开发指导文档位于 `src/` 各目录内：

- **需求基线**：`docs/requirements/00-需求事实总账.md` → `docs/product/PRD-v1.0.md` → `docs/specification/SRS-v1.0.md`
- **架构决策**：`docs/architecture/` （ADR-001~014、系统架构总览）
- **接口与数据**：`docs/specification/`（接口契约、数据模型与约束、Casdoor 集成契约、安全设计）
- **测试规格**：`docs/specification/测试规格与验收追踪-v1.0.md`
- **部署运维**：`docs/operations/部署运维与恢复手册-v1.0.md`
- **后端开发指导**：`src/modules/*/README.md`（各模块）、`src/modules/分层实现规范.md`（分层约定）、`src/` 各目录中文文档
- **CI 流水线**：`docs/engineering/CI与质量门定义-v1.0.md`（门禁权威）、`docs/engineering/CI流水线落地指南-v1.0.md`（`.cnb.yml` 实现明细与维护）
- **容器与镜像**：`docs/engineering/Docker镜像构建规范-v1.0.md`（镜像构建规则，Dockerfile/.dockerignore 已落地）；开发环境依赖编排见 `docker-compose.dev.yml`

## 启动与开发

> 本节给出 1.1 工程脚手架阶段的可执行命令与约束；版本与库选择处于
> `DEP-001 候选基线，待首批技术验证后复核锁定`，不得视为已冻结。

### 环境

- Node.js 24 LTS（`engines.node` 约束）
- pnpm ≥ 10（`packageManager: pnpm@10.34.5`）
- monorepo 工作区声明见 `pnpm-workspace.yaml`（当前仅启用根包）

### 安装与脚本

```bash
pnpm install                  # 安装依赖（须 DNS 可达 npm registry）
pnpm typecheck                # 仅类型检查，不产出
pnpm lint                     # ESLint（@typescript-eslint 推荐集）
pnpm format                   # Prettier 写入
pnpm format:check             # 仅校验格式
pnpm build                    # nest build → dist/
```

### 双入口运行（ADR-013）

应用形态为模块化单体，HTTP 应用与后台任务独立启动：

```bash
pnpm start:dev                # 监听变更，启动 HTTP 应用（src/main.ts → NestApplication）
pnpm start:dev:worker         # 监听变更，启动后台任务（src/main.worker.ts → NestApplicationContext）
pnpm start                    # 生产：node dist/main.js（默认 0.0.0.0:3000，PORT 覆盖）
pnpm start:worker             # 生产：node dist/main.worker.js（无 HTTP 监听）
```

两个入口共用 `AppModule` 模块图；worker 不创建 HTTP 监听器、不注册 controllers。HTTP
端口由 `PORT` 覆盖；监听地址由 `HOST` 覆盖（默认 `0.0.0.0`）。

### 当前可写与不可写范围

- **可写**：工程脚手架、根模块聚合点、TS/ESLint/Prettier/EditorConfig 风格、`.gitignore` / `.npmrc`、
  CI 验证脚本（已在 `scripts/ci/` 由团队提供）。
- **待团队决策后接入**：`src/database/` 实体与迁移、`src/common/` 错误基础设施、`src/adapters/`
  适配（db / casdoor / mail / storage）、12 个领域模块、3 个平台支撑模块（`observability`
  / `job` / `read-model`）。
- **受控范围**：数据库迁移仅限开发 / 测试环境；真实数据与生产发布门继续关闭。

## 当前状态

- 需求、架构、数据、接口、安全、测试与运维文档均已完成内部确认
- 1.1 工程脚手架已落地（NestJS 11 + TS 5.7 + pnpm 9 + 双入口）
- 代码编写已按 `GOV-CODE-WAIVER-001` 豁免开放
- 全部实现测试、部署验证和恢复演练仍为"未执行"
- 生产发布与真实数据启用门继续关闭
