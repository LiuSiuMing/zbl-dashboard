/* ==========================================================================
   ZBL 战报 Tab — 纯静态渲染器（零依赖、零构建）
   --------------------------------------------------------------------------
   * 只加载 data/reports/index.json 里列出的 published 快照，不读 facts/content 草稿
   * 生产代码不含任何 preview / draft 分支
   * 队名一律 <a data-entry-id>，当前 GW 复用 js/lineups.js 的阵容弹层，
     历史 GW 给 FPL 原页链接（弹层只有当前 GW 的 lineups 快照）
   * 深链 #/reports/gwN；切期不刷新页面；段锚点用 JS 平滑滚动，不污染 hash
   ========================================================================== */
(function () {
    'use strict';

    var INDEX_URL = 'data/reports/index.json';
    var CURRENT_URL = 'data/current.json';
    var SECTIONS = ['overview', 'best', 'leader', 'top_group', 'in_form', 'watch'];
    var FPL_ENTRY = 'https://fantasy.premierleague.com/entry/';

    var state = {
        root: null, index: null, reports: [], currentGw: null,
        gw: null, doc: null, loading: false, activated: false
    };

    var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
    function num(v) { return Number(v || 0).toLocaleString('en-US'); }
    function fmtTime(iso) {
        var s = String(iso || '');
        return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)
            ? s.slice(0, 10) + ' ' + s.slice(11, 16) : s;
    }
    function fetchJSON(url) {
        return fetch(url, { cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
            return r.json();
        });
    }
    function gwInHash() {
        var m = /^#\/reports\/gw(\d+)$/.exec(location.hash || '');
        return m ? Number(m[1]) : null;
    }
    function setHash(gw) {
        var h = '#/reports/gw' + gw;
        if (location.hash !== h) history.replaceState(null, '', h);
    }
    function byGw(gw) {
        for (var i = 0; i < state.reports.length; i++) {
            if (Number(state.reports[i].gw) === Number(gw)) return state.reports[i];
        }
        return null;
    }
    function isCurrentReport(gw) {
        return state.currentGw != null && Number(gw) === Number(state.currentGw);
    }

    /* cup.js 在 zbl:tabchange 里会 setChrome(false) 把搜索框/图例恢复可见；
       setTimeout(0) 排在所有同步监听器之后，保证战报 Tab 下它们确实是隐藏的。 */
    function setChrome(onReports) {
        setTimeout(function () {
            var fb = document.getElementById('filter-bar');
            var lg = document.getElementById('legend');
            if (fb) fb.hidden = !!onReports;
            if (lg) lg.hidden = !!onReports;
        }, 0);
    }

    // ---------------------------------------------------------------- 队名链接
    function teamMap(doc) {
        var map = {}, i, r;
        if (doc && doc.team_names) {                 // 发布快照带的 ZBL Master 全量索引
            for (var id in doc.team_names) {
                if (Object.prototype.hasOwnProperty.call(doc.team_names, id)) {
                    map[doc.team_names[id]] = id;
                }
            }
            return map;
        }
        // 夹具降级：只链接事实层里出现过的队名（entry_id 仍取自 facts）
        var rows = [];
        if (doc) {
            rows.push(doc.leader, doc.leader && doc.leader.second, doc.in_form);
            rows = rows.concat(doc.best && doc.best.entries || [], doc.top_group || []);
        }
        for (i = 0; i < rows.length; i++) {
            r = rows[i];
            if (r && r.entry_id != null && r.team_name) map[r.team_name] = r.entry_id;
        }
        return map;
    }
    function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    function teamLink(name, id, current) {
        var href = current ? '#entry=' + id : FPL_ENTRY + id + '/history';
        var extra = current ? ' data-current-gw="1"'
                            : ' target="_blank" rel="noopener noreferrer"';
        return '<a data-entry-id="' + esc(id) + '" href="' + esc(href) + '"' + extra + '>'
             + esc(name) + '</a>';
    }
    function linkify(text, map, current) {
        var names = Object.keys(map).filter(Boolean).sort(function (a, b) { return b.length - a.length; });
        if (!names.length) return esc(text);
        var re = new RegExp('(' + names.map(escapeRe).join('|') + ')', 'g');
        var out = '', last = 0, m;
        while ((m = re.exec(String(text))) !== null) {
            out += esc(String(text).slice(last, m.index));
            out += teamLink(m[1], map[m[1]], current);
            last = m.index + m[1].length;
        }
        return out + esc(String(text).slice(last));
    }

    // ---------------------------------------------------------------- 状态面板
    function renderEmpty() {
        state.root.innerHTML =
            '<div class="rp-state" role="status">' +
            '<h2 class="rp-state-title">暂无已发布战报</h2>' +
            '<p class="rp-state-desc">本 GW 战报还在复核中，定稿发布后会自动出现在这里。</p></div>';
    }
    function renderError(err) {
        state.root.innerHTML =
            '<div class="rp-state rp-state-error" role="alert">' +
            '<h2 class="rp-state-title">战报暂时无法加载</h2>' +
            '<p class="rp-state-desc">' + esc(err && err.message ? err.message : '数据读取失败') + '</p>' +
            '<button type="button" class="rp-retry" data-action="retry">重新加载</button></div>';
    }

    // ---------------------------------------------------------------- 页面渲染
    function switcherHTML(gw) {
        var chips = '', opts = '', i, r, on;
        for (i = 0; i < state.reports.length; i++) {
            r = state.reports[i];
            on = Number(r.gw) === Number(gw);
            chips += '<button type="button" class="rp-chip' + (on ? ' is-active' : '') +
                     '" data-gw="' + esc(r.gw) + '"' + (on ? ' aria-current="true"' : '') +
                     '>GW' + esc(r.gw) + '</button>';
            opts += '<option value="' + esc(r.gw) + '"' + (on ? ' selected' : '') +
                    '>GW' + esc(r.gw) + '</option>';
        }
        var pos = -1;
        for (i = 0; i < state.reports.length; i++) {
            if (Number(state.reports[i].gw) === Number(gw)) pos = i;
        }
        // reports 按 gw 降序：pos-1 = 更新一期，pos+1 = 更早一期
        var newer = pos > 0 ? state.reports[pos - 1].gw : null;
        var older = pos >= 0 && pos < state.reports.length - 1 ? state.reports[pos + 1].gw : null;
        return '<div class="rp-switch">' +
               '<div class="rp-chips" role="group" aria-label="选择战报期数">' + chips + '</div>' +
               '<div class="rp-mobile-switch">' +
                 '<button type="button" class="rp-step" data-gw="' + (older == null ? '' : esc(older)) + '"' +
                   (older == null ? ' disabled' : '') + ' aria-label="上一期">← 上一期</button>' +
                 '<label class="sr-only" for="rp-select">选择战报期数</label>' +
                 '<select id="rp-select" class="rp-select">' + opts + '</select>' +
                 '<button type="button" class="rp-step" data-gw="' + (newer == null ? '' : esc(newer)) + '"' +
                   (newer == null ? ' disabled' : '') + ' aria-label="下一期">下一期 →</button>' +
               '</div></div>';
    }

    function tableHTML(doc, map, current) {
        var rows = doc.top_group || [], body = '', ch, mark, cls;
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            ch = Number(r.rank_change || 0);
            mark = ch > 0 ? '↑' + ch : (ch < 0 ? '↓' + (-ch) : '—');
            cls = ch > 0 ? 'rp-up' : (ch < 0 ? 'rp-down' : 'rp-flat');
            body += '<tr>' +
                '<td class="rp-c-rank">' + esc(r.rank) + '</td>' +
                '<td class="rp-c-team">' + teamLink(r.team_name, r.entry_id, current) + '</td>' +
                '<td class="rp-n">' + num(r.total) + '</td>' +
                '<td class="rp-n">' + num(r.event_total) + '</td>' +
                '<td class="rp-n"><span class="rp-change ' + cls + '">' + esc(mark) + '</span></td>' +
                '<td class="rp-n">' + num(r.overall_rank) + '</td>' +
                '</tr>';
        }
        return '<div class="rp-table-wrap" tabindex="0" role="region" aria-label="第一集团 2–10 名">' +
               '<table class="rp-table"><thead><tr>' +
               '<th scope="col">名次</th><th scope="col">队伍</th><th scope="col">总分</th>' +
               '<th scope="col">本轮</th><th scope="col">名次变化</th><th scope="col">overall</th>' +
               '</tr></thead><tbody>' + body + '</tbody></table></div>';
    }

    function renderReport(doc) {
        var c = doc.content || {}, s = c.sections || {}, head = c.headline || '';
        var gw = doc.gw, current = isCurrentReport(gw), map = teamMap(doc);
        var anchors = '', body = '', i, key, sec, j;
        for (i = 0; i < SECTIONS.length; i++) {
            key = SECTIONS[i];
            sec = s[key];
            if (!sec) continue;
            anchors += '<button type="button" class="rp-anchor" data-anchor="rp-' + key + '">' +
                       esc(sec.headline || sec.title || key) + '</button>';
        }
        for (i = 0; i < SECTIONS.length; i++) {
            key = SECTIONS[i];
            sec = s[key];
            if (!sec) continue;
            body += '<section class="rp-section" id="rp-' + key + '">' +
                    '<h3 class="rp-section-title">' + esc(sec.title || '') + '</h3>';
            for (j = 0; j < sec.paragraphs.length; j++) {
                body += '<p class="rp-p">' + linkify(sec.paragraphs[j], map, current) + '</p>';
            }
            if (key === 'top_group') body += tableHTML(doc, map, current);
            body += '</section>';
        }
        var footnote = (s.overview && s.overview.footnote) ||
            ('全体排名为按 ZBL ' + doc.team_count + ' 队总分-排名拟合的估算值，非官方排名。');
        footnote = footnote.replace(/。$/, '') + '；并列名次按 entry_id 排序。';

        state.root.innerHTML =
          '<article class="rp">' +
            switcherHTML(gw) +
            '<header class="rp-head">' +
              '<h2 class="rp-headline">' + esc(head) + '</h2>' +
              '<p class="rp-meta">' + esc(doc.team_count) + ' 支有效队伍 · 数据截至 ' +
                esc(fmtTime(doc.generated_at)) + '</p>' +
              '<nav class="rp-anchors" aria-label="段落导航">' + anchors + '</nav>' +
            '</header>' +
            '<div class="rp-body">' + body + '</div>' +
            '<p class="rp-foot">' + esc(footnote) + '</p>' +
          '</article>';
        // 渲染完成后同步下拉（切期重绘时不会保留旧选中项）
        var sel = document.getElementById('rp-select');
        if (sel) sel.value = String(gw);
    }

    // ---------------------------------------------------------------- 加载 / 切期
    function ensureIndex() {
        if (state.index) return Promise.resolve(state.index);
        return fetchJSON(INDEX_URL).then(function (idx) {
            state.index = idx;
            state.reports = (Array.isArray(idx) ? idx : (idx.reports || idx.published || []))
                .filter(function (r) { return !r.status || r.status === 'published'; })
                .slice().sort(function (a, b) { return Number(b.gw) - Number(a.gw); });
            return idx;
        });
    }
    function ensureCurrentGw() {
        if (state.currentGw !== null) return Promise.resolve();
        return fetchJSON(CURRENT_URL).then(function (d) {
            state.currentGw = (d && d.meta && d.meta.current_gw) || null;
        }).catch(function () { state.currentGw = null; });   // 取不到则全部按历史 GW 处理
    }
    function selectGw(gw) {
        var entry = byGw(gw);
        if (!entry) { gw = state.reports.length ? Number(state.reports[0].gw) : null; entry = byGw(gw); }
        if (!entry) { renderEmpty(); return Promise.resolve(); }
        if (state.gw === Number(gw) && state.doc) { setHash(gw); return Promise.resolve(); }

        state.loading = true;
        return fetchJSON('data/reports/' + entry.path).then(function (doc) {
            if (!doc || !doc.content || !doc.content.sections) {
                throw new Error('战报快照格式不正确');
            }
            state.doc = doc;
            state.gw = Number(gw);
            renderReport(doc);
            setHash(gw);
            state.loading = false;
        }).catch(function (err) {
            state.loading = false;
            renderError(err);
        });
    }
    function activate() {
        if (!state.root) return;
        state.activated = true;
        setChrome(true);
        Promise.all([ensureIndex(), ensureCurrentGw()]).then(function () {
            if (!state.activated) return;
            if (!state.reports.length) { renderEmpty(); return; }
            var want = gwInHash() || Number(state.reports[0].gw);
            if (!byGw(want)) want = Number(state.reports[0].gw);
            return selectGw(want);
        }).catch(function (err) {
            renderError(err);
        });
    }
    function deactivate(tab) {
        state.activated = false;
        // 切到杯赛时 cup.js 会 setChrome(true) 隐藏榜单控件；这里若再设 false
        // 会把它抢回可见，属于回归。其它 Tab 由 cup.js 恢复，本模块同步兜底。
        if (tab === 'cup') return;
        setChrome(false);
    }

    // ---------------------------------------------------------------- 事件
    function onClick(e) {
        var node = e.target;
        if (!node || !node.closest) return;
        /* ❗必须限定到本模块的按钮：app.js 会把当前 GW 写在 <html data-gw> 上，
           宽泛的 [data-gw] 会一路 closest 到 <html>，把所有点击（含队名链接、
           段锚点）都吞成「切期」，阵容弹层永远打不开。 */
        var chip = node.closest('.rp-chip[data-gw], .rp-step[data-gw]');
        if (chip && state.root.contains(chip) && chip.dataset.gw) {
            e.preventDefault();
            selectGw(Number(chip.dataset.gw));
            return;
        }
        var anchor = node.closest && node.closest('.rp-anchor');
        if (anchor) {
            e.preventDefault();
            var target = document.getElementById(anchor.dataset.anchor);
            var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (target) target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
            return;
        }
        if (node.closest && node.closest('[data-action="retry"]')) {
            state.index = null; state.reports = []; state.gw = null; state.doc = null;
            activate();
            return;
        }
        var link = node.closest && node.closest('a[data-entry-id]');
        if (link) {
            if (link.dataset.currentGw === '1' && window.zblLineups) {
                e.preventDefault();
                /* fromHash:true → 不 pushState '#entry='，也不在关闭时清掉战报深链 */
                window.zblLineups.open(link.getAttribute('data-entry-id'), { fromHash: true });
            }
            // 历史 GW：保留默认行为，打开 FPL 原页
        }
    }

    function init() {
        state.root = document.getElementById('reports-root');
        if (!state.root) return;
        state.root.addEventListener('click', onClick);
        state.root.addEventListener('change', function (e) {
            if (e.target && e.target.id === 'rp-select') selectGw(Number(e.target.value));
        });
        document.addEventListener('zbl:tabchange', function (e) {
            var tab = e.detail && e.detail.tab;
            if (tab === 'reports') activate();
            else deactivate(tab);
        });
        window.addEventListener('hashchange', function () {
            var gw = gwInHash();
            if (gw != null && state.activated && byGw(gw)) selectGw(gw);
        });
        // 深链直达：app.js 的 init 在 DOMContentLoaded 才派发 tabchange，这里兜底一次
        if (gwInHash() != null) setTimeout(activate, 0);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
