# MEVPS · VPS 服务器管理面板

> 基于 **Cloudflare Workers + D1** 的轻量服务器管理面板，主题面板样式复刻自 [soybean-admin](https://github.com/soybeanjs/soybean-admin)（SoybeanAdmin，NaiveUI 设计语言）。
> 支持**纯浏览器（Cloudflare 控制台）部署**，D1 数据库自动创建并绑定。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hltxfk/mevps)

## ✨ 功能

| 菜单 | 功能 |
| --- | --- |
| 📊 数据仪表盘 | VPS 总数 / 运行 / 停止 / 月度成本统计卡片、近 7 天成本趋势图、状态分布环形图、最近操作、系统信息 |
| 🖥 VPS管理 | VPS 记录增删改查、搜索 / 状态筛选、分页、启动 / 停止、到期提醒 |
| 📝 操作日志 | 登录与所有变更操作的审计日志，按类型 / 关键字筛选、分页 |
| ⚙ 系统设置 | 站点名称 / 描述 / 会话有效期、修改用户名密码（变量全部存 D1） |

- 默认登录账号：**admin / 123456**（首次登录后请在「系统设置」中修改）
- SoybeanAdmin 同款布局：深色侧边栏 + 绿色主题 + 多标签页（TagsView）+ 卡片式内容区

## 🏗 部署方式（按你要的三点）

1. **页面来源：`assets/` 静态资源，Cloudflare 边缘直接吐**
   命中静态资源的请求在边缘直接返回，**不进入 Worker 脚本**；
2. **前端代码：独立文件 + 内容哈希文件名，可长期缓存**
   构建产物为 `assets/js/app.<hash>.js`、`assets/css/style.<hash>.css`，配合 `_headers` 配置 `Cache-Control: public, max-age=31536000, immutable`；入口 `index.html` 为 `no-cache`，发版即生效；
3. **Worker 请求额度：静态资源命中不消耗**
   `wrangler.jsonc` 中 `assets.run_worker_first = ["/api/*"]`，只有 `/api/*` 会进入 Worker（API 与鉴权），其余请求由静态资源层直接处理。

数据存储：**D1**，绑定变量名固定为 **`db`**，数据库默认名为 **`mymail`**。所有"变量 / 配置"全部写入 D1 的 `settings` 表（不使用环境变量）；表结构与默认账号在**首次 API 请求时自动初始化**，无需手动执行 SQL。

## 🚀 部署一：Cloudflare 控制台（浏览器操作，推荐）

1. 把本仓库推到你的 GitHub（或直接 Fork 本仓库）；
2. 打开 [Cloudflare 控制台 → Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)，点 **Create application → Import an existing Git repository**，选择本仓库；
3. 构建配置保持默认即可（已自动识别）：
   - Build command：`npm run build`（前端拼接 + 内容哈希输出到 `assets/`）
   - Deploy command：`npm run deploy`（即 `wrangler deploy`）
4. 点击 **Deploy**。部署过程中 Cloudflare 会**自动创建 D1 数据库并绑定**：
   - 绑定变量名固定为 **`db`**
   - 数据库名称默认 **`mymail`**（部署设置页可改，改了也不影响，变量名仍是 `db`）
5. 部署完成后访问 `https://<worker名>.<你的子域>.workers.dev`，用 `admin / 123456` 登录。

> 也可以点 README 顶部的 **Deploy to Cloudflare** 一键按钮，效果相同（会先把仓库克隆到你自己账号下）。

## 🔧 部署二：控制台手动创建（不接 Git）

1. **创建 D1**：控制台 → D1 → Create database，名称填 `mymail`；
2. **创建 Worker**：Workers & Pages → Create → Worker，命名 `mevps`；
3. **粘贴代码**：打开 `worker.js` 全文，粘贴到在线编辑器，Deploy；
4. **上传静态资源**：Worker 页面 → Assets（静态资源）→ 上传 `assets/` 目录下所有文件（含 `_headers`）；如界面提供路由选项，选择"单页应用（SPA）回退"，并将 `/api/*` 设为 Worker 优先（`run_worker_first`）；
5. **绑定 D1**：Worker → Settings → Bindings → Add → D1 Database，**Variable name 填 `db`**，D1 database 选 `mymail`；
6. 保存部署。表结构与默认账号在首次打开页面时自动初始化。

> 手动模式下即使不配 `run_worker_first`，Worker 脚本也能正确兜底（非 `/api/*` 请求自动回退到 `index.html`），
> 但静态命中仍不进 Worker，不影响额度；要完全按第 3 点运行，建议用部署一的方式。

## 🖥 部署三：Wrangler CLI（可选）

```bash
npm run build          # 构建前端（零依赖，Node >= 20）
npx wrangler d1 create mymail   # 记下返回的 database_id，填入 wrangler.jsonc
npx wrangler deploy
```

## 📂 项目结构

```
mevps/
├── worker.js            # Worker 单文件（/api/* 路由 + D1 自动初始化 + 鉴权）
├── wrangler.jsonc       # 部署配置（assets + run_worker_first + D1 绑定 db）
├── package.json         # build/deploy 脚本 + Cloudflare 资源声明
├── build.mjs            # 前端构建：拼接 + 内容哈希文件名 → assets/
├── src/                 # 前端源码（SoybeanAdmin 风格主题）
│   ├── index.html       # 入口（登录页 + 主框架）
│   ├── css/main.css     # 主题样式（NaiveUI 设计语言）
│   ├── js/              # 模块：utils / api / ui / charts / views/* / app
│   ├── _headers         # 缓存与安全响应头规则
│   └── favicon.svg
└── assets/              # 构建产物（部署目录，已提交，可直接上传）
```

## 🔌 API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | 登录（用户名/密码 → Token） |
| GET | `/api/me` | 当前用户 |
| POST | `/api/logout` | 退出（记录日志） |
| GET | `/api/stats` | 仪表盘统计 |
| GET/POST | `/api/vps` | VPS 列表（分页/筛选）/ 新增 |
| PUT/DELETE | `/api/vps/:id` | 修改 / 删除 |
| POST | `/api/vps/:id/action` | 启动 / 停止 / 重启 |
| GET | `/api/logs` | 操作日志（分页/筛选） |
| GET/PUT | `/api/settings` | 系统设置（存 D1） |
| PUT | `/api/profile` | 修改用户名 / 密码 |

## 🔐 安全说明

- 密码使用 **PBKDF2-SHA256（60000 次迭代 + 随机盐）** 存储；
- 登录态为 **HMAC-SHA256 签名 Token**，密钥自动生成并保存在 D1（`settings.token_secret`）；
- 所有登录与变更操作均写入 `logs` 审计表；
- 建议部署后立即修改默认密码，并为 Worker 配置自定义域名 + Cloudflare Access 二次防护。

## 📜 License

MIT（面板样式致敬 [soybean-admin](https://github.com/soybeanjs/soybean-admin)）
