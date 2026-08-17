# RanaMinder Docker 镜像构建规范 v1.0

> 文档状态：实现准备评审草案；Dockerfile、.dockerignore、docker-compose.dev.yml 已随本文落地  
> 草案日期：2026-08-14  
> 权威来源：[ADR-010 单文件外置配置与 Docker 只读挂载](../architecture/ADR-010-单文件外置配置与Docker只读挂载.md)、[ADR-012 分级部署与恢复优先的生产拓扑](../architecture/ADR-012-分级部署与恢复优先的生产拓扑.md)、[ADR-013 Vue 与 NestJS 首版应用技术栈](../architecture/ADR-013-Vue与NestJS首版应用技术栈.md)、[依赖与版本基线](依赖与版本基线-v1.0.md)（§2 Node 基线、§4 DEP-Q-003 镜像基础选型）、[CI 与质量门定义](CI与质量门定义-v1.0.md)（CI-001 阶段 8）、[CI 流水线落地指南](CI流水线落地指南-v1.0.md)（§3 阶段 8 映射）、[启动入口文档](../../src/启动入口文档.md)、[部署运维与恢复手册](../operations/部署运维与恢复手册-v1.0.md)（§13 标准部署边界、§18 开源发布检查）  
> 用途：定义后端服务镜像的构建规则（基础镜像、多阶段构建、双入口、运行身份、配置只读挂载、健康检查、tag 规范），是 CI 阶段 8（镜像构建）的实现依据；**生产部署编排（官方单机/拆分 Compose）属部署运维手册体系，另行收口，本文件不含**

## 1. 定位与范围

`DOCK-001`：范围：镜像**构建**规则与落地文件（`Dockerfile`、`.dockerignore`、开发环境 `docker-compose.dev.yml`）；不包含生产部署编排、镜像制品库发布流程（见部署运维手册 §13/§18）。

`DOCK-002`：前置：代码尚未开工（无 `package.json`），本规范与落地文件以 [启动入口文档](../../src/启动入口文档.md)、[后端工程约定](后端工程约定-v1.0.md)、[依赖与版本基线](依赖与版本基线-v1.0.md) 为输入编写；代码就绪后镜像可直接构建。DEP-Q-003（基础镜像）正式确认前，本节选型为**强候选约定，不冻结**。

`DOCK-003`：镜像形态：**单镜像双入口**——HTTP 应用（`dist/main.js`）与后台任务（`dist/worker.js`）共用同一镜像与编译产物（[启动入口文档](../../src/启动入口文档.md)、ADR-013 §2.3、OPS-TOPO-003），以启动命令区分；不设独立 worker 镜像，未来拆分部署仍同镜像不同命令（ADR-012）。

## 2. 基础镜像选型（DEP-Q-003 候选评估）

`DOCK-010`：候选评估（运行阶段）：

| 候选 | 体积 | 安全补丁速度 | pg 客户端与 CA | 健康检查/调试工具 | 结论 |
|---|---|---|---|---|---|
| `node:24-slim` | 中等（~90 MB） | 官方同步更新 | 自带 CA，node-postgres 纯 JS 无需编译 | 可 apt 安装 curl/wget；可调试 | **强候选（本规范采用）** |
| distroless（nodejs 24） | 小 | 定期更新 | 需另挂 CA 证书；镜像不含 shell | 无 shell，健康检查受限 | 候选；DEP-Q-003 若确认则仅改运行阶段 FROM |
| alpine（node:24-alpine） | 最小 | 官方同步更新 | musl 兼容性需验证（pg 原生扩展场景）；CA 需 apk | busybox 工具 | 候选；node-postgres 场景收益有限 |

`DOCK-011`：选型结论：**构建阶段 `node:24`（官方，含完整工具链）＋ 运行阶段 `node:24-slim`**。理由：与 [依赖与版本基线](依赖与版本基线-v1.0.md) §2 的 Node.js 24 LTS 基线一致；node-postgres 为纯 JS 客户端无编译负担；自带 CA 证书（HTTPS 出站）；非 root 与只读挂载约束可用官方镜像原生支持。若 DEP-Q-003 最终确认 distroless：仅调整运行阶段 `FROM` 与健康检查工具，构建阶段与 §3 不变。

