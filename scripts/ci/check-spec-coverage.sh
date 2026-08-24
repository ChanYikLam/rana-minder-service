#!/usr/bin/env bash
# ============================================================
# RanaMinder 改动文件↔用例对应检查（CI 阶段 4b 覆盖率门禁附属检查）
#
# 职责（P1-A 可选项落地）：本次变更新增/修改的 src/**/*.ts 生产代码文件，
# 必须存在同名 *.spec.ts（同目录）或在文件内标注豁免标记：
#   // no-spec-required <原因>
# 且同名 spec 不得是"陈旧 spec"——若 CI 阶段 4 已产出 coverage/coverage-summary.json，
# 还须校验该文件在覆盖率报告中 lines.covered>0（即对应用例实际执行到了本次改动，
# 否则存在同名 spec 却从未覆盖到该文件，判定陈旧 → MISS，评审 warning）。
# 目的：让 CI-001「新增代码须有对应用例」从口号变为可执行断言。
# 用法：bash scripts/ci/check-spec-coverage.sh [base-ref]
#       base-ref 缺省依次尝试 origin/dev；无显式 base 且无 origin/dev 时
#       fail-closed（exit 1），不静默降级，避免门禁失效。
#       多 commit PR 请显式传 merge-base（CI 已传内置变量），避免漏检中间 commit。
# 边界说明（评审 info/warning）：push 流水线以 $CNB_BEFORE_SHA、PR 流水线以
#       $CNB_PULL_REQUEST_TARGET_SHA 作 base。新建分支首次 push 或浅克隆中目标
#       SHA 不在本地时参数可能为空/不可解析：空 → 回退 origin/dev；不可解析 →
#       尝试 merge-base(origin/dev, HEAD) 兜底；两者都失败才 fail-closed（exit 1）。
#       P1-2 祖先安全（评审 #145）：并发合并/非快进 push 下 $CNB_BEFORE_SHA 未必是
#       HEAD 祖先，三点 diff 边界可能纳入无关文件（误报 MISS）——解析后校验 base
#       必须是 HEAD 祖先，否则回退 merge-base(origin/dev, HEAD)（与 release 同级防护）。
#       对"推送到 dev"的常规 push：origin/dev..HEAD 为空差异 → checked=0 通过，
#       非漏检。
# 退出码：0 = 全部通过；1 = 存在缺失用例 / base 最终不可解析（fail-closed）
# ============================================================
set -u

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

base="${1:-}"

# 解析 base 为本地可用的提交引用：
# 1) 本地已存在 → 直接用；
# 2) 提供但本地缺失（浅克隆目标 SHA 不在本地）→ git fetch origin <base> 后取 FETCH_HEAD；
# 3) 空或仍失败 → 回退 origin/dev（缺失则 fetch origin dev）→ merge-base(origin/dev, HEAD)。
# 全失败才 fail-closed（防止 changed 为空、checked=0 静默通过）。
resolve_base() {
  local ref="$1"
  if git rev-parse --verify --quiet "${ref}^{commit}" >/dev/null 2>&1; then
    echo "$ref"
    return 0
  fi
  if [ -n "$ref" ] && [ "$ref" != "origin/dev" ]; then
    if git fetch origin "$ref" --quiet 2>/dev/null; then
      if git rev-parse --verify --quiet "FETCH_HEAD^{commit}" >/dev/null 2>&1; then
        echo "FETCH_HEAD"
        return 0
      fi
    fi
  fi
  return 1
}

resolved="$(resolve_base "$base" || true)"
if [ -z "$resolved" ]; then
  echo "WARN check-spec-coverage: base='${base:-<空>}' 本地不可解析，回退 origin/dev。" >&2
  git rev-parse --verify --quiet origin/dev >/dev/null 2>&1 || git fetch origin dev --quiet 2>/dev/null || true
  if git rev-parse --verify --quiet origin/dev >/dev/null 2>&1; then
    resolved="$(git merge-base origin/dev HEAD 2>/dev/null || true)"
    if [ -n "$resolved" ]; then
      echo "WARN 已改用 merge-base(origin/dev, HEAD) = $resolved" >&2
    fi
  fi
