#!/usr/bin/env bash
# ============================================================
# RanaMinder 镜像本地验证脚本（DOCK-080 / DOCK-081）
# 权威依据：docs/engineering/Docker镜像构建规范-v1.0.md §9（DOCK-080/081）
#
# 职责：对本地构建的 RanaMinder 镜像执行可重复的冒烟与安全验证，
#       覆盖 DOCK-081 的验证项。需 Docker 可用；代码就绪后即可执行。
#
# 用法：
#   bash scripts/verify-image.sh [IMAGE_TAG]
#     默认 IMAGE_TAG=ranaminder-service:dev
#     退出码：0=全部通过；非 0=存在失败项（逐项打印 PASS/FAIL）
#
# 前置：
#   - 已构建镜像（docker build -t ranaminder-service:dev .）
#   - 已准备好示例配置（config.example.yaml 复制为 config.dev.yaml）
#   - 本脚本自身不启动开发依赖服务（postgres/minio/casdoor），
#     仅验证镜像构建产物与只读挂载/启动边界。
# ============================================================
set -u

IMG="${1:-ranaminder-service:dev}"
CONF="${CONF_FILE:-$PWD/config.dev.yaml}"
FAIL=0
NAME_HTTP="ranaminder-verify-http"
NAME_WORKER="ranaminder-verify-worker"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
pass() { log "PASS: $*"; }
fail() { log "FAIL: $*"; FAIL=1; }

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: 本机无 docker，无法执行镜像验证（DOCK-080/081）。" >&2
    echo "请在具备 Docker 的环境执行，或在 CI 阶段 8 后按 DOCK-081 核对。" >&2
    exit 2
  fi
}

require_conf() {
  if [ ! -f "$CONF" ]; then
    echo "ERROR: 缺少示例配置 $CONF，请先：cp config.example.yaml config.dev.yaml" >&2
    exit 2
  fi
}

cleanup() {
  docker rm -f "$NAME_HTTP" >/dev/null 2>&1 || true
  docker rm -f "$NAME_WORKER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

require_docker
require_conf

log "验证镜像: $IMG"
if ! docker image inspect "$IMG" >/dev/null 2>&1; then
  fail "镜像存在（$IMG）。请先 docker build -t $IMG ."
  exit 1
fi

# ---- DOCK-081 验证项 ----
# 1) 非 root 用户生效
log "— 验证 1/5：非 root 用户（DOCK-040）"
if docker run --rm --entrypoint id "$IMG" 2>/dev/null | grep -q 'uid=10001'; then
  pass "非 root 用户 uid=10001"
else
  fail "镜像未以 uid=10001 的非 root 用户运行"
fi

# 2) 镜像内不含配置/秘密层（docker history 无 config 层）
log "— 验证 2/5：镜像层无配置/秘密（DOCK-041/044、ADR-010）"
if docker history "$IMG" 2>/dev/null | grep -qiE 'config\.yaml|\.env|secret|\.key'; then
  fail "镜像层疑似含配置/秘密，请检查 .dockerignore"
else
  pass "docker history 无配置/秘密层"
fi

# 3) HTTP 入口启动 + 只读根 + tmpfs（DOCK-042）
log "— 验证 3/5：HTTP 入口（node dist/main.js）只读启动"
if docker run --rm -d --name "$NAME_HTTP" \
     -v "$CONF:/etc/ranaminder/config.yaml:ro" \
     --read-only --tmpfs /tmp \
     -p 127.0.0.1:3000:3000 \
     "$IMG" >/dev/null 2>&1; then
  # 给启动留时间；健康判定由应用启动逻辑决定（DOCK-043）
  sleep 5
  if docker inspect -f '{{.State.Running}}' "$NAME_HTTP" 2>/dev/null | grep -q true; then
    pass "HTTP 入口只读启动成功"
  else
    fail "HTTP 入口未保持运行，日志见：docker logs $NAME_HTTP"
  fi
else
  fail "HTTP 入口启动失败"
fi

# 4) Worker 入口启动（命令覆盖，DOCK-030）
log "— 验证 4/5：Worker 入口（node dist/main.worker.js）"
if docker run --rm -d --name "$NAME_WORKER" \
     -v "$CONF:/etc/ranaminder/config.yaml:ro" \
     --read-only --tmpfs /tmp \
     "$IMG" node dist/main.worker.js >/dev/null 2>&1; then
  sleep 5
  if docker inspect -f '{{.State.Running}}' "$NAME_WORKER" 2>/dev/null | grep -q true; then
    pass "Worker 入口启动成功"
  else
    fail "Worker 入口未保持运行，日志见：docker logs $NAME_WORKER"
  fi
else
  fail "Worker 入口启动失败"
fi

# 5) 配置只读挂载生效
log "— 验证 5/5：配置只读挂载（/etc/ranaminder/config.yaml:ro）"
if docker inspect "$NAME_HTTP" 2>/dev/null | grep -q '"/etc/ranaminder/config.yaml";.*"ro"\|"/etc/ranaminder/config.yaml"};.*ro'; then
  pass "配置以只读方式挂载"
else
  # 容错：改用 docker inspect 的 Mounts 段判断
  if docker inspect --format '{{range .Mounts}}{{.Destination}}:{{.RW}}{{end}}' "$NAME_HTTP" 2>/dev/null | grep -q '/etc/ranaminder/config.yaml:false'; then
    pass "配置以只读方式挂载"
  else
    fail "配置未以只读方式挂载"
  fi
fi

# ---- 汇总 ----
log "=================================="
if [ "$FAIL" = 0 ]; then
  log "DOCK-080/081 验证全部通过 ✔"
  exit 0
else
  log "存在失败项 ✘，请按 Docker镜像构建规范 §9 排查。"
  exit 1
fi