## 3. 多阶段构建

`DOCK-020`：两阶段结构（`Dockerfile` 已落地，与本节一致）：

```dockerfile
# 构建阶段：锁文件驱动安装 + 编译（包管理器为 pnpm，与 package.json / CI 一致）
FROM node:24 AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build        # 产出 dist/main.js 与 dist/worker.js

# 运行阶段：生产依赖 + 编译产物，不含源码与工具链
FROM node:24-slim AS runtime
ENV NODE_ENV=production TZ=UTC RANAMINDER_CONFIG=/etc/ranaminder/config.yaml
WORKDIR /app
RUN groupadd --gid 10001 ranaminder && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin ranaminder && mkdir -p /etc/ranaminder
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile && pnpm store prune
COPY --from=build /app/dist ./dist
USER ranaminder
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

`DOCK-021`：规则：

1. **依赖层缓存**：`package.json` 与 pnpm 锁文件（`pnpm-lock.yaml`）先于源码 COPY，依赖未变时 `pnpm install --frozen-lockfile` 层命中缓存；
2. **运行期依赖独立安装**：运行阶段 `pnpm install --prod --frozen-lockfile`（锁文件驱动），不复制构建期 `node_modules`，避免 dev 依赖与构建平台差异进入镜像；
3. **源码不进入运行阶段**：仅复制 `dist/` 产物；`docs`、`test`、`scripts` 等由 `.dockerignore` 排除（§6）；
4. 构建命令与 CI 阶段 7 一致（`pnpm run build`）；若后续引入独立 worker 构建脚本（`build:worker`），在构建阶段同步执行。

## 4. 双入口镜像

`DOCK-030`：镜像默认启动 HTTP 应用（`CMD ["node", "dist/main.js"]`）；后台任务入口以**编排层命令覆盖**启动（`command: ["node", "dist/worker.js"]`）。两个容器共用镜像与 tag，以容器名/服务名区分职责：

| 入口 | 命令 | 监听 | 健康探针 |
|---|---|---|---|
| HTTP 应用（app） | `node dist/main.js` | `:3000`（EXPOSE） | 编排层定义（§5 DOCK-043） |
| 后台任务（worker） | `node dist/worker.js` | 无 | 进程存活探针 |

`DOCK-031`：双入口各自的启动前置（配置校验、依赖就绪、启动状态上报）由 [启动入口文档](../../src/启动入口文档.md) 与部署运维手册 §8 约束，镜像层不重复实现。

## 5. 运行安全基线

`DOCK-040`：**非 root 运行**：运行阶段创建 `ranaminder` 用户（uid/gid 10001）并 `USER ranaminder`；`NODE_ENV=production`、`TZ=UTC`。

`DOCK-041`：**配置只读挂载（ADR-010）**：容器内固定受控位置 `/etc/ranaminder/config.yaml`（`RANAMINDER_CONFIG` 指向）；真实配置在宿主机部署目录，以只读卷挂载，**绝不 COPY 入镜像、绝不含示例配置**；应用不得覆盖/补写该文件。镜像内不携带任何配置样例。

`DOCK-042`：**根文件系统只读**：容器以 `--read-only` 运行（`--tmpfs /tmp` 提供临时写入），由编排层配置；镜像本身按只读根设计（无运行时写路径）。

`DOCK-043`：**健康检查**：`Dockerfile` 不内置 `HEALTHCHECK`（worker 无监听端口，内置会误判）；HTTP 容器的健康检查由编排层定义——首版用 TCP 探针（`:3000`）或进程探针；HTTP 健康端点与 ops 模块内置状态页/启动判定（部署运维手册 §8）落地时对齐，不臆造端点。

`DOCK-044`：**秘密防护**：`.dockerignore` 排除 `config*.yaml`、`*.key`、`*.pem`、`.env*` 等（§6），确保构建上下文与镜像层无真实秘密（ADR-010 §3）；CI 阶段 9（gitleaks）对仓库与构建产物扫描是**第一道防线**，`.dockerignore` 是第二道。

## 6. 镜像内容与 .dockerignore

`DOCK-050`：镜像内容清单（运行阶段）：

| 包含 | 排除 |
|---|---|
| `dist/`（main.js、worker.js 及产物） | `docs/`、`test/`、`scripts/` |
| `node_modules/`（仅生产依赖） | `.git`、`.opencode`、`.DS_Store` |
| `package.json` ＋ 锁文件 | `.cnb.yml`、`docker-compose*.yml`、`Dockerfile` |
| — | 配置样例与秘密（`**/config*.yaml`、`.env*`、`*.key`、`*.pem`） |

`DOCK-051`：`.dockerignore` 已落地于仓库根；新增文件时按上表归类，原则：**镜像只需要运行所需的编译产物与生产依赖，其余一律排除**。

## 7. 镜像 tag 与版本

`DOCK-060`：tag 规则与 CI 对齐（[CI 流水线落地指南](CI流水线落地指南-v1.0.md) §3 阶段 8）：

| 场景 | tag | 说明 |
|---|---|---|
| MR/分支构建（CI 阶段 8） | `<CNB_COMMIT_SHORT>` | 提交短 SHA，非 latest |
| 发布 tag（release-check 阶段 8） | `v<版本号>` | 版本号即镜像 tag，非 latest，push 至 CNB 制品库 |

`DOCK-061`：**禁止 `latest` 用于可复现发布**（CI-001 阶段 8 门禁）；开发环境本地验证可用任意本地 tag。

## 8. 与 CI 对接

`DOCK-070`：CI 阶段 8 门禁条件由 `[ -f Dockerfile ]` 收紧为 `[ -f package.json ] && [ -f Dockerfile ]`（`.cnb.yml` 三处同步）：Dockerfile 已落地但代码未开工时阶段跳过，代码就绪后自动激活；门禁语义不变（构建通过、tag 非 latest）。

`DOCK-071`：镜像构建使用 CNB 制品库地址（`CNB_DOCKER_REGISTRY`/ranaminder-service）；dind 服务（`services: [docker]`）已声明；发布阶段推送后镜像即发布证据（release-check endStages 证据摘要第 6 项）。

## 9. 本地构建与验证

`DOCK-080`：本地验证命令（代码就绪后）：

```bash
# 构建（tag 任意本地名）
docker build -t ranaminder-service:dev .