fi

if [ -z "$resolved" ] || ! git rev-parse --verify --quiet "${resolved}^{commit}" >/dev/null 2>&1; then
  echo "ERROR check-spec-coverage: 无法解析变更基线（base='${base:-<空>}'），门禁 fail-closed（exit 1）。请显式传 merge-base：bash scripts/ci/check-spec-coverage.sh <merge-base>" >&2
  exit 1
fi
base="$resolved"

# P1-2 祖先安全（评审 #145）：push 流水线以 $CNB_BEFORE_SHA 作 base，并发合并/非快进
# push 下该 SHA 未必是 HEAD 祖先——三点 diff base...HEAD 会按 merge-base 计算边界，
# 可能纳入无关文件（误报 MISS）或漏检。解析后校验 base 必须是 HEAD 祖先；否则回退
# merge-base(origin/dev, HEAD)（与 release 流水线 prev_tag 同级防护）。
if ! git merge-base --is-ancestor "$base" HEAD 2>/dev/null; then
  echo "WARN check-spec-coverage: base=$base 不是 HEAD 祖先（并发/非快进 push），改用 merge-base(origin/dev, HEAD) 兜底。" >&2
  git rev-parse --verify --quiet origin/dev >/dev/null 2>&1 || git fetch origin dev --quiet 2>/dev/null || true
  fallback_ancestor="$(git merge-base origin/dev HEAD 2>/dev/null || true)"
  if [ -n "$fallback_ancestor" ]; then
    base="$fallback_ancestor"
    echo "WARN 已改用 merge-base(origin/dev, HEAD) = $base" >&2
  fi
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
# 覆盖率产物路径：CI 阶段 4（test:cov）产出 coverage/coverage-summary.json，阶段 4b
# 复用。本地单独运行脚本且无产物时退化为仅校验 spec 存在，不强查陈旧（并提示）。
COVERAGE_SUMMARY="$root/coverage/coverage-summary.json"
have_coverage=0
[ -f "$COVERAGE_SUMMARY" ] && have_coverage=1
while IFS= read -r f; do
  [ -z "$f" ] && continue
  checked=$((checked + 1))
  spec="${f%.ts}.spec.ts"
  if [ -f "$spec" ]; then
    # 同名 spec 存在：进一步防"陈旧 spec"——该文件须在覆盖率报告中被实际执行（lines.covered>0）。
    # 若 coverage-summary.json 无该文件记录或其 lines.covered==0，说明 spec 从未覆盖到本次改动
    #（陈旧/空壳 spec 蒙混），判定 MISS（评审 warning）。无覆盖率产物时退化为仅查存在性。
    if [ "$have_coverage" = "1" ]; then
      if ! node -e "
        const fs=require('fs');
        const s=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
        const key=require('path').resolve(process.argv[2]);
        const d=s[key];
        if (!d || !d.lines || (d.lines.covered||0)===0) process.exit(1);
      " "$COVERAGE_SUMMARY" "$f"; then
        echo "MISS  $f -> $spec 存在但未覆盖该文件（陈旧 spec），请更新用例以覆盖本次改动"
        fail=1
        continue
      fi
    fi
    continue
  fi
  # 同目录无同名 spec：全文件查豁免标记（评审 info：仅前 40 行会超行误报）
  if grep -q 'no-spec-required' "$f"; then
    echo "SKIP  $f (no-spec-required)"
    continue
  fi
  echo "MISS  $f -> 缺少 $spec（或添加 '// no-spec-required <原因>' 豁免）"
  fail=1
done <<EOF
$changed
EOF
# 注：heredoc 内容不做 glob 展开，文件名含通配符字面量也会原样交由 read -r 处理，
# 不存在通配符误展开风险（评审 info，已评估确认无需引号）。

echo "check-spec-coverage: base=$base checked=$checked fail=$fail"
exit "$fail"
