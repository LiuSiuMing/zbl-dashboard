#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zbl_lineups.py — 生成 ZBL 看板「本 GW 阵容」静态数据（供前端按需加载）

口径：
  * 阵容来源 = GW1 锁定标尺（非 DQ 队全季不变，ZBL 规则）
  * 得分来源 = /event/{gw}/live/
  * 自动替补 = 按 FPL 规则用分钟数复算；**仅在 GW 已结算时**应用（GW 进行中官方也还没结算）
  * 自检：阵型内得分之和（含队长双倍）应等于 current.json 的 event_total（仅当前 GW 可校验）

用法：
  python3 zbl_lineups.py --gw 8 --out data/lineups/gw8.json
"""
import argparse, json, os, sys, time, urllib.request
from datetime import datetime, timezone, timedelta

API = "https://fantasy.premierleague.com/api"
BJT = timezone(timedelta(hours=8))
BASELINE = "/mnt/relay-test/FPL/Zombies/foul_check/ZBL_baseline_GW01_2608221938.json"
CURRENT = "data/current.json"
POS_NAME = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}


def log(msg):
    sys.stderr.write("[lineups] %s\n" % msg)


def get(path, retries=3):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(API + path, headers={"User-Agent": "zbl-lineups/1.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError("GET %s failed: %s" % (path, last))


def formation_ok(xi, el):
    c = {1: 0, 2: 0, 3: 0, 4: 0}
    for e in xi:
        c[el[e]["element_type"]] += 1
    return c[1] == 1 and 3 <= c[2] <= 5 and 2 <= c[3] <= 5 and 1 <= c[4] <= 3


def formation_str(xi, el):
    c = {1: 0, 2: 0, 3: 0, 4: 0}
    for e in xi:
        c[el[e]["element_type"]] += 1
    return "%d-%d-%d" % (c[2], c[3], c[4])


def resolve(t, el, live, apply_subs):
    """返回 (xi, bench_order, subs, captain_mult)"""
    xi = list(t["starters"])
    bench = [t["sub_gk"]] + list(t["sub_out"])
    subs = []
    if apply_subs:
        for starter in list(xi):
            if live[starter]["minutes"] > 0:
                continue
            if len(subs) >= 3:
                break
            for b in bench:
                if b in xi or live[b]["minutes"] <= 0:
                    continue
                if (el[b]["element_type"] == 1) != (el[starter]["element_type"] == 1):
                    continue
                trial = [b if e == starter else e for e in xi]
                if not formation_ok(trial, el):
                    continue
                xi = trial
                bench.remove(b)
                subs.append({"in": b, "out": starter})
                break
    cap, vice = t["captain"], t["vice"]
    if live[cap]["minutes"] > 0:
        mult = {cap: 2}
    elif live[vice]["minutes"] > 0:
        mult = {vice: 2}
    else:
        mult = {}
    return xi, bench, subs, mult


def player_obj(eid, el, teams, live):
    e = el[eid]
    return {
        "name": e["web_name"],
        "pos": POS_NAME[e["element_type"]],
        "team": teams[e["team"]]["short_name"],
        "team_code": teams[e["team"]]["code"],
        "code": e["code"],          # 照片: photos/players/110x140/p{code}.png
        "points": live[eid]["total_points"],
        "minutes": live[eid]["minutes"],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gw", type=int, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--current", default=CURRENT)
    ap.add_argument("--baseline", default=BASELINE)
    a = ap.parse_args()

    boot = get("/bootstrap-static/")
    el = {e["id"]: e for e in boot["elements"]}
    teams = {t["id"]: t for t in boot["teams"]}
    ev = next((e for e in boot["events"] if e["id"] == a.gw), {})
    finished = bool(ev.get("finished"))

    live_raw = get("/event/%d/live/" % a.gw)["elements"]
    live = {e["id"]: e["stats"] for e in live_raw}

    base = json.load(open(a.baseline, encoding="utf-8"))["teams"]
    cur = json.load(open(a.current, encoding="utf-8"))

    out = {
        "gw": a.gw,
        "snapshot_time": datetime.now(BJT).strftime("%Y-%m-%d %H:%M"),
        "gw_finished": finished,
        "league": {"id": cur["meta"]["league_id"], "name": cur["meta"]["league_name"]},
        "players": {},
        "teams": {},
    }
    missing = []
    for entry in cur["entries"]:
        if entry.get("dq"):
            continue
        eid = entry["entry_id"]
        t = base.get(str(eid))
        if not t:
            missing.append(eid)
            continue
        xi, bench, subs, mult = resolve(t, el, live, finished)
        subbed_in = {s["in"] for s in subs}
        bench_all = [t["sub_gk"]] + list(t["sub_out"])   # 原始替补位 4 个（含被顶上者）
        pts = sum(live[e]["total_points"] * mult.get(e, 1) for e in xi)
        bench_pts = sum(live[b]["total_points"] for b in bench_all if b not in subbed_in)
        for e in xi + bench_all + [x["out"] for x in subs]:
            if str(e) not in out["players"]:
                out["players"][str(e)] = player_obj(e, el, teams, live)
        out["teams"][str(eid)] = {
            "zid": entry.get("zid"),
            "team_name": entry.get("team_name"),
            "manager_name": entry.get("manager_name"),
            "entry_id": eid,
            "points": pts,
            "bench_points": bench_pts,
            "official_event_total": entry.get("event_total") if a.gw == cur["meta"]["current_gw"] else None,
            "chip": t.get("active_chip") if a.gw == 1 else None,
            "formation": formation_str(xi, el),
            "starters": [{"id": e, "multiplier": mult.get(e, 1),
                          "captain": e == t["captain"], "vice": e == t["vice"],
                          "sub_in": e in subbed_in} for e in xi],
            "bench": [{"id": b, "came_on": b in subbed_in} for b in bench_all],
            "subs": subs,
        }
        if finished and a.gw == cur["meta"]["current_gw"] and pts != entry.get("event_total"):
            log("WARN 总分不一致 entry=%s calc=%s official=%s" % (eid, pts, entry.get("event_total")))

    if missing:
        log("WARN baseline 缺失 %d 队: %s" % (len(missing), missing[:5]))

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    tmp = a.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, a.out)
    size = os.path.getsize(a.out) / 1024
    log("OK gw=%d finished=%s teams=%d size=%.1fKB -> %s" % (a.gw, finished, len(out["teams"]), size, a.out))


if __name__ == "__main__":
    main()
