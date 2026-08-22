# syntax=docker/dockerfile:1
# ============================================================
# RanaMinder Service 镜像（HTTP 应用与后台任务双入口，单镜像）
# 权威依据：docs/engineering/Docker镜像构建规范-v1.0.md（DOCK-001~081）
#          ADR-010（配置只读挂载）、ADR-013（Node 24 / NestJS 双入口）、
#          依赖与版本基线（Node 24 LTS；DEP-Q-003 未冻结，node:24-slim 为强候选）
# 注意：本文件与 .cnb.yml CI 阶段 8 联动；代码未开工时阶段自动跳过
# ============================================================

# ---- 构建阶段（node:24 官方，含完整工具链）----
FROM node:24 AS build
WORKDIR /app
# 锁文件驱动安装（pnpm-lock.yaml），依赖未变时命中缓存层；
# 通过 corepack 使用与 package.json packageManager 匹配的 pnpm 版本
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
# 编译产物：dist/main.js（HTTP 应用）、dist/main.worker.js（后台任务），
# 共用同一编译产物，见 src/启动入口文档.md
COPY . .
RUN pnpm run build && pnpm run build:worker

# ---- 运行阶段（node:24-slim，DEP-Q-003 强候选）----
FROM node:24-slim AS runtime

ENV NODE_ENV=production \
    TZ=UTC \
    RANAMINDER_CONFIG=/etc/ranaminder/config.yaml

WORKDIR /app

# 非 root 运行身份（DOCK-040）
RUN groupadd --gid 10001 ranaminder && \
    useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin ranaminder && \
    mkdir -p /etc/ranaminder && \
    chown -R ranaminder:ranaminder /app /etc/ranaminder

# 生产依赖独立安装（锁文件驱动；不复制构建期 node_modules，DOCK-021）
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile && pnpm store prune && \
    # 运行阶段不需要 npm/corepack/pnpm 命令，移除基础镜像自带 npm 与 corepack（及其 pnpm 缓存），
    # 消除其依赖层 HIGH/CRITICAL 漏洞（DOCK-061 发布门 / DEP-003 镜像供应链门禁）
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /root/.cache/node/corepack

# 编译产物（源码、docs、test 等不进入运行阶段，见 .dockerignore）
COPY --from=build /app/dist ./dist

USER ranaminder
EXPOSE 3000

# 双入口：默认 HTTP 应用；后台任务以编排层命令覆盖：
#   command: ["node", "dist/main.worker.js"]
CMD ["node", "dist/main.js"]
