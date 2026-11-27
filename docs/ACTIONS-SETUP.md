# GitHub Actions 执行器配置指南

本项目采用**混合架构**：Cloudflare Workers 负责面板 + D1 存储，GitHub Actions 当 SSH 执行器。

```
用户点「获取配置」
   ↓
Cloudflare Worker  →  repository_dispatch（payload 只含 job_id/vps_id，不含凭据）
   ↓
GitHub Actions 启动  →  临时取用 SSH 凭据（HMAC 签名）→ ssh 进 VPS 采集
   ↓                                                    ↓ 采集配置 + 归属地
   ←────────────────  HMAC 签名回传结果  ←────────────────┘
Worker 回写 D1：国家 / 城市地区 / 配置 / 在线态
```

> 为什么这么绕？Cloudflare Workers **无法运行 SSH 客户端**（缺 Node `crypto`/`net`/`stream`），
> 而 Actions 跑在真 Ubuntu 虚拟机上，`ssh`/`ssh2` 都能用。所以 SSH 采集交给 Actions。

---

## 一、仓库侧 Secrets（Settings → Secrets and variables → Actions）

### 推荐：面板里点「一键同步」（不用来 GitHub 后台）

VPS管理 → **SSH设置** → 填好仓库与 Token → 点 **⚡ 一键同步到 GitHub Secrets**。

面板会自动把下面两个值写入仓库的 Actions Secrets：

| Secret | 写入的值 |
|---|---|
| `WORKER_URL` | 自动取自面板自身地址，**无需手填** |
| `CALLBACK_SECRET` | 未设置时自动生成；已设置则沿用当前值 |

技术上，GitHub Secrets API 只接受 libsodium sealed box（`crypto_box_seal`）加密后的值，
面板内置 tweetnacl + blakejs 完成加密（见 `worker.js` 的 `sealForGitHub()`），
并与真 libsodium 做过交叉验证。

> ⚠️ 用「一键同步」时，细粒度 PAT 需额外开 **`Secrets: Read and write`** 权限。

### 手动：去 GitHub 后台填

| Secret | 值 | 说明 |
|---|---|---|
| `WORKER_URL` | 你的面板地址，如 `https://mevps.xxx.workers.dev` | **结尾不带斜杠** |
| `CALLBACK_SECRET` | 你自己生成的随机串 | 与面板「SSH设置」里的**回调密钥**填同一个值 |

生成一个随机串：

```bash
openssl rand -hex 32
```

## 二、面板侧「SSH设置」

VPS管理 → `+ 新增 VPS` 右边 → **SSH设置**，填四项：

| 字段 | 值 |
|---|---|
| GitHub 仓库 | `hltxfk/mevps`（Actions workflow 所在仓库） |
| 触发事件类型 | `vps-sync`（须与 workflow 的 `types` 一致） |
| Token | classic（勾 `repo`）或细粒度 PAT（**`Contents: Read and write`**） |
| 回调密钥 | **和 GitHub Secrets 的 `CALLBACK_SECRET` 完全一致**（用「一键同步」则不用管） |

## 三、Token 怎么建

- **Classic PAT**：Settings → Developer settings → Personal access tokens (classic) → 勾 **`repo`**，Expiration 自定（可 `No expiration`）。
- **细粒度 PAT**（推荐，权限更小）：Fine-grained tokens → 只选 `mevps` 仓库 → Permissions：
  - **`Contents: Read and write`** ← **必填**
  - `Secrets: Read and write` ← 仅在用「一键同步」时需要
  - 有效期最长 1 年。

> ⚠️ **这里是个大坑**：`repository_dispatch`（`POST /repos/{o}/{r}/dispatches`）在 GitHub 官方权限文档里归属
> **Contents** 类目、要求 `write`。`Actions: write` 对应的是 **`workflow_dispatch`**，两者不是一回事。
> 填成 `Actions: write` 会报 `403 Resource not accessible by personal access token`。

## 四、用法

列表里每条 VPS 后面点 **「获取配置」** → 面板置「同步中」→ Actions 异步执行（约 30–60 秒）→
自动回填 **IP 归属地（国家 / 城市地区）** 与 **配置**，并记录添加时间、在线态。

---

## 五、安全设计（重要）

| 措施 | 说明 |
|---|---|
| **凭据不落 GitHub** | dispatch payload 只有 `job_id`/`vps_id`；SSH 密码/私钥由 Actions 通过 HMAC 签名接口**临时取用**，用完即弃，不进 Secrets、不进日志 |
| **HMAC 鉴权** | 回传/取凭据都需 `X-MEVPS-Signature: HMAC-SHA256(body, CALLBACK_SECRET)`，常量时间比较，防伪造 |
| **凭据加密存储** | SSH 凭据与 GitHub Token 均 AES-256-GCM 加密落 D1，界面永不回显，日志不打印 |
| **Actions 打码** | 主机、凭据一律 `::add-mask::`，避免泄漏进运行日志 |
| **最小权限** | workflow `permissions: contents: read`；Token 建议用细粒度 PAT |

### 关于「密钥存 D1」

默认密钥自动生成在 D1 `settings` 表（`enc_key`）。**这属于混淆而非强加密**——密钥与密文同库，
D1 被读取则一起暴露。生产环境建议把密钥移到 Cloudflare Secret：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npx wrangler secret put SSH_ENC_KEY
```

配好后「SSH设置」会显示密钥来源为 `SSH_ENC_KEY（Cloudflare Secret）`。

---

## 六、故障排查

| 现象 | 推查方向 |
|---|---|
| 点「获取配置」报 `未配置 GitHub 仓库/Token` | 去「SSH设置」补齐 |
| 报 `GitHub 触发失败（403）Resource not accessible by personal access token` | 细粒度 PAT 少了 `Contents: Read and write`；报错里的「GitHub 要求的权限」会直接告诉你缺什么 |
| 报 `GitHub Secrets 读取/写入失败（403）` | 「一键同步」需 **`Secrets: Read and write`** 权限 |
| 报 `GitHub 触发失败（401/403）` | Token 过期或权限不足 |
| 报 `GitHub 触发失败（404）` | 「GitHub 仓库」填错，或 workflow 文件没推上去 |
| Actions 跑了但面板没更新 | `WORKER_URL` 填错（带了斜杠？）或 `CALLBACK_SECRET` 两边不一致。用「一键同步」可免这两个坑 |
| Actions 报 `签名校验失败` | 回调密钥与 `CALLBACK_SECRET` 不一致 |
| 面板一直卡「同步中」 | **15 分钟后会自动变成失败**并写明原因（多为 Secrets 未配） |
| 同步失败 `SSH 连接失败` | 主机/端口/用户名/密码错，或 VPS 防火墙拦截（Actions 出口 IP 段需放行 22 端口） |

> ⚠️ GitHub Actions 的出口 IP 是 GitHub 的 IP 段且会变动。你的 VPS 若要限制来源，
> 需放行 [Actions 的 IP 段](https://api.github.com/meta) 的 `actions` 字段，否则 SSH 会被防火墙挡住。
