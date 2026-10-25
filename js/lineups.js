/* ==========================================================================
   ZBL 僵尸联赛看板 — 「本 GW 阵容」弹层（js/lineups.js）
   纯静态 · 零依赖 · 不侵入 app.js（只消费 <tr data-entry-id>）

   设计要点
   ─────────────────────────────────────────────────────────────────────────
   1. 按需加载：首屏不碰 data/lineups/*.json，首次点击才请求，成功后驻留内存。
   2. 三态：骨架（≤1 次自动重试）→ 错误（可手动重试）/ 无数据。
   3. 深链 #entry=<id>：pushState 打开、replaceState 关闭；后退可关。
   4. 无障碍：role=dialog + aria-modal + 焦点陷阱 + 焦点归还 + 图片 alt 回退。
   5. 阵容口径与 zbl_lineups.py 一一对应，任何字段缺失都降级，不报错、不白屏。
   ========================================================================== */

(function () {
    'use strict';

    // ===================== Configuration =====================
    var DATA_DIR   = 'data/lineups/';
    var CURRENT    = 'data/current.json';
    var PHOTO_BASE = 'https://resources.premierleague.com/premierleague/photos/players/110x140/p';
    var BADGE_BASE = 'https://resources.premierleague.com/premierleague/badges/50/t';
    var FPL_BASE   = 'https://fantasy.premierleague.com/entry/';

    // 球场自上而下 = 前锋 → 中场 → 后卫 → 门将（与 FPL 官网方向一致）
    var POS_ORDER  = ['GK', 'DEF', 'MID', 'FWD'];
    var CHIP_TEXT  = { bboost: 'BB 替补计分', '3xc': 'TC 三倍队长', freehit: 'FH 自由换人', wildcard: 'WC 野卡' };
    var RETRY_MS   = 400;          // 自动重试前的等待（只重试 1 次）

    // ===================== State =====================
    var gw = null;                 // 当前 GW（<html data-gw> → 页头文案 → current.json）
    var dataCache = null;          // 已解析的 gw{n}.json
    var dataPromise = null;        // 并发去重
    var shell = null;              // { overlay, dialog, scroll, content }
    var opened = null;             // { entryId, token, deepLink } —— 非 null 即打开
    var seq = 0;                   // 渲染令牌：迟到的响应不覆盖新状态
    var lastFocus = null;          // 打开前的焦点（触发行）
    var titleBase = document.title;
    var scrollLock = null;
    var filterState = null;        // 打开前的搜索框状态（后退关闭时 app.js 会清空它）
    var toastTimer = null;
    var fitWarnings = 0;           // 三档字号仍溢出的名字数量（0 表示全部放下）
    var fitTimer = null;

    // ===================== Utility =====================
    var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    function esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
    }

    function num(v) {
        var n = Number(v);
        return isFinite(n) ? Math.round(n) : 0;
    }

    function delay(ms) {
        return new Promise(function (r) { setTimeout(r, ms); });
    }

    function fetchJSON(url) {
        // no-cache：JSON 每天覆盖同名文件，必须回源校验，不能吃旧缓存
        return fetch(url, { cache: 'no-cache' }).then(function (resp) {
            if (!resp.ok) throw new Error('HTTP ' + resp.status + ' · ' + url);
            return resp.json();
        });
    }

    function firstChar(str) {
        var s = String(str || '').trim();
        return s ? Array.from(s)[0] : '?';
    }

    // ===================== GW 与数据加载 =====================
    function readGW() {
        // 一级：app.js 写在 <html data-gw> 上的当前轮次
        var ds = document.documentElement.getAttribute('data-gw');
        if (ds && /^\d+$/.test(ds)) return Number(ds);

        // 二级：页头「数据更新于 … · 第 8 轮」
        var el = document.getElementById('data-update');
        var m = /第\s*(\d+)\s*轮/.exec(el ? el.textContent || '' : '');
        if (m) return Number(m[1]);

        return null;
    }

    function resolveGW() {
        if (gw) return Promise.resolve(gw);
        var v = readGW();
        if (v) { gw = v; return Promise.resolve(v); }
        // 三级：直接读 current.json（仅当 app.js 补丁未生效时会走到这里）
        return fetchJSON(CURRENT).then(function (d) {
            var g = d && d.meta && d.meta.current_gw;
            if (!g) throw new Error('无法确定当前 GW');
            gw = Number(g);
            return gw;
        });
    }

    function loadData(force) {
        if (!force && dataCache) return Promise.resolve(dataCache);
        if (!force && dataPromise) return dataPromise;

        dataPromise = resolveGW()
            .then(function (g) {
                var url = DATA_DIR + 'gw' + g + '.json';
                return fetchJSON(url).catch(function () {
                    // 自动重试 1 次：日更文件在 16:30 前后可能正好 404
                    return delay(RETRY_MS).then(function () { return fetchJSON(url); });
                });
            })
            .then(function (data) {
                if (!data || !data.teams) throw new Error('阵容数据格式不正确');
                dataCache = data;
                dataPromise = null;
                return data;
            }, function (err) {
                dataPromise = null;
                throw err;
            });

        return dataPromise;
    }

    // ===================== 弹层骨架（只创建一次） =====================
    function buildShell() {
        if (shell) return shell;

        var overlay = document.createElement('div');
        overlay.className = 'lu-overlay';
        overlay.innerHTML =
            '<div class="lu-dialog" role="dialog" aria-modal="true" aria-labelledby="lu-title" tabindex="-1">' +
                '<button type="button" class="lu-close" data-lu-close aria-label="关闭本 GW 阵容">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
                    'stroke-linecap="round" aria-hidden="true" focusable="false">' +
                    '<path d="M6 6l12 12M18 6L6 18"/></svg>' +
                '</button>' +
                '<div class="lu-scroll"><div class="lu-content" id="lu-content"></div></div>' +
            '</div>';

        document.body.appendChild(overlay);

        var dialog = overlay.querySelector('.lu-dialog');
        var scroll = overlay.querySelector('.lu-scroll');
        var content = overlay.querySelector('.lu-content');

        // 遮罩：只认「在遮罩本身按下」，避免从卡片里拖选到外面松手被误关
        overlay.addEventListener('pointerdown', function (e) {
            if (e.target === overlay) close();
        });

        overlay.addEventListener('click', function (e) {
            if (!e.target.closest) return;
            if (e.target.closest('[data-lu-close]')) close();
            else if (e.target.closest('[data-lu-retry]')) retry();
        });

        dialog.addEventListener('keydown', trapFocus);

        // 图片失败 → 隐藏该图，视觉自动落到下层首字母 / 纯文本缩写
        overlay.addEventListener('error', function (e) {
            var img = e.target;
            if (!img || img.tagName !== 'IMG') return;
            img.hidden = true;
            var card = img.closest ? img.closest('.lu-card') : null;
            if (card) {
                var av = card.querySelector('.lu-avatar');
                if (av) av.classList.add('is-imgfail');
                // 照片的 alt 承载球员名；图挂了要把可见姓名放回无障碍树
                var nameEl = card.querySelector('.lu-card-name[aria-hidden]');
                if (nameEl) nameEl.removeAttribute('aria-hidden');
            }
        }, true);

        shell = { overlay: overlay, dialog: dialog, scroll: scroll, content: content };
        return shell;
    }

    // ===================== 焦点管理 =====================
    function focusables(root) {
        var sel = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
                  'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
        return Array.prototype.filter.call(root.querySelectorAll(sel), function (el) {
            return el.getClientRects().length > 0;
        });
    }

    function trapFocus(e) {
        if (e.key !== 'Tab' || !shell) return;
        var list = focusables(shell.dialog);
        if (!list.length) { e.preventDefault(); return; }
        var first = list[0];
        var last = list[list.length - 1];

        if (e.shiftKey) {
            if (document.activeElement === first || document.activeElement === shell.dialog) {
                e.preventDefault();
                last.focus();
            }
        } else if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    }

    function focusDialog() {
        if (!shell) return;
        try { shell.dialog.focus({ preventScroll: true }); } catch (err) { shell.dialog.focus(); }
    }

    /** 数据到位后把焦点交给队名标题：读屏顺序天然是 队名 → 得分 → 阵型 */
    function focusHeading() {
        if (!shell) return;
        var h = shell.content.querySelector('#lu-title');
        if (!h) return;
        h.setAttribute('tabindex', '-1');
        try { h.focus({ preventScroll: true }); } catch (err) { h.focus(); }
        h.addEventListener('blur', function () { h.removeAttribute('tabindex'); }, { once: true });
    }

    function restoreFocus(entryId) {
        var row = document.querySelector('#season-tbody tr[data-entry-id="' + entryId + '"]');
        var target = (lastFocus && lastFocus !== document.body && document.contains(lastFocus)) ? lastFocus : row;
        lastFocus = null;
        if (!target || typeof target.focus !== 'function') return;
        try { target.focus({ preventScroll: true }); } catch (err) { target.focus(); }
    }

    // ===================== 滚动锁 =====================
    function lockScroll() {
        var bar = window.innerWidth - document.documentElement.clientWidth;
        scrollLock = { overflow: document.body.style.overflow, paddingRight: document.body.style.paddingRight };
        document.body.style.overflow = 'hidden';
        if (bar > 0) document.body.style.paddingRight = bar + 'px';   // 补滚动条宽度，防整页横移
    }

    function unlockScroll() {
        if (!scrollLock) return;
        document.body.style.overflow = scrollLock.overflow || '';
        document.body.style.paddingRight = scrollLock.paddingRight || '';
        scrollLock = null;
    }

    // ===================== 背景隔离（读屏 + 焦点） =====================
    /* 焦点陷阱只能拦键盘 Tab，拦不住读屏的「按标题跳转 / 元素列表」。
       所以打开弹层时把主内容整体 inert 掉：inert 同时做到
       ① 移出无障碍树 ② 不可聚焦 ③ 指针事件不落进去。
       老浏览器没有 inert 时降级为 aria-hidden="true"（此时仍有焦点陷阱兜底）。 */
    function setBackgroundInert(on) {
        var nodes = [document.querySelector('.app-container'), document.getElementById('back-to-top')];
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            if (!n) continue;
            if ('inert' in n) {
                n.inert = !!on;
                if (on) n.setAttribute('aria-hidden', 'true');   // 显式声明，便于排查
                else n.removeAttribute('aria-hidden');
            } else if (on) {
                n.setAttribute('aria-hidden', 'true');
            } else {
                n.removeAttribute('aria-hidden');
            }
        }
    }

    // ===================== 搜索框状态（后退关闭时还原） =====================
    function readFilter() {
        var el = document.getElementById('team-filter');
        return el ? { el: el, value: el.value } : null;
    }

    function restoreFilter() {
        var st = filterState;
        filterState = null;
        if (!st || !st.el) return;
        // app.js 的 hashchange → switchTab 会清空搜索框；等这一轮事件派发结束再还原
        setTimeout(function () {
            if (!st.el || st.el.value === st.value) return;
            st.el.value = st.value;
            st.el.dispatchEvent(new Event('input', { bubbles: true }));   // 触发 app.js 的 applyFilter
        }, 0);
    }

    // ===================== 渲染：球员卡 =====================
    function pickSlot(dict, slot) {
        var p = dict[String(slot.id)];
        if (!p) {
            // 防御：字典缺人时仍要占位，不能让整块球场塌掉
            p = { name: '未知球员', pos: '', team: '', team_code: 0, code: 0, points: 0, minutes: 0 };
        }
        return { p: p, s: slot };
    }

    function cardHTML(item, mode, slotLabel, ctx) {
        var p = item.p, s = item.s || {};
        var mult = mode === 'bench' ? 1 : (s.multiplier || 1);
        var pts = num(p.points) * mult;
        var blank = num(p.minutes) === 0;

        var cls = ['lu-card'];
        if (blank) cls.push('is-blank');
        if (s.sub_in) cls.push('is-subin');
        if (mode === 'bench' && s.came_on) cls.push('is-on');

        var name = String(p.name || '未知球员');
        var hasPhoto = !!p.code;                       // 没有 code = 数据层面就没有照片

        var media = '';
        if (hasPhoto) {
            media = '<img class="lu-photo" src="' + PHOTO_BASE + esc(p.code) + '.png" alt="' + esc(name) + '"' +
                    ' width="50" height="50" loading="lazy" decoding="async">';
        }
        if (p.team_code) {
            media += '<img class="lu-clubbadge" src="' + BADGE_BASE + esc(p.team_code) + '.png" alt=""' +
                     ' aria-hidden="true" width="14" height="14" loading="lazy" decoding="async">';
        }

        /* 袖标跟「实际吃到双倍的人」走，与 FPL 一致，且每队恒为 1 个 C：
           · 队长吃到双倍           → C 在队长，V 在副队
           · 队长没上场、副队加倍   → C 移到副队（带说明），0 分的队长不再挂 C
           · 两人都没上场（无双倍） → C 在队长、V 在副队，如实呈现袖标归属 */
        var doubled = mult === 2;
        ctx = ctx || {};
        var showC = s.captain
            ? (ctx.capDoubled || !ctx.hasDouble)
            : !!(s.vice && doubled);
        var showV = !!s.vice && !showC;
        var badges = '';
        if (showC) {
            badges += s.captain
                ? '<span class="lu-badge is-c" role="img" aria-label="队长">C</span>'
                : '<span class="lu-badge is-c" role="img" aria-label="副队长顶替队长，得分加倍"' +
                  ' title="队长本轮未上场，副队顶替队长并加倍">C</span>';
        }
        if (showV) badges += '<span class="lu-badge is-v" role="img" aria-label="副队长">V</span>';
        if (s.sub_in || (mode === 'bench' && s.came_on)) {
            badges += '<span class="lu-badge is-in" role="img" aria-label="本轮由替补席顶上">↑</span>';
        }

        // 照片 alt 已承载姓名 → 可见姓名对读屏隐藏，避免念两遍；
        // 照片 404 时上面的捕获监听会摘掉 aria-hidden。
        var nameHidden = hasPhoto ? ' aria-hidden="true"' : '';
        var ptsTitle = mult === 2
            ? '队长，得分加倍：' + num(p.points) + ' × 2 = ' + pts + ' 分'
            : '本 GW ' + pts + ' 分';

        return '<li class="' + cls.join(' ') + '">' +
            (slotLabel ? '<span class="lu-slot" aria-hidden="true">' + esc(slotLabel) + '</span>' : '') +
            '<span class="lu-avatar' + (hasPhoto ? '' : ' is-noimg') + '">' +
                '<span class="lu-initial" aria-hidden="true">' + esc(firstChar(name)) + '</span>' +
                media +
                (badges ? '<span class="lu-badges">' + badges + '</span>' : '') +
            '</span>' +
            '<span class="lu-card-name"' + nameHidden +
                ' title="' + esc(name) + '">' + esc(name) + '</span>' +
            '<span class="lu-card-foot">' +
                (p.team ? '<span class="lu-club" aria-hidden="true">' + esc(p.team) + '</span>' : '') +
                '<span class="lu-pts' + (mult === 2 ? ' is-captain' : '') + '" title="' + esc(ptsTitle) + '">' +
                    pts +
                '</span>' +
            '</span>' +
        '</li>';
    }

    function lineHTML(line, ctx) {
        if (!line.items.length) return '';
        return '<ul class="lu-line">' + line.items.map(function (it) {
            return cardHTML(it, 'pitch', null, ctx);
        }).join('') + '</ul>';
    }

    // ===================== 渲染：整支队伍 =====================
    function buildView(team, data) {
        var dict = data.players || {};
        var gwNum = num(data.gw);
        var finished = data.gw_finished === true;
        var snapshot = data.snapshot_time || '—';

        var name = String(team.team_name || '未知队伍');
        var official = team.official_event_total;
        var calc = num(team.points);
        var officialNum = (official === null || official === undefined) ? null : num(official);
        var head = officialNum === null ? calc : officialNum;
        // 官方口径与逐人复算不等时，把两个数字同时摆出来，别让用户自己怀疑加法
        var differ = officialNum !== null && officialNum !== calc;
        var benchPts = num(team.bench_points);
        var subs = Array.isArray(team.subs) ? team.subs : [];
        var starters = Array.isArray(team.starters) ? team.starters : [];
        var benchSlots = Array.isArray(team.bench) ? team.bench : [];

        // 首发按位置分线：数据里 starters 不保证按位置排序，必须自己分
        var idx = { GK: 0, DEF: 1, MID: 2, FWD: 3 };
        var lines = [{ pos: 'GK', items: [] }, { pos: 'DEF', items: [] },
                     { pos: 'MID', items: [] }, { pos: 'FWD', items: [] }];
        starters.forEach(function (s) {
            var it = pickSlot(dict, s);
            var li = Object.prototype.hasOwnProperty.call(idx, it.p.pos) ? idx[it.p.pos] : 2;
            lines[li].items.push(it);        // 位置可疑时落到中场线，绝不丢人
        });
        var capSlot = starters.filter(function (s) { return s.captain; })[0];
        var capCtx = {
            capDoubled: !!(capSlot && capSlot.multiplier === 2),
            hasDouble: starters.some(function (s) { return s.multiplier === 2; })
        };
        var pitch = lines.slice().reverse().map(function (ln) { return lineHTML(ln, capCtx); }).join('');

        // 替补席：bench[0] 恒为替补门将，其余按顶上优先级排列
        var bench = benchSlots.map(function (b, i) {
            return cardHTML(pickSlot(dict, b), 'bench', i === 0 ? 'GK' : String(i));
        }).join('');

        // 自动替补明细：被换下的球员本次快照可能没收录（生成器只收集首发 + 替补席），
        // 没名字就写成「已顶替首发」，不编假名字。
        var subsHTML = '';
        if (subs.length) {
            var rows = subs.map(function (sub) {
                var inP = dict[String(sub['in'])];
                var outP = dict[String(sub.out)];
                var inName = inP ? inP.name : '替补球员';
                var outName = outP ? outP.name : '';
                return '<li><span class="lu-in">↑ ' + esc(inName) + '</span> ' +
                    (outName ? '顶替 <span class="lu-out">↓ ' + esc(outName) + '</span>' : '已顶替首发') +
                '</li>';
            }).join('');
            subsHTML = '<div class="lu-subs">' +
                '<p class="lu-subs-title">自动替补 · ' + subs.length + ' 人</p>' +
                '<ul>' + rows + '</ul>' +
            '</div>';
        }

        // 头部
        var chips = ['<li><span class="lu-chip"><b>GW' + gwNum + '</b></span></li>'];
        if (team.formation) chips.push('<li><span class="lu-chip">阵型 <b>' + esc(team.formation) + '</b></span></li>');
        chips.push('<li><span class="lu-chip">替补席 <b>' + benchPts + '</b> 分</span></li>');
        if (team.chip && CHIP_TEXT[team.chip]) {
            chips.push('<li><span class="lu-chip is-chip">' + CHIP_TEXT[team.chip] + '</span></li>');
        }

        var meta = [];
        if (team.manager_name) meta.push('经理 ' + esc(String(team.manager_name).trim()));
        if (team.zid) meta.push(esc(team.zid));

        var headHTML =
            '<div class="lu-head">' +
                '<div class="lu-id">' +
                    '<span class="lu-crest" aria-hidden="true">' + esc(firstChar(name)) + '</span>' +
                    '<div class="lu-idtext">' +
                        '<h2 class="lu-title" id="lu-title">' + esc(name) + '</h2>' +
                        '<p class="lu-sub">' + (meta.length ? meta.join(' · ') : '本 GW 阵容') + '</p>' +
                    '</div>' +
                '</div>' +
                '<div class="lu-score">' +
                    '<span class="lu-score-num">' + head + '<small>分</small></span>' +
                    '<span class="lu-score-cap">本 GW 得分' + (differ ? ' · 官方' : '') + '</span>' +
                    (differ ? '<span class="lu-score-alt">球员卡合计 <b>' + calc + '</b></span>' : '') +
                '</div>' +
                '<ul class="lu-meta">' + chips.join('') + '</ul>' +
            '</div>';

        // 进行中提示（硬要求：gw_finished=false 必须出现在弹层顶部）
        var banner = '';
        if (!finished) {
            banner = '<p class="lu-banner">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ' +
                'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
                '<path d="M12 3.5 21.5 20.5h-19L12 3.5Z"/><path d="M12 9.5v4.5"/><path d="M12 17h.01"/></svg>' +
                '<span>本轮进行中，得分为临时值，自动替补待结算</span>' +
            '</p>';
        }

        // 脚注：口径差异 / 数据异常 / 替补计分说明
        var notes = [];
        if (differ) {
            notes.push('本 GW 得分以 FPL 官方为准（' + officialNum + ' 分）；按球员卡逐人相加为 ' +
                calc + ' 分，差 ' + Math.abs(officialNum - calc) + ' 分，' +
                '源于官方分数与球员明细不是同一秒抓取，属正常快照误差。');
        }
        if (starters.length !== 11) {
            notes.push('本次快照首发人数异常（' + starters.length + ' 人），得分仅供参考。');
        }
        if (subs.length) {
            notes.push('自动替补已计入总分，替补席 ' + benchPts + ' 分不含被顶上场的球员。');
        }

        var foot =
            /* 用 div 而非 <footer>：footer 放在 dialog 里会多出一个 contentinfo 地标 */
            '<div class="lu-foot">' +
                '<span>数据截至 ' + esc(snapshot) + '（北京时间）</span>' +
                '<a href="' + FPL_BASE + esc(team.entry_id) + '/event/' + gwNum + '" target="_blank" ' +
                'rel="noopener noreferrer">查看 FPL 原页<span class="sr-only">（在新窗口打开）</span></a>' +
                (notes.length ? '<p class="lu-note">' + notes.join(' ') + '</p>' : '') +
            '</div>';

        return {
            teamName: name,
            html: banner + headHTML +
                '<div class="lu-body">' +
                    '<div class="lu-pitch">' + pitch + '</div>' +
                    '<section class="lu-bench" aria-label="替补席">' +
                        '<div class="lu-bench-head">' +
                            '<h3 class="lu-bench-title">替补席</h3>' +
                            '<span class="lu-bench-pts">' + benchPts + '<small>分</small></span>' +
                        '</div>' +
                        '<ul class="lu-bench-list">' + bench + '</ul>' +
                        subsHTML +
                    '</section>' +
                    foot +
                '</div>'
        };
    }

    function renderTeam(team, data) {
        var view = buildView(team, data);
        shell.content.innerHTML = view.html;
        fitNames();                      // 同步测量，在首帧绘制前就把字号定下来
        document.title = view.teamName + ' · GW' + num(data.gw) + ' 阵容 | 僵尸联赛';
        if (shell.scroll.scrollTop !== 0) shell.scroll.scrollTop = 0;
        focusHeading();
    }

    // ===================== 名字降档（按实测宽度，不按字符数）===========
    /* 为什么不能用「字符数 ≥ N」判定：字形宽度差异很大。
       Muharemović（11 字符）比 Calvert-Lewin（13 字符）更宽，
       而且不同机器的字体回退不同 —— 只有 scrollWidth 说了算。
       两轮测量 + 最多两次类切换，避免逐元素反复触发布局。 */
    function isOverflow(el) {
        return el.scrollWidth > el.clientWidth + 1;   // +1 留给亚像素取整
    }

    function fitNames(root) {
        if (!shell) return;
        var names = Array.prototype.slice.call((root || shell.content).querySelectorAll('.lu-card-name'));
        if (!names.length) return;

        // 1) 清空档位，量一遍默认字号
        for (var i = 0; i < names.length; i++) names[i].classList.remove('is-tight', 'is-xlong');
        var need = names.filter(isOverflow);
        if (!need.length) return;

        // 2) 全部套上 is-tight，再量一遍
        for (var j = 0; j < need.length; j++) need[j].classList.add('is-tight');
        var still = need.filter(isOverflow);
        if (!still.length) return;

        // 3) 仍溢出 → 再加 is-xlong（第三档就是极限，再不行交给 ellipsis + title）
        for (var k = 0; k < still.length; k++) still[k].classList.add('is-xlong');
        fitWarnings = still.filter(isOverflow).length;
    }

    // ===================== 渲染：骨架 / 错误 / 空 =====================
    function skeletonCard() {
        return '<li class="lu-card">' +
            '<span class="lu-sk lu-sk-avatar"></span>' +
            '<span class="lu-sk lu-sk-name"></span>' +
            '<span class="lu-sk lu-sk-pts"></span>' +
        '</li>';
    }

    function skLine(n) {
        var out = '';
        for (var i = 0; i < n; i++) out += skeletonCard();
        return '<ul class="lu-line">' + out + '</ul>';
    }

    function renderSkeleton() {
        shell.content.innerHTML =
            '<h2 class="sr-only" id="lu-title">正在加载本 GW 阵容</h2>' +
            '<div class="lu-head" aria-hidden="true">' +
                '<div class="lu-id">' +
                    '<span class="lu-sk lu-sk-crest"></span>' +
                    '<div class="lu-idtext">' +
                        '<span class="lu-sk lu-sk-title"></span>' +
                        '<span class="lu-sk lu-sk-sub"></span>' +
                    '</div>' +
                '</div>' +
                '<span class="lu-sk lu-sk-num"></span>' +
                '<ul class="lu-meta">' +
                    '<li><span class="lu-sk lu-sk-chip"></span></li>' +
                    '<li><span class="lu-sk lu-sk-chip"></span></li>' +
                    '<li><span class="lu-sk lu-sk-chip"></span></li>' +
                '</ul>' +
            '</div>' +
            '<div class="lu-body" aria-hidden="true">' +
                '<div class="lu-pitch lu-skeleton">' +
                    skLine(3) + skLine(3) + skLine(4) + skLine(1) +
                '</div>' +
                '<section class="lu-bench">' +
                    '<div class="lu-bench-head"><h3 class="lu-bench-title">替补席</h3></div>' +
                    '<ul class="lu-bench-list">' + skeletonCard() + skeletonCard() + skeletonCard() + '</ul>' +
                '</section>' +
            '</div>' +
            '<p class="sr-only" role="status">正在加载阵容…</p>';
    }

    function renderError(err) {
        var detail = err && err.message ? String(err.message) : '未知错误';
        shell.content.innerHTML =
            '<div class="lu-state" role="alert">' +
                '<svg class="lu-state-icon is-warn" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
                'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
                '<path d="M12 3.5 21.5 20.5h-19L12 3.5Z"/><path d="M12 9.5v4.5"/><path d="M12 17h.01"/></svg>' +
                '<h2 class="lu-state-title" id="lu-title">阵容数据加载失败</h2>' +
                '<p class="lu-state-desc">没能读取阵容数据（' + esc(detail) + '）。' +
                '该文件每天 16:30 生成，若刚过更新时间或正在结算，请稍后再试。</p>' +
                '<button type="button" class="lu-retry" data-lu-retry>' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ' +
                    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
                    '<path d="M4 12a8 8 0 1 0 8-8 8 8 0 0 0-6.9 4"/><path d="M4 3.5V8h4.5"/></svg>' +
                    '重试' +
                '</button>' +
            '</div>';
        document.title = '阵容数据加载失败 | 僵尸联赛';
        var btn = shell.content.querySelector('[data-lu-retry]');
        if (btn) { try { btn.focus({ preventScroll: true }); } catch (e2) { btn.focus(); } }
    }

    function renderEmpty(entryId) {
        shell.content.innerHTML =
            '<div class="lu-state">' +
                '<svg class="lu-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
                'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
                '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.75h.01"/></svg>' +
                '<h2 class="lu-state-title" id="lu-title">暂无该队阵容数据</h2>' +
                '<p class="lu-state-desc">这份快照里没有队伍 ' + esc(entryId) + ' 的阵容。' +
                '可能该队已被判 DQ，或今日数据尚未生成完毕。</p>' +
            '</div>';
        document.title = '暂无阵容数据 | 僵尸联赛';
        focusHeading();
    }

    // ===================== 打开 / 关闭 =====================
    function commit(data, entryId) {
        var team = data.teams && data.teams[entryId];
        if (!team) {
            renderEmpty(entryId);
            if (opened && opened.deepLink) {
                // 深链 id 不存在 → 轻提示 + 清 hash（不新增历史记录）
                toast('没有找到队伍 ' + entryId + ' 的阵容，已清除链接标记');
                if (locationHashId() === entryId) {
                    history.replaceState(null, '', location.pathname + location.search);
                }
            }
            return false;
        }
        renderTeam(team, data);
        return true;
    }

    function startLoad(entryId, token, force) {
        loadData(force).then(function (data) {
            if (!opened || opened.token !== token) return;      // 已关闭 / 已切队：丢弃这次响应
            commit(data, entryId);
        }).catch(function (err) {
            if (!opened || opened.token !== token) return;
            renderError(err);
        });
    }

    function open(entryId, opts) {
        opts = opts || {};
        entryId = String(entryId);
        if (opened && opened.entryId === entryId) return;

        buildShell();
        var fresh = !opened;

        if (fresh) {
            lastFocus = document.activeElement;
            filterState = readFilter();
            shell.scroll.scrollTop = 0;
            shell.overlay.classList.add('is-open');
            lockScroll();
            setBackgroundInert(true);
        }

        var token = ++seq;
        opened = { entryId: entryId, token: token, deepLink: !!opts.fromHash };

        // 历史记录：只有真正「新开」才压栈，切队不重复压
        if (!opts.fromHash && locationHashId() !== entryId) {
            history.pushState({ lu: entryId }, '', '#entry=' + entryId);
        }

        if (dataCache && !opts.force) {
            commit(dataCache, entryId);          // 命中内存缓存：不闪骨架屏
        } else {
            renderSkeleton();
            focusDialog();
            startLoad(entryId, token, !!opts.force);
        }
    }

    function close() {
        if (!opened) return;
        var entryId = opened.entryId;
        opened = null;

        if (shell) {
            shell.overlay.classList.remove('is-open');
            // 等收起动画结束再清内容，避免关闭瞬间露出空白框
            setTimeout(function () {
                if (!opened && shell) shell.content.innerHTML = '';
            }, 260);
        }
        if (locationHashId() === entryId) {
            history.replaceState(null, '', location.pathname + location.search);
        }
        document.title = titleBase;
        unlockScroll();
        setBackgroundInert(false);      // 必须先解除 inert，否则焦点回不到行上
        restoreFocus(entryId);
        restoreFilter();
    }

    function retry() {
        if (!opened) return;
        var token = ++seq;
        opened.token = token;
        renderSkeleton();
        focusDialog();
        startLoad(opened.entryId, token, true);
    }

    // ===================== 深链 =====================
    function locationHashId() {
        var m = /^#entry=(\d+)$/.exec(location.hash || '');
        return m ? m[1] : null;
    }

    function onHashChange() {
        var id = locationHashId();
        if (opened) {
            if (!id) { close(); return; }                              // 后退 / hash 被清 → 关
            if (id !== opened.entryId) open(id, { fromHash: true });    // 手改 URL 换队 → 换内容
            return;
        }
        if (id) open(id, { fromHash: true });
    }

    // ===================== 行装饰（整行可点） =====================
    /* 不给 <tr> 加 role="button" 的实测依据（axe-core 4.x）：
       tr[role=button][aria-label] 会命中 WCAG 2.5.3 label-content-name-mismatch
       （serious，Lighthouse 直接扣分）——行内可见文本「排名/总分/本GW得分…」
       不可能全部塞进 aria-label。改用 tabindex=0 + aria-label + Enter/Space：
       行为等价，语义合规，axe 零违规。 */
    function decorate(root) {
        var rows = (root || document).querySelectorAll('#season-tbody tr[data-entry-id]');
        for (var i = 0; i < rows.length; i++) {
            var tr = rows[i];
            var id = tr.getAttribute('data-entry-id');
            if (!id) continue;

            if (tr.classList.contains('row-dq')) {
                // DQ 行：不可点、不可聚焦、无指针提示
                tr.classList.remove('lu-row');
                tr.setAttribute('aria-disabled', 'true');
                if (tr.hasAttribute('tabindex')) tr.removeAttribute('tabindex');
                if (tr.hasAttribute('aria-label')) tr.removeAttribute('aria-label');
                continue;
            }

            if (tr.classList.contains('lu-row')) continue;
            tr.classList.add('lu-row');
            tr.setAttribute('tabindex', '0');
            var nameEl = tr.querySelector('.team-name');
            var name = nameEl ? String(nameEl.textContent || '').trim() : '该队';
            tr.setAttribute('aria-label', '查看 ' + name + ' 本 GW 阵容');
        }
    }

    function findRowFromEvent(e) {
        var node = e.target;
        if (!node || !node.closest) return null;
        var tr = node.closest('#season-tbody tr[data-entry-id]');
        if (!tr || tr.classList.contains('row-dq')) return null;
        return tr;
    }

    // ===================== 轻提示 =====================
    function toast(msg) {
        var old = document.querySelector('.lu-toast');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        var el = document.createElement('div');
        el.className = 'lu-toast';
        el.setAttribute('role', 'status');
        el.textContent = msg;
        document.body.appendChild(el);
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            if (el.parentNode) el.parentNode.removeChild(el);
            toastTimer = null;
        }, 3200);
    }

    // ===================== Init =====================
    function init() {
        // 行装饰（app.js 异步渲染，用 MutationObserver 兜住重绘）
        var tbody = document.getElementById('season-tbody');
        if (tbody) {
            decorate(tbody);
            if (window.MutationObserver) {
                new MutationObserver(function () { decorate(tbody); })
                    .observe(tbody, { childList: true });
            }
        }

        document.addEventListener('click', function (e) {
            var tr = findRowFromEvent(e);
            if (!tr) return;
            if (e.target.closest && e.target.closest('a,button')) return;
            open(tr.getAttribute('data-entry-id'));
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' || e.key === 'Esc') {
                if (opened) { e.preventDefault(); close(); }
                return;
            }
            if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
            var tr = e.target;
            if (!tr || tr.tagName !== 'TR' || !tr.classList.contains('lu-row')) return;
            e.preventDefault();                       // 空格不要顺带滚页面
            open(tr.getAttribute('data-entry-id'));
        });

        // 深链 / 后退
        window.addEventListener('hashchange', onHashChange);
        window.addEventListener('popstate', onHashChange);

        // 视口变化 / 字体换用后重算：卡宽和字宽都会变，档位必须重量
        window.addEventListener('resize', function () {
            if (!opened) return;
            clearTimeout(fitTimer);
            fitTimer = setTimeout(function () { if (opened) fitNames(); }, 120);
        });
        if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
            document.fonts.ready.then(function () { if (opened) fitNames(); });
        }

        var id = locationHashId();
        if (id) open(id, { fromHash: true });

        // 切到别的 Tab 时收掉弹层（app.js 初始化会派发一次 season，需放行）
        document.addEventListener('zbl:tabchange', function (e) {
            if (opened && e.detail && e.detail.tab !== 'season') close();
        });
    }

    // 最小调试接口（冒烟测试与线上排查用，不参与业务逻辑）
    window.zblLineups = {
        version: '1.1.1',
        open: open,
        close: close,
        /* 仅测试用：buildView 是纯字符串渲染（不碰 DOM），
           tests/logic.mjs 在 Node 里直接调用它做无浏览器的全量断言。 */
        __buildView: buildView,
        get isOpen() { return !!opened; },
        get entryId() { return opened ? opened.entryId : null; },
        get fitWarnings() { return fitWarnings; },   // 三档仍装不下的名字数，冒烟会断言 = 0
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
