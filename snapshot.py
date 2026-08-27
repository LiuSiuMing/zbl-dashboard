#!/usr/bin/env python3
"""
ZBL 僵尸联赛 — FPL 数据快照抓取脚本
=====================================

抓取 Fantasy Premier League 官方 API 的联赛 standings 数据，
与 mapping.json 合并，输出 data/current.json 供前端使用。

用法:
    python snapshot.py [--league-id 467317] [--output data/current.json]

依赖:
    pip install requests
"""

import argparse
import json
import os
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

API_BASE = "https://fantasy.premierleague.com/api"
LEAGUE_STANDINGS_URL = f"{API_BASE}/leagues-classic/{{league_id}}/standings/"
ENTRY_DETAIL_URL = f"{API_BASE}/entry/{{entry_id}}/"
BOOTSTRAP_URL = f"{API_BASE}/bootstrap-static/"

PAGE_SIZE = 50       # FPL returns 50 per page
REQUEST_TIMEOUT = 30 # seconds
MAX_RETRIES = 5
RETRY_DELAY_BASE = 5  # seconds (exponential backoff base)
PAGE_DELAY = 3       # seconds between pages (API rate limit friendly)

BJT = timezone(timedelta(hours=8))

# ============================================================
# Helpers
# ============================================================
def log(msg, level="INFO"):
    ts = datetime.now(BJT).strftime("%H:%M:%S")
    print(f"[{ts}] [{level}] {msg}")


def fetch_with_retry(session, url, max_retries=MAX_RETRIES):
    """Fetch URL with exponential backoff on failure."""
    for attempt in range(1, max_retries + 1):
        try:
            resp = session.get(url, timeout=REQUEST_TIMEOUT)
            if resp.status_code == 429:
                wait = RETRY_DELAY_BASE * (2 ** (attempt - 1))
                log(f"Rate limited (429). Waiting {wait}s... (attempt {attempt}/{max_retries})", "WARN")
                time.sleep(wait)
                continue
            if resp.status_code == 403:
                log(f"HTTP 403 at {url}. FPL may be blocking rapid requests. Waiting 10s...", "WARN")
                time.sleep(10)
                continue
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.Timeout:
            log(f"Timeout on {url} (attempt {attempt}/{max_retries})", "WARN")
            if attempt < max_retries:
                time.sleep(RETRY_DELAY_BASE * attempt)
        except requests.exceptions.ConnectionError as e:
            log(f"Connection error: {e} (attempt {attempt}/{max_retries})", "WARN")
            if attempt < max_retries:
                time.sleep(RETRY_DELAY_BASE * attempt)
        except requests.exceptions.HTTPError as e:
            log(f"HTTP error: {e} (attempt {attempt}/{max_retries})", "ERROR")
            if attempt < max_retries:
                time.sleep(RETRY_DELAY_BASE * attempt)

    log(f"FAILED after {max_retries} attempts: {url}", "ERROR")
    return None


def load_mapping(mapping_path):
    """Load mapping.json and build lookup dict: entry_id_2627 -> {zid, team_name, manager_name}"""
    if not os.path.exists(mapping_path):
        log(f"Mapping file not found: {mapping_path}", "ERROR")
        log("Create mapping.json first (see README for format).", "ERROR")
        sys.exit(1)

    with open(mapping_path, "r", encoding="utf-8") as f:
        mapping_data = json.load(f)

    lookup = {}
    for entry in mapping_data.get("teams", []):
        eid = entry.get("entry_ids", {}).get("2627")
        if eid is not None:
            lookup[int(eid)] = {
                "zid": entry["zid"],
                "team_name": entry["team_name"],
                "manager_name": entry.get("manager_name", "")
            }

    log(f"Loaded mapping: {len(lookup)} entries for season 2627 (from {len(mapping_data.get('teams', []))} total)")
    return lookup


def fetch_current_event(session):
    """Fetch current event (gameweek) from bootstrap-static API.

    Returns (current_event_id, events_data) or (0, []) on failure.
    """
    data = fetch_with_retry(session, BOOTSTRAP_URL)
    if data is None:
        log("Failed to fetch bootstrap data.", "WARN")
        return 0, []

    events = data.get("events", [])
    current_event_id = 0
    for e in events:
        if e.get("is_current", False):
            current_event_id = e.get("id", 0)
            break

    if current_event_id == 0:
        # Fallback: find the last 'finished' event
        finished = [e for e in events if e.get("finished", False)]
        if finished:
            current_event_id = max(e.get("id", 0) for e in finished)

    log(f"Current event (GW): {current_event_id}")
    return current_event_id, events


