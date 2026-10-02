/* ==========================================================================
   ZBL 僵尸联赛看板 — 历史杯赛对阵图（独立模块，不侵入 app.js）
   数据：data/cup/cup_*.json（后端清洗好的结构化对阵树）
   依赖：无（原生 JS）。激活时机：杯赛 Tab 首次可见时懒加载。
   布局：列 = 轮次（左→右晋级），行 = 由 feeds_into 递归中点定位。
   ========================================================================== */

(function () {
    'use strict';

    /* ===================== 配置 ===================== */
    const SEASONS = ['2324', '2425', '2526'];
    const FILES = {
        '2324': 'data/cup/cup_2324.json',
        '2425': 'data/cup/cup_2425.json',
        '2526': 'data/cup/cup_2526.json'
    };
    const LABELS = { '2324': '23/24', '2425': '24/25', '2526': '25/26' };

    // 布局常量（单一真源：JS 计算，同步写入容器 CSS 变量 / 内联样式）
    const ROW_H = 46;      // 行距：一个叶子签位占的高度
    const CARD_H = 40;     // 对阵卡高度
    const COL_W = 168;     // 每轮列宽
    const GAP = 30;        // 列间距（连线走这里）
    const CHAMP_W = 148;   // 冠军列宽
    const HEAD_H = 34;     // 列头高度

    const SPONSOR_ZID = 8; // 冠名赞助商「僵尸条」= ZID000008（与 app.js 同锚点）

    /* ===================== 状态 ===================== */
    const cache = {};          // season -> data
    let activeSeason = '2526'; // 默认展示最近一季
    let activated = false;     // 是否已懒加载过
    let currentTab = 'season';

    /* ===================== DOM ===================== */
    const $ = id => document.getElementById(id);
    let elBracket, elMobile, elLoading, elError, elChamp, elSummary;

    /* ===================== 工具 ===================== */
    function escHTML(s) {
        const d = document.createElement('div');
        d.textContent = String(s == null ? '' : s);
        return d.innerHTML;
    }
    const zidNum = z => { const m = String(z || '').match(/\d+/); return m ? parseInt(m[0], 10) : null; };
    const isSponsor = p => p && (zidNum(p.zid) === SPONSOR_ZID ||
        (!(p.zid) || p.zid === '未登记') && String(p.name || '').replace(/\s/g, '') === '僵尸条');
    const mkey = m => m.round + '|' + String(m.id);

    /* ===================== 数据加载 ===================== */
    function loadSeason(season) {
        if (cache[season]) return Promise.resolve(cache[season]);
        return fetch(FILES[season])
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(d => { cache[season] = d; return d; });
    }

    /* ===================== 激活 / 停用 ===================== */
    function activate() {
        if (!elBracket) return;
        setChrome(true);
        if (activated) return;
        activated = true;
        loadSeason(activeSeason)
            .then(d => { renderSeason(d); })
            .catch(err => { showError(err); });
    }

    function deactivate() { setChrome(false); }

    /** 杯赛 Tab 下隐藏榜单专用控件（搜索框 / 榜单图例），回来自动恢复 */
    function setChrome(onCup) {
        const fb = $('filter-bar'), lg = $('legend');
        if (fb) fb.hidden = onCup;
        if (lg) lg.hidden = onCup;
    }

    function showError(err) {
        console.error('杯赛数据加载失败:', err);
        if (elLoading) elLoading.hidden = true;
        if (elBracket) elBracket.hidden = true;
        if (elMobile) elMobile.hidden = true;
        if (elChamp) elChamp.hidden = true;
        if (elError) elError.hidden = false;
        if (elSummary) elSummary.textContent = '';
    }

    /* ===================== 布局计算 =====================
       叶子（无 feeders 的比赛）按序占一行；有 feeders 的比赛
       行中心 = 各子节点中心的平均。这样无论轮次是否满编
       （轮空 / 不满签），父子中线永远对齐，不产生错位空洞。 */
    function buildLayout(data) {
        const byKey = {};
        data.matches.forEach(m => { byKey[mkey(m)] = m; });

        const feeders = {};
        data.matches.forEach(m => {
            if (m.feeds_into && byKey[m.feeds_into]) {
                (feeders[m.feeds_into] = feeders[m.feeds_into] || []).push(m);
            }
        });

        const champZid = data.champion && data.champion.zid;
        const champWon = {};                       // 冠军赢下的比赛 key 集合
        data.matches.forEach(m => {
            if (!m.winner) return;
            const w = m.winner === 'a' ? m.a : m.b;
            if (w && w.zid === champZid) champWon[mkey(m)] = true;
        });

        const centers = {};
        let leaf = 0;
        function walk(m) {
            const key = mkey(m);
            const ch = (feeders[key] || []).slice().sort((a, b) => (parseInt(a.id, 10) - parseInt(b.id, 10)));
            if (!ch.length) {
                centers[key] = leaf + 0.5;
                leaf++;
            } else {
                let sum = 0;
                for (const c of ch) sum += walk(c);
                centers[key] = sum / ch.length;
            }
            return centers[key];
        }
        // 从决赛（最晚轮）回填整棵树
        const finals = data.matches.filter(m => m.round === data.rounds[data.rounds.length - 1]);
        finals.forEach(walk);

        const nRounds = data.rounds.length;
        const rows = leaf;
        const width = nRounds * (COL_W + GAP) + CHAMP_W;
        const height = rows * ROW_H;

        const cards = data.matches.map(m => {
            const ri = data.rounds.indexOf(m.round);
            return {
                m, ri, key: mkey(m),
                x: ri * (COL_W + GAP),
                cy: centers[mkey(m)] * ROW_H,
                champPath: !!champWon[mkey(m)]
            };
        });
        const cardBy = {};
        cards.forEach(c => { cardBy[c.key] = c; });

        // 连线：子卡右缘中点 → 父卡左缘中点（肘形）
        const edges = [];
        data.matches.forEach(m => {
            if (!m.feeds_into || !byKey[m.feeds_into]) return;
            const from = cardBy[mkey(m)], to = cardBy[m.feeds_into];
            if (!from || !to) return;
            const x1 = from.x + COL_W, y1 = from.cy, x2 = to.x, y2 = to.cy;
            const xm = x1 + GAP / 2;
            edges.push({
                d: 'M' + x1 + ' ' + y1 + ' H' + xm + ' V' + y2 + ' H' + x2,
                champ: champWon[mkey(m)] && champWon[m.feeds_into]
            });
        });
        // 决赛 → 冠军
        const fin = cardBy[mkey(finals[0])];
        if (fin) {
            const x1 = fin.x + COL_W, y1 = fin.cy, x2 = nRounds * (COL_W + GAP), y2 = fin.cy;
            edges.push({ d: 'M' + x1 + ' ' + y1 + ' H' + x2 + ' V' + y2, champ: true });
        }

        // 轮空短划：只有 1 个 feeder 的比赛，另一侧签位是轮空
        const byes = [];
        data.matches.forEach(m => {
            const n = (feeders[mkey(m)] || []).length;
            if (n !== 1) return;
            const to = cardBy[mkey(m)];
            const from = cardBy[mkey(feeders[mkey(m)][0])];
            const side = from.cy < to.cy ? 1 : -1;      // 轮空在对侧
            const y = to.cy + side * (ROW_H / 2);
            const x2 = to.x, x1 = to.x - GAP * 0.55;
            byes.push({ d: 'M' + x1 + ' ' + y + ' H' + x2, tx: x1 - 4, ty: y + 3 });
        });

        return { byKey, cards, edges, byes, rows, width, height, champWon, nRounds };
    }

    /* ===================== 渲染：公共卡片 ===================== */
    function sideHTML(p, win, pending) {
        if (!p) return '<div class="cup-team' + (pending ? ' cup-pending' : ' cup-empty') + '"><span class="cup-tname">待定</span></div>';
        const cls = 'cup-team' + (pending ? '' : win ? ' win' : ' lose');
        return '<div class="' + cls + '">'
            + (pending ? '' : win ? '<svg class="cup-win-mark" aria-hidden="true" focusable="false"><use href="#i-check"/></svg>' : '<span class="cup-lose-mark" aria-hidden="true">·</span>')
            + '<span class="cup-tname"' + (p.name ? ' title="' + escHTML(p.name) + '"' : '') + '>' + escHTML(p.name || '未知队伍') + '</span>'
            + (isSponsor(p) ? '<span class="sponsor-badge cup-sponsor" role="img" aria-label="本届冠名赞助商">冠名</span>' : '')
            + '</div>';
    }

    function cardInnerHTML(m) {
        const pending = !m.winner;
        const wa = !pending && m.winner === 'a';
        const wb = !pending && m.winner === 'b';
        return sideHTML(m.a, wa, pending) + sideHTML(m.b, wb, pending);
    }

    function cardAria(m, label) {
        if (!m.winner) return label + ' 第' + m.id + '场：' + ((m.a && m.a.name) || '待定') + ' 对 ' + ((m.b && m.b.name) || '待定') + '，结果未记录';
        const w = m.winner === 'a' ? m.a : m.b;
        const l = m.winner === 'a' ? m.b : m.a;
        return label + ' 第' + m.id + '场：' + ((w && w.name) || '待定') + ' 胜 ' + ((l && l.name) || '待定');
    }

    /* ===================== 渲染：桌面对阵图 ===================== */
    function renderDesktop(data, L) {
        let html = '<div class="cup-colheads" aria-hidden="true" style="width:' + L.width + 'px">';
        data.rounds.forEach((r, i) => {
            html += '<span class="cup-colhead" style="left:' + (i * (COL_W + GAP)) + 'px;width:' + COL_W + 'px">'
                + escHTML(data.round_labels[r] || r) + '</span>';
        });
        html += '<span class="cup-colhead cup-colhead-champ" style="left:' + (L.nRounds * (COL_W + GAP)) + 'px;width:' + CHAMP_W + 'px">冠军</span></div>';

        html += '<div class="cup-canvas" style="width:' + L.width + 'px;height:' + L.height + 'px">';
        html += '<svg class="cup-links" width="' + L.width + '" height="' + L.height + '" viewBox="0 0 ' + L.width + ' ' + L.height + '" aria-hidden="true" focusable="false">';
        L.edges.forEach(e => { html += '<path class="cup-link' + (e.champ ? ' cup-link-champ' : '') + '" d="' + e.d + '"/>'; });
        L.byes.forEach(b => {
            html += '<path class="cup-bye" d="' + b.d + '"/>'
                + '<text class="cup-bye-label" x="' + b.tx + '" y="' + b.ty + '" text-anchor="end">轮空</text>';
        });
        html += '</svg>';

        L.cards.forEach(c => {
            const m = c.m;
            const top = c.cy - CARD_H / 2;
            html += '<div class="cup-card' + (c.champPath ? ' champ-path' : '') + '"'
                + ' role="group" aria-label="' + escHTML(cardAria(m, data.round_labels[m.round] || m.round)) + '"'
                + ' style="left:' + c.x + 'px;top:' + top.toFixed(1) + 'px;width:' + COL_W + 'px;height:' + CARD_H + 'px">'
                + cardInnerHTML(m) + '</div>';
        });

        // 冠军卡
        const fin = L.cards.find(c => c.m.round === data.rounds[L.nRounds - 1]);
        if (fin) {
            const top = fin.cy - CARD_H / 2;
            const cp = data.champion || {};
            html += '<div class="cup-card cup-champ-card" role="group" aria-label="冠军：' + escHTML(cp.name || '未知') + '"'
                + ' style="left:' + (L.nRounds * (COL_W + GAP)) + 'px;top:' + top.toFixed(1) + 'px;width:' + CHAMP_W + 'px;height:' + CARD_H + 'px">'
                + '<div class="cup-team win cup-champ-team">'
                + '<svg class="cup-champ-crown" aria-hidden="true" focusable="false"><use href="#i-crown"/></svg>'
                + '<span class="cup-tname">' + escHTML(cp.name || '未知') + '</span>'
                + '<span class="cup-champ-tag" role="img" aria-label="杯赛冠军">冠军</span></div></div>';
        }
        html += '</div>';
        elBracket.innerHTML = html;
        elBracket.hidden = false;
    }

    /* ===================== 渲染：移动端分轮列表 ===================== */
    function renderMobile(data, L) {
        // 决赛、半决赛默认展开，其余折叠（最有信息量的先看见）
        const openSet = {};
        const n = data.rounds.length;
        data.rounds.forEach((r, i) => { openSet[r] = i >= n - 2; });

        let html = '';
        data.rounds.forEach(r => {
            const ms = data.matches.filter(m => m.round === r);
            html += '<details class="cup-mround"' + (openSet[r] ? ' open' : '') + '>'
                + '<summary class="cup-mround-head">' + escHTML(data.round_labels[r] || r)
                + '<span class="cup-mround-count">' + ms.length + ' 场</span>'
                + '<svg class="cup-mround-caret" aria-hidden="true" focusable="false"><use href="#i-chevron"/></svg></summary>'
                + '<ul class="cup-mlist">';
            ms.forEach(m => {
                html += '<li class="cup-mcard' + (L.champWon[mkey(m)] ? ' champ-path' : '') + '">'
                    + '<span class="cup-mcard-no">第' + escHTML(m.id) + '场</span>'
                    + cardInnerHTML(m)
                    + '<span class="sr-only">' + escHTML(cardAria(m, data.round_labels[m.round] || m.round)) + '</span>'
                    + '</li>';
            });
            html += '</ul></details>';
        });
        elMobile.innerHTML = html;
        elMobile.hidden = false;
    }

    /* ===================== 渲染：赛季 ===================== */
    function renderSeason(data) {
        if (elError) elError.hidden = true;
        if (elLoading) elLoading.hidden = true;

        const L = buildLayout(data);
        renderDesktop(data, L);
        renderMobile(data, L);

        // 冠军横幅
        const cp = data.champion || {};
        if (elChamp) {
            elChamp.innerHTML = '<svg class="cup-champ-crown" aria-hidden="true" focusable="false"><use href="#i-crown"/></svg>'
                + '<span class="cup-champ-label">' + escHTML(LABELS[data.season] || data.label || '') + ' 杯赛冠军</span>'
                + '<span class="cup-champ-name">' + escHTML(cp.name || '未知') + '</span>';
            elChamp.hidden = false;
        }
        if (elSummary) {
            elSummary.textContent = data.label + ' 赛季共 ' + data.matches.length + ' 场比赛，'
                + '从 ' + (data.round_labels[data.rounds[0]] || data.rounds[0]) + ' 打到决赛，冠军 ' + (data.champion ? data.champion.name : '未知') + '。';
        }
    }

    /* ===================== 交互 ===================== */
    function bindSeasonButtons() {
        const box = $('cup-seasons');
        if (!box) return;
        box.addEventListener('click', e => {
            const btn = e.target.closest('.cup-season-btn');
            if (!btn) return;
            const s = btn.dataset.season;
            if (!s || s === activeSeason) return;
            activeSeason = s;
            box.querySelectorAll('.cup-season-btn').forEach(b =>
                b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
            if (elLoading) elLoading.hidden = false;
            if (elBracket) elBracket.hidden = true;
            if (elMobile) elMobile.hidden = true;
            if (elChamp) elChamp.hidden = true;
            if (elError) elError.hidden = true;
            loadSeason(s).then(renderSeason).catch(showError);
        });
    }

    function bindRetry() {
        const btn = $('cup-retry');
        if (!btn) return;
        btn.addEventListener('click', () => {
            if (elError) elError.hidden = true;
            if (elLoading) elLoading.hidden = false;
            loadSeason(activeSeason).then(renderSeason).catch(showError);
        });
    }

    /* ===================== 启动 ===================== */
    function initCup() {
        elBracket = $('cup-bracket');
        elMobile = $('cup-mobile');
        elLoading = $('cup-loading');
        elError = $('cup-error');
        elChamp = $('cup-champ');
        elSummary = $('cup-summary');
        if (!elBracket) return;

        bindSeasonButtons();
        bindRetry();

        // 打印时强制展开全部分轮（打印态显示的是 .cup-mobile 列表，折叠的 details 打不出内容）
        window.addEventListener('beforeprint', () => {
            elMobile.querySelectorAll('details.cup-mround').forEach(d => { d.dataset.wasOpen = d.open ? '1' : '0'; d.open = true; });
        });
        window.addEventListener('afterprint', () => {
            elMobile.querySelectorAll('details.cup-mround').forEach(d => { d.open = d.dataset.wasOpen === '1'; delete d.dataset.wasOpen; });
        });

        // Tab 切换广播（app.js 在 switchTab 末尾派发）
        document.addEventListener('zbl:tabchange', e => {
            currentTab = e.detail.tab;
            if (currentTab === 'cup') activate(); else deactivate();
        });

        // 时序兜底：app.js 的 init 在 defer 阶段同步执行，#cup 直达的首次
        // switchTab 广播可能早于本监听器注册 → 补查一次当前选中态
        const cupTab = $('tab-cup');
        if (cupTab && cupTab.getAttribute('aria-selected') === 'true') activate();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initCup);
    } else {
        initCup();
    }

})();
