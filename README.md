# ZBL 僵尸联赛 — 实时看板

> Zombie Basketball League Dashboard · 基于 FPL API 的朋友联赛实时排名 + GoAT 指数跨赛季总榜

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
zbl-dashboard/
├── index.html                  # 主页面（Tab 导航：本赛季 / GoAT总榜 / 杯赛[预留]）
├── css/
│   └── style.css               # Matrix 黑底绿字风格 + 移动端适配
├── js/
│   └── app.js                  # 前端逻辑：数据加载、排名计算、GoAT 指数、Tab 切换
├── data/
│   ├── current.json            # ← snapshot.py 生成，本赛季实时数据
│   ├── prev_season_rank.json   # ← 手动填写，上赛季终局排名（用于排名变化比较）
│   └── history/
│       ├── goat_2324.json      # ← 手动填写，2324 赛季终局 GoAT
│       ├── goat_2425.json      # ← 手动填写，2425 赛季终局 GoAT
│       └── goat_2526.json      # ← 手动填写，2526 赛季终局 GoAT
├── mapping.json                # ← 手动维护，ZID ↔ 队名 ↔ 各赛季 entry_id
├── snapshot.py                 # FPL API 快照抓取脚本
├── vercel.json                 # Vercel 部署配置
└── README.md                   # 本文件
```

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

> 值为 2526 赛季终局排名数字（1为最高）。前端对比后会显示 ↑(绿)/↓(红)/―(灰)。

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
- **前端**：原生 HTML/CSS/JS，无构建步骤，零依赖
- **数据**：前端只读本地 JSON 文件，绝不在运行时请求 FPL API
- **时区**：所有时间统一使用 Asia/Shanghai (北京时间)
- **风格**：Matrix 终端黑底绿字，移动端响应式，支持横向滚动

## 页面结构

| Tab | 功能 |
|---|---|
| 本赛季 | 实时总分排名表（排名 / ZID / 队名 / 经理 / GW已赛 / 总分） |
| GoAT 总榜 | 跨赛季 GoAT 指数总榜（排名 / ZID / 队名 / 经理 / 历史GoAT / 本赛季GoAT / 总GoAT / 排名变化） |
| 杯赛 | 🏆 预留，GW30 后开放 |

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

ZBL Zombie Basketball League © 2023-2026
