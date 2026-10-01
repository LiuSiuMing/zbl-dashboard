# ZBL 僵尸联赛 — 实时看板

> Zombie League (ZBL) Dashboard · 基于 FPL API 的朋友联赛实时排名 + GoAT 指数跨赛季总榜
> 主题：**暗夜球场（Undead Pitch）** —— 中性石墨底 + 品牌橘 + 语义色分离

## 统一命名表（2026 重设计后沿用）

| 项 | 值 |
|---|---|
| 中文正式名 | 僵尸联赛 |
| 中文简称 | 橘僵联 |
| 英文正式名 | **Zombie League**（原 Zombie Basketball League，已废弃） |
| 缩写 | **ZBL**（= Zombie League，**不**解释为 Basketball） |
| 赛季标识 | 橘僵联 26/27 |
| 主题名 | 暗夜球场 Undead Pitch |
| 颜色体系 | 底 `#0B0E0D` / 品牌橘 `#FF7A18` / 三甲 金 `#FFC93C` 银 `#C7CDD4` 铜 `#D08A4E` |
| ❌ 禁用 | `Basketball` / `篮球` / `ZBL = Basketball` |

> 本联赛是 **FPL（Fantasy Premier League，英超梦幻足球）** 私联赛，"ZB" 指 **Zombie（僵尸）**，与篮球无关。

## 快速预览

直接用浏览器打开 `index.html` 即可看到看板效果（需要当前目录下存在 `data/current.json` 等数据文件）。

> **注意**：如果是通过 `file://` 协议打开，浏览器可能因 CORS 策略无法加载 JSON 文件。可启动一个本地静态服务器：

```bash
# Python 3
python -m http.server 8080

# 或 Node.js
npx serve .
```

然后访问 `http://localhost:8080`

## 项目结构

```
redesign/
├── index.html                  # 主页面（Tab：本赛季 / GoAT总榜 / 杯赛[预留]）+ SVG 图标雪碧图 + 骨架屏
├── css/
│   └── style.css               # 暗夜球场主题（中性底 + 品牌橘）+ 响应式 + 打印样式
├── js/
│   └── app.js                  # 数据加载、排名计算、GoAT 指数、Tab ARIA、搜索过滤、状态机
├── fonts/
│   └── alimama-subset.woff2    # 14KB 标题字体子集（⚠️ 仅 .logo / .section-title 使用）
├── data/
│   ├── current.json            # ← snapshot.py 生成，本赛季实时数据
│   ├── prev_season_rank.json   # ← 上赛季终局排名（⚠️ 预留字段，当前前端未参与计算，见下）
│   └── history/
│       ├── goat_2324.json      # ← 2324 赛季终局 GoAT
│       ├── goat_2425.json      # ← 2425 赛季终局 GoAT
│       └── goat_2526.json      # ← 2526 赛季终局 GoAT
├── mapping.json                # ← ZID ↔ 队名 ↔ 各赛季 entry_id
├── og.png                      # 分享卡片图（1200×630）
├── vercel.json                 # Vercel 部署配置
└── README.md                   # 本文件
```

## 重设计要点（Phase 1 视觉 / Phase 2 体验 / Phase 3 前端落地）

| 项 | 变化 |
|---|---|
| 主题 | Matrix 终端绿 → **暗夜球场**（中性石墨底 + 品牌橘 `#FF7A18`） |
| 背景 | 全屏 JS Canvas 逐帧动画 → **CSS-only 环境层**（`.ambient`，零 JS、零 setInterval、零常驻 rAF） |
| 发光 | 删除全部 `text-shadow` / 彩色 `box-shadow` 发光（含 105 个元素的无限 `glowPulse`） |
| 字体 | 删除 Google Fonts 两个 `<link>` → 系统字体栈；本地 Alimama 子集仅用于 Logo / 区块标题 |
| 根字号 | `14px` → **`16px`**，断点处不再缩小 root |
| 三甲 | 金色发光文字 → **实心圆形排名筹码**（金/银/铜） |
| 赞助商 | 新增「僵尸条」专属标识：橘色队名 + 冠名胶囊徽章 + 行首橘色竖条 + 橘调行底（**竖条形态独家给赞助商**，与三甲圆形筹码互不冲突） |
| 图标 | 装饰 emoji → **内联 SVG 雪碧图**（14 个 `<symbol>`）；favicon 保留 🧟 |
| 加载态 | 单行「加载中…」→ **12 行骨架屏** + 容器锁高（CLS ≈ 0）+ 120ms 延迟淡入 |
| 错误态 | tbody 内塞红字 → **全站级 `.state-panel`**（`role="alert"`）+ 隐藏 Tab 栏 + 重试按钮自动聚焦 + 三分支文案 |
| 部分失败 | 历史季 JSON 静默丢弃 → GoAT 榜上方**金色 `.notice-bar`** 点名缺失赛季；三季全失败则整列隐藏「名次变化」 |
| Tab | 完整 **ARIA Tabs**（tablist/tab/tabpanel + roving tabindex）、方向键自动激活、杯赛用 `aria-disabled` 而非 `disabled` |
| 路由 | `history.replaceState`（不污染历史栈）；`syncTabFromHash()` 在数据加载前执行；拒绝 `#cup` 激活 |
| 新增 | 搜索框（`type="search"`，实时过滤**不重排名次**）、图例（原生 `<details>`，样本复用真实组件）、回到顶部（仅 ≤768px） |
| 无障碍 | `<caption class="sr-only">`、变化列 `role="img"` + 中文 `aria-label`、DQ / 冠名徽章读屏文案、`[hidden]{display:none!important}` 兜底 |
| 性能 | 105 行一次性 `innerHTML` 批量插入（无逐行 `appendChild` / 逐行绑事件）；无 `setInterval`；搜索用 `hidden` 切换不重建 DOM |

