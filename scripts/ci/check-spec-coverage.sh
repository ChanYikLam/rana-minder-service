#!/usr/bin/env bash
# ============================================================
# RanaMinder 改动文件↔用例对应检查（CI 阶段 4b 覆盖率门禁附属检查）
#
# 职责（P1-A 可选项落地）：本次变更新增/修改的 src/**/*.ts 生产代码文件，
# 必须存在同名 *.spec.ts（同目录）或在文件内标注豁免标记：
#   // no-spec-required <原因>
# 目的：让 CI-001「新增代码须有对应用例」从口号变为可执行断言。
# 用法：bash scripts/ci/check-spec-coverage.sh [base-ref]
#       base-ref 缺省依次尝试 origin/dev；无显式 base 且无 origin/dev 时
#       fail-closed（exit 1），不静默降级，避免门禁失效。
#       多 commit PR 请显式传 merge-base（CI 已传内置变量），避免漏检中间 commit。
# 边界说明（评审 info/warning）：push 流水线以 $CNB_BEFORE_SHA、PR 流水线以
#       $CNB_PULL_REQUEST_TARGET_SHA 作 base。新建分支首次 push 或浅克隆中目标
#       SHA 不在本地时参数可能为空/不可解析：空 → 回退 origin/dev；不可解析 →
#       尝试 merge-base(origin/dev, HEAD) 兜底；两者都失败才 fail-closed（exit 1）。
#       对"推送到 dev"的常规 push：origin/dev..HEAD 为空差异 → checked=0 通过，
#       非漏检。
# 退出码：0 = 全部通过；1 = 存在缺失用例 / base 最终不可解析（fail-closed）
# ============================================================
set -u

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

base="${1:-}"
if [ -z "$base" ]; then
  if git rev-parse --verify --quiet origin/dev >/dev/null 2>&1; then
    base=origin/dev
  else
    # 无显式 base 且无 origin/dev：fail-closed，绝不静默降级导致门禁失效。
    echo "ERROR check-spec-coverage: 未提供 base-ref 且无 origin/dev，无法确定变更基线。" >&2
    echo "ERROR 门禁 fail-closed（exit 1）。请显式传 merge-base：bash scripts/ci/check-spec-coverage.sh <merge-base>" >&2
    exit 1
  fi
fi

# base 必须可解析为提交；不可解析时先尝试 git merge-base origin/dev HEAD 兜底
# （浅克隆/目标 SHA 不在本地 clone 的常见场景，评审：#126 target-SHA 可用性），
# 仍失败才 fail-closed（防止 changed 为空、checked=0 静默通过）。
if ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null 2>&1; then
  echo "WARN check-spec-coverage: base-ref '$base' 无法在本地解析为提交，尝试 merge-base(origin/dev, HEAD) 兜底。" >&2
  if git rev-parse --verify --quiet origin/dev >/dev/null 2>&1; then
    fallback="$(git merge-base origin/dev HEAD 2>/dev/null || true)"
    if [ -n "$fallback" ] && git rev-parse --verify --quiet "${fallback}^{commit}" >/dev/null 2>&1; then
      base="$fallback"
      echo "WARN 已改用 merge-base(origin/dev, HEAD) = $base" >&2
    fi
  fi
fi
if ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null 2>&1; then
  echo "ERROR check-spec-coverage: base-ref '$base' 无法解析为提交，门禁 fail-closed（exit 1）。请显式传 merge-base：bash scripts/ci/check-spec-coverage.sh <merge-base>" >&2
  exit 1
fi

# pathspec 显式覆盖 src/ 顶层（src/*.ts）与嵌套目录（src/**/*.ts）：
# git 的 '**' 在 pathspec 中要求至少一层目录，仅写 src/**/*.ts 会漏检 src/main.ts 等顶层文件。
# 三点 diff（base..HEAD）；失败即报错退出，不使用语义不一致的两点 diff 兜底
if ! changed="$(git diff --name-only --diff-filter=d "$base"...HEAD -- 'src/*.ts' 'src/**/*.ts' 2>&1)"; then
  echo "ERROR check-spec-coverage: 三点 diff 失败（base=$base）" >&2
  exit 1
fi
# 只看生产代码；测试文件自身不要求配对
changed="$(printf '%s\n' "$changed" | grep -v '\.spec\.ts$' || true)"

# 与 c8 的 exclude 口径对齐：排除不纳入覆盖率统计的目录（src/shared/testing/**、src/database/migrations/**）。
# 这些目录内的文件本就无 spec 也无豁免标记（如 fake-db-adapter.ts、迁移脚本），
# 若在此强制要求 spec 会误报 MISS 使门禁失败；故需在 changed 列表中一并过滤，避免门禁与覆盖率统计口径不一致。
if [ -n "$changed" ]; then
  changed="$(printf '%s\n' "$changed" | grep -v -E '^(src/shared/testing/|src/database/migrations/)' || true)"
fi

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
