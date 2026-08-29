#!/usr/bin/env bash
# C1/C2/C4 实测冒烟（联调收口；scripts/dev/smoke-c1-c2-c4.sh）
#
# 前置：联调四容器（postgres/mailpit/casdoor/minio）healthy，
#       已 apply 迁移 + scripts/dev/seed-org-authz.sql + migration 20260828120000
# 用法：bash scripts/dev/smoke-c1-c2-c4.sh
#
# 用真实 JWT 锻造（deriveSessionSecret v1 = sha256 hex）覆盖：
# - C2：GET /api/auth/profile（建档/资料门）
# - C2：PUT /api/auth/profile + 乐观锁冲突 IFC-ERR-008 + currentData
# - C4：logout 写吊销行 + 旧 token 在保护路由上 401（≤5s）
#
# C1（send-email-code → Mailpit → verify-email）需 EMAIL_PENDING 状态主体，
# 本环境无干净种子时由人工浏览器联调跑全链；端点逻辑 + 状态守卫由单元测试覆盖。
set -euo pipefail

WT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SVC_ROOT="$WT_ROOT/rana-minder-service-wt"
ENV_FILE="$SVC_ROOT/.env.dev.local"
[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE"; exit 2; }
set -a; source "$ENV_FILE"; set +a

sign_token() {
  python3 - "$1" <<'PY'
import sys, time, subprocess, hashlib, base64, hmac
sub = sys.argv[1]
secret = subprocess.check_output(['bash','-c',
  'set -a; source "'+sys.argv[2]+'"; set +a; echo -n "$WT44_CASDOOR_CLIENT_SECRET"'
]).decode().strip()
key = hashlib.sha256(('ranaminder-session:' + secret).encode()).hexdigest().encode()
def b64(b): return base64.urlsafe_b64encode(b).rstrip(b'=').decode()
h = b64(b'{"alg":"HS256","typ":"JWT"}')
payload = {"sub":sub,"name":"admin","email":"admin@example.com","iat":int(time.time())-2,"degraded":False}
pb = b64(json.dumps(payload).encode())
import json
sig = b64(hmac.new(key, f"{h}.{pb}".encode(), hashlib.sha256).digest())
print(f"{h}.{pb}.{sig}")
PY
}

TK=$(sign_token "ranaminder-dev__admin__fixed" "$ENV_FILE")
HOST=${HOST:-http://127.0.0.1:3001}
A=(-H "Authorization: Bearer $TK" -H "Content-Type: application/json")

echo "## C2：GET profile"
curl -s "${A[@]}" "$HOST/api/auth/profile" | python3 -m json.tool

echo "## C2：PUT college + 乐观锁（version=N→N+1）"
PROF=$(curl -s "${A[@]}" "$HOST/api/auth/profile"); VER=$(echo "$PROF" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['version'])")
NEW_VER=$((VER+1))
echo "  pre version=$VER  →  expected post=$NEW_VER"
curl -s -X PUT "${A[@]}" "$HOST/api/auth/profile" -d "{\"expectedVersion\":$VER,\"input\":{\"college\":\"公共卫生学院\"}}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('  → version:',d['data']['version'],'college:',d['data'].get('college'))"

echo "## C2：乐观锁冲突（用旧 version 重放）应 409 IFC-ERR-008"
curl -s -X PUT "${A[@]}" "$HOST/api/auth/profile" -d "{\"expectedVersion\":$VER,\"input\":{\"grade\":\"大三\"}}"
echo

echo "## C4：logout 吊销（DELETE /api/auth/logout）"
curl -s -X DELETE "${A[@]}" "$HOST/api/auth/logout"; echo
sleep 1
echo "## C4：旧 token 在保护路由应 401（≤5s 失效）"
code=$(curl -s -o /dev/null -w '%{http_code}' "${A[@]}" "$HOST/api/auth/profile")
echo "  GET /api/auth/profile → $code (expect 401)"
[[ "$code" == "401" ]] && echo "  ✅ C4 PASS" || { echo "  ❌ C4 FAIL"; exit 1; }