## 主题与配色

| 角色 | 值 |
|---|---|
| 页面底 / 卡片 / 吸顶底 / hover | `#0B0E0D` / `#121715` / `#171C1A` / `#1C2220` |
| 文字 primary / secondary / muted / 表头 | `#E8EDEA` / `#A9B4AE` / `#7C8781` / `#8B968F` |
| 品牌橘 / 降级橘 / 行底 / hover 行底 | `#FF7A18` / `#D96E12` / `#201D15` / `#2A2115` |
| 三甲 金 / 银 / 铜 | `#FFC93C` / `#C7CDD4` / `#D08A4E` |
| 语义 上升 / 下降 / 持平 | `#46D17F` / `#CE7171` / `#7C8781` |
| 焦点环 | `#FF9A45` |


## 完整操作流程

### 1. 首次设置数据文件

#### mapping.json

维护所有参赛队伍的映射表。每个队伍必须有唯一的 ZID（跨赛季不变）。

```json
{
    "teams": [
        {
            "zid": "ZID000001",
            "team_name": "示例僵尸队",
            "manager_name": "张三",
            "entry_ids": {
                "2324": 1234567,
                "2425": 2345678,
                "2526": 3456789,
                "2627": 4567890
            }
        }
    ]
}
```

**字段说明**：
| 字段 | 说明 |
|---|---|
| `zid` | 格式 `ZID` + 6位数字，跨赛季不变的唯一队伍识别号 |
| `team_name` | 队名（可中英文混排，FPL上显示的队伍名） |
| `manager_name` | 经理真实姓名 |
| `entry_ids` | 各赛季对应的 FPL entry_id（数字），key 为4位赛季号 |

> 如果在 league standings 中发现某支队伍在 mapping.json 中没有对应 ZID，看板会显示「未登记」并标注 FPL ID，不会报错中断。

#### data/history/goat_*.json

三份历史赛季 GoAT 终局数据文件，格式相同：

```json
{
    "season": "2526",
    "meta": {
        "season_name": "2526",
        "total_entries": 105
    },
    "entries": {
        "ZID000001": {
            "goat_total": 2800,
            "breakdown": {
                "score_total": 2700,
                "final_rank": 1,
                "rank_points": 105,
                "cup_pts": 10,
                "dq": false
            }
        }
    }
}
```

**GoAT 指数公式**：
```
GoAT = 各赛季实际总分 + 各赛季排名分 + 杯赛分

某赛季排名分 = 参赛人数(N, 含DQ) - 该赛季最终排名 + 1
杯赛：每场胜/轮空 = 5分（v1 本赛季暂不纳入）
DQ选手：该赛季得分0，杯赛清零，参与末位排名
```

> 前端只读 `goat_total` 字段。`breakdown` 用于人工校验公式。

#### data/prev_season_rank.json

上赛季（2526赛季）终局 GoAT 排名，用于 GoAT 总榜的「较上季排名变化」列：

```json
{
    "season_compared_against": "2526",
    "entries": {
        "ZID000001": 2,
        "ZID000002": 5
    }
}
```

> 值为 2526 赛季终局排名数字（1为最高）。

> ⚠️ **当前状态：预留字段。** 前端仍会加载本文件（任务书硬约束「数据接口不变」），
> 但**未参与任何计算** —— GoAT 榜的「名次变化」是前端用三季历史 GoAT 现算的
> （`rank(历史三季 GoAT)` 作为赛季初基准，对比 `rank(历史三季 GoAT + 本赛季 GoAT)`）。
> 它的加载失败**不会**触发错误态。

### 2. 抓取本赛季实时数据

安装依赖（首次）：

```bash
pip install requests
```

运行快照脚本：

```bash
python snapshot.py
```