# ============================================================
# Main Logic
# ============================================================
def fetch_all_standings(session, league_id):
    """Fetch all pages of league standings."""
    all_standings = []
    page = 1
    last_updated = None
    league_name = None

    while True:
        url = f"{LEAGUE_STANDINGS_URL.format(league_id=league_id)}?page_standings={page}"
        log(f"Fetching standings page {page}...")

        data = fetch_with_retry(session, url)
        if data is None:
            log("Failed to fetch standings. Aborting.", "ERROR")
            sys.exit(1)

        # Extract league info from first page
        if page == 1:
            league = data.get("league", {})
            league_name = league.get("name", f"League {league_id}")
            last_updated = league.get("created", datetime.now(BJT).isoformat())
            log(f"League: {league_name}")

        standings = data.get("standings", {}).get("results", [])
        if not standings:
            log(f"No more results on page {page}. Done.")
            break

        all_standings.extend(standings)
        has_next = data.get("standings", {}).get("has_next", False)
        log(f"  Got {len(standings)} entries (total: {len(all_standings)}), has_next={has_next}")

        if not has_next:
            break

        page += 1
        log(f"  Waiting {PAGE_DELAY}s before next page...")
        time.sleep(PAGE_DELAY)

    return all_standings, league_name, last_updated


def fetch_entry_details(session, entry_id):
    """Fetch a single entry's detailed info (for manager name, current_gw)."""
    url = ENTRY_DETAIL_URL.format(entry_id=entry_id)
    data = fetch_with_retry(session, url)
    if data is None:
        return None

    return {
        "first_name": data.get("player_first_name", ""),
        "last_name": data.get("player_last_name", ""),
        "current_event": data.get("current_event", 0),
        "summary_overall_points": data.get("summary_overall_points", 0),
    }


def merge_data(standings, lookup):
    """Merge standings with mapping lookup. Returns list of entry dicts."""
    entries = []
    unregistered_count = 0

    for idx, s in enumerate(standings):
        entry_id = s.get("entry", 0)
        team_name_api = s.get("entry_name", f"Team {entry_id}")
        total = s.get("total", 0)
        api_rank = s.get("rank", idx + 1)

        # Look up mapping
        mapped = lookup.get(entry_id)
        if mapped:
            import re as _re
            m = _re.fullmatch(r"ZID(\d+)", str(mapped["zid"]))
            zid = f"ZID{int(m.group(1)):06d}" if m else mapped["zid"]
            team_name = mapped["team_name"]
            manager_name = mapped["manager_name"]
        else:
            zid = "未登记"
            team_name = team_name_api
            manager_name = f"(FPL ID: {entry_id})"
            unregistered_count += 1

        entries.append({
            "rank": api_rank,
            "zid": zid,
            "team_name": team_name,
            "manager_name": manager_name,
            "entry_id": entry_id,
            "total": total,
            "current_gw": 0  # Will be set from bootstrap or entry detail later
        })

    if unregistered_count > 0:
        log(f"Warning: {unregistered_count} teams not found in mapping.json (shown as '未登记')", "WARN")

    return entries


def enrich_entries_details(session, entries, skip_details=False):
    """Optionally fetch per-entry details for manager names and current GW.
    
    If skip_details=True, we rely on mapping.json for names and standings for GW.
    """
    if skip_details:
        log("Skipping per-entry detail fetch (using mapping data only).")
        # Use standings rank as current_gw proxy (we don't have exact GW count)
        # Try to extract from standings data
        return entries

    total = len(entries)
    for idx, entry in enumerate(entries):
        if (idx + 1) % 10 == 0 or idx == 0:
            log(f"Fetching entry details ({idx + 1}/{total})...")
        
        details = fetch_entry_details(session, entry["entry_id"])
        if details:
            if not entry["manager_name"] or entry["manager_name"].startswith("(FPL"):
                fname = details["first_name"]
                lname = details["last_name"]
                entry["manager_name"] = f"{fname} {lname}".strip()
            entry["current_gw"] = details["current_event"] or entry["current_gw"]
            # Use API points if available as backup
            if entry["total"] == 0 and details["summary_overall_points"]:
                entry["total"] = details["summary_overall_points"]
        
        # Small delay to be nice to the API
        time.sleep(0.3)
    
    return entries


