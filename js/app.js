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
                prevSeasonRank = prevRankResult.value.entries || {};
            }

            // Update header timestamp
            updateTimestamp();

            // Render tables
            renderSeasonTable();
            renderGoATTable();

            // Init tabs
            initTabs();

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
            registered: entry.zid !== '未登记'
        }));

        // Sort by rank ascending
        rows.sort((a, b) => a.rank - b.rank);

        // Render HTML
        tbody.innerHTML = rows.map(r => {
            const rankClass = r.rank <= 3 ? ` rank-${r.rank}` : '';
            const zidClass = r.registered ? '' : ' unregistered';
            const zidDisplay = r.registered ? r.zid : '未登记';
            return `
                <tr>
                    <td class="rank-cell${rankClass}">${r.rank}</td>
                    <td class="zid-cell${zidClass}">${zidDisplay}</td>
                    <td class="team-cell" title="${escHTML(r.team_name)}">${escHTML(r.team_name)}</td>
                    <td class="manager-cell">${escHTML(r.manager_name || '—')}</td>
                    <td style="text-align:center;font-family:var(--font-mono);">${r.current_gw}</td>
                    <td class="total-cell glow-text">${r.total}</td>
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
        const N = currentData.meta.total_entries;

        // Calculate current season rankings for GoAT rank points
        const currentRanks = assignRanks(entries, e => e.total);

        // Build GoAT data for each entry
        const goatRows = entries.map((entry, idx) => {
            const zid = entry.zid;
            const currentRank = currentRanks[idx];
            const currentSeasonScore = entry.total || 0;
            const currentRankPoints = N - currentRank + 1;
            const currentGoat = currentSeasonScore + currentRankPoints;
            const registered = entry.zid !== '未登记';

            // Sum up historical GoAT
            let historicalGoat = 0;
            for (const hist of historyData) {
                if (hist.entries && hist.entries[zid]) {
                    historicalGoat += (hist.entries[zid].goat_total || 0);
                }
            }

            const totalGoat = historicalGoat + currentGoat;

            // Previous season final rank
            const prevRank = prevSeasonRank[zid] || null;

            return {
                zid: zid,
                team_name: entry.team_name,
                manager_name: entry.manager_name || '',
                historical_goat: historicalGoat,
                current_score: currentSeasonScore,
                current_rank_points: currentRankPoints,
                current_goat: currentGoat,
                total_goat: totalGoat,
                prev_rank: prevRank,
                registered: registered
            };
        });

        // Calculate GoAT ranks
        const goatRanks = assignRanks(goatRows, r => r.total_goat);

        // Sort by GoAT total descending
        const sorted = goatRows
            .map((r, i) => ({ ...r, goat_rank: goatRanks[i] }))
            .sort((a, b) => b.total_goat - a.total_goat);

        // Render
        tbody.innerHTML = sorted.map(r => {
            const rankClass = r.goat_rank <= 3 ? ` rank-${r.goat_rank}` : '';
            const zidClass = r.registered ? '' : ' unregistered';
            const zidDisplay = r.registered ? r.zid : '未登记';

            // Rank change indicator
            let rankChangeHTML;
            if (r.prev_rank === null || r.prev_rank === undefined) {
                rankChangeHTML = '<span class="rank-change-same">—</span>';
            } else if (r.goat_rank < r.prev_rank) {
                const diff = r.prev_rank - r.goat_rank;
                rankChangeHTML = `<span class="rank-change-up">↑${diff}</span>`;
            } else if (r.goat_rank > r.prev_rank) {
                const diff = r.goat_rank - r.prev_rank;
                rankChangeHTML = `<span class="rank-change-down">↓${diff}</span>`;
            } else {
                rankChangeHTML = '<span class="rank-change-same">―</span>';
            }

            return `
                <tr>
                    <td class="rank-cell${rankClass}">${r.goat_rank}</td>
                    <td class="zid-cell${zidClass}">${zidDisplay}</td>
                    <td class="team-cell" title="${escHTML(r.team_name)}">${escHTML(r.team_name)}</td>
                    <td class="manager-cell">${escHTML(r.manager_name || '—')}</td>
                    <td class="goat-cell">${r.historical_goat}</td>
                    <td class="goat-cell" title="得分 ${r.current_score} + 排名分 ${r.current_rank_points}">
                        ${r.current_goat}
                        <br><small style="color:var(--text-dim);font-size:0.7rem;">(${r.current_score}+${r.current_rank_points})</small>
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
