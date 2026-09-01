/* ==========================================================================
   ZBL 僵尸联赛看板 — Main Application Logic
   ========================================================================== */

(function () {
    'use strict';

    // ===================== Configuration =====================
    const HISTORY_FILES = [
        'data/history/goat_2324.json',
        'data/history/goat_2425.json',
        'data/history/goat_2526.json'
    ];
    const CURRENT_FILE = 'data/current.json';
    const PREV_RANK_FILE = 'data/prev_season_rank.json';

    // ===================== State =====================
    let currentData = null;
    let historyData = []; // Array of {season, entries: {ZID: {goat_total}}}
    let prevSeasonRank = {}; // {ZID: rank}

    // ===================== Initialization =====================
    async function init() {
        try {
            const results = await Promise.allSettled([
                loadJSON(CURRENT_FILE),
                ...HISTORY_FILES.map(f => loadJSON(f)),
                loadJSON(PREV_RANK_FILE).catch(() => null) // optional file
            ]);

            // Current data
            if (results[0].status === 'fulfilled') {
                currentData = results[0].value;
            } else {
                const isFileProtocol = window.location.protocol === 'file:';
                const corsHint = isFileProtocol
                    ? '<br><br><small style="color:#ffcc00;">提示：file:// 协议无法加载 JSON。<br>请运行 <code>python -m http.server 8080</code> 后访问 <code>http://localhost:8080</code></small>'
                    : '<br><br><small style="color:#70a070;">请确认 data/current.json 存在且格式正确。<br>运行 <code>python snapshot.py</code> 生成数据。</small>';
                showError('无法加载本赛季数据 (current.json)' + corsHint);
                return;
            }

            // Historical data
            for (let i = 0; i < HISTORY_FILES.length; i++) {
                const r = results[1 + i];
                if (r.status === 'fulfilled') {
                    historyData.push(r.value);
                }
            }

            // Previous season rank (optional)
            const prevRankResult = results[1 + HISTORY_FILES.length];
            if (prevRankResult && prevRankResult.status === 'fulfilled') {
                prevSeasonRank = prevRankResult.value.ranks || prevRankResult.value.entries || {};
            }

            // Update header timestamp
            updateTimestamp();

            // Render tables
            renderSeasonTable();
            renderGoATTable();

            // Init tabs
            initTabs();

            // 🔗 hash 路由：#goat / #cup 直达对应 Tab（分享链接友好）
            const applyHash = () => {
                const h = (location.hash || '').replace('#', '');
                if (h && document.getElementById(`content-${h}`)) switchTab(h);
            };
            applyHash();
            window.addEventListener('hashchange', applyHash);

            // Init matrix rain
            initMatrixRain();

        } catch (err) {
            console.error('Initialization error:', err);
            showError('数据加载失败: ' + err.message);
        }
    }

    // ===================== Utility =====================
    async function loadJSON(path) {
        const resp = await fetch(path);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${path}`);
        return resp.json();
    }

    function showError(msg) {
        ['season-tbody', 'goat-tbody'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = `<tr><td colspan="8" class="loading-cell" style="color:#ff4444;">⚠ ${msg}</td></tr>`;
        });
    }

    function updateTimestamp() {
        const el = document.getElementById('data-update');
        if (!currentData) return;
        const ts = currentData.snapshot_time;
        el.innerHTML = `<span class="pulse-dot"></span> 数据更新于 ${ts}（北京时间）`;
    }

    /**
     * Standard competition ranking (1224 system):
     * Items with equal values share the same rank, next rank(s) are skipped.
     * E.g., values [100, 95, 95, 80] → ranks [1, 2, 2, 4]
     */
    function assignRanks(items, getValueFn) {
        // Create indices with values, sort descending
        const indexed = items.map((item, i) => ({ index: i, value: getValueFn(item) }));
        indexed.sort((a, b) => b.value - a.value);

        const ranks = new Array(items.length);
        let i = 0;
        while (i < indexed.length) {
            let j = i;
            // Find all items with the same value
            while (j < indexed.length && indexed[j].value === indexed[i].value) {
                j++;
            }
            const rank = i + 1; // 1-based rank
            for (let k = i; k < j; k++) {
                ranks[indexed[k].index] = rank;
            }
            i = j;
        }
        return ranks;
    }

    // ===================== Season Tab =====================
    function renderSeasonTable() {
        const tbody = document.getElementById('season-tbody');
        if (!currentData || !currentData.entries) {
            tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">无数据</td></tr>';
            return;
        }

        const entries = currentData.entries;
        const N = currentData.meta.total_entries;

        // Calculate ranks based on total score descending
        const ranks = assignRanks(entries, e => e.total);

        // Build rows (entries already sorted by entry_rank from API, but we recalculate)
        const rows = entries.map((entry, idx) => ({
            rank: ranks[idx],
            zid: entry.zid,
            team_name: entry.team_name,
            manager_name: entry.manager_name || '',
            current_gw: entry.current_gw,
            total: entry.total,
            dq: !!entry.dq,
            registered: entry.zid !== '未登记'
        }));

        // Sort by rank ascending
        rows.sort((a, b) => a.rank - b.rank);

        // Render HTML
        tbody.innerHTML = rows.map(r => {
            const rankClass = r.rank <= 3 ? ` rank-${r.rank}` : '';
            // DQ 队伍：沉底划线（仅当季排名页）
            const dqRowClass = r.dq ? ' dq-team' : '';
            const dqBadge = r.dq ? ' <span class="dq-badge">DQ</span>' : '';
            return `
                <tr class="${dqRowClass}">
                    <td class="rank-cell${rankClass}">${r.rank}</td>
                    <td class="team-cell" title="${escHTML(r.team_name)}">${escHTML(r.team_name)}${dqBadge}</td>
                    <td class="manager-cell">${escHTML(r.manager_name || '—')}</td>
                    <td class="total-cell">${r.total}</td>
                </tr>`;
        }).join('');
    }

    // ===================== GoAT Tab =====================
    function renderGoATTable() {
        const tbody = document.getElementById('goat-tbody');
        if (!currentData || !currentData.entries) {
            tbody.innerHTML = '<tr><td colspan="8" class="loading-cell">无数据</td></tr>';
            return;
        }

        const entries = currentData.entries;
        const N = currentData.meta.total_entries; // 本赛季报名总数(含 DQ)，排名分分母

        // ===== Step 1: 构建「ZID → 历史 GoAT 累计」字典（三季去重合并）=====
        const historicalGoat = {}; // zid → { goat_total, team_name }
        for (const hist of historyData) {
            if (!hist || !hist.entries) continue;
            for (const [zid, info] of Object.entries(hist.entries)) {
                if (!historicalGoat[zid]) historicalGoat[zid] = { goat_total: 0, team_name: zid };
                historicalGoat[zid].goat_total += (info.goat_total || 0);
                if (info.team_name) historicalGoat[zid].team_name = info.team_name;
            }
        }

        // ===== Step 2: 本赛季数据字典 =====
        const currentByZid = {};
        for (const entry of entries) currentByZid[entry.zid] = entry;

        // ===== Step 3: 合并全部 ZID（历史 ∪ 本赛季）=====
        const allZids = new Set([...Object.keys(historicalGoat), ...Object.keys(currentByZid)]);

        // Build GoAT data for each ZID
        const goatRows = [];
        for (const zid of allZids) {
            const hist = historicalGoat[zid] || null;
            const curr = currentByZid[zid] || null;
            const isDQ = !!(curr && curr.dq);
            const isCurrent = !!curr;

            const currentSeasonScore = curr ? (curr.total || 0) : 0;

            // 排名分：仅本赛季正常队有；DQ 队清零；未参赛队 0
            let currentRankPoints = 0;
            if (isCurrent && !isDQ && curr.rank > 0) {
                currentRankPoints = Math.max(0, N - curr.rank + 1);
            }

            const currentGoat = currentSeasonScore + currentRankPoints;
            const histGoat = hist ? hist.goat_total : 0;
            const totalGoat = histGoat + currentGoat;

            goatRows.push({
                zid: zid,
                team_name: (curr && curr.team_name) || (hist && hist.team_name) || zid,
                manager_name: curr ? (curr.manager_name || '') : '',
                historical_goat: histGoat,
                current_score: currentSeasonScore,
                current_rank_points: currentRankPoints,
                current_goat: currentGoat,
                total_goat: totalGoat,
                registered: zid !== '未登记',
                is_dq: isDQ,
                is_current: isCurrent
            });
        }

        // Calculate GoAT ranks
        // 🔴 排名变化（20:05 Leon 拍板定义）：
        //   实时总榜排名 = rank(三季历史GOAT + 本季score+排名分) —— 同一累计分数池
        //   赛季初基准   = rank(三季历史GOAT)
        //   历史 occupation 大头，单场波动小，哀稳第一则显示― ✓
        const realGoatVals = goatRows.map(r => r.total_goat);
        const histOnlyVals = goatRows.map(r => r.historical_goat);
        const realRanks = assignRanks(goatRows, r => r.total_goat); // 与下方 goatRanks 一致
        const histOnlyRank = (() => {
            const indexed = histOnlyVals.map((v, i) => ({ v, i }));
            indexed.sort((a, b) => b.v - a.v || a.i - b.i);
            const out = new Array(histOnlyVals.length);
            let p = 0;
            while (p < indexed.length) {
                let q = p;
                while (q < indexed.length && indexed[q].v === indexed[p].v) q++;
                for (let k = p; k < q; k++) out[indexed[k].i] = p + 1;
                p = q;
            }
            return out;
        })();

        // Sort by GoAT total descending
        const sorted = goatRows
            .map((r, i) => ({ ...r, goat_rank: realRanks[i], hist_rank: histOnlyRank[i] }))
            .sort((a, b) => b.total_goat - a.total_goat);

        // Render
        tbody.innerHTML = sorted.map(r => {
            const rankClass = r.goat_rank <= 3 ? ` rank-${r.goat_rank}` : '';

            // 排名变化：实时总榜名次 vs 历史赛季 GOAT 名次（纯前端同尺子计算）
            let rankChangeHTML;
            if (r.historical_goat === 0) {
                // 新队/未登记无历史：无法比较
                rankChangeHTML = '<span class="rank-change-same">new</span>';
            } else if (r.goat_rank < r.hist_rank) {
                rankChangeHTML = `<span class="rank-change-up">↑${r.hist_rank - r.goat_rank}</span>`;
            } else if (r.goat_rank > r.hist_rank) {
                rankChangeHTML = `<span class="rank-change-down">↓${r.goat_rank - r.hist_rank}</span>`;
            } else {
                rankChangeHTML = '<span class="rank-change-same">―</span>';
            }

            return `
                <tr class="${!r.is_current ? ' inactive-season' : ''}">
                    <td class="rank-cell${rankClass}">${r.goat_rank}</td>
                    <td class="team-cell" title="${escHTML(r.team_name)}">${escHTML(r.team_name)}${r.is_dq ? ' <span class="dq-badge">DQ</span>' : ''}</td>
                    <td class="manager-cell">${escHTML(r.manager_name || '—')}</td>
                    <td class="goat-cell" title="23/24 + 24/25 + 25/26 三季合计">${r.historical_goat}</td>
                    <td class="goat-cell${r.is_dq ? ' dq-season-cell' : ''}" title="得分 ${r.current_score} + 排名分 ${r.current_rank_points}">
                        ${r.is_current ? r.current_goat : '—'}
                        ${r.is_current ? `<br><small style="color:var(--text-dim);font-size:0.7rem;">(${r.current_score}+${r.current_rank_points})</small>` : ''}
                    </td>
                    <td class="goat-total-cell glow-text">${r.total_goat}</td>
                    <td style="text-align:center;">${rankChangeHTML}</td>
                </tr>`;
        }).join('');
    }

    // ===================== Tab Switching =====================
    function initTabs() {
        const buttons = document.querySelectorAll('.tab-btn:not(.disabled)');
        buttons.forEach(btn => {
            btn.addEventListener('click', () => {
                const tabName = btn.dataset.tab;
                switchTab(tabName);
            });
        });
    }

    function switchTab(tabName) {
        // Update buttons
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName);
        });
        // Update content
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.toggle('active', content.id === `content-${tabName}`);
        });
        // Update nav bottom border alignment
        const nav = document.getElementById('tab-nav');
        nav.scrollTop = 0;
    }

    // ===================== Matrix Rain Effect =====================
    function initMatrixRain() {
        const canvas = document.getElementById('matrix-rain');
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        let w, h, columns, drops;

        function resize() {
            w = canvas.width = window.innerWidth;
            h = canvas.height = window.innerHeight;
            const fontSize = 14;
            columns = Math.floor(w / fontSize);
            drops = new Array(columns).fill(1);
        }

        resize();
        window.addEventListener('resize', resize);

        const chars = 'ZBL僵尸联赛01GWHQFPLアイウエオカキクケコサシスセソ';
        const fontSize = 14;

        function draw() {
            ctx.fillStyle = 'rgba(10, 15, 10, 0.05)';
            ctx.fillRect(0, 0, w, h);

            ctx.fillStyle = '#00ff41';
            ctx.font = fontSize + 'px monospace';

            for (let i = 0; i < columns; i++) {
                const text = chars.charAt(Math.floor(Math.random() * chars.length));
                const x = i * fontSize;
                const y = drops[i] * fontSize;

                ctx.fillText(text, x, y);

                if (y > h && Math.random() > 0.975) {
                    drops[i] = 0;
                }
                drops[i]++;
            }
        }

        setInterval(draw, 80);
    }

    // ===================== HTML Escape =====================
    function escHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ===================== Start =====================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
