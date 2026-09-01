#!/usr/bin/env python3
"""
ZBL 僵尸联赛 — 每日自动更新脚本
=================================

功能：
  1. 抓取 FPL 联赛 standings（分页）
  2. 获取当前 GW（bootstrap-static）
  3. 自动推导 DQ 名单（mapping 全集 − standings 实际）
  4. 输出 data/current.json（DQ 队沉底 + dq:true）
  5. 归档快照到 data/history/
  6. git add → commit → push（Vercel 自动部署）

依赖：
    pip install requests

环境：
    Python 3.8+，git 已配置，GitHub 推送凭据通过环境变量注入

用法：
    python zbl_auto.py                           # 默认参数
    python zbl_auto.py --league-id 467317        # 指定联赛
    python zbl_auto.py --dry-run                 # 只生成 JSON，不 git push
    python zbl_auto.py --no-git                  # 跳过 git 操作
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone, timedelta

import requests

# ============================================================
# Configuration
# ============================================================
DEFAULT_LEAGUE_ID = 467317
DEFAULT_OUTPUT = os.path.join("data", "current.json")
DEFAULT_MAPPING = "mapping.json"
DEFAULT_HISTORY_DIR = os.path.join("data", "history")

API_BASE = "https://fantasy.premierleague.com/api"
LEAGUE_STANDINGS_URL = API_BASE + "/leagues-classic/{league_id}/standings/"
BOOTSTRAP_URL = API_BASE + "/bootstrap-static/"

PAGE_SIZE = 50           # FPL 每页 50 条
REQUEST_TIMEOUT = 30     # 秒
MAX_RETRIES = 5          # 最大重试次数
RETRY_DELAY_BASE = 5     # 指数退避基数（秒）
PAGE_DELAY = 3           # 翻页间隔（秒）
API_RATE_LIMIT = 0.3     # 请求间隔（秒）

BJT = timezone(timedelta(hours=8))
SEASON = "2627"

# ============================================================
# Logging
# ============================================================
def log(msg, level="INFO"):
    """带时间戳的日志输出。"""
    ts = datetime.now(BJT).strftime("%Y-%m-%d %H:%M:%S")
    print("[{ts}] [{level}] {msg}".format(ts=ts, level=level, msg=msg))


# ============================================================
# HTTP Helpers
# ============================================================
def fetch_with_retry(session, url, max_retries=MAX_RETRIES):
    """带指数退避的 HTTP GET，返回 JSON dict 或 None。"""
    for attempt in range(1, max_retries + 1):
        try:
            resp = session.get(url, timeout=REQUEST_TIMEOUT)

            if resp.status_code == 429:
                wait = RETRY_DELAY_BASE * (2 ** (attempt - 1))
                log("Rate limited (429). Waiting {w}s... (attempt {a}/{m})".format(
                    w=wait, a=attempt, m=max_retries), "WARN")
                time.sleep(wait)
                continue

            if resp.status_code == 403:
                wait = 10 + RETRY_DELAY_BASE * (attempt - 1)
                log("HTTP 403 at {u}. Waiting {w}s... (attempt {a}/{m})".format(
                    u=url, w=wait, a=attempt, m=max_retries), "WARN")
                time.sleep(wait)
                continue

            resp.raise_for_status()
            return resp.json()

        except requests.exceptions.Timeout:
            log("Timeout on {u} (attempt {a}/{m})".format(
                u=url, a=attempt, m=max_retries), "WARN")
            if attempt < max_retries:
                time.sleep(RETRY_DELAY_BASE * attempt)

        except requests.exceptions.ConnectionError as e:
            log("Connection error: {e} (attempt {a}/{m})".format(
                e=e, a=attempt, m=max_retries), "WARN")
            if attempt < max_retries:
                time.sleep(RETRY_DELAY_BASE * attempt)

        except requests.exceptions.HTTPError as e:
            log("HTTP error: {e} (attempt {a}/{m})".format(
                e=e, a=attempt, m=max_retries), "ERROR")
            if attempt < max_retries:
                time.sleep(RETRY_DELAY_BASE * attempt)

    log("FAILED after {m} attempts: {u}".format(m=max_retries, u=url), "ERROR")
    return None


# ============================================================
# Mapping Loader
# ============================================================
def normalize_zid(raw_zid):
    """标准化 ZID 格式：ZID138 → ZID000138，已经是6位的不变。"""
    m = re.fullmatch(r"ZID(\d+)", str(raw_zid))
    if m:
        return "ZID{num:06d}".format(num=int(m.group(1)))
    return raw_zid


def load_mapping(mapping_path):
    """加载 mapping.json，构建两个查找结构：

    Returns:
        lookup_by_eid: dict[int, dict]  — entry_id(2627) → {zid, team_name, manager_name}
        full_season_set: set[int]       — 2627 赛季完整 entry_id 集合
    """
    if not os.path.exists(mapping_path):
        log("Mapping file not found: {p}".format(p=mapping_path), "ERROR")
        log("请将 mapping.json 放在脚本同目录，或用 --mapping 指定路径。", "ERROR")
        sys.exit(1)

    with open(mapping_path, "r", encoding="utf-8") as f:
        mapping_data = json.load(f)

    lookup_by_eid = {}
    full_season_set = set()

    for team in mapping_data.get("teams", []):
        eid_raw = team.get("entry_ids", {}).get(SEASON)

        # 跳过 2627 为 null 的队伍（不属于当前赛季）
        if eid_raw is None:
            continue

        eid = int(eid_raw)  # 兼容字符串格式 "4764624"
        zid = normalize_zid(team["zid"])

        lookup_by_eid[eid] = {
            "zid": zid,
            "team_name": team["team_name"],
            "manager_name": team.get("manager_name", ""),
        }
        full_season_set.add(eid)

    log("Mapping loaded: {n} teams for season {s}".format(
        n=len(full_season_set), s=SEASON))
    return lookup_by_eid, full_season_set


# ============================================================
# FPL API Fetchers
# ============================================================
def fetch_current_event(session):
    """从 bootstrap-static 获取当前 GW 编号。返回 int（0 表示失败）。"""
    data = fetch_with_retry(session, BOOTSTRAP_URL)
    if data is None:
        log("Failed to fetch bootstrap-static.", "ERROR")
        return 0

    events = data.get("events", [])
    current_gw = 0

    for e in events:
        if e.get("is_current", False):
            current_gw = e.get("id", 0)
            break

    # 回退：找最后一个已完成的 GW
    if current_gw == 0:
        finished = [e for e in events if e.get("finished", False)]
        if finished:
            current_gw = max(e.get("id", 0) for e in finished)

    log("Current GW: {gw}".format(gw=current_gw))
    return current_gw


def fetch_all_standings(session, league_id):
    """分页拉取全部 standings。返回 (standings_list, league_name)。"""
    all_standings = []
    page = 1
    league_name = None

    while True:
        url = "{base}?page_standings={p}".format(
            base=LEAGUE_STANDINGS_URL.format(league_id=league_id), p=page)
        log("Fetching standings page {p}...".format(p=page))

        data = fetch_with_retry(session, url)
        if data is None:
            log("Failed to fetch standings page {p}. Aborting.".format(p=page), "ERROR")
            sys.exit(1)

        # 首页提取联赛信息
        if page == 1:
            league = data.get("league", {})
            league_name = league.get("name", "League {id}".format(id=league_id))
            log("League: {n}".format(n=league_name))

        results = data.get("standings", {}).get("results", [])
        if not results:
            log("No results on page {p}. Done.".format(p=page))
            break

        all_standings.extend(results)
        has_next = data.get("standings", {}).get("has_next", False)
        log("  Page {p}: {n} entries (total: {t}), has_next={h}".format(
            p=page, n=len(results), t=len(all_standings), h=has_next))

        if not has_next:
            break

        page += 1
        time.sleep(PAGE_DELAY)

    return all_standings, league_name


# ============================================================
# DQ Derivation & Merge
# ============================================================
def derive_dq(full_season_set, standings_eids):
    """推导 DQ 名单：mapping 全集 − standings 实际 entry_id。

    Returns:
        set[int] — 被 DQ 的 entry_id 集合
    """
    standings_eid_set = set(standings_eids)
    dq_eids = full_season_set - standings_eid_set
    return dq_eids


def merge_standings_with_mapping(standings, lookup_by_eid, full_season_set, current_gw):
    """合并 standings + mapping + DQ 推导，生成最终 entries 列表。

    Returns:
        (entries_list, dq_count, meta_extra)
    """
    # --- 正常队（在 standings 中的） ---
    normal_entries = []
    standings_eids = []

    for s in standings:
        eid = s.get("entry", 0)
        standings_eids.append(eid)

        # 经理名：优先取 standings 自带的 player_name（零额外 API 调用）
        api_manager = s.get("player_name", "")

        mapped = lookup_by_eid.get(eid)
        if mapped:
            zid = mapped["zid"]
            team_name = mapped["team_name"]
            manager_name = api_manager or mapped["manager_name"]
        else:
            # standings 里有但 mapping 里没有的（理论上不会发生，但容错）
            zid = "UNMAPPED"
            team_name = s.get("entry_name", "Team {e}".format(e=eid))
            manager_name = api_manager or "(FPL ID: {e})".format(e=eid)
            log("Unmapped entry in standings: {e} ({n})".format(
                e=eid, n=team_name), "WARN")

        normal_entries.append({
            "rank": 0,  # 稍后重新分配
            "zid": zid,
            "team_name": team_name,
            "manager_name": manager_name,
            "entry_id": eid,
            "current_gw": current_gw,
            "total": s.get("total", 0),
        })

    # 按总分降序排序（同分保持 API 原始顺序 → stable sort）
    normal_entries.sort(key=lambda e: -e["total"])

    # 分配 rank（同分同名次）
    prev_total = None
    prev_rank = 0
    for idx, entry in enumerate(normal_entries):
        if entry["total"] != prev_total:
            prev_rank = idx + 1
            prev_total = entry["total"]
        entry["rank"] = prev_rank

    # --- DQ 队（在 mapping 全集中但不在 standings 中的） ---
    dq_eids = derive_dq(full_season_set, standings_eids)
    dq_entries = []

    for eid in sorted(dq_eids):
        mapped = lookup_by_eid.get(eid, {})
        dq_entries.append({
            "rank": len(normal_entries) + len(dq_entries) + 1,
            "zid": mapped.get("zid", "UNMAPPED"),
            "team_name": mapped.get("team_name", "Unknown"),
            "manager_name": mapped.get("manager_name", ""),
            "entry_id": eid,
            "current_gw": current_gw,
            "total": 0,
            "dq": True,
        })

    if dq_entries:
        log("DQ teams detected: {n}".format(n=len(dq_entries)), "WARN")
        for d in dq_entries:
            log("  DQ: [{z}] {t}".format(z=d["zid"], t=d["team_name"]), "WARN")

    all_entries = normal_entries + dq_entries

    return all_entries, len(dq_entries)


def build_output(entries, dq_count, league_id, league_name, current_gw):
    """构建最终 current.json 结构。"""
    now = datetime.now(BJT)
    snapshot_time = now.strftime("%Y-%m-%d %H:%M")

    output = {
        "snapshot_time": snapshot_time,
        "meta": {
            "league_id": league_id,
            "league_name": league_name,
            "season": SEASON,
            "current_gw": current_gw,
            "total_entries": len(entries),
            "dq_count": dq_count,
        },
        "entries": entries,
    }
    return output


# ============================================================
# History Archive
# ============================================================
def save_history(output, history_dir, current_gw):
    """将当前快照归档到 data/history/ 目录。"""
    os.makedirs(history_dir, exist_ok=True)

    now = datetime.now(BJT)
    date_str = now.strftime("%Y%m%d")
    filename = "snapshot_gw{gw:02d}_{date}.json".format(gw=current_gw, date=date_str)
    filepath = os.path.join(history_dir, filename)

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    log("History archived: {p}".format(p=filepath))
    return filepath


# ============================================================
# Git Operations
# ============================================================
def git_push(output_path, history_path, current_gw, snapshot_time):
    """执行 git add → commit → push。

    Returns:
        bool — True 表示成功，False 表示失败
    """
    try:
        # git add
        log("git add ...")
        subprocess.check_call(["git", "add", output_path, history_path])

        # git commit
        commit_msg = "auto: snapshot GW{gw} {ts}".format(
            gw=current_gw, ts=snapshot_time)
        log("git commit: {m}".format(m=commit_msg))
        subprocess.check_call(["git", "commit", "-m", commit_msg])

        # git push
        log("git push ...")
        subprocess.check_call(["git", "push"])

        log("Git push successful. Vercel will auto-deploy.", "INFO")
        return True

    except subprocess.CalledProcessError as e:
        log("Git operation failed: {e}".format(e=e), "ERROR")
        return False
    except FileNotFoundError:
        log("git not found. Install git or use --no-git.", "ERROR")
        return False


# ============================================================
# Main
# ============================================================
def main():
    parser = argparse.ArgumentParser(
        description="ZBL 僵尸联赛 — 每日自动更新脚本",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
用法示例:
  python zbl_auto.py                          # 默认参数
  python zbl_auto.py --league-id 467317       # 指定联赛
  python zbl_auto.py --dry-run                # 只生成 JSON，不 git push
  python zbl_auto.py --no-git                 # 跳过 git 操作
  python zbl_auto.py --mapping /path/to/mapping.json
        """,
    )
    parser.add_argument("--league-id", type=int, default=DEFAULT_LEAGUE_ID,
                        help="FPL League ID (default: {d})".format(d=DEFAULT_LEAGUE_ID))
    parser.add_argument("--output", type=str, default=DEFAULT_OUTPUT,
                        help="输出 JSON 路径 (default: {d})".format(d=DEFAULT_OUTPUT))
    parser.add_argument("--mapping", type=str, default=DEFAULT_MAPPING,
                        help="mapping.json 路径 (default: {d})".format(d=DEFAULT_MAPPING))
    parser.add_argument("--history-dir", type=str, default=DEFAULT_HISTORY_DIR,
                        help="历史归档目录 (default: {d})".format(d=DEFAULT_HISTORY_DIR))
    parser.add_argument("--dry-run", action="store_true",
                        help="只生成 JSON，不执行 git 操作")
    parser.add_argument("--no-git", action="store_true",
                        help="跳过 git 操作（与 --dry-run 等效）")

    args = parser.parse_args()
    skip_git = args.dry_run or args.no_git

    log("=" * 60)
    log("ZBL 僵尸联赛 — 每日自动更新")
    log("League ID:  {v}".format(v=args.league_id))
    log("Output:     {v}".format(v=args.output))
    log("Mapping:    {v}".format(v=args.mapping))
    log("History:    {v}".format(v=args.history_dir))
    log("Git push:   {v}".format(v="SKIP (dry-run)" if skip_git else "YES"))
    log("=" * 60)

    # ---------- Step 1: Load mapping ----------
    lookup_by_eid, full_season_set = load_mapping(args.mapping)

    # ---------- Step 2: Create HTTP session ----------
    session = requests.Session()
    session.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json",
    })

    # ---------- Step 3: Fetch current GW ----------
    current_gw = fetch_current_event(session)
    if current_gw == 0:
        log("WARNING: Could not determine current GW. Using 0.", "WARN")

    # ---------- Step 4: Fetch standings ----------
    standings, league_name = fetch_all_standings(session, args.league_id)
    log("Standings fetched: {n} entries".format(n=len(standings)))

    # ---------- Step 5: Merge + DQ derivation ----------
    entries, dq_count = merge_standings_with_mapping(
        standings, lookup_by_eid, full_season_set, current_gw)

    # ---------- Step 6: Build output ----------
    output = build_output(entries, dq_count, args.league_id,
                          league_name or "League {id}".format(id=args.league_id),
                          current_gw)

    # ---------- Step 7: Write current.json ----------
    output_dir = os.path.dirname(args.output)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    # 先写临时文件再 rename，防止写坏
    tmp_path = args.output + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp_path, args.output)
    log("current.json written: {p}".format(p=os.path.abspath(args.output)))

    # ---------- Step 8: Archive history ----------
    history_path = save_history(output, args.history_dir, current_gw)

    # ---------- Step 9: Git push ----------
    if skip_git:
        log("Git push skipped (dry-run mode).")
    else:
        success = git_push(args.output, history_path, current_gw, output["snapshot_time"])
        if not success:
            log("WARNING: git push failed. Files are saved locally.", "ERROR")
            log("You can manually push later: git add . && git commit -m 'manual' && git push", "WARN")

    # ---------- Summary ----------
    log("=" * 60)
    log("Update complete!")
    log("  Snapshot time: {v}".format(v=output["snapshot_time"]))
    log("  Current GW:   {v}".format(v=current_gw))
    log("  Total teams:  {v}".format(v=output["meta"]["total_entries"]))
    log("  DQ teams:     {v}".format(v=dq_count))
    log("  Normal teams: {v}".format(v=output["meta"]["total_entries"] - dq_count))

    # Top 5
    log("  -- Top 5 --")
    for e in entries[:5]:
        dq_mark = " [DQ]" if e.get("dq") else ""
        log("    #{r} [{z}] {t} -- {p} pts{d}".format(
            r=e["rank"], z=e["zid"], t=e["team_name"],
            p=e["total"], d=dq_mark))

    log("=" * 60)


if __name__ == "__main__":
    main()
