#!/usr/bin/env bash
# update_lineups.sh — 16:35 日更 ZBL「本 GW 阵容」数据
# 依赖：~/zbl-data/baseline_gw1.json（GW1 标尺，非 DQ 队全季不变）
# 行为：读 current.json 的 current_gw → 生成 data/lineups/gw{N}.json → 只保留当前 GW → commit/push
set -uo pipefail
cd "$HOME/zbl-dashboard" || exit 1

BASE="$HOME/zbl-data/baseline_gw1.json"
[ -f "$BASE" ] || { echo "[lineups] 缺 baseline: $BASE" >&2; exit 2; }

GW=$(/usr/bin/python3 -c "import json;print(json.load(open('data/current.json'))['meta']['current_gw'])" 2>/dev/null)
[ -n "$GW" ] || { echo "[lineups] 读不到 current_gw" >&2; exit 2; }

OUT="data/lineups/gw${GW}.json"
/usr/bin/python3 zbl_lineups.py --gw "$GW" --current data/current.json --baseline "$BASE" --out "$OUT"
rc=$?
[ $rc -eq 0 ] || { echo "[lineups] 生成失败 rc=$rc（保留旧文件）" >&2; exit $rc; }

# 只保留当前 GW（需求：不回看历史）
for f in data/lineups/gw*.json; do
  [ -e "$f" ] || continue
  [ "$f" = "$OUT" ] || rm -f "$f"
done

git add "$OUT" data/lineups 2>/dev/null
if git diff --cached --quiet; then
  echo "[lineups] 无变化，跳过推送"
  exit 0
fi
git -c user.name="ZBL Auto Bot" -c user.email="zbl@local" commit -qm "data(lineups): gw${GW} $(date '+%F %H:%M')"
git push origin main >/dev/null 2>&1 || { echo "[lineups] push 失败" >&2; exit 3; }
echo "[lineups] OK gw=$GW pushed"
