#!/usr/bin/env bash
# ============================================================
# RanaMinder 改动文件↔用例对应检查（CI 阶段 4b 附属门禁）
#
# 职责（P1-A 可选项落地）：本次变更新增/修改的 src/**/*.ts 生产代码文件，
# 必须存在同名 *.spec.ts（同目录）或在文件内标注豁免标记：
#   // no-spec-required <原因>
# 目的：让 CI-001「新增代码须有对应用例」从口号变为可执行断言。
# 用法：bash scripts/ci/check-spec-coverage.sh [base-ref]
#       base-ref 缺省依次尝试 $CNB_COMPARE_TO / origin/dev / HEAD~1
# 退出码：0 = 全部通过；1 = 存在缺失用例且未豁免
# ============================================================
set -u

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

base="${1:-${CNB_COMPARE_TO:-}}"
if [ -z "$base" ]; then
  if git rev-parse --verify --quiet origin/dev >/dev/null 2>&1; then
    base=origin/dev
  else
    base=HEAD~1
  fi
fi

changed="$(git diff --name-only --diff-filter=d "$base"...HEAD -- 'src/**/*.ts' 2>/dev/null \
  || git diff --name-only --diff-filter=d "$base" -- 'src/**/*.ts')"
# 只看生产代码；测试文件自身不要求配对
changed="$(printf '%s\n' "$changed" | grep -v '\.spec\.ts$' || true)"

fail=0
checked=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  checked=$((checked + 1))
  spec="${f%.ts}.spec.ts"
  if [ -f "$spec" ]; then
    continue
  fi
  # 同目录无同名 spec：查豁免标记（前 40 行内）
  if head -n 40 "$f" | grep -q 'no-spec-required'; then
    echo "SKIP  $f (no-spec-required)"
    continue
  fi
  echo "MISS  $f -> 缺少 $spec（或添加 '// no-spec-required <原因>' 豁免）"
  fail=1
done <<EOF
$changed
EOF

echo "check-spec-coverage: base=$base checked=$checked fail=$fail"
exit "$fail"