def build_output(entries, league_id, league_name, current_event=0):
    """Build the final current.json structure.

    `current_event` is the authoritative current GW from bootstrap API.
    """
    now = datetime.now(BJT)
    snapshot_time = now.strftime("%Y-%m-%d %H:%M")

    # Use bootstrap current_event as authoritative GW number
    gw = current_event

    # Fallback: if not provided, derive from entries (max current_gw found)
    if gw == 0:
        gw_values = [e.get("current_gw", 0) for e in entries if e.get("current_gw", 0) > 0]
        gw = max(gw_values) if gw_values else 0

    # Set all entries' current_gw to the authoritative GW
    for e in entries:
        if e.get("current_gw", 0) == 0:
            e["current_gw"] = gw

    output = {
        "snapshot_time": snapshot_time,
        "meta": {
            "league_id": league_id,
            "league_name": league_name,
            "season": "2627",
            "current_gw": gw,
            "total_entries": len(entries)
        },
        "entries": [
            {
                "rank": e["rank"],
                "zid": e["zid"],
                "team_name": e["team_name"],
                "manager_name": e["manager_name"],
                "entry_id": e["entry_id"],
                "current_gw": e["current_gw"],
                "total": e["total"]
            }
            for e in entries
        ]
    }

    return output


# ============================================================
# CLI Entry Point
# ============================================================
def main():
    parser = argparse.ArgumentParser(
        description="ZBL 僵尸联赛 FPL 数据快照抓取",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
用法示例:
  python snapshot.py                              # 默认: league 467317
  python snapshot.py --league-id 467317           # 指定联赛
  python snapshot.py --skip-details               # 跳过逐队 API 调用 (更快)
  python snapshot.py --output data/current.json   # 指定输出路径
        """
    )
    parser.add_argument("--league-id", type=int, default=DEFAULT_LEAGUE_ID,
                        help=f"FPL League ID (default: {DEFAULT_LEAGUE_ID})")
    parser.add_argument("--output", type=str, default=DEFAULT_OUTPUT,
                        help=f"输出 JSON 路径 (default: {DEFAULT_OUTPUT})")
    parser.add_argument("--mapping", type=str, default=DEFAULT_MAPPING,
                        help=f"mapping.json 路径 (default: {DEFAULT_MAPPING})")
    parser.add_argument("--skip-details", action="store_true",
                        help="跳过逐队 entry detail API 调用（仅用 standings 数据）")
    parser.add_argument("--no-sort", action="store_true",
                        help="不按总分排序 (保留 API 原始排名)")

    args = parser.parse_args()

    log(f"{'='*60}")
    log(f"ZBL 僵尸联赛快照抓取")
    log(f"League ID: {args.league_id}")
    log(f"Output:   {args.output}")
    log(f"Mapping:  {args.mapping}")
    log(f"Skip entry details: {args.skip_details}")
    log(f"{'='*60}")

    # Load mapping
    lookup = load_mapping(args.mapping)

    # Create session with headers to mimic browser
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
    })

    # Fetch standings
    standings, league_name, _ = fetch_all_standings(session, args.league_id)
    log(f"Total standings fetched: {len(standings)}")

    # Fetch current event (GW) from bootstrap API
    current_event, _ = fetch_current_event(session)

    # Merge with mapping
    entries = merge_data(standings, lookup)

    # Optionally enrich with per-entry details
    if not args.skip_details:
        entries = enrich_entries_details(session, entries)
    else:
        log("跳过逐队详情抓取，使用 mapping + standings 数据。")

    # Sort by total descending (stable sort preserves API order for ties)
    if not args.no_sort:
        entries.sort(key=lambda e: (-e["total"], e["rank"]))

    # Build output
    output = build_output(entries, args.league_id, league_name or f"League {args.league_id}", current_event)

    # Ensure output directory exists
    output_dir = os.path.dirname(args.output)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    # Write compact JSON
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, separators=(",", ":"))

    # Terminal summary
    log(f"{'='*60}")
    log(f"快照完成！")
    log(f"  输出文件: {os.path.abspath(args.output)}")
    log(f"  快照时间: {output['snapshot_time']}")
    log(f"  当前 GW: {output['meta']['current_gw']}")
    log(f"  队伍总数: {output['meta']['total_entries']}")
    
    # Show top 5
    log(f"  ── 前 5 名 ──")
    for i, e in enumerate(entries[:5], 1):
        log(f"    {i}. [{e['zid']}] {e['team_name']} — {e['total']} 分")
    
    # Count unregistered
    unregistered = [e for e in entries if e["zid"] == "未登记"]
    if unregistered:
        log(f"  ⚠ 未登记队伍: {len(unregistered)} (需在 mapping.json 中补充)", "WARN")

    log(f"{'='*60}")
    snap_ts = output["snapshot_time"]
    log(f"下一步: git add {args.output}; git commit -m 'snapshot {snap_ts}'; git push")


if __name__ == "__main__":
    main()
