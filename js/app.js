/* ==========================================================================
   ZBL 僵尸联赛看板 — Main Application Logic
   暗夜球场（Undead Pitch）主题 · 纯静态 · 零依赖
   无 setInterval / 无常驻 requestAnimationFrame / 无 canvas 逐帧重绘
   ========================================================================== */

(function () {
    'use strict';

    // ===================== Configuration =====================
    const HISTORY_FILES = [
        { file: 'data/history/goat_2324.json', label: '23/24' },
        { file: 'data/history/goat_2425.json', label: '24/25' },
        { file: 'data/history/goat_2526.json', label: '25/26' }
    ];
    const CURRENT_FILE = 'data/current.json';

    /* 队名兜底字典：data/history/goat_*.json 的 entry 可能不带 team_name
       （README 给的历史样例只有 goat_total + breakdown），未参赛队伍会退化成
       显示「ZID000104」这种 ZID 串。这里附带读根目录的静态 mapping.json 做第三级兜底。
       26KB 静态文件，Vercel CDN 会缓存；加载失败仅静默降级，不进错误态也不进部分失败警告条。 */
    const MAPPING_FILE = 'mapping.json';

    // ⚠️ 预留字段（任务书硬约束「数据接口不变」，故保留加载，不删除这个 fetch）。
    //    当前未参与任何计算：GoAT 榜的「名次变化」是前端用历史 GoAT 现算的
    //    （histOnlyRank），不读本文件。它的加载失败不得触发错误态。
    const PREV_RANK_FILE = 'data/prev_season_rank.json';

    /* ===== 支线 B：本届冠名赞助商识别 ===== */
    const SPONSOR = { zid: 8, teamName: '僵尸条' };   // mapping.json: ZID000008 → 僵尸条

    // 'ZID000008' / 'ZID138' / 'ZID00008' 都能取出数字 8
    const zidNum = z => { const m = String(z || '').match(/\d+/); return m ? parseInt(m[0], 10) : null; };

    // 主锚点 = ZID 数字；降级路径 = 无 ZID 时按去空格队名严格相等
    const isSponsor = row =>
        zidNum(row.zid) === SPONSOR.zid ||
        (!(row.zid) || row.zid === '未登记') &&
            String(row.team_name || '').replace(/\s/g, '') === SPONSOR.teamName;

    // ===================== State =====================
    let currentData = null;
    let historyData = [];      // Array of { entries: {ZID:{goat_total}} }
    let missingSeasons = [];   // 加载失败的历史赛季显示名，如 ['24/25']
    let activeTab = 'season';
    let filterTimer = null;
    let teamNameMap = {};        // ZID → team_name（来自 mapping.json，纯兜底）
    let pendingNameFallback = false;   // 本次渲染是否有行走到了队名兜底分支

    // ===================== Initialization =====================
    async function init() {
        // ❗初始定位必须前移到数据加载之前，否则首屏会闪一下赛季榜再跳 GoAT
        syncTabFromHash();
        window.addEventListener('hashchange', syncTabFromHash);

        initTabs();
        initFilter();
        initLegend();
        initBackToTop();

        // ❗不 await：mapping.json 只用于队名兜底，绝不能拖慢首屏表格渲染
        const mappingPromise = loadJSON(MAPPING_FILE).catch(() => null);

        try {
            const results = await Promise.allSettled([
                loadJSON(CURRENT_FILE),
                ...HISTORY_FILES.map(h => loadJSON(h.file)),
                loadJSON(PREV_RANK_FILE).catch(() => null)   // 预留字段，失败静默
            ]);

            if (results[0].status !== 'fulfilled') {
                showError(results[0].reason);
                return;
            }
            currentData = results[0].value;

            // 历史赛季：失败的要点名，不能静默丢弃（否则 GoAT 总分系统性偏低且用户不知情）
            missingSeasons = [];
            for (let i = 0; i < HISTORY_FILES.length; i++) {
                const r = results[1 + i];
                if (r.status === 'fulfilled') historyData.push(r.value);
                else missingSeasons.push(HISTORY_FILES[i].label);
            }

            // 预留字段 prev_season_rank.json：读取但当前不参与计算（见顶部注释）
            // const prevRankResult = results[1 + HISTORY_FILES.length];

            if (!currentData || !Array.isArray(currentData.entries) || currentData.entries.length === 0) {
                showEmpty();
                return;
            }

            updateTimestamp();
            renderSeasonTable();
            pendingNameFallback = false;
            renderGoATTable();
            renderGoatNotice();
            clearSkeleton();
            updateFilterCount(true);

            // mapping.json 落地后用真实队名回填未参赛行（不阻塞首屏）
            applyMappingTeamNames(mappingPromise);
        } catch (err) {
            console.error('Initialization error:', err);
            showError(err);
        }
    }

    // ===================== Utility =====================
    async function loadJSON(path) {
        const resp = await fetch(path);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${path}`);
        return resp.json();
    }

    const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    function escHTML(str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g, c => ESC_MAP[c]);
    }

    function clearSkeleton() {
        ['season-tbody', 'goat-tbody'].forEach(id => {
            const tb = document.getElementById(id);
            if (tb) tb.removeAttribute('aria-busy');
        });
        document.querySelectorAll('.table-wrapper').forEach(w => w.classList.remove('is-loading'));
    }

    function updateTimestamp() {
        const el = document.getElementById('data-update');
        if (!currentData || !el) return;
        const ts = currentData.snapshot_time || '';
        let gw = null;
        const meta = currentData.meta || {};
        if (meta.current_gw != null) gw = meta.current_gw;
        else if (meta.gw != null) gw = meta.gw;
        else if (currentData.entries && currentData.entries[0]) gw = currentData.entries[0].current_gw;
        // 取不到轮次时整段省略，不要显示「第 undefined 轮」
        const gwText = (gw === null || gw === '' || gw === undefined) ? '' : ` · 第 ${gw} 轮`;
        const text = `数据更新于 ${ts}（北京时间）${gwText}`;
        el.innerHTML = `<span class="pulse-dot" aria-hidden="true"></span>${escHTML(text)}`;
        const pt = document.getElementById('print-ts');
        if (pt) pt.textContent = `${ts}（北京时间）`;
    }

    /**
     * Standard competition ranking (1224 system):
     * 并列同名次，后续名次跳号。如 [100,95,95,80] → [1,2,2,4]
     * ✅ 该逻辑经验证正确，原样保留。
     */
    function assignRanks(items, getValueFn) {
        const indexed = items.map((item, i) => ({ index: i, value: getValueFn(item) }));
        indexed.sort((a, b) => b.value - a.value);

        const ranks = new Array(items.length);
        let i = 0;
        while (i < indexed.length) {
            let j = i;
            while (j < indexed.length && indexed[j].value === indexed[i].value) j++;
            const rank = i + 1;                      // 1-based
            for (let k = i; k < j; k++) ranks[indexed[k].index] = rank;
            i = j;
        }
        return ranks;
    }

    // ===================== 徽章 / 单元格片段 =====================
    function sponsorBadgeHTML() {
        return '<span class="sponsor-badge" role="img" aria-label="本届冠名赞助商" title="本届冠名赞助商">冠名</span>';
    }
    function dqBadgeHTML() {
        return '<span class="dq-badge" role="img" aria-label="已判 DQ，取消本赛季资格">DQ</span>';
    }
    function rankChipHTML(rank) {
        return rank <= 3
            ? `<span class="rank-chip">${rank}</span>`
            : String(rank);
    }

    /** 名次变化单元格：SVG（非 U+2191 字符，防列宽跳动）+ 中文 aria-label */
    function rankChangeHTML(goatRank, histRank, histGoat, degraded) {
        const note = degraded ? '（历史数据不完整，仅供参考）' : '';
        if (!histGoat) {
            return `<span class="rank-change rank-change-new" role="img" aria-label="本赛季新加入，暂无历史名次">new</span>`;
        }
        if (goatRank < histRank) {
            const n = histRank - goatRank;
            return `<span class="rank-change rank-change-up" role="img" aria-label="名次上升 ${n} 位${note}" title="赛季初第 ${histRank} 名 → 现在第 ${goatRank} 名，上升 ${n} 位${note}"><svg aria-hidden="true" focusable="false"><use href="#i-up"/></svg>${n}</span>`;
        }
        if (goatRank > histRank) {
            const n = goatRank - histRank;
            return `<span class="rank-change rank-change-down" role="img" aria-label="名次下降 ${n} 位${note}" title="赛季初第 ${histRank} 名 → 现在第 ${goatRank} 名，下降 ${n} 位${note}"><svg aria-hidden="true" focusable="false"><use href="#i-down"/></svg>${n}</span>`;
        }
        return `<span class="rank-change rank-change-same" role="img" aria-label="名次与赛季初持平" title="赛季初第 ${goatRank} 名 → 现在第 ${goatRank} 名，持平${note}"><svg aria-hidden="true" focusable="false"><use href="#i-flat"/></svg></span>`;
    }

    /**
     * 本赛季「排名变化」：当前排名 vs 上轮结束排名（API 的 last_rank）。
     *
     * ⚠️ 与上面的 rankChangeHTML（）口径不同：GoAT 是「实时 GoAT 名次 vs 赛季初
     *    （仅按历史 GoAT 排序）名次」，本赛季是「当前名次 vs 上轮名次」。
     *    两者写成两个独立函数，互不干扰，GoAT 逻辑一个字未改。
     *
     * 复用同一套 .rank-change 组件与 #i-up / #i-down / #i-flat 符号，保持一致。
     * last_rank 缺失（首轮 / DQ / 老快照）→ 显示「—」，绝不出现 0 或 NaN。
     */
    function seasonRankChangeHTML(rank, lastRank) {
        const cur = Number(rank);
        const last = Number(lastRank);
        // null/undefined/空串/非数字/非正 → 无法比较
        if (!isFinite(cur) || !isFinite(last) || cur <= 0 || last <= 0) {
            return '<span class="rank-change rank-change-none" role="img" aria-label="暂无上轮排名，无法比较" title="暂无上轮排名数据（首轮、DQ 或历史快照）">—</span>';
        }
        if (cur < last) {
            const n = last - cur;
            return `<span class="rank-change rank-change-up" role="img" aria-label="较上轮上升 ${n} 位" title="上轮第 ${last} 名 → 现在第 ${cur} 名，上升 ${n} 位"><svg aria-hidden="true" focusable="false"><use href="#i-up"/></svg>${n}</span>`;
        }
        if (cur > last) {
            const n = cur - last;
            return `<span class="rank-change rank-change-down" role="img" aria-label="较上轮下降 ${n} 位" title="上轮第 ${last} 名 → 现在第 ${cur} 名，下降 ${n} 位"><svg aria-hidden="true" focusable="false"><use href="#i-down"/></svg>${n}</span>`;
        }
        return `<span class="rank-change rank-change-same" role="img" aria-label="较上轮名次持平" title="上轮第 ${last} 名 → 现在第 ${cur} 名，持平"><svg aria-hidden="true" focusable="false"><use href="#i-flat"/></svg></span>`;
    }

    /** 本 GW 得分：DQ / 字段缺失 → 「—」，绝不显示 NaN */
    function gwScoreHTML(eventTotal) {
        const v = Number(eventTotal);
        if (eventTotal === null || eventTotal === undefined || eventTotal === '' || !isFinite(v)) {
            return '<span class="cell-empty">—</span>';
        }
        return `<span class="cell-main">${v}</span>`;
    }

    // ===================== Season Tab =====================
    function renderSeasonTable() {
        const tbody = document.getElementById('season-tbody');
        if (!tbody || !currentData || !currentData.entries) return;

        const entries = currentData.entries;
        const ranks = assignRanks(entries, e => e.total);

        const rows = entries.map((entry, idx) => ({
            rank: ranks[idx],
            zid: entry.zid,
            team_name: entry.team_name,
            manager_name: entry.manager_name || '',
            total: entry.total,
            last_rank: entry.last_rank,          // 可能为 null（首轮 / DQ / 老快照）
            event_total: entry.event_total,      // 可能为 undefined（老快照）
            dq: !!entry.dq
        })).sort((a, b) => a.rank - b.rank);

        const gwNum = (currentData.meta && currentData.meta.current_gw) || null;
        const gwLabel = gwNum ? `第 ${gwNum} 轮` : '本轮';

        // 一次性 innerHTML 批量插入（105 行不逐行 appendChild、不逐行绑事件）
        tbody.innerHTML = rows.map(r => {
            const cls = [];
            if (r.dq) cls.push('row-dq');
            if (isSponsor(r)) cls.push('row-sponsor');

            const rankCls = r.rank <= 3 ? ` rank-${r.rank}` : '';
            const badges = (isSponsor(r) ? sponsorBadgeHTML() : '') + (r.dq ? dqBadgeHTML() : '');
            const search = escHTML(`${r.team_name} ${r.manager_name}`);

            // DQ 队没有本轮得分，强制「—」（不显示 0）
            const gwCell = r.dq ? '<span class="cell-empty">—</span>' : gwScoreHTML(r.event_total);
            const hasGw = !r.dq && r.event_total !== null && r.event_total !== undefined && r.event_total !== '' && isFinite(Number(r.event_total));
            const gwTitle = hasGw ? `${gwLabel}得分 ${Number(r.event_total)}` : `${gwLabel}得分暂无数据`;

            return `<tr class="${cls.join(' ')}" data-search="${search}">
                <td class="rank-cell${rankCls}">${rankChipHTML(r.rank)}</td>
                <td class="team-cell" title="${escHTML(r.team_name)}"><span class="team-name">${escHTML(r.team_name)}</span>${badges}</td>
                <td class="manager-cell">${escHTML(r.manager_name || '—')}</td>
                <td class="total-cell">${r.total}</td>
                <td class="rank-change-cell">${seasonRankChangeHTML(r.rank, r.last_rank)}</td>
                <td class="gw-score-cell" title="${escHTML(gwTitle)}">${gwCell}</td>
            </tr>`;
        }).join('');

        const cap = document.getElementById('season-caption');
        if (cap) cap.textContent = `本赛季积分榜，按 FPL 总分降序，共 ${rows.length} 支队伍`;
    }

    // ===================== GoAT Tab =====================
    function renderGoATTable() {
        const tbody = document.getElementById('goat-tbody');
        if (!tbody || !currentData || !currentData.entries) return;

        const entries = currentData.entries;
        const N = (currentData.meta && currentData.meta.total_entries) || entries.length;

        // Step 1: ZID → 历史 GoAT 累计（三季合并，失败的赛季已不计入）
        const historicalGoat = {};
        for (const hist of historyData) {
            if (!hist || !hist.entries) continue;
            for (const [zid, info] of Object.entries(hist.entries)) {
                // ⚠️ team_name 默认必须是空串，不能用 zid 兜底：否则第三步的兜底链
                //    会被这个"假名字"短路，未参赛行就会把 ZID 串当队名显示出来
                if (!historicalGoat[zid]) historicalGoat[zid] = { goat_total: 0, team_name: '' };
                historicalGoat[zid].goat_total += (info.goat_total || 0);
                if (info.team_name) historicalGoat[zid].team_name = info.team_name;
            }
        }

        // Step 2 / 3: 合并历史 ∪ 本赛季
        const currentByZid = {};
        for (const entry of entries) currentByZid[entry.zid] = entry;
        const allZids = new Set([...Object.keys(historicalGoat), ...Object.keys(currentByZid)]);

        const goatRows = [];
        for (const zid of allZids) {
            const hist = historicalGoat[zid] || null;
            const curr = currentByZid[zid] || null;
            const isDQ = !!(curr && curr.dq);
            const isCurrent = !!curr;

            const currentScore = curr ? (curr.total || 0) : 0;
            let currentRankPoints = 0;
            if (isCurrent && !isDQ && curr.rank > 0) {
                currentRankPoints = Math.max(0, N - curr.rank + 1);
            }
            const currentGoat = currentScore + currentRankPoints;
            const histGoat = hist ? hist.goat_total : 0;

            // 队名四级兜底：本赛季 → 历史季 → mapping.json → 占位文案
            // （历史 JSON 的 entry 常常不带 team_name，否则未参赛行会退化成显示 ZID 串）
            const nameFromEntries = (curr && curr.team_name) || (hist && hist.team_name) || '';
            if (!nameFromEntries) pendingNameFallback = true;

            goatRows.push({
                zid: zid,
                team_name: nameFromEntries || teamNameMap[zid] || '未登记队伍',
                manager_name: curr ? (curr.manager_name || '') : '',
                historical_goat: histGoat,
                current_score: currentScore,
                current_rank_points: currentRankPoints,
                current_goat: currentGoat,
                total_goat: histGoat + currentGoat,
                is_dq: isDQ,
                is_current: isCurrent
            });
        }

        // 实时总榜名次 vs 赛季初（仅按历史 GoAT 排序）名次
        const realRanks = assignRanks(goatRows, r => r.total_goat);
        const histOnlyRank = (() => {
            const indexed = goatRows.map((r, i) => ({ v: r.historical_goat, i }));
            indexed.sort((a, b) => b.v - a.v || a.i - b.i);
            const out = new Array(goatRows.length);
            let p = 0;
            while (p < indexed.length) {
                let q = p;
                while (q < indexed.length && indexed[q].v === indexed[p].v) q++;
                for (let k = p; k < q; k++) out[indexed[k].i] = p + 1;
                p = q;
            }
            return out;
        })();

        const sorted = goatRows
            .map((r, i) => ({ ...r, goat_rank: realRanks[i], hist_rank: histOnlyRank[i] }))
            .sort((a, b) => b.total_goat - a.total_goat);

        // 三季全失败 → 历史分全为 0 → 变化列全是垃圾数据，整列隐藏更诚实
        const hideChange = missingSeasons.length === HISTORY_FILES.length;
        const degraded = missingSeasons.length > 0;
        const th = document.querySelector('#goat-table .col-rank-change');
        if (th) th.hidden = hideChange;

        tbody.innerHTML = sorted.map(r => {
            const cls = [];
            if (!r.is_current) cls.push('row-inactive');
            if (r.is_dq) cls.push('row-dq');
            if (isSponsor(r)) cls.push('row-sponsor');

            const rankCls = r.goat_rank <= 3 ? ` rank-${r.goat_rank}` : '';
            const badges = (isSponsor(r) ? sponsorBadgeHTML() : '') + (r.is_dq ? dqBadgeHTML() : '');
            // 未参赛对读屏完全不可见（灰斜体不传递信息），补一次 sr-only 说明
            const srInactive = r.is_current ? '' : '<span class="sr-only">（本赛季未参赛，仅保留历史成绩）</span>';
            const search = escHTML(`${r.team_name} ${r.manager_name}`);

            const histTitle = `历史三季 GoAT 合计 ${r.historical_goat} 分（23/24 + 24/25 + 25/26）`;
            const currTitle = `本赛季：FPL 得分 ${r.current_score} + 排名分 ${r.current_rank_points} = ${r.current_goat}`;
            const totalTitle = `GoAT 总分 ${r.total_goat} = 历史 ${r.historical_goat} + 本季 ${r.current_goat}（本榜排序依据）`;

            const currCell = r.is_current
                ? `<span class="cell-main">${r.current_goat}</span><span class="cell-sub">${r.current_score}+${r.current_rank_points}</span>`
                : '—';

            return `<tr class="${cls.join(' ')}" data-search="${search}">
                <td class="rank-cell${rankCls}">${rankChipHTML(r.goat_rank)}</td>
                <td class="team-cell" title="${escHTML(r.team_name)}"><span class="team-name">${escHTML(r.team_name)}</span>${badges}${srInactive}</td>
                <td class="manager-cell">${escHTML(r.manager_name || '—')}</td>
                <td class="goat-cell" title="${histTitle}"><span class="cell-main">${r.historical_goat}</span></td>
                <td class="goat-cell${r.is_dq ? ' dq-season-cell' : ''}" title="${currTitle}">${currCell}</td>
                <td class="goat-total-cell" title="${totalTitle}"><span class="cell-main">${r.total_goat}</span></td>
                <td${hideChange ? ' hidden' : ''}>${rankChangeHTML(r.goat_rank, r.hist_rank, r.historical_goat, degraded)}</td>
            </tr>`;
        }).join('');

        const cap = document.getElementById('goat-caption');
        if (cap) cap.textContent = `GoAT 总榜，按 GoAT 总分降序（历史三季 GoAT 加本赛季 GoAT），共 ${sorted.length} 支队伍`;
    }

    /** mapping.json → { ZID: team_name }。不是 governance 数据，纯展示兜底 */
    function buildTeamNameMap(data) {
        const map = {};
        if (data && Array.isArray(data.teams)) {
            for (const t of data.teams) {
                if (t && t.zid && t.team_name) map[t.zid] = t.team_name;
            }
        }
        return map;
    }

    /**
     * mapping.json 落地后回填队名。
     * ❗硬性要求：失败静默（不进错误态、不进部分失败警告条）；不阻塞首屏；
     *   只有确实有行走过兜底分支时才重渲染，避免无谓的重绘。
     */
    function applyMappingTeamNames(mappingPromise) {
        Promise.resolve(mappingPromise)
            .then(data => {
                teamNameMap = buildTeamNameMap(data);
                if (!Object.keys(teamNameMap).length) return;
                if (!pendingNameFallback) return;
                if (!document.getElementById('goat-tbody')) return;   // 已被错误态/空态替换

                renderGoATTable();
                const input = document.getElementById('team-filter');
                if (input) applyFilter(input.value || '');            // 新队名要能被搜到
            })
            .catch(() => { /* mapping.json 缺失 → 静默降级，保持占位文案 */ });
    }

    /** 部分失败：GoAT 榜上方金色警告条（告知型，不是错误） */
    function renderGoatNotice() {
        const bar = document.getElementById('goat-notice');
        if (!bar) return;
        if (!missingSeasons.length) { bar.hidden = true; return; }

        const ok = HISTORY_FILES.filter(h => missingSeasons.indexOf(h.label) === -1).map(h => h.label);
        const text = `历史数据不完整：${HISTORY_FILES.length} 个赛季中只读取到 ${ok.length} 个（${ok.length ? ok.join('、') : '无'}），缺失 ${missingSeasons.join('、')}。GoAT 总分与名次变化可能低于实际值。`;
        const p = bar.querySelector('.notice-text');
        if (p) p.textContent = text;
        bar.hidden = false;   // live region 必须先存在于 DOM，文本后填才会被播报
    }

    // ===================== 状态面板：错误 / 空数据 =====================
    function replacePanelArea(html) {
        const main = document.getElementById('panel-area');
        if (!main) return;
        main.innerHTML = html;
        clearSkeleton();
        // 表格已不存在 → 搜索框与图例都是死控件/无对象，一并隐藏
        const nav = document.getElementById('tab-nav');
        const fb = document.getElementById('filter-bar');
        const lg = document.getElementById('legend');
        return { nav: nav, fb: fb, lg: lg };
    }

    function bindRetry() {
        const btn = document.getElementById('btn-retry');
        if (!btn) return;
        btn.addEventListener('click', () => location.reload());
        btn.focus();   // 键盘用户直接 Enter 重试
    }

    function showError(err) {
        const msg = err && err.message ? String(err.message) : '';
        const isFileProtocol = location.protocol === 'file:';
        let hintKey = 'net';
        if (isFileProtocol) hintKey = 'file';
        else if (/HTTP 40[34]/.test(msg)) hintKey = 'missing';

        const HINTS = {
            file: '检测到你正在用 file:// 直接打开本文件，浏览器会阻止读取本地 JSON。请在项目目录运行 python -m http.server 8080，然后访问 http://localhost:8080',
            missing: '请确认 data/current.json 存在且格式正确。若在服务器上，请运行 python snapshot.py 重新生成数据。',
            net: '请检查网络连接后重试。数据每日 16:30 更新，若刚过更新时间，稍等几分钟再试。'
        };

        const desc = '看板数据来自本站 data/ 目录下的 JSON 快照，本次读取失败。可能是网络问题，或今日快照尚未生成。'
            + (msg ? `（${escHTML(msg)}）` : '');

        const parts = replacePanelArea(
            `<div class="state-panel state-error" role="alert">
                <svg class="state-icon" aria-hidden="true" focusable="false"><use href="#i-warn"/></svg>
                <h2 class="state-title">数据暂时无法加载</h2>
                <p class="state-desc">${escHTML(desc)}</p>
                <p class="state-hint">${escHTML(HINTS[hintKey])}</p>
                <button type="button" class="btn-retry" id="btn-retry">
                    <svg aria-hidden="true" focusable="false"><use href="#i-refresh"/></svg>
                    重新加载
                </button>
            </div>`
        );
        if (!parts) return;
        if (parts.nav) parts.nav.hidden = true;   // 两个榜都无数据，Tab 是死控件
        if (parts.fb) parts.fb.hidden = true;
        if (parts.lg) parts.lg.hidden = true;
        bindRetry();
    }

    function showEmpty() {
        const parts = replacePanelArea(
            `<div class="state-panel state-empty">
                <svg class="state-icon" aria-hidden="true" focusable="false"><use href="#i-chart"/></svg>
                <h2 class="state-title">暂无榜单数据</h2>
                <p class="state-desc">已成功读取数据文件，但其中没有队伍记录。</p>
                <p class="state-hint">数据每日 16:30 自动生成。若赛季刚开始，请等待首次快照。</p>
                <button type="button" class="btn-retry" id="btn-retry">
                    <svg aria-hidden="true" focusable="false"><use href="#i-refresh"/></svg>
                    重新加载
                </button>
            </div>`
        );
        if (!parts) return;
        // Tab 栏不隐藏（结构仍在，用户可切换）
        if (parts.fb) parts.fb.hidden = true;
        if (parts.lg) parts.lg.hidden = true;
        bindRetry();
    }

    // ===================== Tab 切换 =====================
    function initTabs() {
        const tabs = Array.from(document.querySelectorAll('.tab-btn'));

        tabs.forEach(btn => {
            btn.addEventListener('click', () => {
                // ❗aria-disabled 不是 disabled，click 仍会触发 → 必须 JS 拦截
                if (btn.getAttribute('aria-disabled') === 'true') return;
                switchTab(btn.dataset.tab);
            });
        });

        const nav = document.getElementById('tab-nav');
        if (!nav) return;
        nav.addEventListener('keydown', e => {
            if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].indexOf(e.key) === -1) return;
            e.preventDefault();
            const list = tabs;                     // 含禁用项：方向键可到达
            let i = list.indexOf(document.activeElement);
            if (i < 0) i = list.findIndex(b => b.getAttribute('aria-selected') === 'true');

            let next;
            if (e.key === 'Home') next = 0;
            else if (e.key === 'End') next = list.length - 1;
            else {
                const d = e.key === 'ArrowRight' ? 1 : -1;
                next = (i + d + list.length) % list.length;
            }
            const target = list[next];
            target.focus();                                        // 焦点总是移动
            if (target.getAttribute('aria-disabled') !== 'true') {  // 但只有可用项才激活
                switchTab(target.dataset.tab);
            }
        });
    }

    function switchTab(tabName, opts) {
        opts = opts || {};
        document.querySelectorAll('.tab-btn').forEach(btn => {
            const sel = btn.dataset.tab === tabName;
            btn.setAttribute('aria-selected', sel ? 'true' : 'false');
            btn.tabIndex = sel ? 0 : -1;                    // roving tabindex
            const panel = document.getElementById(btn.getAttribute('aria-controls'));
            if (panel) {
                panel.hidden = !sel;                        // ❗用 hidden 属性，不是仅切 class
                panel.classList.toggle('active', sel);      // 打印态据此决定打印哪个 Tab
            }
        });
        activeTab = tabName;

        // 切换 Tab 清空关键词：每次切换都回到完整榜
        const input = document.getElementById('team-filter');
        if (input) input.value = '';
        applyFilter('');

        // 切换后重置容器滚动位置，避免落到榜单中部
        const panel = document.getElementById('content-' + tabName);
        const wrap = panel && panel.querySelector('.table-wrapper');
        if (wrap) wrap.scrollTop = 0;

        if (!opts.fromHash) {
            // replaceState 而非 pushState：切 Tab 是视图状态，不该污染历史栈
            const url = (tabName === 'season')
                ? location.pathname + location.search      // 默认 Tab 不写 hash
                : '#' + tabName;
            history.replaceState(null, '', url);
        }

        // 广播 Tab 切换（杯赛模块据此懒加载/隐藏榜单专用控件，见 js/cup.js）
        document.dispatchEvent(new CustomEvent('zbl:tabchange', { detail: { tab: tabName } }));
    }

    function syncTabFromHash() {
        const h = (location.hash || '').replace('#', '');
        const btn = h ? document.getElementById('tab-' + h) : null;
        // ❗拒绝禁用 Tab：杯赛不可通过 URL 激活
        if (!btn || btn.getAttribute('aria-disabled') === 'true') {
            switchTab('season', { fromHash: true });
            return;
        }
        switchTab(h, { fromHash: true });
    }

    // ===================== 搜索过滤 =====================
    function initFilter() {
        const input = document.getElementById('team-filter');
        if (!input) return;
        input.addEventListener('input', () => applyFilter(input.value));
        input.addEventListener('keydown', e => {
            if (e.key === 'Escape') { input.value = ''; applyFilter(''); input.blur(); }
        });
    }

    /** 过滤只切换行的 hidden，不改排名数字 */
    function applyFilter(kw) {
        const tbody = document.getElementById(activeTab === 'goat' ? 'goat-tbody' : 'season-tbody');
        if (!tbody) return;

        const key = String(kw || '').trim().replace(/\s/g, '').toLowerCase();
        let shown = 0;
        const rows = tbody.rows;
        for (let i = 0; i < rows.length; i++) {
            const tr = rows[i];
            if (tr.classList.contains('sk-row') || tr.classList.contains('state-empty-row')) continue;
            const hay = (tr.dataset.search || '').toLowerCase().replace(/\s/g, '');
            const hit = !key || hay.indexOf(key) !== -1;
            tr.hidden = !hit;                       // ❗不重建 DOM
            if (hit) shown++;
        }
        toggleEmptyRow(tbody, !!key && shown === 0);

        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(() => updateFilterCount(false, shown, key), 300);
    }

    function toggleEmptyRow(tbody, show) {
        let row = tbody.querySelector('.state-empty-row');
        if (show) {
            if (!row) {
                const colspan = tbody.id === 'goat-tbody' ? 7 : 6;   // 赛季榜 6 列（含排名变化 + 本GW得分）
                row = document.createElement('tr');
                row.className = 'state-empty-row';
                row.innerHTML = `<td class="state-inline" colspan="${colspan}">没有匹配的队伍，换个关键词试试。</td>`;
                tbody.appendChild(row);
            }
            row.hidden = false;
        } else if (row) {
            row.hidden = true;
        }
    }

    /** immediate=true 表示渲染完成后的初始化调用；否则为 debounce 后的过滤播报 */
    function updateFilterCount(immediate, shown, key) {
        const el = document.getElementById('filter-count');
        if (!el) return;
        const tbody = document.getElementById(activeTab === 'goat' ? 'goat-tbody' : 'season-tbody');
        if (!tbody) return;
        if (tbody.querySelector('.sk-row')) return;   // 数据尚未渲染，保持初始文案

        if (immediate) {
            el.textContent = `共 ${countDataRows(tbody)} 支队伍`;
            return;
        }
        if (!key) { el.textContent = `共 ${countDataRows(tbody)} 支队伍`; return; }
        if (!shown) { el.textContent = '没有匹配的队伍'; return; }
        el.textContent = `${shown} / ${countDataRows(tbody)}`;
    }

    function countDataRows(tbody) {
        let n = 0;
        const rows = tbody.rows;
        for (let i = 0; i < rows.length; i++) {
            const tr = rows[i];
            if (tr.classList.contains('sk-row') || tr.classList.contains('state-empty-row')) continue;
            n++;
        }
        return n;
    }

    // ===================== 图例 / 回到顶部 =====================
    function initLegend() {
        const lg = document.getElementById('legend');
        if (!lg) return;
        if (window.matchMedia && window.matchMedia('(max-width:768px)').matches) lg.open = false;
    }

    function initBackToTop() {
        const btt = document.getElementById('back-to-top');
        if (!btt) return;
        let ticking = false;
        window.addEventListener('scroll', () => {
            if (ticking) return;
            ticking = true;
            window.requestAnimationFrame(() => {
                btt.hidden = window.scrollY <= 600;
                ticking = false;
            });
        }, { passive: true });

        btt.addEventListener('click', () => {
            const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches;
            window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
            const sel = document.querySelector('.tab-btn[aria-selected="true"]');
            if (sel) sel.focus();
        });
    }

    // ===================== Start =====================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
