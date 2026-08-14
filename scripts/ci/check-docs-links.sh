#!/usr/bin/env bash
# ============================================================
# RanaMinder 文档链接一致性检查（CI 阶段 11）
#
# 职责：扫描 docs/、src/、test/ 与仓库根 README.md 中的 Markdown
#       相对链接，确认目标文件存在；外部 URL 与纯锚点链接跳过。
# 用法：bash scripts/ci/check-docs-links.sh
# 退出码：0 = 全部通过；1 = 存在断链
# 权威依据：docs/engineering/CI与质量门定义-v1.0.md（CI-001 阶段 11）
# ============================================================
set -u

root="$(cd "$(dirname "$0")/../.." && pwd)"
fail=0
count=0

check_file() {
  local md="$1" dir link target real
  dir="$(dirname "$md")"
  while IFS= read -r link; do
    [ -z "$link" ] && continue
    case "$link" in
      http://*|https://*|mailto:*|ftp://*|tel:*|'data:'*) continue ;;
      \#*) continue ;; # 纯锚点
    esac
    target="${link%%#*}" # 去掉锚点，只校验文件路径部分
    [ -z "$target" ] && continue
    case "$target" in
      /*) real="$root$target" ;;
      *) real="$dir/$target" ;;
    esac
    count=$((count + 1))
    if [ ! -e "$real" ]; then
      echo "BROKEN LINK: $md -> $link (missing: $real)"
      fail=1
    fi
  done < <(grep -oE '\]\([^)]*\)' "$md" | sed -E 's/^\]\((.*)\)$/\1/')
}

# 收集待检查文件：docs/、src/、test/ 下全部 *.md，以及根 README.md
mapfile -t files < <(find "$root/docs" "$root/src" "$root/test" -name '*.md' -type f 2>/dev/null | sort)
files+=("$root/README.md")

for md in "${files[@]}"; do
  check_file "$md"
done

if [ "$fail" -ne 0 ]; then
  echo "FAIL: 发现断链（共检查 $count 个链接）"
  exit 1
fi
echo "OK: 共检查 $count 个相对链接，全部有效"
exit 0