# HTTP 入口冒烟：只读挂载示例配置 + 只读根 + 临时卷
docker run --rm -d --name ranaminder-app   -v "$PWD/config.dev.yaml:/etc/ranaminder/config.yaml:ro"   --read-only --tmpfs /tmp -p 3000:3000 ranaminder-service:dev

# worker 入口冒烟（命令覆盖）
docker run --rm -d --name ranaminder-worker   -v "$PWD/config.dev.yaml:/etc/ranaminder/config.yaml:ro"   --read-only --tmpfs /tmp ranaminder-service:dev   node dist/worker.js

# 开发环境依赖服务（PG18/MinIO/Casdoor/Mailpit）
docker compose -f docker-compose.dev.yml up -d
```

`DOCK-081`：验证项：双入口分别启动成功；只读配置生效（容器内 `/etc/ranaminder/config.yaml` 只读）；`docker history` 无配置/秘密层；非 root 用户生效（`docker exec id`）；`docker run --read-only` 无写路径异常。

## 10. 检查结论

| 检查项 | 结果 |
|---|---|
| 镜像构建规范 | 已落地（本文件） |
| Dockerfile（多阶段、双入口、非 root） | 已落地（仓库根） |
| .dockerignore（秘密与杂物排除） | 已落地（仓库根） |
| 开发环境编排 docker-compose.dev.yml | 已落地（仓库根，四依赖服务） |
| postgres 初始化脚本 | 已落地（scripts/dev/postgres-init.sql，挂载 init 自动执行） |
| CI 阶段 8 门禁 | 已同步（Dockerfile＋package.json 双条件，三处配置） |
| DEP-Q-003 | 保持待确认；node:24-slim 为强候选（§2），确认后按 DOCK-011 调整 |
| 生产部署编排 | 不属本文件范围（部署运维手册体系另行收口） |
