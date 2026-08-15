# RanaMinder CI 流水线落地指南 v1.0

> 文档状态：实现准备评审草案；流水线配置已落地（仓库根 `.cnb.yml`），代码相关阶段处于"代码就绪后自动激活"状态  
> 草案日期：2026-08-14  
> 修订记录：2026-08-14 v1.0 完善——新增流水线总览图（§1.1）、端到端执行流程示例（§2）、gitleaks 豁免规则（§4.4）、平台启用与日常操作（§8）、常见问题排查（§9）；检查结论链接数以本地最新运行为准  
> 权威来源：[CI 与质量门定义 v1.0](CI与质量门定义-v1.0.md)（CI-001~CI-006）、[后端工程约定 v1.0](后端工程约定-v1.0.md) §8、[测试执行计划 v1.0](测试执行计划-v1.0.md)、[依赖与版本基线 v1.0](依赖与版本基线-v1.0.md) §4、[部署运维与恢复手册](../operations/部署运维与恢复手册-v1.0.md)  
> 平台语法参考：cnb.cool 云原生构建 [语法手册](https://docs.cnb.cool/zh/build/grammar.md)、[触发规则](https://docs.cnb.cool/zh/build/trigger-rule.md)、[内置环境变量](https://docs.cnb.cool/zh/build/build-in-env.md)  
> 用途：说明 `.cnb.yml` 的流水线结构、CI-001 十一阶段到配置的逐项映射、触发策略、环境与密钥、失败处置与本地复现；**本文件是 CI 配置的维护说明，门禁规则本身以 CI 与质量门定义为准**

## 1. 落地总览

`CIL-001`：本仓库 CI 由两部分组成，均入库版本控制：

| 产物 | 位置 | 内容 |
|---|---|---|
| 流水线配置 | 仓库根 `.cnb.yml` | 分支×事件触发的流水线定义（docs-check / code-check / release-check） |
| 检查脚本 | `scripts/ci/check-docs-links.sh` | 文档相对链接一致性检查（CI-001 阶段 11） |
| 检查脚本 | `scripts/ci/check-license-registry.sh` | 依赖许可证登记一致性检查（CI-001 阶段 10 辅助，DEP-003） |
| 落地说明 | 本文件 | 阶段映射、维护与复现说明 |

`CIL-002`：平台为 cnb.cool（腾讯云 CODING 云原生构建），使用声明式 `.cnb.yml`（script + stages 语法，分支/事件/条件体系为 CNB 自研，**不兼容** `.woodpecker.yml`）。

`CIL-003`：与门禁定义的映射：

| 门禁定义条目 | 落地情况 |
|---|---|
| CI-001 十一阶段流水线 | 全部落入配置（§3 逐项映射）；阶段 1~8、10 由 code-check / release-check 承载，阶段 9、11 由 docs-check / code-check / release-check 承载 |
| CI-002 触发策略 | 落地（§2）：MR/push 全量（ifModify 分流）、纯文档变更只跑阶段 9+11、发布 tag 全量+发布证据 |
| CI-003 合并门 | 由流水线结果＋保护分支状态检查承载；第 2~6 项为人工评审门，CI 提供对应证据 |
| CI-004 发布门 | release-check 的 endStages 输出证据摘要；真实验证（TVER-*）与演练（OPS-VER-*）仍为人工门 |
| CI-005 失败处置 | 见 §5：失败即阻断，人工重跑，例外走治理记录 |
| CI-006 证据关系 | 见 §5：流水线日志归档为执行证据，结论回填测试规格/运维手册 |

### 1.1 流水线总览

`CIL-004`：三条流水线的结构与阶段分配（阶段名与 .cnb.yml 一致）：

```text
触发（分支 × 事件）                        流水线                           阶段
──────────────────────              ──────────────              ─────────────────────────────────────
(main|dev) pull_request ──┬──────►  docs-check ──┬──────────►  9-秘密扫描（gitleaks，0 命中）
（MR 含推送更新）          │       （任何变更必跑） └──────────►  11-文档链接一致性
                          │
                          └──────►  code-check ──┬──────────►  1-安装 → 2-类型检查 → 3-Lint与格式
                                （ifModify 代码    │            → 4-单元测试L1 → 5-集成测试L2
                                  变更才跑）       │            → 6-契约测试L3 → 7-构建
                                                  │            → 8-镜像构建 → 10-依赖审计与许可证登记
                                                  │            （以上均为代码就绪后激活）
                                                  └──────────►  9-秘密扫描、11-文档链接一致性（复用）

(main|dev) push ──┬──────►  docs-check（同上）
（合并后回归）     └──────►  code-check（同上）

v* tag_push ─────────────►  release-check ──► 全量阶段 1~11（代码就绪后激活）
（发布）                         │
                                └── endStages：发布门证据摘要（CI-004 六项，人工门证据）
```

`CIL-005`：docs-check 与 code-check 为**并行流水线**（同一事件下多条 pipeline 并发执行）；流水线内 stages 按序串行，stage 内 jobs 可串行（数组）或并行（对象）。阶段 9、11 在三条流水线中重复出现，修改时须同步（§3 CIL-021）。

## 2. 触发矩阵

`CIL-010`：分支×事件×流水线：

| 分支（glob） | 事件 | 执行流水线 | 依据 |
|---|---|---|---|
| `(main\|dev)` | `pull_request`（含推送更新） | docs-check ＋ code-check | CI-002 规则 1 |
| `(main\|dev)` | `push`（合并后回归） | docs-check ＋ code-check | CI-001 精神，合并后分支自身质量可观测 |
| `v*` | `tag_push` | release-check（全量＋发布证据） | CI-002 规则 3 |
| 其他分支 | 任意 | 无流水线 | 分支自身无配置则不触发；MR 到 main/dev 时按**目标分支**配置执行（CNB 规则：PR 事件读取目标分支配置） |

`CIL-011`：**docs-check 无条件执行**——任何变更（含纯文档、`.cnb.yml` 自身）都先过秘密扫描与文档链接检查，对应 CI-002 规则 2"纯文档变更保留阶段 9 与 11"。

`CIL-012`：**code-check 用 `ifModify` 分流**，仅当变更文件命中以下规则才执行：

```yaml
ifModify:
  - "**"                 # 命中一切变更
  - "!(docs/**)"         # 排除文档目录
  - "!(**/*.md)"         # 排除所有 Markdown
  - "!*.md"
  - "!(scripts/ci/**)"   # 排除 CI 脚本自身
```

即：变更 `src/**`、`test/**`、构建配置、`.cnb.yml` 等时执行；纯文档/纯 CI 脚本变更时不执行。PR 事件按 PR 变更文件统计，push 事件按 before/after 差异统计（新分支 push 无法统计时视为命中，全量执行）。

`CIL-013`：**代码未开工保护**：仓库当前无 `package.json`（代码未开工，GOV-CODE-WAIVER-001 后仍处于文档期）。所有代码阶段以 `if` 条件检查 `package.json` / 锁文件存在性，不存在即跳过（不影响流水线状态）；**代码开工后（首个 `package.json` 合入）各阶段自动激活，此后锁文件缺失/漂移即失败**（CI-001 阶段 1 门禁）。当前仓库状态下：docs-check 两条阶段真实执行，code-check 全部阶段跳过，流水线保持绿色。

`CIL-014`：**端到端执行流程示例**（一次典型 MR 的完整旅程）：

1. 开发者在 feature 分支推送变更（如仅文档变更）并创建 MR（feature → dev）；
2. 平台读取**目标分支 dev** 的 `.cnb.yml`（PR 事件按"预合并后的 Commit"执行，配置取自目标分支），生成 docs-check 与 code-check 两条流水线；
3. 并行执行：docs-check 跑阶段 9（gitleaks）→ 阶段 11（链接检查）；code-check 因变更仅命中 `docs/**`（ifModify 排除列表）**不执行**；
4. MR 页状态检查显示 docs-check 通过 → 评审通过 → 合并；
5. 合并触发 dev 分支 push 事件 → docs-check＋code-check 回归（dev 合并后自身质量可观测）；
6. 发布时打 `v1.0.0` tag → `v*` 匹配 `tag_push` → release-check 全量执行（阶段 1~11），endStages 输出发布门证据摘要（CI-004）；
7. 阶段 9/11 的构建日志归档为执行证据，结论回填 `TST-*`/`OPS-VER-*`/`TVER-*`（CIL-043）。

若第 3 步 docs-check 失败（秘密命中或断链）：MR 被状态检查阻断（配合保护分支），开发者本地按 §6 复现修复后重新推送，流水线自动重跑（含推送更新事件）。

## 3. 阶段实现明细（CI-001 十一阶段 → 配置映射）

`CIL-020`：下表为逐阶段映射；命令名（`npm run test:unit` 等）为按工程约定的建议名，代码开工落地 package.json 时按 [后端工程约定](后端工程约定-v1.0.md) 与 [测试执行计划](测试执行计划-v1.0.md) 对齐，**命令名变更不影响门禁语义**。

| CI-001 阶段 | 流水线 | 配置位置 | 命令 | 门禁 | 当前状态 |
|---|---|---|---|---|---|
| 1 安装 | code-check / release-check | 阶段 `1-安装` | `npm ci`（锁文件驱动） | 通过；锁文件缺失/漂移失败 | 代码就绪后激活 |
| 2 类型检查 | code-check / release-check | 阶段 `2-类型检查` | `npx tsc --noEmit -p tsconfig.json` | 通过 | 代码就绪后激活 |
| 3 Lint | code-check / release-check | 阶段 `3-Lint与格式` | `npm run lint` ＋ `npm run format:check` | 通过 | 代码就绪后激活 |
| 4 单元测试 L1 | code-check / release-check | 阶段 `4-单元测试L1` | `npm run test:unit` | 通过；覆盖率不设硬下限，新增代码须有对应用例 | 代码就绪后激活 |
| 5 集成测试 L2 | code-check / release-check | 阶段 `5-集成测试L2` | `npm run test:integration`（真实 PG18，见 §7.2） | 通过 | 代码就绪后激活 |
| 6 契约测试 L3 | code-check / release-check | 阶段 `6-契约测试L3` | `npm run test:contract` | 通过 | 代码就绪后激活 |
| 7 构建 | code-check / release-check | 阶段 `7-构建` | `npm run build` ＋ `npm run build:worker`（HTTP 与 Worker 双入口，ADR-001/ADR-013） | 通过 | 代码就绪后激活 |
| 8 镜像 | code-check / release-check | 阶段 `8-镜像构建`（release 为 `8-镜像构建推送`） | `docker build`，tag 为提交 SHA（release 为版本 Tag）；push 至 CNB 制品库 | 通过（tag 非 latest） | Dockerfile 出现后激活 |
| 9 秘密扫描 | docs-check / code-check / release-check | 阶段 `9-秘密扫描` | gitleaks v8.30.0（固定版本，见 §4.3）`detect --source . --redact` | 0 命中 | **已激活** |
| 10 依赖审计 | code-check / release-check | 阶段 `10-依赖审计与许可证登记` | `npm audit --audit-level=high` ＋ `scripts/ci/check-license-registry.sh` | 无关键/高危未处置项；DEP-003 登记一致 | 代码就绪后激活（登记检查脚本已就位） |
| 11 文档一致性 | docs-check / code-check / release-check | 阶段 `11-文档链接一致性` | `bash scripts/ci/check-docs-links.sh` | 全部相对链接有效 | **已激活** |

`CIL-021`：阶段 9、11 在所有流水线中重复出现（docs-check 双阶段、code-check/release-check 全量），修改时须同步三处；§6 给出本地复现命令。

`CIL-022`：**阶段跳过语义**：stage 的 `if` 条件不满足时该 stage 被跳过（跳过不算失败，不阻断流水线）；同一流水线内 stage 按序串行，前一 stage 失败即中止后续 stage（不执行 failStages 时状态直接失败上报）。"跳过"与"失败"在构建记录中分别标注，排查时注意区分。

## 4. 环境与密钥

### 4.1 构建镜像

`CIL-030`：所有流水线使用 `node:24`（与 [依赖与版本基线](依赖与版本基线-v1.0.md) §2 "Node.js 24 LTS（Active）"一致）。升级 Node 基线时同步修改 `.cnb.yml` 全部 `docker.image`。

### 4.2 内置环境变量与密钥

`CIL-031`：使用 CNB 内置只读变量：`CNB_BRANCH`（分支或 Tag 名）、`CNB_COMMIT_SHORT`（构建提交短 SHA）、`CNB_DOCKER_REGISTRY`（制品库 Docker 源）、`CNB_EVENT`、`CNB_IS_TAG` 等，完整清单见[官方文档](https://docs.cnb.cool/zh/build/build-in-env.md)。流水线内不得将秘密写入 `.cnb.yml` 或仓库任何文件。

`CIL-032`：当前阶段无私有凭据需求（npm 公开源、镜像公开）。需要私有 npm 源 / 私有镜像时：凭据放入 cnb.cool **密钥仓库**文件，流水线用 `imports` 引用（如 `imports: https://cnb.cool/<slug>/-/blob/<branch>/npm.yml`），禁止明文入仓。

### 4.3 gitleaks 版本固定与升级

`CIL-033`：阶段 9 固定 gitleaks `v8.30.0`（从 GitHub Releases 下载 `gitleaks_8.30.0_linux_x64.tar.gz`，解压到 `/usr/local/bin`）。升级步骤：更新 `.cnb.yml` 三处下载 URL → 本地按 §6 复现一次 → 提交。若 cnb.cool 构建节点访问 GitHub 不稳定，将二进制预置到 CNB 制品库/内网镜像并在配置中改引（见 §7.4）。

### 4.4 gitleaks 误报豁免规则

`CIL-034`：阶段 9 门禁为 **0 命中**；gitleaks 使用通用正则规则，文档/测试中的占位示例（如配置规格草案的示例值、测试标记 `SYN-SENSITIVE-MARKER-*`）可能被误报。豁免规则：

1. **真实秘密一律不得豁免**：移除并轮换（若已推送到远端），立即在 MR 中处理；
2. 假阳性需豁免时，在仓库根新增 `.gitleaks.toml`，仅对**精确路径/正则**做 `allowlist`，每条豁免必须带注释说明原因；
3. 豁免文件随 MR 提交并单独可辨（评审时逐条核对），禁止为掩盖秘密添加豁免；
4. 当前仓库在 gitleaks `v8.30.0` 下实测 0 命中，无需豁免；未来命中时先按 §9 FAQ 判断类型再处理。

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

# 阶段 9：秘密扫描（macOS 按本机架构下载 darwin 版；Intel 用 darwin_x64，Apple Silicon 用 darwin_arm64；CI 使用 linux_x64）
curl -sSfL https://github.com/gitleaks/gitleaks/releases/download/v8.30.0/gitleaks_8.30.0_darwin_arm64.tar.gz -o /tmp/gitleaks.tar.gz
tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks
gitleaks detect --source . --no-banner --redact

# 阶段 10 辅助：许可证登记一致性（当前仓库无 package.json 时输出 SKIP）
bash scripts/ci/check-license-registry.sh
```

`CIL-051`：`check-docs-links.sh` 覆盖 `docs/`、`src/`、`test/` 与根 `README.md` 的全部 Markdown 相对链接（含锚点剥离、外部 URL 跳过）；**任何文档变更在本地先跑一遍再提交**。

## 7. 边界与后续

### 7.1 前端仓库

`CIL-060`：CI-001 中"前后端"字样：本仓库（rana-minder-service）只承载后端；前端对应阶段（npm ci/tsc/lint/构建）由前端仓库 `rana-minder-web` 的流水线承载，两端流水线独立，契约一致性由 [前后端契约对齐](前后端契约对齐-v1.0.md) 的文档与人工门保证。

### 7.2 集成测试 L2 的真实 PG18

`CIL-061`：cnb.cool 未提供托管 PostgreSQL 服务，采用"dind 服务 + 容器内运行 PG18"方案：流水线已声明 `services: [docker]`（code-check / release-check），代码开工后在阶段 5 脚本中启动 `postgres:18` 容器（含扩展/RLS/约束，测试库隔离），再运行 `npm run test:integration`；容器启动命令的占位注释已写入配置。

### 7.3 依赖许可证登记表

`CIL-062`：[依赖与版本基线](依赖与版本基线-v1.0.md) §4（DEP-003）当前为规则条款、尚无逐依赖登记表；`check-license-registry.sh` 在 package.json 出现后要求每个直接依赖在登记表中出现（名称级匹配）。登记表落表格式由依赖与版本基线维护者定义后，本脚本按需收紧为"名称+版本+许可证"三字段匹配。

### 7.4 构建节点网络依赖

`CIL-063`：阶段 9 下载依赖 GitHub Releases；若 cnb.cool 构建节点网络受限，将 gitleaks 二进制上传至 CNB 制品库（或镜像），修改配置下载地址即可，门禁语义不变。

### 7.5 保护分支对接

`CIL-064`：main/dev 设为保护分支并勾选"需要通过状态检查"后，docs-check/code-check 结果自动成为合并门（CI-003 规则 1）；未开启状态检查时流水线仍执行，但不自动阻断合并，需人工把关。

## 8. 平台启用与日常操作

`CIL-070`：**启用自动触发**：仓库「设置 → 云原生构建 → 允许自动触发」开启（默认开启）；首次提交 `.cnb.yml` 并 push 后即生效。Fork 仓库默认不触发，需在「设置 → 云原生构建」勾选"Fork 的仓库默认允许自动触发"（本仓库非 Fork 场景，无需处理）。

`CIL-071`：**保护分支配置**（让流水线结果成为合并门，CI-003 规则 1）：仓库「设置 → 分支规则」→ 对 `main` 与 `dev` 分别设置：勾选「需要评审人批准」＋「需要通过状态检查」；此后 docs-check/code-check 任一失败即阻断合并，未配置时流水线仍执行但不自动阻断（§7.5）。

`CIL-072`：**查看与重跑**：仓库「云原生构建」标签页查看构建记录、展开阶段日志（含 gitleaks/链接检查输出）；失败构建可点击「重跑」（对应 CI-005 规则 2 的手动重跑路径）。MR 页的状态检查区展示最近一次结果。

`CIL-073`：**发布流程**：发布时推送版本 tag（如 `v1.0.0`，匹配 `v*`）即自动触发 release-check；镜像产出至 CNB Docker 制品库（`CNB_DOCKER_REGISTRY`），版本 Tag 即镜像 tag（非 latest）。**首次启用验证清单**：修改一行 README 并 push 到 dev → 确认 docs-check 两条阶段执行且绿色；再打一个临时 tag 验证 release-check 触发（验证后可删）。

## 9. 常见问题排查（FAQ）

| # | 现象 | 原因与处置 |
|---|---|---|
| `CIL-080` | MR 未触发任何流水线 | ① 目标分支（dev/main）上尚无 `.cnb.yml`（配置未合入目标分支，PR 事件读取目标分支配置）→ 先合并配置 MR；② 云原生构建自动触发未开启（CIL-070）；③ Fork 仓库默认不触发 |
| `CIL-081` | code-check 未执行 | 预期行为：变更仅命中 `docs/**`、`*.md`、`scripts/ci/**`（CIL-012）；或推送的是**新分支**（无 before 对比基准，push 事件不统计变更，此时视为命中会全量执行；MR 事件按 PR 变更统计） |
| `CIL-082` | gitleaks 下载失败/超时 | 偶发网络问题：按 CIL-041 重跑一次；持续失败按 §7.4 将二进制预置到 CNB 制品库/内网镜像并改引配置；本地可用 §6 命令验证扫描本身 |
| `CIL-083` | gitleaks 报命中 | ① 真实秘密：立即移除并轮换，禁止豁免；② 假阳性（占位示例/测试标记）：按 §4.4 加 `.gitleaks.toml` 豁免并注明原因 |
| `CIL-084` | 阶段 11 链接检查失败 | 本地跑 `bash scripts/ci/check-docs-links.sh` 查看 BROKEN LINK 行；常见原因：文件移动/新增目录后 `../` 层数不对、文件名大小写不匹配（Linux 区分大小写）、忘记提交目标文件 |
| `CIL-085` | 本地与 CI 结果不一致 | CI 在 Linux 节点、`node:24` 容器中运行检出内容；本地未跟踪文件（`.DS_Store` 等）不会出现在 CI；gitleaks 版本须与 CI 一致（固定 v8.30.0）；路径大小写问题只在 Linux 暴露 |
| `CIL-086` | 如何本地校验 `.cnb.yml` 语法 | VSCode 安装 `redhat.vscode-yaml` 并配置 schema（https://docs.cnb.cool/conf-schema-zh.json）；或本地用 yaml 解析器（python/ruby）解析后确认无语法错误；提交前检查分支/事件/流水线名与文档一致 |
| `CIL-087` | 阶段显示"跳过"（SKIP） | 预期行为：代码未开工阶段按 CIL-013 跳过，不算失败；代码开工后任一代码阶段跳过需立即排查（配置被误改/文件缺失） |
| `CIL-088` | feature 分支 push 不触发 | 预期行为：只有目标分支（dev/main）与 `v*` 配置生效；feature 分支自身无配置则不触发，MR 到 dev 后按 dev 配置执行（CIL-010） |

## 10. 检查结论

| 检查项 | 结果 |
|---|---|
| 流水线配置（.cnb.yml） | 已落地（main/dev × PR/push、v* × tag） |
| CI-001 十一阶段映射 | 已映射（§3 表）；阶段 9、11 当前真实执行，其余代码就绪后自动激活 |
| CI-002 触发策略 | 已落地（ifModify 分流、纯文档只跑 9+11、tag 全量+证据） |
| 检查脚本 | check-docs-links.sh（已激活，全量链接零断链，数字以本地最新运行为准）；check-license-registry.sh（待代码就绪激活） |
| 平台操作说明 | 已补充（§8 启用、保护分支、查看/重跑、发布与首启验证清单） |
| 常见问题排查 | 已补充（§9 九类现象与处置） |
| 既有断链修复 | src/modules/分层实现规范.md 15 处链接已修复（`../architecture/` 等缺少 `../../docs/` 前缀） |
| 密钥 | 无入仓秘密；私有凭据预留密钥仓库 imports 通道 |
| 前端对应阶段 | 由 rana-minder-web 仓库单独承载（§7.1） |