**脚本选项**：
```
python snapshot.py --league-id 467317     # 指定联赛 ID（默认 467317）
python snapshot.py --output data/current.json  # 指定输出路径
python snapshot.py --skip-details          # 跳过逐队 detail API（更快，仅用 standings 数据）
python snapshot.py --no-sort               # 不按总分排序（保留 API 原始顺序）
```

**脚本行为**：
- 自动翻页抓取全部 standings（每页50条，约2-3页）
- 每页间隔 3 秒（尊重 API 速率限制）
- 自动重试（最多5次，指数退避）
- 合并 mapping.json 映射关系
- 可选抓取每队 detail（经理名、准确 GW 数）
- 输出紧凑 JSON 到 `data/current.json`
- 终端显示摘要 + 前5名

### 3. 推送并自动部署到 Vercel

```bash
git add data/current.json
git commit -m "snapshot 2026-08-27 10:30"
git push
```

Vercel 检测到 push 后会自动重新部署（默认行为，无需额外配置）。

## 首次 Vercel 项目创建

1. **注册/登录 Vercel**: https://vercel.com (免费 plan)

2. **安装 Vercel CLI**:
   ```bash
   npm install -g vercel
   ```

3. **在本地初始化并部署**:
   ```bash
   cd zbl-dashboard
   git init
   git add .
   git commit -m "Initial commit"
   vercel
   ```
   - 选择 **Other** 作为 framework preset
   - Root Directory: `./` (当前目录)
   - Build Command: 留空
   - Output Directory: `./` (当前目录)
   - 确认 Deploy: Yes

4. **后续**:
   - 将 Vercel 关联到 GitHub 仓库（推荐）
   - `vercel --prod` 推送到生产环境
   - 之后每次 git push 到主分支，Vercel 自动重新部署

### 通过 GitHub 集成（推荐）

1. 将本项目推送到 GitHub: `git remote add origin https://github.com/YOUR_USER/zbl-dashboard.git`
2. 在 Vercel Dashboard → New Project → Import Git Repository → 选择 zbl-dashboard
3. Framework Preset: `Other`
4. Build Command: 留空
5. Root Directory: 默认 (`/`)
6. 点击 Deploy
7. 完成！之后每次 git push 自动触发重新部署

## 数据更新完整流程

```
1. python snapshot.py              # 抓取最新数据
2. git diff data/current.json      # 检查变更（可选）
3. git add data/current.json       # 暂存
4. git commit -m "snapshot <TIME>" # 提交
5. git push                        # 推送 → Vercel 自动部署
```

## 技术说明

- **纯静态站点**：零后端、零数据库、Vercel 免费额度内运行
- **前端**：原生 HTML/CSS/JS，无构建步骤，零依赖（**无框架、无打包器、无 npm 依赖**）
- **数据**：前端只读本地 JSON 文件，绝不在运行时请求 FPL API
- **时区**：所有时间统一使用 Asia/Shanghai (北京时间)
- **风格**：暗夜球场主题（中性石墨底 + 品牌橘），响应式（桌面表格 / ≤768px GoAT 卡片 / ≤480px 赛季榜卡片），**移动端无横向溢出、无容器嵌套滚动**
- **性能**：无 Canvas 逐帧动画、无 `setInterval`、无常驻 `requestAnimationFrame`；105 行一次性批量插入

## 页面结构

| Tab | 功能 |
|---|---|
| 本赛季 | 本赛季积分榜（排名 / 队名[冠名·DQ 徽章] / 经理 / 总分），点 Tab 时 URL 不带 hash |
| GoAT 总榜 | 跨赛季总榜（排名 / 队名 / 经理 / 历史 GoAT / 本季 GoAT / GoAT 总分 / 名次变化），URL 带 `#goat` |
| 杯赛 | 预留，GW30 后开放（`aria-disabled`，键盘可达但不可激活） |

> 全站共用：Tab 栏下方一个搜索框（搜索队名或经理，实时过滤**不重排名次**）+ 一个可折叠图例（原生 `<details>`，桌面默认展开）；≤768px 显示「回到顶部」。
> 榜单中：金/银/铜**圆形筹码** = 三甲；橘色队名 +「冠名」徽章 + 行首橘色竖条 = 冠名赞助商「僵尸条」。


## 常见问题

**Q: 打开 index.html 表格空白？**
A: 确保 data/*.json 文件存在且格式正确。建议用本地 HTTP 服务器而非 file:// 打开。

**Q: snapshot.py 报错 429/403？**
A: FPL API 有速率限制。脚本已内置重试机制，如仍失败可加 `--skip-details` 跳过详细抓取。

**Q: 某队伍显示「未登记」？**
A: 在 mapping.json 中补充该队伍的 ZID 和 entry_ids 映射。

**Q: Vercel 部署后数据不更新？**
A: 确认 git push 后 Vercel 触发了新部署（Dashboard → Deployments 查看）。

---

ZBL Zombie League 橘僵联 © 2023-2026
