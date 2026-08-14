#!/usr/bin/env bash
# ============================================================
# RanaMinder 依赖许可证登记一致性检查（CI 阶段 10 辅助）
#
# 职责：当仓库存在 package.json 时，校验每个直接依赖（dependencies
#       + devDependencies）都在依赖与版本基线登记表中出现（DEP-003：
#       名称、版本、许可证、用途、维护状态登记）。
# 用法：bash scripts/ci/check-license-registry.sh
# 退出码：0 = 通过或 SKIP（代码未开工）；1 = 登记不一致
# 权威依据：docs/engineering/依赖与版本基线-v1.0.md §4（DEP-003）、
#           docs/engineering/CI与质量门定义-v1.0.md（CI-001 阶段 10）
# ============================================================
set -u

root="$(cd "$(dirname "$0")/../.." && pwd)"
registry="$root/docs/engineering/依赖与版本基线-v1.0.md"

if [ ! -f "$root/package.json" ]; then
  echo "SKIP: 仓库尚无 package.json（代码未开工），许可证登记由 DEP-003 人工维护"
  exit 0
fi
if [ ! -f "$registry" ]; then
  echo "FAIL: 缺少依赖与版本基线登记表：$registry"
  exit 1
fi
if ! grep -q 'DEP-003' "$registry"; then
  echo "FAIL: 依赖与版本基线 v1.0 缺少 DEP-003 许可证登记规则"
  exit 1
fi

deps="$(node -e "const p=require(process.argv[1]);const all=Object.assign({},p.dependencies||{},p.devDependencies||{});console.log(Object.keys(all).join('\n'))" "$root/package.json" 2>/dev/null || true)"
if [ -z "$deps" ]; then
  echo "OK: package.json 无直接依赖，登记检查通过"
  exit 0
fi

fail=0
while IFS= read -r dep; do
  [ -z "$dep" ] && continue
  if ! grep -qF "$dep" "$registry"; then
    echo "FAIL: 依赖 [$dep] 未在依赖与版本基线登记表中登记（DEP-003：名称/版本/许可证/用途/维护状态）"
    fail=1
  fi
done <<< "$deps"

if [ "$fail" -ne 0 ]; then
  echo "FAIL: 依赖登记不一致（DEP-003）"
  exit 1
fi
echo "OK: 全部直接依赖已在登记表中登记"
exit 0
