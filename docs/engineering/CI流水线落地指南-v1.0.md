# RanaMinder CI 流水线落地指南 v1.0

> 文档状态：实现准备评审草案；流水线配置已落地（仓库根 `.cnb.yml`），代码相关阶段处于"代码就绪后自动激活"状态  
> 草案日期：2026-08-14  
> 权威来源：[CI 与质量门定义 v1.0](CI与质量门定义-v1.0.md)（CI-001~CI-006）、[后端工程约定 v1.0](后端工程约定-v1.0.md) §8、[测试执行计划 v1.0](测试执行计划-v1.0.md)、[依赖与版本基线 v1.0](依赖与版本基线-v1.0.md) §4、[部署运维与恢复手册](../operations/部署运维与恢复手册-v1.0.md)  
> 平台语法参考：cnb.cool 云原生构建 [语法手册](https://docs.cnb.cool/zh/build/grammar.md)、[触发规则](https://docs.cnb.cool/zh/build/trigger-rule.md)、[内置环境变量](https://docs.cnb.cool/zh/build/build-in-env.md)  
> 用途：说明 `.cnb.yml` 的流水线结构、CI-001 十一阶段到配置的逐项映射、触发策略、环境与密钥、失败处置与本地复现；**本文件是 CI 配置的维护说明，门禁规则本身以 CI 与质量门定义为准**

## 1. 落地总览

`CIL-001`：本仓库 CI 由两部分组成，均入库版本控制：

| 产物       | 位置                                   | 内容                                                                 |
| ---------- | -------------------------------------- | -------------------------------------------------------------------- |
| 流水线配置 | 仓库根 `.cnb.yml`                      | 分支×事件触发的流水线定义（docs-check / code-check / release-check） |
| 检查脚本   | `scripts/ci/check-docs-links.sh`       | 文档相对链接一致性检查（CI-001 阶段 11）                             |
| 检查脚本   | `scripts/ci/check-license-registry.sh` | 依赖许可证登记一致性检查（CI-001 阶段 10 辅助，DEP-003）             |
| 落地说明   | 本文件                                 | 阶段映射、维护与复现说明                                             |

`CIL-002`：平台为 cnb.cool（腾讯云 CODING 云原生构建），使用声明式 `.cnb.yml`（script + stages 语法，分支/事件/条件体系为 CNB 自研，**不兼容** `.woodpecker.yml`）。

`CIL-003`：与门禁定义的映射：

| 门禁定义条目          | 落地情况                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI-001 十一阶段流水线 | 全部落入配置（§3 逐项映射）；阶段 1~8、10 由 code-check / release-check 承载，阶段 9、11 由 docs-check / release-check 承载（docs-check 无条件执行覆盖所有 MR/push） |
| CI-002 触发策略       | 落地（§2）：MR/push 全量（ifModify 分流）、纯文档变更只跑阶段 9+11、发布 tag 全量+发布证据                                                                           |
| CI-003 合并门         | 由流水线结果＋保护分支状态检查承载；第 2~6 项为人工评审门，CI 提供对应证据                                                                                           |
| CI-004 发布门         | release-check 的 endStages 输出证据摘要；真实验证（TVER-_）与演练（OPS-VER-_）仍为人工门                                                                             |
| CI-005 失败处置       | 见 §5：失败即阻断，人工重跑，例外走治理记录                                                                                                                          |
| CI-006 证据关系       | 见 §5：流水线日志归档为执行证据，结论回填测试规格/运维手册                                                                                                           |

## 2. 触发矩阵

`CIL-010`：分支×事件×流水线：

| 分支（glob）  | 事件                         | 执行流水线                      | 依据                                                                                                 |
| ------------- | ---------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `(main\|dev)` | `pull_request`（含推送更新） | docs-check ＋ code-check        | CI-002 规则 1                                                                                        |
| `(main\|dev)` | `push`（合并后回归）         | docs-check ＋ code-check        | CI-001 精神，合并后分支自身质量可观测                                                                |
| `v*`          | `tag_push`                   | release-check（全量＋发布证据） | CI-002 规则 3                                                                                        |
| 其他分支      | 任意                         | 无流水线                        | 分支自身无配置则不触发；MR 到 main/dev 时按**目标分支**配置执行（CNB 规则：PR 事件读取目标分支配置） |

`CIL-011`：**docs-check 无条件执行**——任何变更（含纯文档、`.cnb.yml` 自身）都先过秘密扫描与文档链接检查，对应 CI-002 规则 2"纯文档变更保留阶段 9 与 11"。

`CIL-012`：**code-check 用 `ifModify` 分流**，仅当变更文件命中以下规则才执行：

```yaml
ifModify:
  - '**' # 命中一切变更
  - '!(docs/**)' # 排除文档目录
  - '!(**/*.md)' # 排除所有 Markdown
  - '!*.md'
  - '!(scripts/ci/**)' # 排除 CI 脚本自身
```

即：变更 `src/**`、`test/**`、构建配置、`.cnb.yml` 等时执行；纯文档/纯 CI 脚本变更时不执行。PR 事件按 PR 变更文件统计，push 事件按 before/after 差异统计（新分支 push 无法统计时视为命中，全量执行）。

`CIL-013`：**代码阶段保护**：仓库已包含 `package.json` 与 `pnpm-lock.yaml`，代码阶段已全部激活。阶段 1 在 `package.json` 存在时执行 `corepack pnpm install --frozen-lockfile`，`pnpm-lock.yaml` 缺失/漂移即失败（CI-001 阶段 1 门禁）。测试阶段 4/5/6 以 `package.json` 存在为条件，使用仓库内置的 Node 测试运行器（`node --test`）执行，不再依赖 Jest 配置文件。

## 3. 阶段实现明细（CI-001 十一阶段 → 配置映射）

`CIL-020`：下表为逐阶段映射；命令名（`npm run test:unit` 等）为按工程约定的建议名，代码开工落地 package.json 时按 [后端工程约定](后端工程约定-v1.0.md) 与 [测试执行计划](测试执行计划-v1.0.md) 对齐，**命令名变更不影响门禁语义**。

| CI-001 阶段   | 流水线                     | 配置位置                                         | 命令                                                                                                              | 门禁                                         | 当前状态   |
| ------------- | -------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------- |
| 1 安装        | code-check / release-check | 阶段 `1-安装`                                    | `corepack pnpm install --frozen-lockfile`（pnpm 锁文件驱动）                                                      | 通过；pnpm-lock.yaml 缺失/漂移失败           | **已激活** |
| 2 类型检查    | code-check / release-check | 阶段 `2-类型检查`                                | `npx tsc --noEmit -p tsconfig.json`                                                                               | 通过                                         | **已激活** |
| 3 Lint        | code-check / release-check | 阶段 `3-Lint与格式`                              | `npm run lint` ＋ `npm run format:check`                                                                          | 通过                                         | **已激活** |
| 4 单元测试 L1 | code-check / release-check | 阶段 `4-单元测试L1`                              | `npm run test:unit`                                                                                               | 通过；覆盖率不设硬下限，新增代码须有对应用例 | **已激活** |
| 5 集成测试 L2 | code-check / release-check | 阶段 `5-集成测试L2`                              | 启动 PG18 容器（pg18-ci，扩展 pg_trgm/btree_gist）→ `npm run test:integration`（见 §7.2）                         | 通过                                         | **已激活** |
| 6 契约测试 L3 | code-check / release-check | 阶段 `6-契约测试L3`                              | `npm run test:contract`                                                                                           | 通过                                         | **已激活** |
| 7 构建        | code-check / release-check | 阶段 `7-构建`                                    | `npm run build` ＋ `npm run build:worker`（HTTP 与 Worker 双入口，ADR-001/ADR-013）                               | 通过                                         | **已激活** |
| 8 镜像        | code-check / release-check | 阶段 `8-镜像构建`（release 为 `8-镜像构建推送`） | `docker build`，tag 为提交 SHA（code-check 仅构建，release 构建并 push 至 CNB 制品库）                            | 通过（tag 非 latest）                        | **已激活** |
| 9 秘密扫描    | docs-check / release-check | 阶段 `9-秘密扫描`                                | gitleaks v8.30.0（固定版本，见 §4.3）`detect --source . --redact`                                                 | 0 命中                                       | **已激活** |
| 10 依赖审计   | code-check / release-check | 阶段 `10-依赖审计与许可证登记`                   | `corepack pnpm audit --audit-level=high`（corepack 匹配 packageManager）＋ `scripts/ci/check-license-registry.sh` | 无关键/高危未处置项；DEP-003 登记一致        | **已激活** |
| 11 文档一致性 | docs-check / release-check | 阶段 `11-文档链接一致性`                         | `bash scripts/ci/check-docs-links.sh`                                                                             | 全部相对链接有效                             | **已激活** |

`CIL-021`：阶段 9、11 在 `docs-check`（PR/push 两处）与 `release-check`（tag 一处）出现；`code-check` 不重复承载，因为 docs-check 在任何 MR/push 中无条件执行，阶段 9、11 已覆盖全部变更。修改 gitleaks 下载地址或链接检查命令时，须同步这三处；§6 给出本地复现命令。

## 4. 环境与密钥

### 4.1 构建镜像

`CIL-030`：所有流水线使用 `node:24`（与 [依赖与版本基线](依赖与版本基线-v1.0.md) §2 "Node.js 24 LTS（Active）"一致）。升级 Node 基线时同步修改 `.cnb.yml` 全部 `docker.image`。

### 4.2 内置环境变量与密钥

`CIL-031`：使用 CNB 内置只读变量：`CNB_BRANCH`（分支或 Tag 名）、`CNB_COMMIT_SHORT`（构建提交短 SHA）、`CNB_DOCKER_REGISTRY`（制品库 Docker 源）、`CNB_EVENT`、`CNB_IS_TAG` 等，完整清单见[官方文档](https://docs.cnb.cool/zh/build/build-in-env.md)。流水线内不得将秘密写入 `.cnb.yml` 或仓库任何文件。

`CIL-032`：当前阶段无私有凭据需求（npm 公开源、镜像公开）。需要私有 npm 源 / 私有镜像时：凭据放入 cnb.cool **密钥仓库**文件，流水线用 `imports` 引用（如 `imports: https://cnb.cool/<slug>/-/blob/<branch>/npm.yml`），禁止明文入仓。

### 4.3 gitleaks 版本固定与升级

`CIL-033`：阶段 9 固定 gitleaks `v8.30.0`（从 GitHub Releases 下载 `gitleaks_8.30.0_linux_x64.tar.gz`，解压到 `/usr/local/bin`）。升级步骤：更新 `.cnb.yml` 三处下载 URL → 本地按 §6 复现一次 → 提交。若 cnb.cool 构建节点访问 GitHub 不稳定，将二进制预置到 CNB 制品库/内网镜像并在配置中改引（见 §7.4）。

## 5. 证据与失败处置

`CIL-040`：**失败即阻断**（CI-005 规则 1）：任一阶段失败，流水线状态上报为失败；配合保护分支"需要通过状态检查"即阻断合并。不配置 `allowFailure`，不硬编码跳过。

`CIL-041`：**偶发失败处置**（CI-005 规则 2）：不启用自动 `retry`（避免掩盖真实失败），由维护者在 cnb.cool 构建记录页手动"重跑"，仍失败按真实失败处置。阶段 9 的 gitleaks 下载偶发超时可先重跑一次。

`CIL-042`：**门禁例外**（CI-005 规则 3）：任何例外必须由需求方显式记录（`GOV-CODE-WAIVER-001` 式记录），不在 CI 中硬编码跳过。

`CIL-043`：**证据关系**（CI-006）：流水线日志是执行证据，结论仍回填测试规格 `TST-*`、运维手册 `OPS-VER-*` 与首批验证清单 `TVER-*`；release-check 的 `endStages` 输出发布门证据摘要（CI-004 六项），供治理归档；CI 通过不等于验收通过。

## 6. 本地复现

`CIL-050`：各阶段命令可在本地直接复现（与 CI 一致）：

```bash
# 阶段 11：文档链接一致性（当前仓库必须零断链）
bash scripts/ci/check-docs-links.sh

# 阶段 9：秘密扫描（macOS 下载 darwin 版二进制；CI 使用 linux_x64）
curl -sSfL https://github.com/gitleaks/gitleaks/releases/download/v8.30.0/gitleaks_8.30.0_darwin_x64.tar.gz -o /tmp/gitleaks.tar.gz
tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks
gitleaks detect --source . --no-banner --redact

# 阶段 10 辅助：许可证登记一致性（package.json 存在时校验 DEP-003 登记表）
bash scripts/ci/check-license-registry.sh
```

`CIL-051`：`check-docs-links.sh` 覆盖 `docs/`、`src/`、`test/` 与根 `README.md` 的全部 Markdown 相对链接（含锚点剥离、外部 URL 跳过）；**任何文档变更在本地先跑一遍再提交**。

## 7. 边界与后续

### 7.1 前端仓库

`CIL-060`：CI-001 中"前后端"字样：本仓库（rana-minder-service）只承载后端；前端对应阶段（npm ci/tsc/lint/构建）由前端仓库 `rana-minder-web` 的流水线承载，两端流水线独立，契约一致性由 [前后端契约对齐](前后端契约对齐-v1.0.md) 的文档与人工门保证。

### 7.2 集成测试 L2 的真实 PG18

`CIL-061`：cnb.cool 未提供托管 PostgreSQL 服务，采用"dind 服务 + 容器内运行 PG18"方案：流水线已声明 `services: [docker]`（code-check / release-check），阶段 5 脚本启动 `postgres:18` 容器 `pg18-ci`，等待 `pg_isready` 就绪后创建 `pg_trgm`/`btree_gist` 扩展（与开发环境 `scripts/dev/postgres-init.sql` 一致），再运行 `npm run test:integration`；测试库为 `ranaminder_test`（与开发库 `ranaminder_dev` 隔离），应用连接信息由 `package.json` 的 `test:integration` 脚本按 [配置规格](配置规格-v1.0.md) 草案传入，容器用完即清（trap）。

### 7.3 依赖许可证登记表

`CIL-062`：[依赖与版本基线](依赖与版本基线-v1.0.md) §4（DEP-003）当前为规则条款、尚无逐依赖登记表；`check-license-registry.sh` 在 package.json 出现后要求每个直接依赖在登记表中出现（名称级匹配）。登记表落表格式由依赖与版本基线维护者定义后，本脚本按需收紧为"名称+版本+许可证"三字段匹配。

### 7.4 构建节点网络依赖

`CIL-063`：阶段 9 下载依赖 GitHub Releases；若 cnb.cool 构建节点网络受限，将 gitleaks 二进制上传至 CNB 制品库（或镜像），修改配置下载地址即可，门禁语义不变。

### 7.5 保护分支对接

`CIL-064`：main/dev 设为保护分支并勾选"需要通过状态检查"后，docs-check/code-check 结果自动成为合并门（CI-003 规则 1）；未开启状态检查时流水线仍执行，但不自动阻断合并，需人工把关。

## 8. 检查结论

| 检查项                 | 结果                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 流水线配置（.cnb.yml） | 已落地（main/dev × PR/push、v* × tag）                                                                                                                         |
| CI-001 十一阶段映射    | 已映射（§3 表）；全部阶段已激活并随对应流水线真实执行                                                                                                          |
| CI-002 触发策略        | 已落地（ifModify 分流、纯文档只跑 9+11、tag 全量+证据）                                                                                                        |
| 检查脚本               | check-docs-links.sh（已激活，当前仓库 886 个相对链接零断链）；check-license-registry.sh（已激活，校验 DEP-003 登记表）                                         |
| 镜像构建输入           | Dockerfile/.dockerignore/docker-compose.dev.yml 已随 [Docker 镜像构建规范](Docker镜像构建规范-v1.0.md) 落地；阶段 8 门禁同步为 package.json＋Dockerfile 双条件 |
| 既有断链修复           | src/modules/分层实现规范.md 15 处链接已修复（`../architecture/` 等缺少 `../../docs/` 前缀）                                                                    |
| 密钥                   | 无入仓秘密；私有凭据预留密钥仓库 imports 通道                                                                                                                  |
| 前端对应阶段           | 由 rana-minder-web 仓库单独承载（§7.1）                                                                                                                        |
