#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ZBL 本 GW 阵容生成器 v2
=======================
v1 的问题（2026-10-28 修）：
  1. 用 GW1 的 starters/bench/captain 当成「全季不变」→ 错。ZBL 只冻结 15 人名单，
     每 GW 首发 / 替补顺序 / 队长都可以改 → 会凭空造出 autosub、总分算错。
  2. official_event_total 取 current.json 的 event_total（联赛 standings 口径），
     比分结算滞后 → 与 live 数据不同源，出现「卡片合计对、官方总分不对」。
  3. bench 直接回填 GW1 的 4 个替补位 → 被顶上的球员同时出现在首发和替补席，
     被换下的首发无处显示。

v2：直接读官方 /entry/{id}/event/{gw}/picks/（同一份响应里就有）
  · picks position 1-11 = 本 GW 实际首发（已含官方 autosub 结果）
  · position 12-15     = 当前替补席（被换下的首发会回到这里）
  · automatic_subs     = 官方自动替补明细（in/out）
  · entry_history.points / points_on_bench = 官方分数，同源同时刻
  · active_chip        = 本 GW 芯片（bboost 替补计分 / 3xc 队长三倍，multiplier 已反映）
基线 baseline_gw1.json 仅作兜底：picks 拉取失败时退回 v1 逻辑。
"""
import argparse
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta

API = "https://fantasy.premierleague.com/api"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
BJT = timezone(timedelta(hours=8))
POS_NAME = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}
HOME = os.path.expanduser("~")
CURRENT = os.path.join(HOME, "zbl-dashboard", "data", "current.json")
BASELINE = os.path.join(HOME, "zbl-data", "baseline_gw1.json")


def log(msg):
    print("[lineups] %s" % msg, flush=True)


def get(path, retries=3):
    url = path if path.startswith("http") else API + path
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception as e:                       # noqa: BLE001
            last = e
            time.sleep(1.0 + i * 1.5)
    raise last


# ---------------- 兜底：v1 的 autosub 推演（仅 picks 拉取失败时用） ----------------
def formation_ok(xi, el):
    c = {1: 0, 2: 0, 3: 0, 4: 0}
    for e in xi:
        c[el[e]["element_type"]] += 1
    return c[1] == 1 and 3 <= c[2] <= 5 and 2 <= c[3] <= 5 and 1 <= c[4] <= 3


def formation_str(ids, el):
    c = {1: 0, 2: 0, 3: 0, 4: 0}
    for e in ids:
        c[el[e]["element_type"]] += 1
    return "%d-%d-%d" % (c[2], c[3], c[4])


def resolve_legacy(t, el, live, apply_subs):
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
    st = live.get(eid, {})
    return {
        "name": e["web_name"],
        "pos": POS_NAME[e["element_type"]],
        "team": teams[e["team"]]["short_name"],
        "team_code": teams[e["team"]]["code"],
        "code": e["code"],
        "points": st.get("total_points", 0),
        "minutes": st.get("minutes", 0),
    }


def build_from_picks(p, eid, live):
    """从官方 picks 响应构队；返回 (team_dict, 需要收录的球员 id 列表)"""
    picks = p["picks"]
    xi = sorted([x for x in picks if x["position"] <= 11], key=lambda x: x["position"])
    bench = sorted([x for x in picks if x["position"] > 11], key=lambda x: x["position"])
    auto = p.get("automatic_subs") or []
    subs = [{"in": s["element_in"], "out": s["element_out"]} for s in auto]
    sub_in = {s["in"] for s in subs}
    sub_out = {s["out"] for s in subs}
    hist = p.get("entry_history") or {}

    pts = sum(live.get(x["element"], {}).get("total_points", 0) * x["multiplier"] for x in picks)

    team = {
        "points": pts,
        "bench_points": hist.get("points_on_bench", 0),
        "official_event_total": hist.get("points"),
        "chip": p.get("active_chip"),
        "formation": None,          # 由调用方用 el 填
        "starters": [{"id": x["element"], "multiplier": x["multiplier"],
                      "captain": bool(x.get("is_captain")),
                      "vice": bool(x.get("is_vice_captain")),
                      "sub_in": x["element"] in sub_in} for x in xi],
        "bench": [{"id": x["element"], "came_on": x["element"] in sub_in,
                   "subbed_out": x["element"] in sub_out} for x in bench],
        "subs": subs,
    }
    return team, [x["element"] for x in picks]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gw", type=int, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--current", default=CURRENT)
    ap.add_argument("--baseline", default=BASELINE)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--no-fallback", action="store_true")
    a = ap.parse_args()

    boot = get("/bootstrap-static/")
    el = {e["id"]: e for e in boot["elements"]}
    teams = {t["id"]: t for t in boot["teams"]}
    ev = next((e for e in boot["events"] if e["id"] == a.gw), {})
    finished = bool(ev.get("finished"))

    live = {e["id"]: e["stats"] for e in get("/event/%d/live/" % a.gw)["elements"]}

    cur = json.load(open(a.current, encoding="utf-8"))
    base = {}
    if not a.no_fallback and os.path.exists(a.baseline):
        base = json.load(open(a.baseline, encoding="utf-8")).get("teams", {})

    out = {
        "gw": a.gw,
        "snapshot_time": datetime.now(BJT).strftime("%Y-%m-%d %H:%M"),
        "gw_finished": finished,
        "league": {"id": cur["meta"]["league_id"], "name": cur["meta"]["league_name"]},
        "players": {},
        "teams": {},
    }

    entries = [e for e in cur["entries"] if not e.get("dq")]

    def fetch(entry):
        eid = entry["entry_id"]
        try:
            return eid, get("/entry/%d/event/%d/picks/" % (eid, a.gw)), None
        except Exception as e:                        # noqa: BLE001
            return eid, None, str(e)

    with ThreadPoolExecutor(max_workers=max(1, a.workers)) as ex:
        fetched = {eid: (p, err) for eid, p, err in ex.map(fetch, entries)}

    n_api = n_legacy = 0
    bad = []
    for entry in entries:
        eid = entry["entry_id"]
        p, err = fetched.get(eid, (None, "not fetched"))
        team, ids = None, []

        if p and p.get("picks"):
            team, ids = build_from_picks(p, eid, live)
            team["formation"] = formation_str([x["id"] for x in team["starters"]], el)
            team["source"] = "api"
            n_api += 1
            calc, off = team["points"], team["official_event_total"]
            if off is not None and calc != off:
                bad.append((eid, entry.get("team_name"), calc, off, team.get("chip")))
        else:
            t = base.get(str(eid))
            if not t:
                log("WARN 既无 picks 也无 baseline entry=%s err=%s" % (eid, err))
                continue
            xi, bench, subs, mult = resolve_legacy(t, el, live, finished)
            sub_in = {s["in"] for s in subs}
            subbed_out = {s["out"] for s in subs}
            bench_all = [t["sub_gk"]] + list(t["sub_out"])
            team = {
                "points": sum(live[e]["total_points"] * mult.get(e, 1) for e in xi),
                "bench_points": sum(live[b]["total_points"] for b in bench_all if b not in sub_in),
                "official_event_total": entry.get("event_total"),
                "chip": None,
                "formation": formation_str(xi, el),
                "starters": [{"id": e, "multiplier": mult.get(e, 1),
                              "captain": e == t["captain"], "vice": e == t["vice"],
                              "sub_in": e in sub_in} for e in xi],
                "bench": [{"id": b, "came_on": b in sub_in, "subbed_out": b in subbed_out}
                          for b in bench_all],
                "subs": subs,
                "source": "baseline-fallback",
            }
            ids = list(set(xi + bench_all + list(subbed_out)))
            n_legacy += 1
            if err:
                log("WARN fallback entry=%s err=%s" % (eid, err))

        team.update({
            "zid": entry.get("zid"),
            "team_name": entry.get("team_name"),
            "manager_name": entry.get("manager_name"),
            "entry_id": eid,
        })
        out["teams"][str(eid)] = team
        for e in ids:
            if str(e) not in out["players"]:
                out["players"][str(e)] = player_obj(e, el, teams, live)

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    tmp = a.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, a.out)

    if bad:
        log("WARN 总分与官方不一致 %d 队: %s" % (len(bad), bad[:8]))
    size = os.path.getsize(a.out) / 1024
    log("OK gw=%d finished=%s teams=%d api=%d fallback=%d mismatch=%d size=%.1fKB -> %s"
        % (a.gw, finished, len(out["teams"]), n_api, n_legacy, len(bad), size, a.out))
    if bad and finished:
        sys.exit(4)


if __name__ == "__main__":
    main()
