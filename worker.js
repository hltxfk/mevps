/**
 * MEVPS —— VPS 服务器管理面板 · Cloudflare Worker
 *
 * 架构（见 wrangler.jsonc）：
 *   - 静态资源（assets/ 目录，含内容哈希文件名的前端代码）由 Cloudflare 边缘直接响应，
 *     命中静态资源的请求【不会】进入本脚本，不消耗 Worker 请求额度；
 *   - 仅 /api/* 路径进入本脚本（assets.run_worker_first = ["/api/*"]）。
 *
 * 数据存储：
 *   - 唯一的绑定是 D1，绑定变量名固定为 env.db（数据库默认名 mevps）；
 *   - 所有"变量/配置"都写在 D1 的 settings 表里，不使用环境变量；
 *   - 首次收到 API 请求时自动建表并初始化（默认账号 admin / 123456）。
 */

import { connect } from 'cloudflare:sockets';

const API_VERSION = '1.0.0';

/* ------------------------------ 工具函数 ------------------------------ */

const te = new TextEncoder();

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return bytesToHex(arr.buffer);
}

function b64url(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(s + '='.repeat((4 - (s.length % 4)) % 4))));
}

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations: 60000 },
    key,
    256
  );
  return bytesToHex(bits);
}

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToHex(await crypto.subtle.sign('HMAC', key, te.encode(data)));
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signToken(secret, username, hours) {
  const payload = b64url(JSON.stringify({ u: username, exp: Date.now() + hours * 3600 * 1000 }));
  return `${payload}.${await hmacSign(secret, payload)}`;
}

async function verifyToken(secret, token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expect = await hmacSign(secret, payload);
  if (sig !== expect) return null;
  try {
    const data = JSON.parse(unb64url(payload));
    if (!data.u || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function bytesToB64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* 标准 base64 编码。GitHub Secrets API 的 encrypted_value 用的是标准 base64，不是 base64url。
 * 上面的 b64urlToBytes() 反向兼容两者（标准 base64 不含 - 和 _，替换不影响），可直接用于解 key。 */
function bytesToB64(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

/* --------------------- 凭据加密（AES-256-GCM） ---------------------
 * 用途：GitHub Actions 触发 Token 等敏感凭据落库前加密。
 * 密钥优先取 Cloudflare Secret 环境变量 SSH_ENC_KEY（base64url 32 字节）；
 * 未配置时退而在 D1 settings 自动生成 enc_key（仅混淆，不等于加密），
 * 生产环境请务必 wrangler secret put SSH_ENC_KEY。 */
const ENC_PREFIX = 'enc.v1.';

async function importEncKey(rawB64) {
  return crypto.subtle.importKey('raw', b64urlToBytes(rawB64), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function resolveEncKey(env) {
  if (env && env.SSH_ENC_KEY) {
    return { key: await importEncKey(String(env.SSH_ENC_KEY).trim()), source: 'secret' };
  }
  const db = env.db;
  let row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('enc_key').first();
  if (!row || !row.value) {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    const b64 = bytesToB64url(arr.buffer);
    await db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind('enc_key', b64)
      .run();
    row = { value: b64 };
  }
  return { key: await importEncKey(row.value), source: 'd1' };
}

async function encSecret(env, plaintext) {
  if (!plaintext) return '';
  const { key } = await resolveEncKey(env);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(String(plaintext)));
  return ENC_PREFIX + bytesToB64url(iv.buffer) + '.' + bytesToB64url(ct);
}

async function decSecret(env, blob) {
  if (!blob || !String(blob).startsWith(ENC_PREFIX)) return '';
  const parts = String(blob).slice(ENC_PREFIX.length).split('.');
  if (parts.length !== 2) return '';
  const { key } = await resolveEncKey(env);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlToBytes(parts[0]) }, key, b64urlToBytes(parts[1]));
    return new TextDecoder().decode(pt);
  } catch {
    return '';
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

const ok = (data) => json({ ok: true, data });
const err = (message, status = 400) => json({ ok: false, error: message }, status);

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '-';
}

function nowStr(ms = Date.now()) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/* --------------------------- D1 自动初始化 --------------------------- */

/* 数据库初始化（每次冷启动/首次请求时执行，幂等）。
 *
 * ⚠️ 这里【绝对不能】把 promise 缓存到 globalThis 供别的请求 await：
 * Cloudflare 的 handle_cross_request_promise_resolution 兼容行为（由
 * compatibility_date ≥ 2025 启用）规定「promise 只能在创建它的请求里 settle」，
 * 跨请求 await 会永远无法 settle，并报：
 *   "This promise was created by a request that has since ended, so it can never settle."
 * 典型触发：用户刷新页面，浏览器 abort 掉上一页未完成的请求，
 * 那个请求创建的 initDb promise 变成孤儿，后续请求 await 就炸。
 *
 * 因此这里只缓存一个普通布尔值（不是 promise），未命中就地跑一次初始化。
 * 并发首次请求可能都跑一遍 initDb，所以 initDb 内部必须全幂等 + 并发容错。 */
async function ensureDb(env) {
  const g = globalThis;
  if (g.__mevpsReady) return;
  await initDb(env);
  g.__mevpsReady = true;
}

/* --------- vps 表结构升级：SSH 连接参数模型（v2） --------- */
async function migrateVps(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'vps_schema_ver'").first();
  const ver = row ? Number(row.value) || 0 : 0;
  const info = await db.prepare('PRAGMA table_info(vps)').all();
  let cols = new Set((info.results || []).map((c) => c.name));
  const mark = (v) =>
    db
      .prepare("INSERT INTO settings (key, value) VALUES ('vps_schema_ver', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(String(v))
      .run();

  // v1 旧结构 → v2 SSH 模型：整表重建，保留可用数据。
  // ⚠️ 判据不能用 ip：从 v3 起 ip 是正式字段、新表也有，拿它判旧表会误伤；
  //    改用旧表专有的 provider / expire_date 识别。
  if (ver < 2 && (cols.has('provider') || cols.has('expire_date'))) {
  await db
    .prepare(
      'CREATE TABLE vps_new (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ssh_host TEXT NOT NULL, ssh_port INTEGER DEFAULT 22, ssh_username TEXT DEFAULT "root", ssh_auth TEXT DEFAULT "password", ssh_secret_enc TEXT DEFAULT "", country TEXT DEFAULT "", city TEXT DEFAULT "", spec TEXT DEFAULT "", online INTEGER DEFAULT -1, sync_status TEXT DEFAULT "idle", sync_error TEXT DEFAULT "", last_sync_at TEXT DEFAULT "", remark TEXT DEFAULT "", created_at TEXT, updated_at TEXT)'
    )
    .run();
  await db
    .prepare('INSERT INTO vps_new (id, name, ssh_host, spec, remark, created_at, updated_at) SELECT id, name, ip, spec, remark, created_at, updated_at FROM vps')
    .run();
  await db.prepare('DROP TABLE vps').run();
  await db.prepare('ALTER TABLE vps_new RENAME TO vps').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_vps_sync ON vps(sync_status)').run();
  }

  // v2 → v3：补 IP 与归属地中英两套字段（幂等，已有则跳过）
  const info2 = await db.prepare('PRAGMA table_info(vps)').all();
  cols = new Set((info2.results || []).map((c) => c.name));
  const adds = [
    ['ip', 'TEXT DEFAULT ""'],
    ['geo_en', 'TEXT DEFAULT ""'],
    ['geo_zh', 'TEXT DEFAULT ""'],
  ];
  for (const [nm, ddl] of adds) {
    if (!cols.has(nm)) await db.prepare('ALTER TABLE vps ADD COLUMN ' + nm + ' ' + ddl).run();
  }
  await mark(3);
}

async function initDb(env) {
  const db = env.db;
  if (!db) throw new Error('D1 绑定缺失');

  await db.batch([
    'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)',
    'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT, updated_at TEXT)',
    'CREATE TABLE IF NOT EXISTS vps (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ssh_host TEXT NOT NULL, ssh_port INTEGER DEFAULT 22, ssh_username TEXT DEFAULT "root", ssh_auth TEXT DEFAULT "password", ssh_secret_enc TEXT DEFAULT "", country TEXT DEFAULT "", city TEXT DEFAULT "", spec TEXT DEFAULT "", online INTEGER DEFAULT -1, sync_status TEXT DEFAULT "idle", sync_error TEXT DEFAULT "", last_sync_at TEXT DEFAULT "", remark TEXT DEFAULT "", created_at TEXT, updated_at TEXT)',
    'CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT DEFAULT \"\", action TEXT DEFAULT \"\", target TEXT DEFAULT \"\", detail TEXT DEFAULT \"\", ip TEXT DEFAULT \"\", status TEXT DEFAULT \"success\", created_at TEXT)',
    'CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC)',
    'CREATE TABLE IF NOT EXISTS sync_jobs (id TEXT PRIMARY KEY, vps_id INTEGER, status TEXT DEFAULT "pending", created_at TEXT, updated_at TEXT)',
    'CREATE INDEX IF NOT EXISTS idx_vps_sync ON vps(sync_status)',
    'CREATE INDEX IF NOT EXISTS idx_jobs_vps ON sync_jobs(vps_id)',
  ].map((sql) => db.prepare(sql)));

  // 旧库升级：region/provider/price/expire_date/ip → SSH 连接参数模型
  await migrateVps(db);

  // 回调签名密钥（幂等初始化，缺失则生成）
  const cbRow = await db.prepare("SELECT value FROM settings WHERE key = 'sync_callback_secret'").first();
  if (!cbRow) {
    await db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').bind('sync_callback_secret', randomHex(32)).run();
  }

  // 迁移：早期单一 gh_token_enc → 双 Token 槽（旧值并入 classic）
  const legacyToken = await db.prepare("SELECT value FROM settings WHERE key = 'gh_token_enc'").first();
  if (legacyToken && legacyToken.value) {
    await db
      .prepare("INSERT INTO settings (key, value) VALUES ('gh_token_classic_enc', ?) ON CONFLICT(key) DO NOTHING")
      .bind(legacyToken.value)
      .run();
    await db.prepare("DELETE FROM settings WHERE key = 'gh_token_enc'").run();
  }

  // ---- settings：所有"变量"都存这里 ----
  const secretRow = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('token_secret').first();
  if (!secretRow) {
    const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    await db.batch([
      insert.bind('token_secret', randomHex(32)),
      insert.bind('site_name', 'MEVPS'),
      insert.bind('site_desc', '基于 Cloudflare Workers + D1 的轻量 VPS 管理面板'),
      insert.bind('session_hours', '24'),
      insert.bind('init_at', nowStr()),
    ]);
  }

  // ---- 默认账号 admin / 123456 ----
  const userRow = await db.prepare('SELECT id FROM users LIMIT 1').first();
  if (!userRow) {
    const salt = randomHex(16);
    const hash = await hashPassword('123456', salt);
    // 并发首次初始化时，另一个请求可能已经插入了 admin（username 有 UNIQUE 约束）。
    // 用 INSERT OR IGNORE + changes 判断是否由本请求负责写演示数据，避免重复/抛错。
    const inserted = await db
      .prepare('INSERT OR IGNORE INTO users (username, password_hash, salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind('admin', hash, salt, nowStr(), nowStr())
      .run();
    const insertedCount = inserted && inserted.meta ? inserted.meta.changes : 1;
    if (insertedCount > 0) {

    // ---- 演示数据（仅首次初始化写入，可在面板中自行修改/删除）----
    const demo = [
      ['web-01', '192.0.2.11', 22, 'root', '官网 Web 节点'],
      ['web-02', '192.0.2.12', 22, 'root', '官网备用节点'],
      ['api-01', '198.51.100.21', 22, 'root', '业务 API 服务器'],
      ['db-01', '198.51.100.22', 22, 'root', '数据库主节点'],
      ['dev-01', '203.0.113.31', 22, 'ubuntu', '开发测试机'],
      ['cdn-01', '203.0.113.32', 22, 'root', '欧洲边缘缓存'],
    ];
    const ins = db.prepare(
      'INSERT INTO vps (name, ssh_host, ssh_port, ssh_username, ssh_auth, remark, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const t = nowStr();
    await db.batch(demo.map((d) => ins.bind(d[0], d[1], d[2], d[3], 'password', d[4], t, t)));

    const insLog = db.prepare(
      'INSERT INTO logs (username, action, target, detail, ip, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    await db.batch([
      insLog.bind('admin', '登录', '系统', '首次登录系统', '-', 'success', t),
      insLog.bind('admin', '新增', 'web-01', '创建 VPS 记录 web-01', '-', 'success', t),
      insLog.bind('system', '初始化', 'D1', '数据表自动初始化完成，写入演示数据', '-', 'success', t),
    ]);
    }
  }
}

async function getSetting(db, key, fallback = '') {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : fallback;
}

async function addLog(db, username, action, target, detail, ip, status = 'success') {
  await db
    .prepare('INSERT INTO logs (username, action, target, detail, ip, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(username || '-', action, target || '-', detail || '-', ip, status, nowStr())
    .run();
}

/* ------------------------------ 鉴权 ------------------------------ */

async function authenticate(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const secret = await getSetting(env.db, 'token_secret');
  const payload = await verifyToken(secret, token);
  return payload ? payload.u : null;
}

/* ------------------------------ API 路由 ------------------------------ */

/* ---------------------- GitHub Actions 执行器对接 ---------------------- */

/* 取当前启用的 GitHub Token（解密）。classic 优先级由 gh_token_type 决定，缺失时回退。 */
async function getActiveGhToken(env) {
  const db = env.db;
  const type = (await getSetting(db, 'gh_token_type', 'classic')) === 'fine' ? 'fine' : 'classic';
  let enc = await getSetting(db, type === 'fine' ? 'gh_token_fine_enc' : 'gh_token_classic_enc', '');
  if (!enc) enc = await getSetting(db, 'gh_token_classic_enc', '');
  return await decSecret(env, enc);
}

async function createSyncJob(db, vpsId) {
  const id = randomHex(16);
  await db
    .prepare('INSERT INTO sync_jobs (id, vps_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, vpsId, 'pending', nowStr(), nowStr())
    .run();
  return id;
}

/* 同步超时兜底。
 * 若 Actions 在取到凭据前就失败（最常见：GitHub Secrets 未配置），它永远不会回传结果，
 * 任务会永久停在 pending/running，面板就一直显示「同步中」。
 * 这里把超过 TTL 仍未回传的任务标记为 timeout，并回写 VPS 状态为失败。
 * TTL 取 15 分钟：workflow 的 timeout-minutes 为 10，留 5 分钟余量。 */
const SYNC_JOB_TTL_MS = 15 * 60 * 1000;
const SYNC_TIMEOUT_MSG = '同步超时：Actions 未回传结果（多为 GitHub Secrets 未配置，或执行失败）';

async function sweepStaleSyncJobs(db) {
  const cutoff = nowStr(Date.now() - SYNC_JOB_TTL_MS);
  const stale = await db
    .prepare("SELECT id, vps_id FROM sync_jobs WHERE status IN ('pending','running') AND created_at < ?")
    .bind(cutoff)
    .all();
  const rows = stale.results || [];
  if (!rows.length) return 0;
  const t = nowStr();
  // 先终结任务，再回写 VPS；NOT EXISTS 保证不会把刚发起的新同步任务状态覆盖掉
  for (const j of rows) {
    await db.prepare("UPDATE sync_jobs SET status='timeout', updated_at=? WHERE id=?").bind(t, j.id).run();
    await db
      .prepare(
        `UPDATE vps SET sync_status='error', sync_error=?, updated_at=?
         WHERE id = ? AND NOT EXISTS (
           SELECT 1 FROM sync_jobs j2 WHERE j2.vps_id = vps.id AND j2.status IN ('pending','running')
         )`
      )
      .bind(SYNC_TIMEOUT_MSG, t, j.vps_id)
      .run();
  }
  return rows.length;
}

/* 路径归一化：容忍 WORKER_URL 末尾多带斜杠导致的 //api/xxx，以及中间的重复斜杠。
 * 必须在【入口分发】之前做，否则 //api/xxx 会被 startsWith('/api/') 判为非 API 而直接 404。 */
function normalizePathname(p) {
  return p.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
}

/* 把 GitHub API 的错误响应转成可读、可操作的提示。
 * 安全约定：只取响应体里的 message 与响应头里的权限说明，绝不回显 token。
 * 403 时 GitHub 会在 X-Accepted-GitHub-Permissions 响应头里直接说明所需权限。 */
function ghApiError(res, text, extraHint = [], label = '触发') {
  let msg = '';
  try {
    const j = JSON.parse(text);
    if (j && typeof j.message === 'string') msg = j.message;
  } catch {
    /* 非 JSON 响应（如 HTML 错误页），走下面的兜底 */
  }
  if (!msg) msg = String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!msg) msg = `HTTP ${res.status}`;

  const need = String(res.headers.get('X-Accepted-GitHub-Permissions') || '').trim();
  const hint = [];
  if (need) hint.push(`GitHub 要求的权限：${need}`);

  if (res.status === 403 && /not accessible by (?:personal access )?token/i.test(msg)) {
    if (!need) hint.push('fine-grained PAT 需「Contents: Read and write」；classic PAT 需勾选 repo 全量');
    hint.push('并确认 Token 的仓库范围包含该仓库');
  } else if (res.status === 403 && /rate limit/i.test(msg)) {
    hint.push('触发了 GitHub API 限流，请稍后再试');
  } else if (res.status === 404) {
    hint.push('请检查「GitHub仓库」是否为 owner/repo 格式，且 Token 能访问该仓库');
  } else if (res.status === 401) {
    hint.push('Token 无效或已过期，请到「SSH设置」重新填写');
  } else if (res.status === 422) {
    hint.push('事件类型或仓库名格式不合法');
  }

  const all = hint.concat(extraHint);
  return `GitHub ${label}失败（${res.status}）${msg}${all.length ? '｜' + all.join('；') : ''}`;
}

/* repository_dispatch 触发 Actions。
 * 安全约定：client_payload 只含 job_id / vps_id，绝不携带 SSH 凭据或任何密钥。 */
async function dispatchSync(env, jobId, vpsId) {
  const db = env.db;
  const repo = await getSetting(db, 'gh_repo', '');
  const eventType = await getSetting(db, 'gh_event', 'vps-sync');
  const token = await getActiveGhToken(env);
  if (!repo) return { ok: false, error: '未配置 GitHub 仓库，请到「SSH设置」填写' };
  if (!token) return { ok: false, error: '未配置 GitHub Token，请到「SSH设置」填写' };
  const [owner, name] = repo.split('/');
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${name}/dispatches`, {
      method: 'POST',
      headers: {
        // GitHub REST API 强制要求 User-Agent，缺失时直接 403
        // （"Request forbidden by administrative rules ... User-Agent header"）
        'User-Agent': 'mevps-worker',
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ event_type: eventType, client_payload: { job_id: jobId, vps_id: vpsId } }),
    });
    if (res.status === 204 || res.ok) return { ok: true };
    const text = await res.text().catch(() => '');
    return { ok: false, error: ghApiError(res, text) };
  } catch (e) {
    return { ok: false, error: `GitHub 调用异常: ${e && e.message ? e.message : e}` };
  }
}

async function handleApi(request, env, url) {
  await ensureDb(env);
  const db = env.db;
  // 归一化路径：容忍 WORKER_URL 末尾多带斜杠导致的 //api/xxx，以及中间的重复斜杠
  const path = normalizePathname(url.pathname);
  const method = request.method;
  const ip = clientIp(request);

  // 读取类接口顺带回收超时的同步任务，避免面板一直卡在「同步中」
  if (method === 'GET' && (path === '/api/vps' || path === '/api/stats')) await sweepStaleSyncJobs(db);

  // 健康检查 + 登录（无需令牌）
  if (path === '/api/health') {
    return ok({ version: API_VERSION, time: nowStr() });
  }

  if (path === '/api/login' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) return err('请输入用户名和密码');
    const user = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
    if (!user) {
      await addLog(db, username, '登录', '系统', '用户不存在', ip, 'fail');
      return err('用户名或密码错误', 401);
    }
    const hash = await hashPassword(password, user.salt);
    if (hash !== user.password_hash) {
      await addLog(db, username, '登录', '系统', '密码错误', ip, 'fail');
      return err('用户名或密码错误', 401);
    }
    const hours = Number(await getSetting(db, 'session_hours', '24')) || 24;
    const secret = await getSetting(db, 'token_secret');
    const token = await signToken(secret, username, hours);
    await addLog(db, username, '登录', '系统', '登录成功', ip, 'success');
    return ok({ token, username, expiresIn: hours * 3600 });
  }

  // —— 内部接口：Actions 执行器（HMAC 鉴权，非用户态）——
  // 安全约定：SSH 凭据仅在 HMAC 签名校验通过后临时下发，用完即弃；
  // dispatch payload 不含凭据，凭据与密钥均不落 GitHub。
  if (path === '/api/internal/creds' || path === '/api/internal/result') {
    const cbSecret = await getSetting(db, 'sync_callback_secret', '');
    if (!cbSecret) return err('回调密钥未初始化', 500);
    const sig = request.headers.get('X-MEVPS-Signature') || '';
    const raw = await request.text();
    const expect = await hmacSign(cbSecret, raw);
    if (!sig || !safeEqualHex(sig, expect)) return err('签名校验失败', 401);
    let payload;
    try {
      payload = JSON.parse(raw || '{}');
    } catch {
      return err('请求体不是合法 JSON');
    }

    if (path === '/api/internal/creds') {
      const job = await db.prepare('SELECT * FROM sync_jobs WHERE id = ?').bind(String(payload.job_id || '')).first();
      if (!job) return err('同步任务不存在', 404);
      const v = await db.prepare('SELECT * FROM vps WHERE id = ?').bind(job.vps_id).first();
      if (!v) return err('VPS 记录不存在', 404);
      const secret = await decSecret(env, v.ssh_secret_enc || '');
      return ok({ vps_id: v.id, host: v.ssh_host, port: v.ssh_port, username: v.ssh_username, auth: v.ssh_auth, secret });
    }

    // /api/internal/result：回写 配置 / 归属地 / 在线态
    const job = await db.prepare('SELECT * FROM sync_jobs WHERE id = ?').bind(String(payload.job_id || '')).first();
    if (!job) return err('同步任务不存在', 404);
    const good = payload.ok !== false;
    await db
      .prepare('UPDATE vps SET country=?, city=?, ip=?, geo_en=?, geo_zh=?, spec=?, online=?, sync_status=?, sync_error=?, last_sync_at=?, updated_at=? WHERE id=?')
      .bind(
        String(payload.country || '').slice(0, 64),
        String(payload.city || '').slice(0, 64),
        String(payload.ip || '').slice(0, 64),
        String(payload.geo_en || '').slice(0, 120),
        String(payload.geo_zh || '').slice(0, 120),
        String(payload.spec || '').slice(0, 300),
        payload.online === true ? 1 : payload.online === false ? 0 : -1,
        good ? 'ok' : 'error',
        String(payload.error || '').slice(0, 300),
        nowStr(),
        nowStr(),
        job.vps_id
      )
      .run();
    await db.prepare('UPDATE sync_jobs SET status=?, updated_at=? WHERE id=?').bind(good ? 'done' : 'failed', nowStr(), job.id).run();
    return ok({});
  }

  // —— 以下接口均需登录 ——
  const username = await authenticate(request, env);
  if (!username) return err('登录已过期，请重新登录', 401);

  if (path === '/api/me' && method === 'GET') {
    return ok({ username, version: API_VERSION });
  }

  if (path === '/api/logout' && method === 'POST') {
    await addLog(db, username, '登出', '系统', '退出登录', ip);
    return ok({});
  }

  // 仪表盘统计
  if (path === '/api/stats' && method === 'GET') {
    const totalRow = await db.prepare('SELECT COUNT(*) AS c FROM vps').first();
    const onlineRow = await db.prepare('SELECT COUNT(*) AS c FROM vps WHERE online = 1').first();
    const offlineRow = await db.prepare('SELECT COUNT(*) AS c FROM vps WHERE online = 0').first();
    const total = totalRow ? totalRow.c : 0;
    const online = onlineRow ? onlineRow.c : 0;
    const offline = offlineRow ? offlineRow.c : 0;
    const syncCounts = await db.prepare('SELECT sync_status, COUNT(*) AS c FROM vps GROUP BY sync_status').all();
    const dist = (syncCounts.results || []).map((r) => ({ status: r.sync_status, count: r.c }));
    // 近 7 天新增 VPS 趋势（替代原成本趋势）
    const since = new Date(Date.now() - 6 * 86400000);
    const sinceStr = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, '0')}-${String(since.getDate()).padStart(2, '0')}`;
    const grouped = await db
      .prepare('SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS c FROM vps WHERE created_at >= ? GROUP BY d')
      .bind(sinceStr)
      .all();
    const byDay = {};
    for (const r of grouped.results || []) byDay[r.d] = r.c;
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      trend.push({ date: `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, count: byDay[key] || 0 });
    }
    const recent = await db
      .prepare('SELECT id, username, action, target, detail, status, created_at FROM logs ORDER BY id DESC LIMIT 8')
      .all();
    // 待同步 / 同步失败（替代原到期提醒）
    const needSync = await db
      .prepare("SELECT id, name, ssh_host, sync_status, sync_error FROM vps WHERE sync_status IN ('pending','running','error') ORDER BY updated_at DESC LIMIT 5")
      .all();
    return ok({
      total,
      online,
      offline,
      unknown: total - online - offline,
      trend,
      dist,
      recentLogs: recent.results || [],
      needSync: needSync.results || [],
      siteName: await getSetting(db, 'site_name', 'MEVPS'),
      version: API_VERSION,
    });
  }

  // VPS 列表
  if (path === '/api/vps' && method === 'GET') {
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize')) || 10));
    const keyword = (url.searchParams.get('keyword') || '').trim();
    const status = (url.searchParams.get('status') || '').trim();
    const where = [];
    const args = [];
    if (keyword) {
      where.push('(name LIKE ? OR ssh_host LIKE ? OR country LIKE ? OR city LIKE ? OR geo_en LIKE ? OR geo_zh LIKE ? OR remark LIKE ?)');
      args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    if (status) {
      where.push('sync_status = ?');
      args.push(status);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = await db.prepare(`SELECT COUNT(*) AS c FROM vps ${clause}`).bind(...args).first();
    // 安全列白名单：绝不回传 ssh_secret_enc
    const list = await db
      .prepare(
        `SELECT id, name, ssh_host, ssh_port, ssh_username, ssh_auth, country, city, ip, geo_en, geo_zh, spec, online, sync_status, sync_error, last_sync_at, remark, created_at, updated_at FROM vps ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`
      )
      .bind(...args, pageSize, (page - 1) * pageSize)
      .all();
    return ok({ list: list.results || [], total: totalRow ? totalRow.c : 0, page, pageSize });
  }

  // 新增 VPS
  if (path === '/api/vps' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const name = String(b.name || '').trim();
    const host = String(b.ssh_host || '').trim();
    if (!name || !host) return err('名称和主机/IP 为必填项');
    const port = Math.min(65535, Math.max(1, Number(b.ssh_port) || 22));
    const user = String(b.ssh_username || 'root').trim().slice(0, 64);
    const auth = b.ssh_auth === 'key' ? 'key' : 'password';
    const secret = String(b.ssh_secret || '');
    const secretEnc = secret ? await encSecret(env, secret) : '';
    if (secret && !secretEnc) return err('SSH 凭据加密失败，请检查 SSH_ENC_KEY 配置');
    const t = nowStr();
    const r = await db
      .prepare(
        'INSERT INTO vps (name, ssh_host, ssh_port, ssh_username, ssh_auth, ssh_secret_enc, remark, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(name, host, port, user, auth, secretEnc, String(b.remark || '').slice(0, 500), t, t)
      .run();
    await addLog(db, username, '新增', name, `创建 VPS 记录 ${name}（${host}:${port}）`, ip);
    return ok({ id: r.meta.last_row_id });
  }

  // 批量删除 VPS
  if (path === '/api/vps/batch-delete' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return err('请选择要删除的记录');
    const del = db.prepare('DELETE FROM vps WHERE id = ?');
    const results = await db.batch(ids.map((id) => del.bind(id)));
    const deleted = results.reduce((s, r) => s + ((r && r.meta && r.meta.changes) || 0), 0);
    await addLog(db, username, '删除', 'VPS', `批量删除 VPS 记录（#${ids.join('、#')}）`, ip);
    return ok({ deleted });
  }

  // 单个 VPS 操作：修改 / 删除 / 启停
  const m = path.match(/^\/api\/vps\/(\d+)$/);
  const ma = path.match(/^\/api\/vps\/(\d+)\/action$/);
  // 终端一次性票据（WebSocket 握手无法带 Authorization 头，改用短期 HMAC 票据）
  const mt = path.match(/^\/api\/vps\/(\d+)\/terminal-ticket$/);
  if (mt && method === 'POST') {
    const id = Number(mt[1]);
    const row = await db.prepare('SELECT id, name FROM vps WHERE id = ?').bind(id).first();
    if (!row) return err('记录不存在', 404);
    return ok({ ticket: await issueTerminalTicket(env, username, id) });
  }
  if (m) {
    const id = Number(m[1]);
    const row = await db.prepare('SELECT * FROM vps WHERE id = ?').bind(id).first();
    if (!row) return err('记录不存在', 404);
    if (method === 'PUT') {
      const b = await request.json().catch(() => ({}));
      const name = String(b.name ?? row.name).trim();
      const host = String(b.ssh_host ?? row.ssh_host).trim();
      if (!name || !host) return err('名称和主机/IP 为必填项');
      const port = Math.min(65535, Math.max(1, Number(b.ssh_port ?? row.ssh_port) || 22));
      const user = String(b.ssh_username ?? row.ssh_username).trim().slice(0, 64);
      const auth = (b.ssh_auth ?? row.ssh_auth) === 'key' ? 'key' : 'password';
      // SSH 凭据：仅在提供新值时覆盖；留空保持原值，显式 clear_secret=true 才清空
      let secretEnc = row.ssh_secret_enc || '';
      if (b.clear_secret === true) {
        secretEnc = '';
      } else if (typeof b.ssh_secret === 'string' && b.ssh_secret.trim()) {
        secretEnc = await encSecret(env, b.ssh_secret.trim());
        if (!secretEnc) return err('SSH 凭据加密失败，请检查 SSH_ENC_KEY 配置');
      }
      await db
        .prepare(
          'UPDATE vps SET name=?, ssh_host=?, ssh_port=?, ssh_username=?, ssh_auth=?, ssh_secret_enc=?, remark=?, updated_at=? WHERE id=?'
        )
        .bind(name, host, port, user, auth, secretEnc, String(b.remark ?? row.remark).slice(0, 500), nowStr(), id)
        .run();
      await addLog(db, username, '修改', row.name, `修改 VPS 记录 #${id}`, ip);
      return ok({});
    }
    if (method === 'DELETE') {
      await db.prepare('DELETE FROM vps WHERE id = ?').bind(id).run();
      await addLog(db, username, '删除', row.name, `删除 VPS 记录 #${id}`, ip);
      return ok({});
    }
    return err('不支持的请求方法', 405);
  }
  if (ma && method === 'POST') {
    const id = Number(ma[1]);
    const row = await db.prepare('SELECT * FROM vps WHERE id = ?').bind(id).first();
    if (!row) return err('记录不存在', 404);
    const b = await request.json().catch(() => ({}));
    if (b.action !== 'sync') return err('未知操作');
    // 建同步任务 → 触发 GitHub Actions 执行器（payload 不含凭据）
    const jobId = await createSyncJob(db, id);
    const d = await dispatchSync(env, jobId, id);
    if (!d.ok) {
      await db.prepare("UPDATE vps SET sync_status='error', sync_error=?, updated_at=? WHERE id=?").bind(d.error.slice(0, 500), nowStr(), id).run();
      await db.prepare("UPDATE sync_jobs SET status='failed', updated_at=? WHERE id=?").bind(nowStr(), jobId).run();
      await addLog(db, username, '同步', row.name, `同步触发失败：${d.error}`, ip, 'fail');
      return err(d.error);
    }
    await db.prepare("UPDATE vps SET sync_status='running', sync_error='', updated_at=? WHERE id=?").bind(nowStr(), id).run();
    await addLog(db, username, '同步', row.name, `触发配置/归属地同步 #${id}（job ${jobId.slice(0, 8)}）`, ip);
    return ok({ sync_status: 'running', job_id: jobId });
  }

  // 操作日志
  if (path === '/api/logs' && method === 'GET') {
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize')) || 10));
    const keyword = (url.searchParams.get('keyword') || '').trim();
    const action = (url.searchParams.get('action') || '').trim();
    const where = [];
    const args = [];
    if (keyword) {
      where.push('(username LIKE ? OR target LIKE ? OR detail LIKE ?)');
      args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    if (action) {
      where.push('action = ?');
      args.push(action);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = await db.prepare(`SELECT COUNT(*) AS c FROM logs ${clause}`).bind(...args).first();
    const list = await db
      .prepare(`SELECT * FROM logs ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...args, pageSize, (page - 1) * pageSize)
      .all();
    return ok({ list: list.results || [], total: totalRow ? totalRow.c : 0, page, pageSize });
  }

  // 批量删除操作日志
  if (path === '/api/logs/batch-delete' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return err('请选择要删除的日志');
    const del = db.prepare('DELETE FROM logs WHERE id = ?');
    const results = await db.batch(ids.map((id) => del.bind(id)));
    const deleted = results.reduce((s, r) => s + ((r && r.meta && r.meta.changes) || 0), 0);
    await addLog(db, username, '删除', '操作日志', `批量删除 ${deleted} 条操作日志（#${ids.join('、#')}）`, ip);
    return ok({ deleted });
  }

  // 系统设置（所有变量都保存在 D1 settings 表）
  if (path === '/api/settings' && method === 'GET') {
    const rows = await db.prepare('SELECT key, value FROM settings').all();
    const map = {};
    for (const r of rows.results || []) map[r.key] = r.value;
    return ok({
      site_name: map.site_name || 'MEVPS',
      site_desc: map.site_desc || '',
      session_hours: map.session_hours || '24',
      init_at: map.init_at || '',
      version: API_VERSION,
    });
  }
  if (path === '/api/settings' && method === 'PUT') {
    const b = await request.json().catch(() => ({}));
    const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const batch = [];
    if (typeof b.site_name === 'string' && b.site_name.trim()) batch.push(up.bind('site_name', b.site_name.trim().slice(0, 50)));
    if (typeof b.site_desc === 'string') batch.push(up.bind('site_desc', b.site_desc.slice(0, 200)));
    const sh = Number(b.session_hours);
    if (sh >= 1 && sh <= 720) batch.push(up.bind('session_hours', String(sh)));
    if (batch.length) await db.batch(batch);
    await addLog(db, username, '设置', '系统设置', `更新系统设置（${batch.length} 项）`, ip);
    return ok({});
  }

  // 修改用户名 / 密码
  if (path === '/api/profile' && method === 'PUT') {
    const b = await request.json().catch(() => ({}));
    const user = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
    if (!user) return err('用户不存在', 404);
    const oldPassword = String(b.old_password || '');
    if (!oldPassword) return err('请输入当前密码');
    const hash = await hashPassword(oldPassword, user.salt);
    if (hash !== user.password_hash) {
      await addLog(db, username, '修改', '账号', '当前密码错误', ip, 'fail');
      return err('当前密码错误', 403);
    }
    const newUsername = String(b.username || '').trim();
    const newPassword = String(b.new_password || '');
    if (newPassword && newPassword.length < 6) return err('新密码至少 6 位');
    if (!newPassword && !newUsername) return err('没有需要修改的内容');
    let target = username;
    if (newUsername && newUsername !== username) {
      const exists = await db.prepare('SELECT id FROM users WHERE username = ?').bind(newUsername).first();
      if (exists) return err('用户名已被占用');
      await db.prepare('UPDATE users SET username = ?, updated_at = ? WHERE id = ?').bind(newUsername, nowStr(), user.id).run();
      target = newUsername;
      await addLog(db, username, '修改', '账号', `用户名 ${username} → ${newUsername}`, ip);
    }
    if (newPassword) {
      const salt = randomHex(16);
      const nh = await hashPassword(newPassword, salt);
      await db.prepare('UPDATE users SET password_hash = ?, salt = ?, updated_at = ? WHERE id = ?').bind(nh, salt, nowStr(), user.id).run();
      await addLog(db, target, '修改', '账号', '修改登录密码', ip);
    }
    return ok({ username: target });
  }

  // —— GitHub Actions 集成配置（SSH 执行器触发端）——
  // 安全约定：Token 只写不读，接口永不回显明文或任何片段。
  if (path === '/api/actions' && method === 'GET') {
    const repo = await getSetting(db, 'gh_repo', '');
    const evt = await getSetting(db, 'gh_event', 'vps-sync');
    const hasClassic = !!(await getSetting(db, 'gh_token_classic_enc', ''));
    const hasFine = !!(await getSetting(db, 'gh_token_fine_enc', ''));
    const activeType = (await getSetting(db, 'gh_token_type', 'classic')) === 'fine' ? 'fine' : 'classic';
    const cbSet = !!(await getSetting(db, 'sync_callback_secret', ''));
    const { source } = await resolveEncKey(env);
    return ok({
      repo,
      event: evt,
      has_classic: hasClassic,
      has_fine: hasFine,
      active_type: activeType,
      callback_set: cbSet,
      enc_source: source,
    });
  }

  if (path === '/api/actions' && method === 'PUT') {
    const b = await request.json().catch(() => ({}));
    const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const batch = [];
    if (typeof b.gh_repo === 'string') {
      const repo = b.gh_repo.trim();
      if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) return err('GitHub 仓库格式应为 owner/repo');
      batch.push(up.bind('gh_repo', repo.slice(0, 100)));
    }
    if (typeof b.gh_event === 'string' && b.gh_event.trim()) batch.push(up.bind('gh_event', b.gh_event.trim().slice(0, 60)));
    // 双 Token 槽：仅在非空时更新，留空即保持原有值，避免误清空。
    if (typeof b.gh_token_classic === 'string' && b.gh_token_classic.trim()) {
      const enc = await encSecret(env, b.gh_token_classic.trim());
      if (!enc) return err('Classic Token 加密失败，请检查 SSH_ENC_KEY 配置');
      batch.push(up.bind('gh_token_classic_enc', enc));
    }
    if (typeof b.gh_token_fine === 'string' && b.gh_token_fine.trim()) {
      const enc = await encSecret(env, b.gh_token_fine.trim());
      if (!enc) return err('细粒度 Token 加密失败，请检查 SSH_ENC_KEY 配置');
      batch.push(up.bind('gh_token_fine_enc', enc));
    }
    if (typeof b.gh_token_type === 'string' && ['classic', 'fine'].includes(b.gh_token_type)) {
      batch.push(up.bind('gh_token_type', b.gh_token_type));
    }
    // 回调密钥：用户自设（需与 GitHub Secrets 的 CALLBACK_SECRET 一致），仅非空时覆盖
    if (typeof b.callback_secret === 'string' && b.callback_secret.trim()) {
      batch.push(up.bind('sync_callback_secret', b.callback_secret.trim().slice(0, 128)));
    }
    if (b.reset_callback === true) batch.push(up.bind('sync_callback_secret', randomHex(32)));
    if (!batch.length) return err('没有需要保存的内容');
    await db.batch(batch);
    await addLog(db, username, '设置', 'SSH 设置', `更新 Actions 集成配置（${batch.length} 项）`, ip);
    return ok({});
  }

  // —— 一键同步到 GitHub Secrets ——
  // 把 WORKER_URL 与 CALLBACK_SECRET 自动写入仓库的 Actions Secrets，省去手动去 GitHub 后台配置。
  // GitHub Secrets API 只接受 libsodium sealed box 加密值，加密见 sealForGitHub()。
  // 安全约定：不回显任何密钥；日志只记操作名与结果。
  if (path === '/api/actions/sync-secrets' && method === 'POST') {
    const repo = await getSetting(db, 'gh_repo', '');
    if (!repo) return err('未配置 GitHub 仓库，请先在上方填写并保存');
    const [owner, name] = repo.split('/');
    const token = await getActiveGhToken(env);
    if (!token) return err('未配置 GitHub Token，请先在上方填写并保存');

    // 回调密钥缺失时自动生成并落库，让这个按钮能一次配完
    let cb = await getSetting(db, 'sync_callback_secret', '');
    if (!cb) {
      cb = randomHex(32);
      await db
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind('sync_callback_secret', cb)
        .run();
    }

    // Worker 自己的公网地址：直接从当前请求推导，无需用户填写
    const selfUrl = new URL(request.url).origin;

    const ghHeaders = {
      'User-Agent': 'mevps-worker',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const secretsHint = ['fine-grained PAT 还需「Secrets: Read and write」权限；classic PAT 需勾选 repo 全量'];

    try {
      // 1) 取仓库公钥（sealed box 的收件方公钥）
      const pkRes = await fetch(`https://api.github.com/repos/${owner}/${name}/actions/secrets/public-key`, { headers: ghHeaders });
      if (!pkRes.ok) return err(ghApiError(pkRes, await pkRes.text().catch(() => ''), secretsHint, 'Secrets 读取'));
      const pkJson = await pkRes.json();
      if (!pkJson || !pkJson.key || !pkJson.key_id) return err('GitHub 返回的仓库公钥不完整');
      const pk = b64urlToBytes(pkJson.key); // 兼容标准 base64 与 base64url
      if (pk.length !== 32) return err('GitHub 返回的仓库公钥长度异常');

      // 2) 逐个加密并写入
      const want = [
        { name: 'WORKER_URL', value: selfUrl },
        { name: 'CALLBACK_SECRET', value: cb },
      ];
      const synced = [];
      for (const s of want) {
        const encrypted_value = bytesToB64(sealForGitHub(pk, te.encode(s.value)));
        const r = await fetch(`https://api.github.com/repos/${owner}/${name}/actions/secrets/${s.name}`, {
          method: 'PUT',
          headers: { ...ghHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ encrypted_value, key_id: pkJson.key_id }),
        });
        // 201 = 新建，204 = 覆盖更新
        if (r.status !== 201 && r.status !== 204) {
          return err(`${s.name}：${ghApiError(r, await r.text().catch(() => ''), secretsHint, 'Secrets 写入')}`);
        }
        synced.push(s.name);
      }
      await addLog(db, username, '设置', 'SSH 设置', `一键同步 GitHub Secrets（${synced.join('、')}）`, ip);
      return ok({ synced, worker_url: selfUrl });
    } catch (e) {
      return err(`同步 GitHub Secrets 异常: ${e && e.message ? e.message : e}`);
    }
  }

  return err('接口不存在', 404);
}

/* ============ VENDOR: tweetnacl v1.0.3 + blakejs v1.2.1 (blake2b) ============
 *
 * 为什么需要这两个库
 * ------------------
 * GitHub Secrets API 只接受用 libsodium sealed box (crypto_box_seal) 加密后的值，
 * 而 Cloudflare Workers 的 WebCrypto 不提供 X25519 / XSalsa20-Poly1305 / BLAKE2b，
 * 必须自带实现。本项目要求 worker.js 保持单文件可粘贴部署（README「部署二」），故内联而非 import。
 *
 * 来源与完整性（均与 npm registry 发布值校验过）
 * --------------------------------------------
 * tweetnacl 1.0.3  https://unpkg.com/tweetnacl@1.0.3/nacl-fast.min.js
 *   npm tarball shasum ac0af71680458d8a6378d0d0d050ab1407d35596 ✓
 *   nacl-fast.min.js sha256 3ec535c004aeeb225785d8e93fb33bf99f52e399bd7dfc01969b5629baea5131
 *   许可 Unlicense（公有领域），审计 Cure53
 * blakejs 1.2.1    https://registry.npmjs.org/blakejs/-/blakejs-1.2.1.tgz
 *   npm tarball shasum 5057e4206eadb4a97f7c0b6e197a505042fc3814 ✓
 *   许可 MIT
 *
 * 变更说明
 * --------
 * 下列 minified/源码均【逐字节保持原样】，仅在外层加作用域包装把 module.exports /
 * require('./util') 接到局部变量，避免污染 Worker 全局，也避免 require 依赖。
 * 未修改任何算法实现。
 *
 * 已验证
 * ------
 *  1. blake2b(outlen=24) 与 Python hashlib.blake2b(digest_size=24) 逐一比对一致
 *  2. sealForGitHub() 产物可被 PyNaCl 1.6.2 的 SealedBox（真 libsodium）成功解开
 *  3. 密文结构 = 32 字节一次性临时公钥 + secretbox 密文，符合 crypto_box_seal
 * ===================================================================== */

/* ---------- blakejs: util.js + blake2b.js（原样，仅包作用域） ---------- */
const __blakeUtil = (() => {
  const module = { exports: {} };
const ERROR_MSG_INPUT = 'Input must be an string, Buffer or Uint8Array'

// For convenience, let people hash a string, not just a Uint8Array
function normalizeInput (input) {
  let ret
  if (input instanceof Uint8Array) {
    ret = input
  } else if (typeof input === 'string') {
    const encoder = new TextEncoder()
    ret = encoder.encode(input)
  } else {
    throw new Error(ERROR_MSG_INPUT)
  }
  return ret
}

// Converts a Uint8Array to a hexadecimal string
// For example, toHex([255, 0, 255]) returns "ff00ff"
function toHex (bytes) {
  return Array.prototype.map
    .call(bytes, function (n) {
      return (n < 16 ? '0' : '') + n.toString(16)
    })
    .join('')
}

// Converts any value in [0...2^32-1] to an 8-character hex string
function uint32ToHex (val) {
  return (0x100000000 + val).toString(16).substring(1)
}

// For debugging: prints out hash state in the same format as the RFC
// sample computation exactly, so that you can diff
function debugPrint (label, arr, size) {
  let msg = '\n' + label + ' = '
  for (let i = 0; i < arr.length; i += 2) {
    if (size === 32) {
      msg += uint32ToHex(arr[i]).toUpperCase()
      msg += ' '
      msg += uint32ToHex(arr[i + 1]).toUpperCase()
    } else if (size === 64) {
      msg += uint32ToHex(arr[i + 1]).toUpperCase()
      msg += uint32ToHex(arr[i]).toUpperCase()
    } else throw new Error('Invalid size ' + size)
    if (i % 6 === 4) {
      msg += '\n' + new Array(label.length + 4).join(' ')
    } else if (i < arr.length - 2) {
      msg += ' '
    }
  }
  console.log(msg)
}

// For performance testing: generates N bytes of input, hashes M times
// Measures and prints MB/second hash performance each time
function testSpeed (hashFn, N, M) {
  let startMs = new Date().getTime()

  const input = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    input[i] = i % 256
  }
  const genMs = new Date().getTime()
  console.log('Generated random input in ' + (genMs - startMs) + 'ms')
  startMs = genMs

  for (let i = 0; i < M; i++) {
    const hashHex = hashFn(input)
    const hashMs = new Date().getTime()
    const ms = hashMs - startMs
    startMs = hashMs
    console.log('Hashed in ' + ms + 'ms: ' + hashHex.substring(0, 20) + '...')
    console.log(
      Math.round((N / (1 << 20) / (ms / 1000)) * 100) / 100 + ' MB PER SECOND'
    )
  }
}

module.exports = {
  normalizeInput: normalizeInput,
  toHex: toHex,
  debugPrint: debugPrint,
  testSpeed: testSpeed
}

  return module.exports;
})();
const blakejs = (() => {
  const module = { exports: {} };
  const require = () => __blakeUtil;
// Blake2B in pure Javascript
// Adapted from the reference implementation in RFC7693
// Ported to Javascript by DC - https://github.com/dcposch

const util = require('./util')

// 64-bit unsigned addition
// Sets v[a,a+1] += v[b,b+1]
// v should be a Uint32Array
function ADD64AA (v, a, b) {
  const o0 = v[a] + v[b]
  let o1 = v[a + 1] + v[b + 1]
  if (o0 >= 0x100000000) {
    o1++
  }
  v[a] = o0
  v[a + 1] = o1
}

// 64-bit unsigned addition
// Sets v[a,a+1] += b
// b0 is the low 32 bits of b, b1 represents the high 32 bits
function ADD64AC (v, a, b0, b1) {
  let o0 = v[a] + b0
  if (b0 < 0) {
    o0 += 0x100000000
  }
  let o1 = v[a + 1] + b1
  if (o0 >= 0x100000000) {
    o1++
  }
  v[a] = o0
  v[a + 1] = o1
}

// Little-endian byte access
function B2B_GET32 (arr, i) {
  return arr[i] ^ (arr[i + 1] << 8) ^ (arr[i + 2] << 16) ^ (arr[i + 3] << 24)
}

// G Mixing function
// The ROTRs are inlined for speed
function B2B_G (a, b, c, d, ix, iy) {
  const x0 = m[ix]
  const x1 = m[ix + 1]
  const y0 = m[iy]
  const y1 = m[iy + 1]

  ADD64AA(v, a, b) // v[a,a+1] += v[b,b+1] ... in JS we must store a uint64 as two uint32s
  ADD64AC(v, a, x0, x1) // v[a, a+1] += x ... x0 is the low 32 bits of x, x1 is the high 32 bits

  // v[d,d+1] = (v[d,d+1] xor v[a,a+1]) rotated to the right by 32 bits
  let xor0 = v[d] ^ v[a]
  let xor1 = v[d + 1] ^ v[a + 1]
  v[d] = xor1
  v[d + 1] = xor0

  ADD64AA(v, c, d)

  // v[b,b+1] = (v[b,b+1] xor v[c,c+1]) rotated right by 24 bits
  xor0 = v[b] ^ v[c]
  xor1 = v[b + 1] ^ v[c + 1]
  v[b] = (xor0 >>> 24) ^ (xor1 << 8)
  v[b + 1] = (xor1 >>> 24) ^ (xor0 << 8)

  ADD64AA(v, a, b)
  ADD64AC(v, a, y0, y1)

  // v[d,d+1] = (v[d,d+1] xor v[a,a+1]) rotated right by 16 bits
  xor0 = v[d] ^ v[a]
  xor1 = v[d + 1] ^ v[a + 1]
  v[d] = (xor0 >>> 16) ^ (xor1 << 16)
  v[d + 1] = (xor1 >>> 16) ^ (xor0 << 16)

  ADD64AA(v, c, d)

  // v[b,b+1] = (v[b,b+1] xor v[c,c+1]) rotated right by 63 bits
  xor0 = v[b] ^ v[c]
  xor1 = v[b + 1] ^ v[c + 1]
  v[b] = (xor1 >>> 31) ^ (xor0 << 1)
  v[b + 1] = (xor0 >>> 31) ^ (xor1 << 1)
}

// Initialization Vector
const BLAKE2B_IV32 = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372,
  0x5f1d36f1, 0xa54ff53a, 0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c,
  0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19
])

const SIGMA8 = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 14, 10, 4, 8, 9, 15, 13,
  6, 1, 12, 0, 2, 11, 7, 5, 3, 11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1,
  9, 4, 7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8, 9, 0, 5, 7, 2, 4,
  10, 15, 14, 1, 11, 12, 6, 8, 3, 13, 2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5,
  15, 14, 1, 9, 12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11, 13, 11, 7,
  14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10, 6, 15, 14, 9, 11, 3, 0, 8, 12, 2,
  13, 7, 1, 4, 10, 5, 10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0, 0,
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 14, 10, 4, 8, 9, 15, 13, 6,
  1, 12, 0, 2, 11, 7, 5, 3
]

// These are offsets into a uint64 buffer.
// Multiply them all by 2 to make them offsets into a uint32 buffer,
// because this is Javascript and we don't have uint64s
const SIGMA82 = new Uint8Array(
  SIGMA8.map(function (x) {
    return x * 2
  })
)

// Compression function. 'last' flag indicates last block.
// Note we're representing 16 uint64s as 32 uint32s
const v = new Uint32Array(32)
const m = new Uint32Array(32)
function blake2bCompress (ctx, last) {
  let i = 0

  // init work variables
  for (i = 0; i < 16; i++) {
    v[i] = ctx.h[i]
    v[i + 16] = BLAKE2B_IV32[i]
  }

  // low 64 bits of offset
  v[24] = v[24] ^ ctx.t
  v[25] = v[25] ^ (ctx.t / 0x100000000)
  // high 64 bits not supported, offset may not be higher than 2**53-1

  // last block flag set ?
  if (last) {
    v[28] = ~v[28]
    v[29] = ~v[29]
  }

  // get little-endian words
  for (i = 0; i < 32; i++) {
    m[i] = B2B_GET32(ctx.b, 4 * i)
  }

  // twelve rounds of mixing
  // uncomment the DebugPrint calls to log the computation
  // and match the RFC sample documentation
  // util.debugPrint('          m[16]', m, 64)
  for (i = 0; i < 12; i++) {
    // util.debugPrint('   (i=' + (i < 10 ? ' ' : '') + i + ') v[16]', v, 64)
    B2B_G(0, 8, 16, 24, SIGMA82[i * 16 + 0], SIGMA82[i * 16 + 1])
    B2B_G(2, 10, 18, 26, SIGMA82[i * 16 + 2], SIGMA82[i * 16 + 3])
    B2B_G(4, 12, 20, 28, SIGMA82[i * 16 + 4], SIGMA82[i * 16 + 5])
    B2B_G(6, 14, 22, 30, SIGMA82[i * 16 + 6], SIGMA82[i * 16 + 7])
    B2B_G(0, 10, 20, 30, SIGMA82[i * 16 + 8], SIGMA82[i * 16 + 9])
    B2B_G(2, 12, 22, 24, SIGMA82[i * 16 + 10], SIGMA82[i * 16 + 11])
    B2B_G(4, 14, 16, 26, SIGMA82[i * 16 + 12], SIGMA82[i * 16 + 13])
    B2B_G(6, 8, 18, 28, SIGMA82[i * 16 + 14], SIGMA82[i * 16 + 15])
  }
  // util.debugPrint('   (i=12) v[16]', v, 64)

  for (i = 0; i < 16; i++) {
    ctx.h[i] = ctx.h[i] ^ v[i] ^ v[i + 16]
  }
  // util.debugPrint('h[8]', ctx.h, 64)
}

// reusable parameterBlock
const parameterBlock = new Uint8Array([
  0,
  0,
  0,
  0, //  0: outlen, keylen, fanout, depth
  0,
  0,
  0,
  0, //  4: leaf length, sequential mode
  0,
  0,
  0,
  0, //  8: node offset
  0,
  0,
  0,
  0, // 12: node offset
  0,
  0,
  0,
  0, // 16: node depth, inner length, rfu
  0,
  0,
  0,
  0, // 20: rfu
  0,
  0,
  0,
  0, // 24: rfu
  0,
  0,
  0,
  0, // 28: rfu
  0,
  0,
  0,
  0, // 32: salt
  0,
  0,
  0,
  0, // 36: salt
  0,
  0,
  0,
  0, // 40: salt
  0,
  0,
  0,
  0, // 44: salt
  0,
  0,
  0,
  0, // 48: personal
  0,
  0,
  0,
  0, // 52: personal
  0,
  0,
  0,
  0, // 56: personal
  0,
  0,
  0,
  0 // 60: personal
])

// Creates a BLAKE2b hashing context
// Requires an output length between 1 and 64 bytes
// Takes an optional Uint8Array key
// Takes an optinal Uint8Array salt
// Takes an optinal Uint8Array personal
function blake2bInit (outlen, key, salt, personal) {
  if (outlen === 0 || outlen > 64) {
    throw new Error('Illegal output length, expected 0 < length <= 64')
  }
  if (key && key.length > 64) {
    throw new Error('Illegal key, expected Uint8Array with 0 < length <= 64')
  }
  if (salt && salt.length !== 16) {
    throw new Error('Illegal salt, expected Uint8Array with length is 16')
  }
  if (personal && personal.length !== 16) {
    throw new Error('Illegal personal, expected Uint8Array with length is 16')
  }

  // state, 'param block'
  const ctx = {
    b: new Uint8Array(128),
    h: new Uint32Array(16),
    t: 0, // input count
    c: 0, // pointer within buffer
    outlen: outlen // output length in bytes
  }

  // initialize parameterBlock before usage
  parameterBlock.fill(0)
  parameterBlock[0] = outlen
  if (key) parameterBlock[1] = key.length
  parameterBlock[2] = 1 // fanout
  parameterBlock[3] = 1 // depth
  if (salt) parameterBlock.set(salt, 32)
  if (personal) parameterBlock.set(personal, 48)

  // initialize hash state
  for (let i = 0; i < 16; i++) {
    ctx.h[i] = BLAKE2B_IV32[i] ^ B2B_GET32(parameterBlock, i * 4)
  }

  // key the hash, if applicable
  if (key) {
    blake2bUpdate(ctx, key)
    // at the end
    ctx.c = 128
  }

  return ctx
}

// Updates a BLAKE2b streaming hash
// Requires hash context and Uint8Array (byte array)
function blake2bUpdate (ctx, input) {
  for (let i = 0; i < input.length; i++) {
    if (ctx.c === 128) {
      // buffer full ?
      ctx.t += ctx.c // add counters
      blake2bCompress(ctx, false) // compress (not last)
      ctx.c = 0 // counter to zero
    }
    ctx.b[ctx.c++] = input[i]
  }
}

// Completes a BLAKE2b streaming hash
// Returns a Uint8Array containing the message digest
function blake2bFinal (ctx) {
  ctx.t += ctx.c // mark last block offset

  while (ctx.c < 128) {
    // fill up with zeros
    ctx.b[ctx.c++] = 0
  }
  blake2bCompress(ctx, true) // final block flag = 1

  // little endian convert and store
  const out = new Uint8Array(ctx.outlen)
  for (let i = 0; i < ctx.outlen; i++) {
    out[i] = ctx.h[i >> 2] >> (8 * (i & 3))
  }
  return out
}

// Computes the BLAKE2B hash of a string or byte array, and returns a Uint8Array
//
// Returns a n-byte Uint8Array
//
// Parameters:
// - input - the input bytes, as a string, Buffer or Uint8Array
// - key - optional key Uint8Array, up to 64 bytes
// - outlen - optional output length in bytes, default 64
// - salt - optional salt bytes, string, Buffer or Uint8Array
// - personal - optional personal bytes, string, Buffer or Uint8Array
function blake2b (input, key, outlen, salt, personal) {
  // preprocess inputs
  outlen = outlen || 64
  input = util.normalizeInput(input)
  if (salt) {
    salt = util.normalizeInput(salt)
  }
  if (personal) {
    personal = util.normalizeInput(personal)
  }

  // do the math
  const ctx = blake2bInit(outlen, key, salt, personal)
  blake2bUpdate(ctx, input)
  return blake2bFinal(ctx)
}

// Computes the BLAKE2B hash of a string or byte array
//
// Returns an n-byte hash in hex, all lowercase
//
// Parameters:
// - input - the input bytes, as a string, Buffer, or Uint8Array
// - key - optional key Uint8Array, up to 64 bytes
// - outlen - optional output length in bytes, default 64
// - salt - optional salt bytes, string, Buffer or Uint8Array
// - personal - optional personal bytes, string, Buffer or Uint8Array
function blake2bHex (input, key, outlen, salt, personal) {
  const output = blake2b(input, key, outlen, salt, personal)
  return util.toHex(output)
}

module.exports = {
  blake2b: blake2b,
  blake2bHex: blake2bHex,
  blake2bInit: blake2bInit,
  blake2bUpdate: blake2bUpdate,
  blake2bFinal: blake2bFinal
}

  return module.exports;
})();

/* ---------- tweetnacl: nacl-fast.min.js（原样，仅包作用域） ---------- */
const nacl = (() => {
  const module = { exports: {} };
!function(i){"use strict";var v=function(r){var t,n=new Float64Array(16);if(r)for(t=0;t<r.length;t++)n[t]=r[t];return n},h=function(){throw new Error("no PRNG")},o=new Uint8Array(16),n=new Uint8Array(32);n[0]=9;var s=v(),u=v([1]),p=v([56129,1]),c=v([30883,4953,19914,30187,55467,16705,2637,112,59544,30585,16505,36039,65139,11119,27886,20995]),y=v([61785,9906,39828,60374,45398,33411,5274,224,53552,61171,33010,6542,64743,22239,55772,9222]),e=v([54554,36645,11616,51542,42930,38181,51040,26924,56412,64982,57905,49316,21502,52590,14035,8553]),a=v([26200,26214,26214,26214,26214,26214,26214,26214,26214,26214,26214,26214,26214,26214,26214,26214]),l=v([41136,18958,6951,50414,58488,44335,6150,12099,55207,15867,153,11085,57099,20417,9344,11139]);function f(r,t,n,e){r[t]=n>>24&255,r[t+1]=n>>16&255,r[t+2]=n>>8&255,r[t+3]=255&n,r[t+4]=e>>24&255,r[t+5]=e>>16&255,r[t+6]=e>>8&255,r[t+7]=255&e}function w(r,t,n,e,o){var i,h=0;for(i=0;i<o;i++)h|=r[t+i]^n[e+i];return(1&h-1>>>8)-1}function b(r,t,n,e){return w(r,t,n,e,16)}function g(r,t,n,e){return w(r,t,n,e,32)}function A(r,t,n,e){!function(r,t,n,e){for(var o,i=255&e[0]|(255&e[1])<<8|(255&e[2])<<16|(255&e[3])<<24,h=255&n[0]|(255&n[1])<<8|(255&n[2])<<16|(255&n[3])<<24,a=255&n[4]|(255&n[5])<<8|(255&n[6])<<16|(255&n[7])<<24,f=255&n[8]|(255&n[9])<<8|(255&n[10])<<16|(255&n[11])<<24,s=255&n[12]|(255&n[13])<<8|(255&n[14])<<16|(255&n[15])<<24,u=255&e[4]|(255&e[5])<<8|(255&e[6])<<16|(255&e[7])<<24,c=255&t[0]|(255&t[1])<<8|(255&t[2])<<16|(255&t[3])<<24,y=255&t[4]|(255&t[5])<<8|(255&t[6])<<16|(255&t[7])<<24,l=255&t[8]|(255&t[9])<<8|(255&t[10])<<16|(255&t[11])<<24,w=255&t[12]|(255&t[13])<<8|(255&t[14])<<16|(255&t[15])<<24,v=255&e[8]|(255&e[9])<<8|(255&e[10])<<16|(255&e[11])<<24,p=255&n[16]|(255&n[17])<<8|(255&n[18])<<16|(255&n[19])<<24,b=255&n[20]|(255&n[21])<<8|(255&n[22])<<16|(255&n[23])<<24,g=255&n[24]|(255&n[25])<<8|(255&n[26])<<16|(255&n[27])<<24,A=255&n[28]|(255&n[29])<<8|(255&n[30])<<16|(255&n[31])<<24,_=255&e[12]|(255&e[13])<<8|(255&e[14])<<16|(255&e[15])<<24,U=i,d=h,E=a,x=f,M=s,m=u,B=c,S=y,k=l,K=w,Y=v,L=p,T=b,z=g,R=A,P=_,N=0;N<20;N+=2)U^=(o=(T^=(o=(k^=(o=(M^=(o=U+T|0)<<7|o>>>25)+U|0)<<9|o>>>23)+M|0)<<13|o>>>19)+k|0)<<18|o>>>14,m^=(o=(d^=(o=(z^=(o=(K^=(o=m+d|0)<<7|o>>>25)+m|0)<<9|o>>>23)+K|0)<<13|o>>>19)+z|0)<<18|o>>>14,Y^=(o=(B^=(o=(E^=(o=(R^=(o=Y+B|0)<<7|o>>>25)+Y|0)<<9|o>>>23)+R|0)<<13|o>>>19)+E|0)<<18|o>>>14,P^=(o=(L^=(o=(S^=(o=(x^=(o=P+L|0)<<7|o>>>25)+P|0)<<9|o>>>23)+x|0)<<13|o>>>19)+S|0)<<18|o>>>14,U^=(o=(x^=(o=(E^=(o=(d^=(o=U+x|0)<<7|o>>>25)+U|0)<<9|o>>>23)+d|0)<<13|o>>>19)+E|0)<<18|o>>>14,m^=(o=(M^=(o=(S^=(o=(B^=(o=m+M|0)<<7|o>>>25)+m|0)<<9|o>>>23)+B|0)<<13|o>>>19)+S|0)<<18|o>>>14,Y^=(o=(K^=(o=(k^=(o=(L^=(o=Y+K|0)<<7|o>>>25)+Y|0)<<9|o>>>23)+L|0)<<13|o>>>19)+k|0)<<18|o>>>14,P^=(o=(R^=(o=(z^=(o=(T^=(o=P+R|0)<<7|o>>>25)+P|0)<<9|o>>>23)+T|0)<<13|o>>>19)+z|0)<<18|o>>>14;U=U+i|0,d=d+h|0,E=E+a|0,x=x+f|0,M=M+s|0,m=m+u|0,B=B+c|0,S=S+y|0,k=k+l|0,K=K+w|0,Y=Y+v|0,L=L+p|0,T=T+b|0,z=z+g|0,R=R+A|0,P=P+_|0,r[0]=U>>>0&255,r[1]=U>>>8&255,r[2]=U>>>16&255,r[3]=U>>>24&255,r[4]=d>>>0&255,r[5]=d>>>8&255,r[6]=d>>>16&255,r[7]=d>>>24&255,r[8]=E>>>0&255,r[9]=E>>>8&255,r[10]=E>>>16&255,r[11]=E>>>24&255,r[12]=x>>>0&255,r[13]=x>>>8&255,r[14]=x>>>16&255,r[15]=x>>>24&255,r[16]=M>>>0&255,r[17]=M>>>8&255,r[18]=M>>>16&255,r[19]=M>>>24&255,r[20]=m>>>0&255,r[21]=m>>>8&255,r[22]=m>>>16&255,r[23]=m>>>24&255,r[24]=B>>>0&255,r[25]=B>>>8&255,r[26]=B>>>16&255,r[27]=B>>>24&255,r[28]=S>>>0&255,r[29]=S>>>8&255,r[30]=S>>>16&255,r[31]=S>>>24&255,r[32]=k>>>0&255,r[33]=k>>>8&255,r[34]=k>>>16&255,r[35]=k>>>24&255,r[36]=K>>>0&255,r[37]=K>>>8&255,r[38]=K>>>16&255,r[39]=K>>>24&255,r[40]=Y>>>0&255,r[41]=Y>>>8&255,r[42]=Y>>>16&255,r[43]=Y>>>24&255,r[44]=L>>>0&255,r[45]=L>>>8&255,r[46]=L>>>16&255,r[47]=L>>>24&255,r[48]=T>>>0&255,r[49]=T>>>8&255,r[50]=T>>>16&255,r[51]=T>>>24&255,r[52]=z>>>0&255,r[53]=z>>>8&255,r[54]=z>>>16&255,r[55]=z>>>24&255,r[56]=R>>>0&255,r[57]=R>>>8&255,r[58]=R>>>16&255,r[59]=R>>>24&255,r[60]=P>>>0&255,r[61]=P>>>8&255,r[62]=P>>>16&255,r[63]=P>>>24&255}(r,t,n,e)}function _(r,t,n,e){!function(r,t,n,e){for(var o,i=255&e[0]|(255&e[1])<<8|(255&e[2])<<16|(255&e[3])<<24,h=255&n[0]|(255&n[1])<<8|(255&n[2])<<16|(255&n[3])<<24,a=255&n[4]|(255&n[5])<<8|(255&n[6])<<16|(255&n[7])<<24,f=255&n[8]|(255&n[9])<<8|(255&n[10])<<16|(255&n[11])<<24,s=255&n[12]|(255&n[13])<<8|(255&n[14])<<16|(255&n[15])<<24,u=255&e[4]|(255&e[5])<<8|(255&e[6])<<16|(255&e[7])<<24,c=255&t[0]|(255&t[1])<<8|(255&t[2])<<16|(255&t[3])<<24,y=255&t[4]|(255&t[5])<<8|(255&t[6])<<16|(255&t[7])<<24,l=255&t[8]|(255&t[9])<<8|(255&t[10])<<16|(255&t[11])<<24,w=255&t[12]|(255&t[13])<<8|(255&t[14])<<16|(255&t[15])<<24,v=255&e[8]|(255&e[9])<<8|(255&e[10])<<16|(255&e[11])<<24,p=255&n[16]|(255&n[17])<<8|(255&n[18])<<16|(255&n[19])<<24,b=255&n[20]|(255&n[21])<<8|(255&n[22])<<16|(255&n[23])<<24,g=255&n[24]|(255&n[25])<<8|(255&n[26])<<16|(255&n[27])<<24,A=255&n[28]|(255&n[29])<<8|(255&n[30])<<16|(255&n[31])<<24,_=255&e[12]|(255&e[13])<<8|(255&e[14])<<16|(255&e[15])<<24,U=0;U<20;U+=2)i^=(o=(b^=(o=(l^=(o=(s^=(o=i+b|0)<<7|o>>>25)+i|0)<<9|o>>>23)+s|0)<<13|o>>>19)+l|0)<<18|o>>>14,u^=(o=(h^=(o=(g^=(o=(w^=(o=u+h|0)<<7|o>>>25)+u|0)<<9|o>>>23)+w|0)<<13|o>>>19)+g|0)<<18|o>>>14,v^=(o=(c^=(o=(a^=(o=(A^=(o=v+c|0)<<7|o>>>25)+v|0)<<9|o>>>23)+A|0)<<13|o>>>19)+a|0)<<18|o>>>14,_^=(o=(p^=(o=(y^=(o=(f^=(o=_+p|0)<<7|o>>>25)+_|0)<<9|o>>>23)+f|0)<<13|o>>>19)+y|0)<<18|o>>>14,i^=(o=(f^=(o=(a^=(o=(h^=(o=i+f|0)<<7|o>>>25)+i|0)<<9|o>>>23)+h|0)<<13|o>>>19)+a|0)<<18|o>>>14,u^=(o=(s^=(o=(y^=(o=(c^=(o=u+s|0)<<7|o>>>25)+u|0)<<9|o>>>23)+c|0)<<13|o>>>19)+y|0)<<18|o>>>14,v^=(o=(w^=(o=(l^=(o=(p^=(o=v+w|0)<<7|o>>>25)+v|0)<<9|o>>>23)+p|0)<<13|o>>>19)+l|0)<<18|o>>>14,_^=(o=(A^=(o=(g^=(o=(b^=(o=_+A|0)<<7|o>>>25)+_|0)<<9|o>>>23)+b|0)<<13|o>>>19)+g|0)<<18|o>>>14;r[0]=i>>>0&255,r[1]=i>>>8&255,r[2]=i>>>16&255,r[3]=i>>>24&255,r[4]=u>>>0&255,r[5]=u>>>8&255,r[6]=u>>>16&255,r[7]=u>>>24&255,r[8]=v>>>0&255,r[9]=v>>>8&255,r[10]=v>>>16&255,r[11]=v>>>24&255,r[12]=_>>>0&255,r[13]=_>>>8&255,r[14]=_>>>16&255,r[15]=_>>>24&255,r[16]=c>>>0&255,r[17]=c>>>8&255,r[18]=c>>>16&255,r[19]=c>>>24&255,r[20]=y>>>0&255,r[21]=y>>>8&255,r[22]=y>>>16&255,r[23]=y>>>24&255,r[24]=l>>>0&255,r[25]=l>>>8&255,r[26]=l>>>16&255,r[27]=l>>>24&255,r[28]=w>>>0&255,r[29]=w>>>8&255,r[30]=w>>>16&255,r[31]=w>>>24&255}(r,t,n,e)}var U=new Uint8Array([101,120,112,97,110,100,32,51,50,45,98,121,116,101,32,107]);function d(r,t,n,e,o,i,h){var a,f,s=new Uint8Array(16),u=new Uint8Array(64);for(f=0;f<16;f++)s[f]=0;for(f=0;f<8;f++)s[f]=i[f];for(;64<=o;){for(A(u,s,h,U),f=0;f<64;f++)r[t+f]=n[e+f]^u[f];for(a=1,f=8;f<16;f++)a=a+(255&s[f])|0,s[f]=255&a,a>>>=8;o-=64,t+=64,e+=64}if(0<o)for(A(u,s,h,U),f=0;f<o;f++)r[t+f]=n[e+f]^u[f];return 0}function E(r,t,n,e,o){var i,h,a=new Uint8Array(16),f=new Uint8Array(64);for(h=0;h<16;h++)a[h]=0;for(h=0;h<8;h++)a[h]=e[h];for(;64<=n;){for(A(f,a,o,U),h=0;h<64;h++)r[t+h]=f[h];for(i=1,h=8;h<16;h++)i=i+(255&a[h])|0,a[h]=255&i,i>>>=8;n-=64,t+=64}if(0<n)for(A(f,a,o,U),h=0;h<n;h++)r[t+h]=f[h];return 0}function x(r,t,n,e,o){var i=new Uint8Array(32);_(i,e,o,U);for(var h=new Uint8Array(8),a=0;a<8;a++)h[a]=e[a+16];return E(r,t,n,h,i)}function M(r,t,n,e,o,i,h){var a=new Uint8Array(32);_(a,i,h,U);for(var f=new Uint8Array(8),s=0;s<8;s++)f[s]=i[s+16];return d(r,t,n,e,o,f,a)}var m=function(r){var t,n,e,o,i,h,a,f;this.buffer=new Uint8Array(16),this.r=new Uint16Array(10),this.h=new Uint16Array(10),this.pad=new Uint16Array(8),this.leftover=0,t=255&r[this.fin=0]|(255&r[1])<<8,this.r[0]=8191&t,n=255&r[2]|(255&r[3])<<8,this.r[1]=8191&(t>>>13|n<<3),e=255&r[4]|(255&r[5])<<8,this.r[2]=7939&(n>>>10|e<<6),o=255&r[6]|(255&r[7])<<8,this.r[3]=8191&(e>>>7|o<<9),i=255&r[8]|(255&r[9])<<8,this.r[4]=255&(o>>>4|i<<12),this.r[5]=i>>>1&8190,h=255&r[10]|(255&r[11])<<8,this.r[6]=8191&(i>>>14|h<<2),a=255&r[12]|(255&r[13])<<8,this.r[7]=8065&(h>>>11|a<<5),f=255&r[14]|(255&r[15])<<8,this.r[8]=8191&(a>>>8|f<<8),this.r[9]=f>>>5&127,this.pad[0]=255&r[16]|(255&r[17])<<8,this.pad[1]=255&r[18]|(255&r[19])<<8,this.pad[2]=255&r[20]|(255&r[21])<<8,this.pad[3]=255&r[22]|(255&r[23])<<8,this.pad[4]=255&r[24]|(255&r[25])<<8,this.pad[5]=255&r[26]|(255&r[27])<<8,this.pad[6]=255&r[28]|(255&r[29])<<8,this.pad[7]=255&r[30]|(255&r[31])<<8};function B(r,t,n,e,o,i){var h=new m(i);return h.update(n,e,o),h.finish(r,t),0}function S(r,t,n,e,o,i){var h=new Uint8Array(16);return B(h,0,n,e,o,i),b(r,t,h,0)}function k(r,t,n,e,o){var i;if(n<32)return-1;for(M(r,0,t,0,n,e,o),B(r,16,r,32,n-32,r),i=0;i<16;i++)r[i]=0;return 0}function K(r,t,n,e,o){var i,h=new Uint8Array(32);if(n<32)return-1;if(x(h,0,32,e,o),0!==S(t,16,t,32,n-32,h))return-1;for(M(r,0,t,0,n,e,o),i=0;i<32;i++)r[i]=0;return 0}function Y(r,t){var n;for(n=0;n<16;n++)r[n]=0|t[n]}function L(r){var t,n,e=1;for(t=0;t<16;t++)n=r[t]+e+65535,e=Math.floor(n/65536),r[t]=n-65536*e;r[0]+=e-1+37*(e-1)}function T(r,t,n){for(var e,o=~(n-1),i=0;i<16;i++)e=o&(r[i]^t[i]),r[i]^=e,t[i]^=e}function z(r,t){var n,e,o,i=v(),h=v();for(n=0;n<16;n++)h[n]=t[n];for(L(h),L(h),L(h),e=0;e<2;e++){for(i[0]=h[0]-65517,n=1;n<15;n++)i[n]=h[n]-65535-(i[n-1]>>16&1),i[n-1]&=65535;i[15]=h[15]-32767-(i[14]>>16&1),o=i[15]>>16&1,i[14]&=65535,T(h,i,1-o)}for(n=0;n<16;n++)r[2*n]=255&h[n],r[2*n+1]=h[n]>>8}function R(r,t){var n=new Uint8Array(32),e=new Uint8Array(32);return z(n,r),z(e,t),g(n,0,e,0)}function P(r){var t=new Uint8Array(32);return z(t,r),1&t[0]}function N(r,t){var n;for(n=0;n<16;n++)r[n]=t[2*n]+(t[2*n+1]<<8);r[15]&=32767}function O(r,t,n){for(var e=0;e<16;e++)r[e]=t[e]+n[e]}function C(r,t,n){for(var e=0;e<16;e++)r[e]=t[e]-n[e]}function F(r,t,n){var e,o,i=0,h=0,a=0,f=0,s=0,u=0,c=0,y=0,l=0,w=0,v=0,p=0,b=0,g=0,A=0,_=0,U=0,d=0,E=0,x=0,M=0,m=0,B=0,S=0,k=0,K=0,Y=0,L=0,T=0,z=0,R=0,P=n[0],N=n[1],O=n[2],C=n[3],F=n[4],I=n[5],Z=n[6],G=n[7],q=n[8],D=n[9],V=n[10],X=n[11],j=n[12],H=n[13],J=n[14],Q=n[15];i+=(e=t[0])*P,h+=e*N,a+=e*O,f+=e*C,s+=e*F,u+=e*I,c+=e*Z,y+=e*G,l+=e*q,w+=e*D,v+=e*V,p+=e*X,b+=e*j,g+=e*H,A+=e*J,_+=e*Q,h+=(e=t[1])*P,a+=e*N,f+=e*O,s+=e*C,u+=e*F,c+=e*I,y+=e*Z,l+=e*G,w+=e*q,v+=e*D,p+=e*V,b+=e*X,g+=e*j,A+=e*H,_+=e*J,U+=e*Q,a+=(e=t[2])*P,f+=e*N,s+=e*O,u+=e*C,c+=e*F,y+=e*I,l+=e*Z,w+=e*G,v+=e*q,p+=e*D,b+=e*V,g+=e*X,A+=e*j,_+=e*H,U+=e*J,d+=e*Q,f+=(e=t[3])*P,s+=e*N,u+=e*O,c+=e*C,y+=e*F,l+=e*I,w+=e*Z,v+=e*G,p+=e*q,b+=e*D,g+=e*V,A+=e*X,_+=e*j,U+=e*H,d+=e*J,E+=e*Q,s+=(e=t[4])*P,u+=e*N,c+=e*O,y+=e*C,l+=e*F,w+=e*I,v+=e*Z,p+=e*G,b+=e*q,g+=e*D,A+=e*V,_+=e*X,U+=e*j,d+=e*H,E+=e*J,x+=e*Q,u+=(e=t[5])*P,c+=e*N,y+=e*O,l+=e*C,w+=e*F,v+=e*I,p+=e*Z,b+=e*G,g+=e*q,A+=e*D,_+=e*V,U+=e*X,d+=e*j,E+=e*H,x+=e*J,M+=e*Q,c+=(e=t[6])*P,y+=e*N,l+=e*O,w+=e*C,v+=e*F,p+=e*I,b+=e*Z,g+=e*G,A+=e*q,_+=e*D,U+=e*V,d+=e*X,E+=e*j,x+=e*H,M+=e*J,m+=e*Q,y+=(e=t[7])*P,l+=e*N,w+=e*O,v+=e*C,p+=e*F,b+=e*I,g+=e*Z,A+=e*G,_+=e*q,U+=e*D,d+=e*V,E+=e*X,x+=e*j,M+=e*H,m+=e*J,B+=e*Q,l+=(e=t[8])*P,w+=e*N,v+=e*O,p+=e*C,b+=e*F,g+=e*I,A+=e*Z,_+=e*G,U+=e*q,d+=e*D,E+=e*V,x+=e*X,M+=e*j,m+=e*H,B+=e*J,S+=e*Q,w+=(e=t[9])*P,v+=e*N,p+=e*O,b+=e*C,g+=e*F,A+=e*I,_+=e*Z,U+=e*G,d+=e*q,E+=e*D,x+=e*V,M+=e*X,m+=e*j,B+=e*H,S+=e*J,k+=e*Q,v+=(e=t[10])*P,p+=e*N,b+=e*O,g+=e*C,A+=e*F,_+=e*I,U+=e*Z,d+=e*G,E+=e*q,x+=e*D,M+=e*V,m+=e*X,B+=e*j,S+=e*H,k+=e*J,K+=e*Q,p+=(e=t[11])*P,b+=e*N,g+=e*O,A+=e*C,_+=e*F,U+=e*I,d+=e*Z,E+=e*G,x+=e*q,M+=e*D,m+=e*V,B+=e*X,S+=e*j,k+=e*H,K+=e*J,Y+=e*Q,b+=(e=t[12])*P,g+=e*N,A+=e*O,_+=e*C,U+=e*F,d+=e*I,E+=e*Z,x+=e*G,M+=e*q,m+=e*D,B+=e*V,S+=e*X,k+=e*j,K+=e*H,Y+=e*J,L+=e*Q,g+=(e=t[13])*P,A+=e*N,_+=e*O,U+=e*C,d+=e*F,E+=e*I,x+=e*Z,M+=e*G,m+=e*q,B+=e*D,S+=e*V,k+=e*X,K+=e*j,Y+=e*H,L+=e*J,T+=e*Q,A+=(e=t[14])*P,_+=e*N,U+=e*O,d+=e*C,E+=e*F,x+=e*I,M+=e*Z,m+=e*G,B+=e*q,S+=e*D,k+=e*V,K+=e*X,Y+=e*j,L+=e*H,T+=e*J,z+=e*Q,_+=(e=t[15])*P,h+=38*(d+=e*O),a+=38*(E+=e*C),f+=38*(x+=e*F),s+=38*(M+=e*I),u+=38*(m+=e*Z),c+=38*(B+=e*G),y+=38*(S+=e*q),l+=38*(k+=e*D),w+=38*(K+=e*V),v+=38*(Y+=e*X),p+=38*(L+=e*j),b+=38*(T+=e*H),g+=38*(z+=e*J),A+=38*(R+=e*Q),i=(e=(i+=38*(U+=e*N))+(o=1)+65535)-65536*(o=Math.floor(e/65536)),h=(e=h+o+65535)-65536*(o=Math.floor(e/65536)),a=(e=a+o+65535)-65536*(o=Math.floor(e/65536)),f=(e=f+o+65535)-65536*(o=Math.floor(e/65536)),s=(e=s+o+65535)-65536*(o=Math.floor(e/65536)),u=(e=u+o+65535)-65536*(o=Math.floor(e/65536)),c=(e=c+o+65535)-65536*(o=Math.floor(e/65536)),y=(e=y+o+65535)-65536*(o=Math.floor(e/65536)),l=(e=l+o+65535)-65536*(o=Math.floor(e/65536)),w=(e=w+o+65535)-65536*(o=Math.floor(e/65536)),v=(e=v+o+65535)-65536*(o=Math.floor(e/65536)),p=(e=p+o+65535)-65536*(o=Math.floor(e/65536)),b=(e=b+o+65535)-65536*(o=Math.floor(e/65536)),g=(e=g+o+65535)-65536*(o=Math.floor(e/65536)),A=(e=A+o+65535)-65536*(o=Math.floor(e/65536)),_=(e=_+o+65535)-65536*(o=Math.floor(e/65536)),i=(e=(i+=o-1+37*(o-1))+(o=1)+65535)-65536*(o=Math.floor(e/65536)),h=(e=h+o+65535)-65536*(o=Math.floor(e/65536)),a=(e=a+o+65535)-65536*(o=Math.floor(e/65536)),f=(e=f+o+65535)-65536*(o=Math.floor(e/65536)),s=(e=s+o+65535)-65536*(o=Math.floor(e/65536)),u=(e=u+o+65535)-65536*(o=Math.floor(e/65536)),c=(e=c+o+65535)-65536*(o=Math.floor(e/65536)),y=(e=y+o+65535)-65536*(o=Math.floor(e/65536)),l=(e=l+o+65535)-65536*(o=Math.floor(e/65536)),w=(e=w+o+65535)-65536*(o=Math.floor(e/65536)),v=(e=v+o+65535)-65536*(o=Math.floor(e/65536)),p=(e=p+o+65535)-65536*(o=Math.floor(e/65536)),b=(e=b+o+65535)-65536*(o=Math.floor(e/65536)),g=(e=g+o+65535)-65536*(o=Math.floor(e/65536)),A=(e=A+o+65535)-65536*(o=Math.floor(e/65536)),_=(e=_+o+65535)-65536*(o=Math.floor(e/65536)),i+=o-1+37*(o-1),r[0]=i,r[1]=h,r[2]=a,r[3]=f,r[4]=s,r[5]=u,r[6]=c,r[7]=y,r[8]=l,r[9]=w,r[10]=v,r[11]=p,r[12]=b,r[13]=g,r[14]=A,r[15]=_}function I(r,t){F(r,t,t)}function Z(r,t){var n,e=v();for(n=0;n<16;n++)e[n]=t[n];for(n=253;0<=n;n--)I(e,e),2!==n&&4!==n&&F(e,e,t);for(n=0;n<16;n++)r[n]=e[n]}function G(r,t){var n,e=v();for(n=0;n<16;n++)e[n]=t[n];for(n=250;0<=n;n--)I(e,e),1!==n&&F(e,e,t);for(n=0;n<16;n++)r[n]=e[n]}function q(r,t,n){var e,o,i=new Uint8Array(32),h=new Float64Array(80),a=v(),f=v(),s=v(),u=v(),c=v(),y=v();for(o=0;o<31;o++)i[o]=t[o];for(i[31]=127&t[31]|64,i[0]&=248,N(h,n),o=0;o<16;o++)f[o]=h[o],u[o]=a[o]=s[o]=0;for(a[0]=u[0]=1,o=254;0<=o;--o)T(a,f,e=i[o>>>3]>>>(7&o)&1),T(s,u,e),O(c,a,s),C(a,a,s),O(s,f,u),C(f,f,u),I(u,c),I(y,a),F(a,s,a),F(s,f,c),O(c,a,s),C(a,a,s),I(f,a),C(s,u,y),F(a,s,p),O(a,a,u),F(s,s,a),F(a,u,y),F(u,f,h),I(f,c),T(a,f,e),T(s,u,e);for(o=0;o<16;o++)h[o+16]=a[o],h[o+32]=s[o],h[o+48]=f[o],h[o+64]=u[o];var l=h.subarray(32),w=h.subarray(16);return Z(l,l),F(w,w,l),z(r,w),0}function D(r,t){return q(r,t,n)}function V(r,t){return h(t,32),D(r,t)}function X(r,t,n){var e=new Uint8Array(32);return q(e,n,t),_(r,o,e,U)}m.prototype.blocks=function(r,t,n){for(var e,o,i,h,a,f,s,u,c,y,l,w,v,p,b,g,A,_,U,d=this.fin?0:2048,E=this.h[0],x=this.h[1],M=this.h[2],m=this.h[3],B=this.h[4],S=this.h[5],k=this.h[6],K=this.h[7],Y=this.h[8],L=this.h[9],T=this.r[0],z=this.r[1],R=this.r[2],P=this.r[3],N=this.r[4],O=this.r[5],C=this.r[6],F=this.r[7],I=this.r[8],Z=this.r[9];16<=n;)y=c=0,y+=(E+=8191&(e=255&r[t+0]|(255&r[t+1])<<8))*T,y+=(x+=8191&(e>>>13|(o=255&r[t+2]|(255&r[t+3])<<8)<<3))*(5*Z),y+=(M+=8191&(o>>>10|(i=255&r[t+4]|(255&r[t+5])<<8)<<6))*(5*I),y+=(m+=8191&(i>>>7|(h=255&r[t+6]|(255&r[t+7])<<8)<<9))*(5*F),c=(y+=(B+=8191&(h>>>4|(a=255&r[t+8]|(255&r[t+9])<<8)<<12))*(5*C))>>>13,y&=8191,y+=(S+=a>>>1&8191)*(5*O),y+=(k+=8191&(a>>>14|(f=255&r[t+10]|(255&r[t+11])<<8)<<2))*(5*N),y+=(K+=8191&(f>>>11|(s=255&r[t+12]|(255&r[t+13])<<8)<<5))*(5*P),y+=(Y+=8191&(s>>>8|(u=255&r[t+14]|(255&r[t+15])<<8)<<8))*(5*R),l=c+=(y+=(L+=u>>>5|d)*(5*z))>>>13,l+=E*z,l+=x*T,l+=M*(5*Z),l+=m*(5*I),c=(l+=B*(5*F))>>>13,l&=8191,l+=S*(5*C),l+=k*(5*O),l+=K*(5*N),l+=Y*(5*P),c+=(l+=L*(5*R))>>>13,l&=8191,w=c,w+=E*R,w+=x*z,w+=M*T,w+=m*(5*Z),c=(w+=B*(5*I))>>>13,w&=8191,w+=S*(5*F),w+=k*(5*C),w+=K*(5*O),w+=Y*(5*N),v=c+=(w+=L*(5*P))>>>13,v+=E*P,v+=x*R,v+=M*z,v+=m*T,c=(v+=B*(5*Z))>>>13,v&=8191,v+=S*(5*I),v+=k*(5*F),v+=K*(5*C),v+=Y*(5*O),p=c+=(v+=L*(5*N))>>>13,p+=E*N,p+=x*P,p+=M*R,p+=m*z,c=(p+=B*T)>>>13,p&=8191,p+=S*(5*Z),p+=k*(5*I),p+=K*(5*F),p+=Y*(5*C),b=c+=(p+=L*(5*O))>>>13,b+=E*O,b+=x*N,b+=M*P,b+=m*R,c=(b+=B*z)>>>13,b&=8191,b+=S*T,b+=k*(5*Z),b+=K*(5*I),b+=Y*(5*F),g=c+=(b+=L*(5*C))>>>13,g+=E*C,g+=x*O,g+=M*N,g+=m*P,c=(g+=B*R)>>>13,g&=8191,g+=S*z,g+=k*T,g+=K*(5*Z),g+=Y*(5*I),A=c+=(g+=L*(5*F))>>>13,A+=E*F,A+=x*C,A+=M*O,A+=m*N,c=(A+=B*P)>>>13,A&=8191,A+=S*R,A+=k*z,A+=K*T,A+=Y*(5*Z),_=c+=(A+=L*(5*I))>>>13,_+=E*I,_+=x*F,_+=M*C,_+=m*O,c=(_+=B*N)>>>13,_&=8191,_+=S*P,_+=k*R,_+=K*z,_+=Y*T,U=c+=(_+=L*(5*Z))>>>13,U+=E*Z,U+=x*I,U+=M*F,U+=m*C,c=(U+=B*O)>>>13,U&=8191,U+=S*N,U+=k*P,U+=K*R,U+=Y*z,E=y=8191&(c=(c=((c+=(U+=L*T)>>>13)<<2)+c|0)+(y&=8191)|0),x=l+=c>>>=13,M=w&=8191,m=v&=8191,B=p&=8191,S=b&=8191,k=g&=8191,K=A&=8191,Y=_&=8191,L=U&=8191,t+=16,n-=16;this.h[0]=E,this.h[1]=x,this.h[2]=M,this.h[3]=m,this.h[4]=B,this.h[5]=S,this.h[6]=k,this.h[7]=K,this.h[8]=Y,this.h[9]=L},m.prototype.finish=function(r,t){var n,e,o,i,h=new Uint16Array(10);if(this.leftover){for(i=this.leftover,this.buffer[i++]=1;i<16;i++)this.buffer[i]=0;this.fin=1,this.blocks(this.buffer,0,16)}for(n=this.h[1]>>>13,this.h[1]&=8191,i=2;i<10;i++)this.h[i]+=n,n=this.h[i]>>>13,this.h[i]&=8191;for(this.h[0]+=5*n,n=this.h[0]>>>13,this.h[0]&=8191,this.h[1]+=n,n=this.h[1]>>>13,this.h[1]&=8191,this.h[2]+=n,h[0]=this.h[0]+5,n=h[0]>>>13,h[0]&=8191,i=1;i<10;i++)h[i]=this.h[i]+n,n=h[i]>>>13,h[i]&=8191;for(h[9]-=8192,e=(1^n)-1,i=0;i<10;i++)h[i]&=e;for(e=~e,i=0;i<10;i++)this.h[i]=this.h[i]&e|h[i];for(this.h[0]=65535&(this.h[0]|this.h[1]<<13),this.h[1]=65535&(this.h[1]>>>3|this.h[2]<<10),this.h[2]=65535&(this.h[2]>>>6|this.h[3]<<7),this.h[3]=65535&(this.h[3]>>>9|this.h[4]<<4),this.h[4]=65535&(this.h[4]>>>12|this.h[5]<<1|this.h[6]<<14),this.h[5]=65535&(this.h[6]>>>2|this.h[7]<<11),this.h[6]=65535&(this.h[7]>>>5|this.h[8]<<8),this.h[7]=65535&(this.h[8]>>>8|this.h[9]<<5),o=this.h[0]+this.pad[0],this.h[0]=65535&o,i=1;i<8;i++)o=(this.h[i]+this.pad[i]|0)+(o>>>16)|0,this.h[i]=65535&o;r[t+0]=this.h[0]>>>0&255,r[t+1]=this.h[0]>>>8&255,r[t+2]=this.h[1]>>>0&255,r[t+3]=this.h[1]>>>8&255,r[t+4]=this.h[2]>>>0&255,r[t+5]=this.h[2]>>>8&255,r[t+6]=this.h[3]>>>0&255,r[t+7]=this.h[3]>>>8&255,r[t+8]=this.h[4]>>>0&255,r[t+9]=this.h[4]>>>8&255,r[t+10]=this.h[5]>>>0&255,r[t+11]=this.h[5]>>>8&255,r[t+12]=this.h[6]>>>0&255,r[t+13]=this.h[6]>>>8&255,r[t+14]=this.h[7]>>>0&255,r[t+15]=this.h[7]>>>8&255},m.prototype.update=function(r,t,n){var e,o;if(this.leftover){for(n<(o=16-this.leftover)&&(o=n),e=0;e<o;e++)this.buffer[this.leftover+e]=r[t+e];if(n-=o,t+=o,this.leftover+=o,this.leftover<16)return;this.blocks(this.buffer,0,16),this.leftover=0}if(16<=n&&(o=n-n%16,this.blocks(r,t,o),t+=o,n-=o),n){for(e=0;e<n;e++)this.buffer[this.leftover+e]=r[t+e];this.leftover+=n}};var j=k,H=K;var J=[1116352408,3609767458,1899447441,602891725,3049323471,3964484399,3921009573,2173295548,961987163,4081628472,1508970993,3053834265,2453635748,2937671579,2870763221,3664609560,3624381080,2734883394,310598401,1164996542,607225278,1323610764,1426881987,3590304994,1925078388,4068182383,2162078206,991336113,2614888103,633803317,3248222580,3479774868,3835390401,2666613458,4022224774,944711139,264347078,2341262773,604807628,2007800933,770255983,1495990901,1249150122,1856431235,1555081692,3175218132,1996064986,2198950837,2554220882,3999719339,2821834349,766784016,2952996808,2566594879,3210313671,3203337956,3336571891,1034457026,3584528711,2466948901,113926993,3758326383,338241895,168717936,666307205,1188179964,773529912,1546045734,1294757372,1522805485,1396182291,2643833823,1695183700,2343527390,1986661051,1014477480,2177026350,1206759142,2456956037,344077627,2730485921,1290863460,2820302411,3158454273,3259730800,3505952657,3345764771,106217008,3516065817,3606008344,3600352804,1432725776,4094571909,1467031594,275423344,851169720,430227734,3100823752,506948616,1363258195,659060556,3750685593,883997877,3785050280,958139571,3318307427,1322822218,3812723403,1537002063,2003034995,1747873779,3602036899,1955562222,1575990012,2024104815,1125592928,2227730452,2716904306,2361852424,442776044,2428436474,593698344,2756734187,3733110249,3204031479,2999351573,3329325298,3815920427,3391569614,3928383900,3515267271,566280711,3940187606,3454069534,4118630271,4000239992,116418474,1914138554,174292421,2731055270,289380356,3203993006,460393269,320620315,685471733,587496836,852142971,1086792851,1017036298,365543100,1126000580,2618297676,1288033470,3409855158,1501505948,4234509866,1607167915,987167468,1816402316,1246189591];function Q(r,t,n,e){for(var o,i,h,a,f,s,u,c,y,l,w,v,p,b,g,A,_,U,d,E,x,M,m,B,S=new Int32Array(16),k=new Int32Array(16),K=r[0],Y=r[1],L=r[2],T=r[3],z=r[4],R=r[5],P=r[6],N=r[7],O=t[0],C=t[1],F=t[2],I=t[3],Z=t[4],G=t[5],q=t[6],D=t[7],V=0;128<=e;){for(_=0;_<16;_++)U=8*_+V,S[_]=n[U+0]<<24|n[U+1]<<16|n[U+2]<<8|n[U+3],k[_]=n[U+4]<<24|n[U+5]<<16|n[U+6]<<8|n[U+7];for(_=0;_<80;_++)if(o=Y,i=L,h=T,c=C,y=F,l=I,x=65535&(E=D),M=E>>>16,m=65535&(d=N),B=d>>>16,x+=65535&(E=((w=Z)>>>14|(a=z)<<18)^(Z>>>18|z<<14)^(z>>>9|Z<<23)),M+=E>>>16,m+=65535&(d=(z>>>14|Z<<18)^(z>>>18|Z<<14)^(Z>>>9|z<<23)),B+=d>>>16,x+=65535&(E=Z&(v=G)^~Z&(p=q)),M+=E>>>16,m+=65535&(d=z&(f=R)^~z&(s=P)),B+=d>>>16,d=J[2*_],x+=65535&(E=J[2*_+1]),M+=E>>>16,m+=65535&d,B+=d>>>16,d=S[_%16],M+=(E=k[_%16])>>>16,m+=65535&d,B+=d>>>16,m+=(M+=(x+=65535&E)>>>16)>>>16,x=65535&(E=A=65535&x|M<<16),M=E>>>16,m=65535&(d=g=65535&m|(B+=m>>>16)<<16),B=d>>>16,x+=65535&(E=(O>>>28|K<<4)^(K>>>2|O<<30)^(K>>>7|O<<25)),M+=E>>>16,m+=65535&(d=(K>>>28|O<<4)^(O>>>2|K<<30)^(O>>>7|K<<25)),B+=d>>>16,M+=(E=O&C^O&F^C&F)>>>16,m+=65535&(d=K&Y^K&L^Y&L),B+=d>>>16,u=65535&(m+=(M+=(x+=65535&E)>>>16)>>>16)|(B+=m>>>16)<<16,b=65535&x|M<<16,x=65535&(E=l),M=E>>>16,m=65535&(d=h),B=d>>>16,M+=(E=A)>>>16,m+=65535&(d=g),B+=d>>>16,Y=K,L=o,T=i,z=h=65535&(m+=(M+=(x+=65535&E)>>>16)>>>16)|(B+=m>>>16)<<16,R=a,P=f,N=s,K=u,C=O,F=c,I=y,Z=l=65535&x|M<<16,G=w,q=v,D=p,O=b,_%16==15)for(U=0;U<16;U++)d=S[U],x=65535&(E=k[U]),M=E>>>16,m=65535&d,B=d>>>16,d=S[(U+9)%16],x+=65535&(E=k[(U+9)%16]),M+=E>>>16,m+=65535&d,B+=d>>>16,g=S[(U+1)%16],x+=65535&(E=((A=k[(U+1)%16])>>>1|g<<31)^(A>>>8|g<<24)^(A>>>7|g<<25)),M+=E>>>16,m+=65535&(d=(g>>>1|A<<31)^(g>>>8|A<<24)^g>>>7),B+=d>>>16,g=S[(U+14)%16],M+=(E=((A=k[(U+14)%16])>>>19|g<<13)^(g>>>29|A<<3)^(A>>>6|g<<26))>>>16,m+=65535&(d=(g>>>19|A<<13)^(A>>>29|g<<3)^g>>>6),B+=d>>>16,B+=(m+=(M+=(x+=65535&E)>>>16)>>>16)>>>16,S[U]=65535&m|B<<16,k[U]=65535&x|M<<16;x=65535&(E=O),M=E>>>16,m=65535&(d=K),B=d>>>16,d=r[0],M+=(E=t[0])>>>16,m+=65535&d,B+=d>>>16,B+=(m+=(M+=(x+=65535&E)>>>16)>>>16)>>>16,r[0]=K=65535&m|B<<16,t[0]=O=65535&x|M<<16,x=65535&(E=C),M=E>>>16,m=65535&(d=Y),B=d>>>16,d=r[1],M+=(E=t[1])>>>16,m+=65535&d,B+=d>>>16,B+=(m+=(M+=(x+=65535&E)>>>16)>>>16)>>>16,r[1]=Y=65535&m|B<<16,t[1]=C=65535&x|M<<16,x=65535&(E=F),M=E>>>16,m=65535&(d=L),B=d>>>16,d=r[2],M+=(E=t[2])>>>16,m+=65535&d,B+=d>>>16,B+=(m+=(M+=(x+=65535&E)>>>16)>>>16)>>>16,r[2]=L=65535&m|B<<16,t[2]=F=65535&x|M<<16,x=65535&(E=I),M=E>>>16,m=65535&(d=T),B=d>>>16,d=r[3],M+=(E=t[3])>>>16,m+=65535&d,B+=d>>>16,B+=(m+=(M+=(x+=65535&E)>>>16)>>>16)>>>16,r[3]=T=65535&m|B<<16,t[3]=I=65535&x|M<<16,x=65535&(E=Z),M=E>>>16,m=65535&(d=z),B=d>>>16,d=r[4],M+=(E=t[4])>>>16,m+=65535&d,B+=d>>>16,B+=(m+=(M+=(x+=65535&E)>>>16)>>>16)>>>16,r[4]=z=65535&m|B<<16,t[4]=Z=65535&x|M<<16,x=65535&(E=G),M=E>>>16,m=65535&(d=R),B=d>>>16,d=r[5],M+=(E=t[5])>>>16,m+=65535&d,B+=d>>>16,B+=(m+=(M+=(x+=65535&E)>>>16)>>>16)>>>16,r[5]=R=65535&m|B<<16,t[5]=G=65535&x|M<<16,x=65535&(E=q),M=E>>>16,m=65535&(d=P),B=d>>>16,d=r[6],M+=(E=t[6])>>>16,m+=65535&d,B+=d>>>16,B+=(m+=(M+=(x+=65535&E)>>>16)>>>16)>>>16,r[6]=P=65535&m|B<<16,t[6]=q=65535&x|M<<16,x=65535&(E=D),M=E>>>16,m=65535&(d=N),B=d>>>16,d=r[7],M+=(E=t[7])>>>16,m+=65535&d,B+=d>>>16,B+=(m+=(M+=(x+=65535&E)>>>16)>>>16)>>>16,r[7]=N=65535&m|B<<16,t[7]=D=65535&x|M<<16,V+=128,e-=128}return e}function W(r,t,n){var e,o=new Int32Array(8),i=new Int32Array(8),h=new Uint8Array(256),a=n;for(o[0]=1779033703,o[1]=3144134277,o[2]=1013904242,o[3]=2773480762,o[4]=1359893119,o[5]=2600822924,o[6]=528734635,o[7]=1541459225,i[0]=4089235720,i[1]=2227873595,i[2]=4271175723,i[3]=1595750129,i[4]=2917565137,i[5]=725511199,i[6]=4215389547,i[7]=327033209,Q(o,i,t,n),n%=128,e=0;e<n;e++)h[e]=t[a-n+e];for(h[n]=128,h[(n=256-128*(n<112?1:0))-9]=0,f(h,n-8,a/536870912|0,a<<3),Q(o,i,h,n),e=0;e<8;e++)f(r,8*e,o[e],i[e]);return 0}function $(r,t){var n=v(),e=v(),o=v(),i=v(),h=v(),a=v(),f=v(),s=v(),u=v();C(n,r[1],r[0]),C(u,t[1],t[0]),F(n,n,u),O(e,r[0],r[1]),O(u,t[0],t[1]),F(e,e,u),F(o,r[3],t[3]),F(o,o,y),F(i,r[2],t[2]),O(i,i,i),C(h,e,n),C(a,i,o),O(f,i,o),O(s,e,n),F(r[0],h,a),F(r[1],s,f),F(r[2],f,a),F(r[3],h,s)}function rr(r,t,n){var e;for(e=0;e<4;e++)T(r[e],t[e],n)}function tr(r,t){var n=v(),e=v(),o=v();Z(o,t[2]),F(n,t[0],o),F(e,t[1],o),z(r,e),r[31]^=P(n)<<7}function nr(r,t,n){var e,o;for(Y(r[0],s),Y(r[1],u),Y(r[2],u),Y(r[3],s),o=255;0<=o;--o)rr(r,t,e=n[o/8|0]>>(7&o)&1),$(t,r),$(r,r),rr(r,t,e)}function er(r,t){var n=[v(),v(),v(),v()];Y(n[0],e),Y(n[1],a),Y(n[2],u),F(n[3],e,a),nr(r,n,t)}function or(r,t,n){var e,o=new Uint8Array(64),i=[v(),v(),v(),v()];for(n||h(t,32),W(o,t,32),o[0]&=248,o[31]&=127,o[31]|=64,er(i,o),tr(r,i),e=0;e<32;e++)t[e+32]=r[e];return 0}var ir=new Float64Array([237,211,245,92,26,99,18,88,214,156,247,162,222,249,222,20,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,16]);function hr(r,t){var n,e,o,i;for(e=63;32<=e;--e){for(n=0,o=e-32,i=e-12;o<i;++o)t[o]+=n-16*t[e]*ir[o-(e-32)],n=Math.floor((t[o]+128)/256),t[o]-=256*n;t[o]+=n,t[e]=0}for(o=n=0;o<32;o++)t[o]+=n-(t[31]>>4)*ir[o],n=t[o]>>8,t[o]&=255;for(o=0;o<32;o++)t[o]-=n*ir[o];for(e=0;e<32;e++)t[e+1]+=t[e]>>8,r[e]=255&t[e]}function ar(r){var t,n=new Float64Array(64);for(t=0;t<64;t++)n[t]=r[t];for(t=0;t<64;t++)r[t]=0;hr(r,n)}function fr(r,t,n,e){var o,i,h=new Uint8Array(64),a=new Uint8Array(64),f=new Uint8Array(64),s=new Float64Array(64),u=[v(),v(),v(),v()];W(h,e,32),h[0]&=248,h[31]&=127,h[31]|=64;var c=n+64;for(o=0;o<n;o++)r[64+o]=t[o];for(o=0;o<32;o++)r[32+o]=h[32+o];for(W(f,r.subarray(32),n+32),ar(f),er(u,f),tr(r,u),o=32;o<64;o++)r[o]=e[o];for(W(a,r,n+64),ar(a),o=0;o<64;o++)s[o]=0;for(o=0;o<32;o++)s[o]=f[o];for(o=0;o<32;o++)for(i=0;i<32;i++)s[o+i]+=a[o]*h[i];return hr(r.subarray(32),s),c}function sr(r,t,n,e){var o,i=new Uint8Array(32),h=new Uint8Array(64),a=[v(),v(),v(),v()],f=[v(),v(),v(),v()];if(n<64)return-1;if(function(r,t){var n=v(),e=v(),o=v(),i=v(),h=v(),a=v(),f=v();if(Y(r[2],u),N(r[1],t),I(o,r[1]),F(i,o,c),C(o,o,r[2]),O(i,r[2],i),I(h,i),I(a,h),F(f,a,h),F(n,f,o),F(n,n,i),G(n,n),F(n,n,o),F(n,n,i),F(n,n,i),F(r[0],n,i),I(e,r[0]),F(e,e,i),R(e,o)&&F(r[0],r[0],l),I(e,r[0]),F(e,e,i),R(e,o))return 1;P(r[0])===t[31]>>7&&C(r[0],s,r[0]),F(r[3],r[0],r[1])}(f,e))return-1;for(o=0;o<n;o++)r[o]=t[o];for(o=0;o<32;o++)r[o+32]=e[o];if(W(h,r,n),ar(h),nr(a,f,h),er(f,t.subarray(32)),$(a,f),tr(i,a),n-=64,g(t,0,i,0)){for(o=0;o<n;o++)r[o]=0;return-1}for(o=0;o<n;o++)r[o]=t[o+64];return n}function ur(r,t){if(32!==r.length)throw new Error("bad key size");if(24!==t.length)throw new Error("bad nonce size")}function cr(){for(var r=0;r<arguments.length;r++)if(!(arguments[r]instanceof Uint8Array))throw new TypeError("unexpected type, use Uint8Array")}function yr(r){for(var t=0;t<r.length;t++)r[t]=0}i.lowlevel={crypto_core_hsalsa20:_,crypto_stream_xor:M,crypto_stream:x,crypto_stream_salsa20_xor:d,crypto_stream_salsa20:E,crypto_onetimeauth:B,crypto_onetimeauth_verify:S,crypto_verify_16:b,crypto_verify_32:g,crypto_secretbox:k,crypto_secretbox_open:K,crypto_scalarmult:q,crypto_scalarmult_base:D,crypto_box_beforenm:X,crypto_box_afternm:j,crypto_box:function(r,t,n,e,o,i){var h=new Uint8Array(32);return X(h,o,i),j(r,t,n,e,h)},crypto_box_open:function(r,t,n,e,o,i){var h=new Uint8Array(32);return X(h,o,i),H(r,t,n,e,h)},crypto_box_keypair:V,crypto_hash:W,crypto_sign:fr,crypto_sign_keypair:or,crypto_sign_open:sr,crypto_secretbox_KEYBYTES:32,crypto_secretbox_NONCEBYTES:24,crypto_secretbox_ZEROBYTES:32,crypto_secretbox_BOXZEROBYTES:16,crypto_scalarmult_BYTES:32,crypto_scalarmult_SCALARBYTES:32,crypto_box_PUBLICKEYBYTES:32,crypto_box_SECRETKEYBYTES:32,crypto_box_BEFORENMBYTES:32,crypto_box_NONCEBYTES:24,crypto_box_ZEROBYTES:32,crypto_box_BOXZEROBYTES:16,crypto_sign_BYTES:64,crypto_sign_PUBLICKEYBYTES:32,crypto_sign_SECRETKEYBYTES:64,crypto_sign_SEEDBYTES:32,crypto_hash_BYTES:64,gf:v,D:c,L:ir,pack25519:z,unpack25519:N,M:F,A:O,S:I,Z:C,pow2523:G,add:$,set25519:Y,modL:hr,scalarmult:nr,scalarbase:er},i.randomBytes=function(r){var t=new Uint8Array(r);return h(t,r),t},i.secretbox=function(r,t,n){cr(r,t,n),ur(n,t);for(var e=new Uint8Array(32+r.length),o=new Uint8Array(e.length),i=0;i<r.length;i++)e[i+32]=r[i];return k(o,e,e.length,t,n),o.subarray(16)},i.secretbox.open=function(r,t,n){cr(r,t,n),ur(n,t);for(var e=new Uint8Array(16+r.length),o=new Uint8Array(e.length),i=0;i<r.length;i++)e[i+16]=r[i];return e.length<32||0!==K(o,e,e.length,t,n)?null:o.subarray(32)},i.secretbox.keyLength=32,i.secretbox.nonceLength=24,i.secretbox.overheadLength=16,i.scalarMult=function(r,t){if(cr(r,t),32!==r.length)throw new Error("bad n size");if(32!==t.length)throw new Error("bad p size");var n=new Uint8Array(32);return q(n,r,t),n},i.scalarMult.base=function(r){if(cr(r),32!==r.length)throw new Error("bad n size");var t=new Uint8Array(32);return D(t,r),t},i.scalarMult.scalarLength=32,i.scalarMult.groupElementLength=32,i.box=function(r,t,n,e){var o=i.box.before(n,e);return i.secretbox(r,t,o)},i.box.before=function(r,t){cr(r,t),function(r,t){if(32!==r.length)throw new Error("bad public key size");if(32!==t.length)throw new Error("bad secret key size")}(r,t);var n=new Uint8Array(32);return X(n,r,t),n},i.box.after=i.secretbox,i.box.open=function(r,t,n,e){var o=i.box.before(n,e);return i.secretbox.open(r,t,o)},i.box.open.after=i.secretbox.open,i.box.keyPair=function(){var r=new Uint8Array(32),t=new Uint8Array(32);return V(r,t),{publicKey:r,secretKey:t}},i.box.keyPair.fromSecretKey=function(r){if(cr(r),32!==r.length)throw new Error("bad secret key size");var t=new Uint8Array(32);return D(t,r),{publicKey:t,secretKey:new Uint8Array(r)}},i.box.publicKeyLength=32,i.box.secretKeyLength=32,i.box.sharedKeyLength=32,i.box.nonceLength=24,i.box.overheadLength=i.secretbox.overheadLength,i.sign=function(r,t){if(cr(r,t),64!==t.length)throw new Error("bad secret key size");var n=new Uint8Array(64+r.length);return fr(n,r,r.length,t),n},i.sign.open=function(r,t){if(cr(r,t),32!==t.length)throw new Error("bad public key size");var n=new Uint8Array(r.length),e=sr(n,r,r.length,t);if(e<0)return null;for(var o=new Uint8Array(e),i=0;i<o.length;i++)o[i]=n[i];return o},i.sign.detached=function(r,t){for(var n=i.sign(r,t),e=new Uint8Array(64),o=0;o<e.length;o++)e[o]=n[o];return e},i.sign.detached.verify=function(r,t,n){if(cr(r,t,n),64!==t.length)throw new Error("bad signature size");if(32!==n.length)throw new Error("bad public key size");var e,o=new Uint8Array(64+r.length),i=new Uint8Array(64+r.length);for(e=0;e<64;e++)o[e]=t[e];for(e=0;e<r.length;e++)o[e+64]=r[e];return 0<=sr(i,o,o.length,n)},i.sign.keyPair=function(){var r=new Uint8Array(32),t=new Uint8Array(64);return or(r,t),{publicKey:r,secretKey:t}},i.sign.keyPair.fromSecretKey=function(r){if(cr(r),64!==r.length)throw new Error("bad secret key size");for(var t=new Uint8Array(32),n=0;n<t.length;n++)t[n]=r[32+n];return{publicKey:t,secretKey:new Uint8Array(r)}},i.sign.keyPair.fromSeed=function(r){if(cr(r),32!==r.length)throw new Error("bad seed size");for(var t=new Uint8Array(32),n=new Uint8Array(64),e=0;e<32;e++)n[e]=r[e];return or(t,n,!0),{publicKey:t,secretKey:n}},i.sign.publicKeyLength=32,i.sign.secretKeyLength=64,i.sign.seedLength=32,i.sign.signatureLength=64,i.hash=function(r){cr(r);var t=new Uint8Array(64);return W(t,r,r.length),t},i.hash.hashLength=64,i.verify=function(r,t){return cr(r,t),0!==r.length&&0!==t.length&&(r.length===t.length&&0===w(r,0,t,0,r.length))},i.setPRNG=function(r){h=r},function(){var o="undefined"!=typeof self?self.crypto||self.msCrypto:null;if(o&&o.getRandomValues){i.setPRNG(function(r,t){var n,e=new Uint8Array(t);for(n=0;n<t;n+=65536)o.getRandomValues(e.subarray(n,n+Math.min(t-n,65536)));for(n=0;n<t;n++)r[n]=e[n];yr(e)})}else"undefined"!=typeof require&&(o=require("crypto"))&&o.randomBytes&&i.setPRNG(function(r,t){var n,e=o.randomBytes(t);for(n=0;n<t;n++)r[n]=e[n];yr(e)})}()}("undefined"!=typeof module&&module.exports?module.exports:self.nacl=self.nacl||{});
  return module.exports;
})();

/* tweetnacl 自动探测 PRNG 可能失败，显式接到 WebCrypto（Node / Workers 均可用）。 */
nacl.setPRNG((buf, n) => {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < n; i++) buf[i] = bytes[i];
});

/**
 * libsodium crypto_box_seal 等价实现 —— GitHub Secrets API 要求的格式。
 *
 * 权威构造（libsodium src/libsodium/crypto_box/crypto_box_seal.c）:
 *   esk, epk = 一次性 X25519 密钥对
 *   nonce    = crypto_generichash(epk || pk, outlen=24)   ← BLAKE2b-24，不是 SHA-512
 *   sealed   = epk(32) || crypto_box_easy(msg, nonce, pk, esk)
 *
 * ⚠️ 网上多数教程写成 SHA512(epk||pk)[0:24]，那是错的，会造成解密失败。
 *
 * @param {Uint8Array} pk  收件方 32 字节 X25519 公钥（GitHub 的 key）
 * @param {Uint8Array} msg 明文
 * @returns {Uint8Array} sealed box 密文
 */
function sealForGitHub(pk, msg) {
  if (!(pk instanceof Uint8Array) || pk.length !== 32) throw new Error('sealForGitHub: 公钥必须是 32 字节 Uint8Array');
  const ephemeral = nacl.box.keyPair();
  const both = new Uint8Array(64);
  both.set(ephemeral.publicKey, 0);
  both.set(pk, 32);
  // BLAKE2b，输出长度 24 字节 = crypto_box_NONCEBYTES
  const nonce = blakejs.blake2b(both, undefined, 24);
  const ct = nacl.box(msg, nonce, pk, ephemeral.secretKey);
  const out = new Uint8Array(32 + ct.length);
  out.set(ephemeral.publicKey, 0);
  out.set(ct, 32);
  return out;
}
/* ============ /VENDOR ============ */

/* ==================== SSH 迷你客户端（浏览器内终端用） ====================
 * 纯 JS 最小 SSH-2 客户端，供「终端」按钮经 Worker 与 VPS 建立交互式 SSH 会话。
 * 只依赖 WebCrypto 与上方 vendored tweetnacl（ed25519 / x25519）。
 *
 * 算法支持：
 *   KEX：       curve25519-sha256、ecdh-sha2-nistp256
 *   加密：      aes128-gcm@openssh.com、aes256-gcm@openssh.com（AEAD，无独立 MAC）
 *   主机密钥：  ssh-ed25519 / ecdsa-sha2-nistp256 / rsa-sha2-512 / rsa-sha2-256 / ssh-rsa（全部验签）
 *   认证：      password / publickey（OpenSSH 私钥格式 ed25519/rsa/ecdsa；PEM PKCS#1/PKCS#8 RSA）；
 *             password 被服务器禁用时自动降级 keyboard-interactive（RFC 4256，密码回答交互提示）
 *   严格 KEX：  kex-strict-c/s-v00@openssh.com（防 Terrapin 前缀截断攻击）
 *
 * 交互式会话：pty-req + shell + window-change，通道层带窗口流量控制。
 */
const SSH = (() => {
  const td = new TextDecoder();
  const te2 = new TextEncoder();

  /* ---- 缓冲区读写 ---- */
  class Writer {
    constructor() { this.parts = []; this.len = 0; }
    raw(u8) { const b = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8); this.parts.push(b); this.len += b.length; return this; }
    u8(v) { return this.raw(Uint8Array.of(v & 0xff)); }
    u32(v) { return this.raw(Uint8Array.of((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)); }
    bool(v) { return this.u8(v ? 1 : 0); }
    str(s) { const b = typeof s === 'string' ? te2.encode(s) : s; return this.u32(b.length).raw(b); }
    /* mpint：正整数大端，去前导零；最高位为 1 时补 0x00（RFC 4251 §5） */
    mpint(u8) {
      let b = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
      let i = 0;
      while (i < b.length - 1 && b[i] === 0) i++;
      b = b.slice(i);
      if (b.length === 0) b = Uint8Array.of(0);
      if (b[0] & 0x80) { const n = new Uint8Array(b.length + 1); n.set(b, 1); b = n; }
      return this.str(b);
    }
    bytes() {
      const out = new Uint8Array(this.len);
      let o = 0;
      for (const p of this.parts) { out.set(p, o); o += p.length; }
      return out;
    }
  }

  class Reader {
    constructor(u8) { this.b = u8; this.p = 0; }
    u8() { return this.b[this.p++]; }
    u32() { const v = ((this.b[this.p] << 24) | (this.b[this.p + 1] << 16) | (this.b[this.p + 2] << 8) | this.b[this.p + 3]) >>> 0; this.p += 4; return v; }
    bytes(n) { const s = this.b.slice(this.p, this.p + n); this.p += n; return s; }
    str() { return this.bytes(this.u32()); }
    text() { return td.decode(this.str()); }
    bool() { return this.u8() !== 0; }
    /* mpint → 无符号大端字节（去掉可能的 0x00 填充） */
    mpint() { const b = this.str(); if (b.length && b[0] === 0) return b.slice(1); return b; }
  }

  const cat = (...arrs) => {
    let n = 0;
    for (const a of arrs) n += a.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  };

  /* ---- 哈希 / AES-GCM ---- */
  async function digest(name, data) { return new Uint8Array(await crypto.subtle.digest(name, data)); }
  const sha256 = (d) => digest('SHA-256', d);
  async function importAesKey(raw) { return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); }

  /* GCM 的 12 字节 IV：前 4 字节固定，后 8 字节为大端调用计数器，每包 +1（RFC 5647 §7.1） */
  function incIv(iv) {
    const out = iv.slice();
    for (let i = 11; i >= 4; i--) { out[i] = (out[i] + 1) & 0xff; if (out[i] !== 0) break; }
    return out;
  }

  /* ---- base64url / JWK 辅助（WebCrypto 用 JWK 导入最省事，免拼 DER） ---- */
  function b64urlBytes(u8) {
    let s = '';
    for (const b of u8) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64uToBytes(s) {
    const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  /* 无符号大端整数 → base64url（去前导零） */
  const jwkInt = (u8) => {
    let i = 0;
    while (i < u8.length - 1 && u8[i] === 0) i++;
    return b64urlBytes(u8.slice(i));
  };
  function bytesToBig(u8) { let n = 0n; for (const b of u8) n = (n << 8n) | BigInt(b); return n; }
  function bigToBytes(n) {
    if (n === 0n) return Uint8Array.of(0);
    let hex = n.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  /* RSA 私钥 JWK 需完整分量（含 CRT 参数），dp/dq 由 d、p、q 推出 */
  function rsaJwk(k) {
    const dBig = bytesToBig(k.d); const pBig = bytesToBig(k.p); const qBig = bytesToBig(k.q);
    return {
      kty: 'RSA',
      n: jwkInt(k.n), e: jwkInt(k.e), d: jwkInt(k.d),
      p: jwkInt(k.p), q: jwkInt(k.q),
      dp: jwkInt(bigToBytes(dBig % (pBig - 1n))),
      dq: jwkInt(bigToBytes(dBig % (qBig - 1n))),
      qi: jwkInt(k.qi),
    };
  }

  /* ---- 私钥文件解析 ---- */
  function parsePem(pem) {
    const m = String(pem).match(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]+?)-----END \1-----/);
    if (!m) throw new Error('无法识别的私钥格式');
    const bin = atob(m[2].replace(/\s+/g, ''));
    const der = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
    return { label: m[1], der };
  }

  /* OpenSSH 私钥格式（openssh-key-v1） */
  function parseOpensshPrivateKey(pem) {
    const { label, der } = parsePem(pem);
    if (label !== 'OPENSSH PRIVATE KEY') throw new Error(`暂不支持的私钥类型：${label}（请用 ssh-keygen 生成的 OPENSSH 格式）`);
    const r0 = new Reader(der);
    if (td.decode(r0.bytes(14)) !== 'openssh-key-v1' || r0.u8() !== 0) throw new Error('私钥格式损坏（magic 不匹配）');
    const cipherName = r0.text();
    const kdfName = r0.text();
    r0.str(); // kdfoptions
    if (r0.u32() !== 1) throw new Error('仅支持单私钥文件');
    r0.str(); // 公钥部分（忽略）
    if (cipherName !== 'none' || kdfName !== 'none') {
      throw new Error('暂不支持带口令加密的私钥，请改用密码认证，或用 ssh-keygen -p -N "" 去掉口令');
    }
    const r = new Reader(r0.str()); // 私钥部分（string 封装）
    if (r.u32() !== r.u32()) throw new Error('私钥校验失败（可能已损坏或需要口令）');
    const keyType = r.text();
    if (keyType === 'ssh-ed25519') {
      const pub = r.str();
      const priv = r.str(); // 64 字节：seed(32) || pub(32)
      if (priv.length < 32) throw new Error('ed25519 私钥损坏');
      return { kind: 'ed25519', seed: priv.slice(0, 32), pub };
    }
    if (keyType === 'ssh-rsa') {
      const n = r.mpint(); const e = r.mpint(); const d = r.mpint();
      const qi = r.mpint(); const p = r.mpint(); const q = r.mpint(); // iqmp, p, q
      return { kind: 'rsa', n, e, d, p, q, qi };
    }
    if (keyType === 'ecdsa-sha2-nistp256') {
      r.text(); // curve 名
      const q = r.str(); // 65 字节未压缩点
      const d = r.mpint();
      return { kind: 'ecdsa', q, d };
    }
    throw new Error(`暂不支持的私钥算法：${keyType}`);
  }

  /* 极简 ASN.1 DER：拆出 SEQUENCE 内的各元素 */
  function derReadAll(buf) {
    const out = [];
    let p = 0;
    while (p < buf.length) {
      p++; // tag
      let n = buf[p++];
      if (n & 0x80) {
        const c = n & 0x7f;
        n = 0;
        for (let i = 0; i < c; i++) n = (n << 8) | buf[p++];
      }
      out.push(buf.slice(p, p + n));
      p += n;
    }
    return out;
  }

  function parsePkcs1Rsa(der) {
    const ints = derReadAll(derReadAll(der)[0]);
    return { n: ints[1], e: ints[2], d: ints[3], p: ints[4], q: ints[5], qi: ints[8] };
  }

  /* ---- 主机密钥验签（sigAlgo 取自签名 blob 首串，决定哈希） ---- */
  async function verifyHostKey(kexHash, hostKeyBlob, sigBlob) {
    const hr = new Reader(hostKeyBlob);
    const blobType = hr.text();
    const sr = new Reader(sigBlob);
    const sigAlgo = sr.text();
    try {
      if (sigAlgo === 'ssh-ed25519') {
        const pub = hr.str();
        const sig = sr.str();
        return nacl.sign.detached.verify(kexHash, sig, pub);
      }
      if (sigAlgo === 'ecdsa-sha2-nistp256') {
        hr.text(); // 'nistp256'
        const q = hr.str();
        const inner = new Reader(sr.str()); // 签名 blob：string(mpw(r), mpint(s))
        const rawSig = cat(pad32(inner.mpint()), pad32(inner.mpint()));
        const key = await crypto.subtle.importKey('raw', q, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, rawSig, kexHash);
      }
      if (sigAlgo === 'rsa-sha2-512' || sigAlgo === 'rsa-sha2-256' || sigAlgo === 'ssh-rsa') {
        const e = hr.mpint(); const n = hr.mpint(); // blob 类型为 ssh-rsa（或 rsa-sha2-*），后跟 e、n
        void blobType;
        const sig = sr.str();
        const hashName = sigAlgo === 'rsa-sha2-512' ? 'SHA-512' : sigAlgo === 'rsa-sha2-256' ? 'SHA-256' : 'SHA-1';
        const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwkInt(n), e: jwkInt(e) }, { name: 'RSASSA-PKCS1-v1_5', hash: hashName }, false, ['verify']);
        return await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, sig, kexHash);
      }
    } catch {
      return false;
    }
    return false;
  }
  function pad32(u8) { const out = new Uint8Array(32); out.set(u8.slice(-32), 32 - Math.min(32, u8.length)); return out; }

  /* ---- 用户私钥 → 签名器 ---- */
  async function rsaUserKey(jwk, blob) {
    /* 现代服务器默认拒 ssh-rsa(SHA-1)，统一用 rsa-sha2-512 签名（RFC 8332）。
     * USERAUTH_REQUEST 的算法名是 rsa-sha2-512，但公钥 blob 内仍嵌 "ssh-rsa"。 */
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }, false, ['sign']);
    return {
      sigAlgo: 'rsa-sha2-512',
      blob,
      sign: async (data) => new Writer().str('rsa-sha2-512').str(new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, data))).bytes(),
    };
  }

  async function ecdsaUserKey(jwk) {
    const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const q = cat(Uint8Array.of(4), b64uToBytes(jwk.x), b64uToBytes(jwk.y));
    return {
      sigAlgo: 'ecdsa-sha2-nistp256',
      blob: new Writer().str('ecdsa-sha2-nistp256').str('nistp256').str(q).bytes(),
      sign: async (data) => {
        const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data));
        return new Writer().str('ecdsa-sha2-nistp256').str(new Writer().mpint(raw.slice(0, 32)).mpint(raw.slice(32, 64)).bytes()).bytes();
      },
    };
  }

  async function buildUserKey(pemText) {
    const { label } = parsePem(pemText);
    if (label === 'OPENSSH PRIVATE KEY') {
      const k = parseOpensshPrivateKey(pemText);
      if (k.kind === 'ed25519') {
        const kp = nacl.sign.keyPair.fromSeed(k.seed);
        return {
          sigAlgo: 'ssh-ed25519',
          blob: new Writer().str('ssh-ed25519').str(kp.publicKey).bytes(),
          sign: async (data) => new Writer().str('ssh-ed25519').str(nacl.sign.detached(data, kp.secretKey)).bytes(),
        };
      }
      if (k.kind === 'rsa') {
        const blob = new Writer().str('ssh-rsa').mpint(k.e).mpint(k.n).bytes();
        return rsaUserKey(rsaJwk(k), blob);
      }
      if (k.kind === 'ecdsa') {
        return ecdsaUserKey({ kty: 'EC', crv: 'P-256', x: b64urlBytes(k.q.slice(1, 33)), y: b64urlBytes(k.q.slice(33, 65)), d: jwkInt(k.d) });
      }
    }
    if (label === 'RSA PRIVATE KEY') {
      const k = parsePkcs1Rsa(derReadAll(parsePem(pemText).der)[0]);
      const blob = new Writer().str('ssh-rsa').mpint(k.e).mpint(k.n).bytes();
      return rsaUserKey(rsaJwk(k), blob);
    }
    if (label === 'PRIVATE KEY') {
      /* PKCS#8：RSA / ECDSA 直接导入后导出 JWK 复用 */
      const { der } = parsePem(pemText);
      for (const spec of [
        { alg: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }, fix: async (jwk) => rsaUserKey(jwk, new Writer().str('ssh-rsa').mpint(b64uToBytes(jwk.e)).mpint(b64uToBytes(jwk.n)).bytes()) },
        { alg: { name: 'ECDSA', namedCurve: 'P-256' }, fix: (jwk) => ecdsaUserKey(jwk) },
      ]) {
        try {
          const key = await crypto.subtle.importKey('pkcs8', der, spec.alg, true, ['sign']);
          return await spec.fix(await crypto.subtle.exportKey('jwk', key));
        } catch { /* 尝试下一个 */ }
      }
      throw new Error('无法解析该 PKCS#8 私钥（支持 RSA / ECDSA P-256）');
    }
    throw new Error(`暂不支持的私钥类型：${label}`);
  }

  /* ---- 协议常量 ---- */
  const MSG = {
    DISCONNECT: 1, IGNORE: 2, UNIMPLEMENTED: 3, DEBUG: 4, SERVICE_REQUEST: 5, SERVICE_ACCEPT: 6, EXT_INFO: 7,
    KEXINIT: 20, NEWKEYS: 21, KEX_ECDH_INIT: 30, KEX_ECDH_REPLY: 31,
    USERAUTH_REQUEST: 50, USERAUTH_FAILURE: 51, USERAUTH_SUCCESS: 52, USERAUTH_BANNER: 53, USERAUTH_PK_OK: 60,
    /* RFC 4256 keyboard-interactive：INFO_REQUEST 与 PK_OK 同为 60（按在途认证方法区分），INFO_RESPONSE=61 */
    USERAUTH_INFO_REQUEST: 60, USERAUTH_INFO_RESPONSE: 61,
    GLOBAL_REQUEST: 80, REQUEST_SUCCESS: 81, REQUEST_FAILURE: 82,
    CHANNEL_OPEN: 90, CHANNEL_OPEN_CONFIRMATION: 91, CHANNEL_OPEN_FAILURE: 92, CHANNEL_WINDOW_ADJUST: 93,
    CHANNEL_DATA: 94, CHANNEL_EXTENDED_DATA: 95, CHANNEL_EOF: 96, CHANNEL_CLOSE: 97, CHANNEL_REQUEST: 98,
    CHANNEL_SUCCESS: 99, CHANNEL_FAILURE: 100,
  };

  const KEX_ALGOS = 'curve25519-sha256,curve25519-sha256@libssh.org,ecdh-sha2-nistp256,kex-strict-c-v00@openssh.com';
  const HOSTKEY_ALGOS = 'ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-512,rsa-sha2-256,ssh-rsa';
  const ENC_ALGOS = 'aes128-gcm@openssh.com,aes256-gcm@openssh.com';
  const MAC_ALGOS = 'hmac-sha2-256,hmac-sha2-512,hmac-sha1'; // AEAD 不使用，仅供协商占位
  const COMP_ALGOS = 'none';

  function pickName(myList, serverList) {
    const server = new Set(serverList.split(',').map((s) => s.trim()));
    for (const n of myList.split(',')) if (server.has(n.trim())) return n.trim();
    return null;
  }

  /* ---- 主体 ---- */
  class SshClient {
    /** @param transport { write(Uint8Array), close(), onData(fn), onClose(fn), onError(fn) } */
    constructor(transport) {
      this.t = transport;
      this.inbuf = new Uint8Array(0);
      this.gotServerVer = false;
      this.sentVer = false;
      this.sendSeq = 0;
      this.recvSeq = 0;
      this.sendChain = Promise.resolve();
      this.pumping = false;
      this.encOut = null;
      this.encIn = null;
      this.sessionId = null;
      this.kexDone = false;
      this.strictApplied = false;
      this.msgQ = [];
      this.waiters = [];
      this.closed = false;
      this.closeReason = '';
      this.remoteChan = 0;
      this.remoteChanSet = false;
      this.remoteWindow = 0;
      this.remoteMaxPacket = 32768;
      this.recvWindowMax = 2 * 1024 * 1024;
      this.recvWindow = this.recvWindowMax;
      this.sendQueue = [];
      this.onDataCb = null;
      this.onEventCb = null;

      transport.onData((d) => this.feed(d));
      transport.onClose(() => this.handleClose('连接已关闭'));
      transport.onError((e) => this.handleClose('连接错误：' + (e && e.message ? e.message : e)));
    }

    onData(cb) { this.onDataCb = cb; }
    onEvent(cb) { this.onEventCb = cb; }
    emit(type, detail) { if (this.onEventCb) this.onEventCb({ type, ...detail }); }

    handleClose(reason) {
      if (this.closed) return;
      this.closed = true;
      this.closeReason = reason;
      for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error(reason)); }
      this.emit('closed', { reason });
      try { this.t.close(); } catch { /* ignore */ }
    }

    close() {
      if (this.closed) return;
      if (this.remoteChanSet) {
        this.sendPacket(new Writer().u8(MSG.CHANNEL_CLOSE).u32(this.remoteChan).bytes()).catch(() => {});
      }
      this.closed = true;
      this.sendChain.then(() => { try { this.t.close(); } catch { /* ignore */ } });
    }

    /* ---------- 包编解码 ---------- */
    /* 加密/明文在链式任务执行时才决定，保证 NEWKEYS 前后包序严格正确 */
    sendPacket(payload) {
      this.sendChain = this.sendChain.then(async () => {
        if (this.closed && payload[0] !== MSG.CHANNEL_CLOSE) return;
        /* 对齐规则跟 OpenSSH packet.c：EtM/AEAD 模式长度字段不加密，
         * 不计入对齐（len -= aadlen），即 bodyLen ≡ 0 (mod block)；
         * 明文模式为 (4+bodyLen) ≡ 0 (mod 8)。 */
        const blockSize = this.encOut ? 16 : 8;
        const baseLen = (this.encOut ? 0 : 4) + 1 + payload.length;
        let pad = blockSize - (baseLen % blockSize);
        if (pad < 4) pad += blockSize;
        const bodyLen = 1 + payload.length + pad;
        const body = new Uint8Array(bodyLen);
        body[0] = pad;
        body.set(payload, 1);
        crypto.getRandomValues(body.subarray(1 + payload.length));
        const lenBe = new Writer().u32(bodyLen).bytes();
        if (this.encOut) {
          const iv = this.encOut.iv;
          this.encOut.iv = incIv(iv);
          const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: lenBe }, this.encOut.key, body));
          this.t.write(cat(lenBe, cipher));
        } else {
          this.t.write(cat(lenBe, body));
        }
        this.sendSeq = (this.sendSeq + 1) >>> 0;
      });
      return this.sendChain;
    }

    feed(chunk) {
      if (this.closed) return;
      this.inbuf = cat(this.inbuf, chunk);
      if (!this.gotServerVer) {
        const nl = this.inbuf.indexOf(10);
        if (nl < 0) return;
        const line = td.decode(this.inbuf.slice(0, nl)).replace(/\r$/, '');
        this.inbuf = this.inbuf.slice(nl + 1);
        if (line.startsWith('SSH-')) {
          this.serverVer = line;
          this.gotServerVer = true;
          if (!this.sentVer) this.sendVersion();
        }
        /* 非 SSH- 开头的行是 banner，丢弃后继续等版本行 */
      }
      this.pump();
    }

    async pump() {
      if (this.pumping) return;
      this.pumping = true;
      try {
        while (!this.closed && this.gotServerVer) {
          const pkt = await this.takePacket();
          if (!pkt) break;
          this.recvSeq = (this.recvSeq + 1) >>> 0;
          try { this.dispatch(pkt); } catch (e) { this.handleClose('协议处理错误：' + (e && e.message ? e.message : e)); return; }
        }
      } finally {
        this.pumping = false;
      }
    }

    async takePacket() {
      if (this.inbuf.length < 4) return null;
      const dv = new DataView(this.inbuf.buffer, this.inbuf.byteOffset, this.inbuf.byteLength);
      const packetLen = dv.getUint32(0);
      if (packetLen > 4 * 1024 * 1024 || packetLen < 1) { this.handleClose('包长度异常'); return null; }
      if (!this.encIn) {
        const total = 4 + packetLen;
        if (this.inbuf.length < total) return null;
        const body = this.inbuf.slice(4, total);
        this.inbuf = this.inbuf.slice(total);
        return body.slice(1, body.length - body[0]);
      }
      /* AEAD：4 字节明文长度(AAD) + 密文(packetLen) + 16 字节 tag */
      const total = 4 + packetLen + 16;
      if (this.inbuf.length < total) return null;
      const lenBe = this.inbuf.slice(0, 4);
      const ct = this.inbuf.slice(4, total);
      this.inbuf = this.inbuf.slice(total);
      const iv = this.encIn.iv;
      this.encIn.iv = incIv(iv);
      let plain;
      try {
        plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: lenBe }, this.encIn.key, ct));
      } catch {
        this.handleClose('解密失败（密钥协商异常或数据被篡改）');
        return null;
      }
      return plain.slice(1, plain.length - plain[0]);
    }

    dispatch(payload) {
      const type = payload[0];
      if (type === MSG.KEXINIT) {
        if (!this.kexDone && !this.serverKexInit) {
          this.serverKexInit = payload;
          if (this.kexResolve) this.kexResolve();
        } else if (this.kexDone && !this.rekeyPromise) {
          /* 会话中 rekey */
          this.rekeyPromise = (async () => {
            try {
              const myInit = this.buildKexInit();
              await this.sendPacket(myInit);
              await this.doKex(payload, myInit);
            } catch (e) {
              this.handleClose('rekey 失败：' + (e && e.message ? e.message : e));
            }
          })();
        }
        return;
      }
      if (type === MSG.KEX_ECDH_REPLY || type === MSG.NEWKEYS || type === MSG.SERVICE_ACCEPT
        || type === MSG.USERAUTH_SUCCESS || type === MSG.USERAUTH_FAILURE || type === MSG.USERAUTH_PK_OK
        || type === MSG.CHANNEL_OPEN_CONFIRMATION || type === MSG.CHANNEL_OPEN_FAILURE
        || type === MSG.CHANNEL_SUCCESS || type === MSG.CHANNEL_FAILURE) {
        this.deliver(type, payload);
        return;
      }
      if (type === MSG.DISCONNECT) {
        const r = new Reader(payload);
        r.u8(); r.u32();
        this.handleClose('服务器断开连接：' + (r.text() || '（无说明）'));
        return;
      }
      if (type === MSG.IGNORE || type === MSG.UNIMPLEMENTED || type === MSG.DEBUG || type === MSG.EXT_INFO || type === MSG.USERAUTH_BANNER) return;
      if (type === MSG.GLOBAL_REQUEST) {
        const r = new Reader(payload);
        r.u8(); r.text();
        if (r.bool()) this.sendPacket(new Writer().u8(MSG.REQUEST_FAILURE).bytes()).catch(() => {});
        return;
      }
      if (type === MSG.CHANNEL_DATA || type === MSG.CHANNEL_EXTENDED_DATA) {
        const r = new Reader(payload);
        r.u8();
        const chan = r.u32();
        if (type === MSG.CHANNEL_EXTENDED_DATA) r.u32(); // data_type
        const data = r.str();
        if (chan === this.remoteChan) {
          this.recvWindow -= data.length;
          if (this.recvWindow < this.recvWindowMax / 2) {
            const add = this.recvWindowMax - this.recvWindow;
            this.recvWindow += add;
            this.sendPacket(new Writer().u8(MSG.CHANNEL_WINDOW_ADJUST).u32(this.remoteChan).u32(add).bytes()).catch(() => {});
          }
          if (this.onDataCb) this.onDataCb(data);
        }
        return;
      }
      if (type === MSG.CHANNEL_WINDOW_ADJUST) {
        const r = new Reader(payload);
        r.u8(); r.u32();
        this.remoteWindow += r.u32();
        this.flushSendQueue();
        return;
      }
      if (type === MSG.CHANNEL_REQUEST) {
        const r = new Reader(payload);
        r.u8();
        const chan = r.u32();
        const req = r.text();
        const wantReply = r.bool();
        if (req === 'exit-status') this.emit('exit', { code: r.u32() });
        else if (req === 'exit-signal') this.emit('exit', { signal: r.text() });
        if (wantReply && chan === this.remoteChan) {
          this.sendPacket(new Writer().u8(MSG.CHANNEL_SUCCESS).u32(chan).bytes()).catch(() => {});
        }
        return;
      }
      if (type === MSG.CHANNEL_EOF) return;
      if (type === MSG.CHANNEL_CLOSE) {
        if (!this.closed) {
          this.sendPacket(new Writer().u8(MSG.CHANNEL_CLOSE).u32(this.remoteChan).bytes()).catch(() => {});
          this.closed = true;
          this.emit('closed', { reason: '会话已结束' });
          this.sendChain.then(() => { try { this.t.close(); } catch { /* ignore */ } });
        }
        return;
      }
    }

    deliver(type, payload) {
      for (let i = 0; i < this.waiters.length; i++) {
        if (this.waiters[i].types.includes(type)) {
          const w = this.waiters.splice(i, 1)[0];
          clearTimeout(w.timer);
          w.resolve(payload);
          return;
        }
      }
      this.msgQ.push({ type, payload });
    }

    waitMsg(types, timeoutMs = 30000) {
      for (let i = 0; i < this.msgQ.length; i++) {
        if (types.includes(this.msgQ[i].type)) return Promise.resolve(this.msgQ.splice(i, 1)[0].payload);
      }
      return new Promise((resolve, reject) => {
        const w = { types, resolve, reject };
        w.timer = setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error('SSH 握手超时（' + types.join('/') + '）'));
        }, timeoutMs);
        this.waiters.push(w);
      });
    }

    /* ---------- 版本交换 / KEX ---------- */
    sendVersion() {
      this.clientVer = 'SSH-2.0-MEVPS_1.0';
      this.t.write(te2.encode(this.clientVer + '\r\n'));
      this.sentVer = true;
    }

    buildKexInit() {
      const cookie = new Uint8Array(16);
      crypto.getRandomValues(cookie);
      return new Writer()
        .u8(MSG.KEXINIT).raw(cookie)
        .str(KEX_ALGOS).str(HOSTKEY_ALGOS).str(ENC_ALGOS).str(ENC_ALGOS)
        .str(MAC_ALGOS).str(MAC_ALGOS).str(COMP_ALGOS).str(COMP_ALGOS)
        .str('').str('')
        .bool(false).u32(0)
        .bytes();
    }

    /* 主入口：握手 + 认证 + 交互式 shell */
    async login({ username, password, privateKey, term = 'xterm-256color', cols = 80, rows = 24 }) {
      if (!this.sentVer) this.sendVersion();
      const myInit = this.buildKexInit();
      await this.sendPacket(myInit);
      if (!this.serverKexInit) {
        await Promise.race([
          new Promise((res) => { this.kexResolve = res; }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('等待服务器 KEXINIT 超时')), 30000)),
        ]);
      }
      await this.doKex(this.serverKexInit, myInit);

      await this.sendPacket(new Writer().u8(MSG.SERVICE_REQUEST).str('ssh-userauth').bytes());
      await this.waitMsg([MSG.SERVICE_ACCEPT], 30000);

      if (password) {
        try {
          await this.authPassword(username, password);
        } catch (e) {
          /* 服务器禁用 password 方法（只留 publickey/keyboard-interactive 等）时自动降级 */
          if (!String((e && e.message) || '').includes('keyboard-interactive')) throw e;
          await this.authKeyboardInteractive(username, password);
        }
      } else if (privateKey) {
        const key = await buildUserKey(privateKey);
        await this.authPublicKey(username, key);
      } else {
        throw new Error('未提供密码或私钥');
      }
      await this.openShell(term, cols, rows);
    }

    async doKex(serverInit, myInit) {
      const sr = new Reader(serverInit);
      sr.u8(); sr.bytes(16);
      const serverKex = sr.text(); const serverHostKey = sr.text();
      const serverEnc2c = sr.text(); const serverEnc2s = sr.text();
      sr.text(); sr.text(); sr.text(); sr.text(); // mac / comp（AEAD 下不参与）

      const kexAlgo = pickName(KEX_ALGOS, serverKex);
      const hostKeyAlgo = pickName(HOSTKEY_ALGOS, serverHostKey);
      const enc2c = pickName(ENC_ALGOS, serverEnc2c);
      const enc2s = pickName(ENC_ALGOS, serverEnc2s);
      if (!kexAlgo || !hostKeyAlgo || !enc2c || !enc2s) throw new Error('算法协商失败（服务器不支持所需算法）');
      /* 严格 KEX（防 Terrapin）：双方都声明才启用 */
      const strict = serverKex.split(',').includes('kex-strict-s-v00@openssh.com');

      let qC; let shared;
      if (kexAlgo.startsWith('curve25519')) {
        const sk = new Uint8Array(32);
        crypto.getRandomValues(sk);
        qC = nacl.scalarMult.base(sk);
        await this.sendPacket(new Writer().u8(MSG.KEX_ECDH_INIT).str(qC).bytes());
        const reply = await this.waitMsg([MSG.KEX_ECDH_REPLY], 30000);
        const rr = new Reader(reply);
        rr.u8();
        const kS = rr.str(); const qS = rr.str(); const sigBlob = rr.str();
        shared = nacl.scalarMult(sk, qS);
        if (!shared || shared.every((b) => b === 0)) throw new Error('ECDH 共享密钥无效');
        return this.finishKex({ hostKeyAlgo, enc2c, enc2s, kS, qC, qS, sigBlob, shared, strict, myInit, serverInit });
      }
      /* ecdh-sha2-nistp256 */
      const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      qC = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
      await this.sendPacket(new Writer().u8(MSG.KEX_ECDH_INIT).str(qC).bytes());
      const reply2 = await this.waitMsg([MSG.KEX_ECDH_REPLY], 30000);
      const rr2 = new Reader(reply2);
      rr2.u8();
      const kS2 = rr2.str(); const qS2 = rr2.str(); const sigBlob2 = rr2.str();
      const peerKey = await crypto.subtle.importKey('raw', qS2, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, kp.privateKey, 256));
      return this.finishKex({ hostKeyAlgo, enc2c, enc2s, kS: kS2, qC, qS: qS2, sigBlob: sigBlob2, shared, strict, myInit, serverInit });
    }

    async finishKex({ hostKeyAlgo, enc2c, enc2s, kS, qC, qS, sigBlob, shared, strict, myInit, serverInit }) {
      void hostKeyAlgo;
      /* 交换哈希 H（RFC 4253 §8 + RFC 5656 §4） */
      const h = new Writer()
        .str(this.clientVer).str(this.serverVer)
        .str(myInit).str(serverInit)
        .str(kS).str(qC).str(qS).mpint(shared);
      const H = await sha256(h.bytes());
      if (!this.sessionId) this.sessionId = H;

      /* 主机密钥验签（签名对象为 H） */
      const ok = await verifyHostKey(H, kS, sigBlob);
      if (!ok) throw new Error('主机密钥签名验证失败（可能存在中间人攻击！）');
      const fp = 'SHA256:' + btoa(String.fromCharCode(...await sha256(kS))).replace(/=+$/, '');
      this.emit('hostkey', { fp, algo: new Reader(kS).text() });

      /* 密钥派生（RFC 4253 §7.2）：A/B=IV，C/D=加密密钥 */
      const keyLen = enc2c.startsWith('aes128') ? 16 : 32;
      const derive = async (letter, need) => {
        let out = new Uint8Array(0);
        let prev = new Uint8Array(0);
        while (out.length < need) {
          prev = await sha256(cat(new Writer().mpint(shared).bytes(), H, te2.encode(letter), prev.length ? prev : this.sessionId));
          out = cat(out, prev);
        }
        return out.slice(0, need);
      };
      const ivC = await derive('A', 12);
      const ivS = await derive('B', 12);
      const keyC = await derive('C', keyLen);
      const keyS = await derive('D', keyLen);

      /* NEWKEYS 之后启用出站密钥；严格 KEX 下首个 NEWKEYS 后序号清零 */
      await this.sendPacket(new Writer().u8(MSG.NEWKEYS).bytes());
      this.encOut = { key: await importAesKey(keyC), iv: ivC.slice() };
      if (strict && !this.strictApplied) { this.strictApplied = true; this.sendSeq = 0; }

      await this.waitMsg([MSG.NEWKEYS], 30000);
      this.encIn = { key: await importAesKey(keyS), iv: ivS.slice() };
      if (strict && this.strictApplied) this.recvSeq = 0;
      this.kexDone = true;
    }

    /* ---------- 认证 ---------- */
    async authPassword(username, password) {
      await this.sendPacket(new Writer()
        .u8(MSG.USERAUTH_REQUEST).str(username).str('ssh-connection').str('password')
        .bool(false).str(password).bytes());
      await this.expectAuthOk();
    }

    /* keyboard-interactive（RFC 4256）：服务器禁用 password 方法、只留
     * publickey/keyboard-interactive 时（如 ct8.pl 系列），用已存密码回答交互提示。*/
    async authKeyboardInteractive(username, password) {
      await this.sendPacket(new Writer()
        .u8(MSG.USERAUTH_REQUEST).str(username).str('ssh-connection').str('keyboard-interactive')
        .str('').str('').bytes());
      for (let round = 0; round < 8; round++) {
        const msg = await this.waitMsg([MSG.USERAUTH_SUCCESS, MSG.USERAUTH_FAILURE, MSG.USERAUTH_INFO_REQUEST], 30000);
        if (msg[0] === MSG.USERAUTH_SUCCESS) return;
        if (msg[0] === MSG.USERAUTH_FAILURE) {
          const r = new Reader(msg);
          r.u8();
          const methods = r.text();
          const partial = r.bool();
          throw new Error(partial ? '认证不完整，请继续认证' : `认证失败（服务器允许的方式：${methods || '无'}）`);
        }
        /* INFO_REQUEST: name, instruction, language, num_prompts, (prompt, echo)* */
        const r = new Reader(msg);
        r.u8();
        r.text(); r.text(); r.text();
        const n = r.u32();
        const w = new Writer().u8(MSG.USERAUTH_INFO_RESPONSE).u32(n);
        for (let i = 0; i < n; i++) {
          r.text(); // 提示文本
          const echo = r.bool();
          w.str(echo ? '' : password); // 非回显提示（密码框）回密码；回显提示留空
        }
        await this.sendPacket(w.bytes());
      }
      throw new Error('keyboard-interactive 认证交互轮次过多');
    }

    async authPublicKey(username, key) {
      /* USERAUTH_REQUEST 构造：hasSig=true 时带签名字段；签名对象是去掉签名字段的请求全文 */
      const reqBody = (hasSig) => new Writer()
        .u8(MSG.USERAUTH_REQUEST).str(username).str('ssh-connection').str('publickey')
        .bool(hasSig).str(key.sigAlgo).str(key.blob).bytes();
      const toSign = cat(new Writer().str(this.sessionId).bytes(), reqBody(true));
      const sig = await key.sign(toSign);
      const w = new Writer().raw(reqBody(true)).str(sig);
      await this.sendPacket(w.bytes());
      await this.expectAuthOk();
    }

    async expectAuthOk() {
      const msg = await this.waitMsg([MSG.USERAUTH_SUCCESS, MSG.USERAUTH_FAILURE, MSG.USERAUTH_PK_OK], 30000);
      if (msg[0] === MSG.USERAUTH_SUCCESS) return;
      if (msg[0] === MSG.USERAUTH_PK_OK) return this.expectAuthOk();
      const r = new Reader(msg);
      r.u8();
      const methods = r.text();
      const partial = r.bool();
      throw new Error(partial ? '认证不完整，请继续认证' : `认证失败（服务器允许的方式：${methods || '无'}）`);
    }

    /* ---------- 交互式 shell ---------- */
    async openShell(term, cols, rows) {
      await this.sendPacket(new Writer().u8(MSG.CHANNEL_OPEN).str('session').u32(0).u32(this.recvWindowMax).u32(32768).bytes());
      const conf = await this.waitMsg([MSG.CHANNEL_OPEN_CONFIRMATION, MSG.CHANNEL_OPEN_FAILURE], 30000);
      if (conf[0] === MSG.CHANNEL_OPEN_FAILURE) {
        const r = new Reader(conf);
        r.u8(); r.u32();
        throw new Error('服务器拒绝打开会话通道：' + r.text());
      }
      const r = new Reader(conf);
      r.u8(); r.u32(); // 我方通道号
      this.remoteChan = r.u32();
      this.remoteWindow = r.u32();
      this.remoteMaxPacket = Math.min(r.u32() || 32768, 32768);
      this.remoteChanSet = true;

      /* pty-req */
      await this.sendPacket(new Writer()
        .u8(MSG.CHANNEL_REQUEST).u32(this.remoteChan).str('pty-req').bool(true)
        .str(term).u32(cols).u32(rows).u32(cols * 8).u32(rows * 16)
        .str(Uint8Array.of(0))
        .bytes());
      let rep = await this.waitMsg([MSG.CHANNEL_SUCCESS, MSG.CHANNEL_FAILURE], 30000);
      if (rep[0] === MSG.CHANNEL_FAILURE) throw new Error('PTY 申请被服务器拒绝');

      /* shell */
      await this.sendPacket(new Writer().u8(MSG.CHANNEL_REQUEST).u32(this.remoteChan).str('shell').bool(true).bytes());
      rep = await this.waitMsg([MSG.CHANNEL_SUCCESS, MSG.CHANNEL_FAILURE], 30000);
      if (rep[0] === MSG.CHANNEL_FAILURE) throw new Error('Shell 启动被服务器拒绝');
      this.emit('ready', {});
    }

    /* 终端输入 → 通道数据（带发送窗口流控） */
    write(data) {
      if (this.closed) return;
      this.sendQueue.push(typeof data === 'string' ? te2.encode(data) : data);
      this.flushSendQueue();
    }

    flushSendQueue() {
      while (this.sendQueue.length && this.remoteWindow > 0) {
        const chunkSize = Math.min(this.sendQueue[0].length, this.remoteMaxPacket, this.remoteWindow);
        const chunk = this.sendQueue[0].slice(0, chunkSize);
        if (chunkSize < this.sendQueue[0].length) this.sendQueue[0] = this.sendQueue[0].slice(chunkSize);
        else this.sendQueue.shift();
        this.remoteWindow -= chunkSize;
        this.sendPacket(new Writer().u8(MSG.CHANNEL_DATA).u32(this.remoteChan).str(chunk).bytes()).catch(() => {});
      }
    }

    /* 终端尺寸变化 */
    resize(cols, rows) {
      if (this.closed || !this.remoteChanSet) return;
      this.sendPacket(new Writer()
        .u8(MSG.CHANNEL_REQUEST).u32(this.remoteChan).str('window-change').bool(false)
        .u32(cols).u32(rows).u32(cols * 8).u32(rows * 16).bytes()).catch(() => {});
    }
  }

  return { SshClient, buildUserKey, Writer, Reader, MSG };
})();
/* ==================== /SSH 迷你客户端 ==================== */

/* ==================== 终端 WebSocket 网关 ====================
 * 浏览器 ←WebSocket→ 本 Worker ←TCP(SshClient)→ VPS:22。
 * 鉴权：先用 Bearer 会话换 5 分钟一次性 HMAC 票据（WS 握手带不了 Authorization 头）。 */

async function issueTerminalTicket(env, user, vpsId) {
  const secret = await getSetting(env.db, 'token_secret');
  const payload = b64url(JSON.stringify({ u: user, v: vpsId, exp: Date.now() + 5 * 60 * 1000, r: randomHex(8) }));
  return `${payload}.${await hmacSign(secret, 'term.' + payload)}`;
}

async function verifyTerminalTicket(env, ticket, vpsId) {
  if (!ticket || !ticket.includes('.')) return null;
  const [payload, sig] = ticket.split('.');
  const secret = await getSetting(env.db, 'token_secret');
  const expect = await hmacSign(secret, 'term.' + payload);
  if (sig !== expect) return null;
  try {
    const data = JSON.parse(unb64url(payload));
    if (!data.u || data.v !== vpsId || data.exp < Date.now()) return null;
    return data.u;
  } catch {
    return null;
  }
}

async function handleTerminalWS(request, env, url) {
  await ensureDb(env);
  const m = url.pathname.match(/^\/api\/vps\/(\d+)\/terminal$/);
  if (!m) return err('Not Found', 404);
  const vpsId = Number(m[1]);
  const user = await verifyTerminalTicket(env, url.searchParams.get('ticket'), vpsId);
  if (!user) return err('票据无效或已过期，请重新打开终端', 401);

  const row = await env.db.prepare('SELECT * FROM vps WHERE id = ?').bind(vpsId).first();
  if (!row) return err('记录不存在', 404);
  const secret = await decSecret(env, row.ssh_secret_enc);
  if (!secret) return err('该 VPS 未配置 SSH 凭据', 400);

  const pair = new WebSocketPair();
  const [clientWs, serverWs] = [pair[0], pair[1]];
  serverWs.accept();
  startTerminalSession({ env, row, secret, ws: serverWs, user, ip: clientIp(request) });
  return new Response(null, { status: 101, webSocket: clientWs });
}

function startTerminalSession({ env, row, secret, ws, user, ip }) {
  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ } };
  const keepAlive = setInterval(() => send({ type: 'ping' }), 45000);
  const cleanup = () => { clearInterval(keepAlive); };

  let socket;
  try {
    socket = connect({ hostname: row.ssh_host, port: row.ssh_port });
  } catch (e) {
    send({ type: 'error', message: 'TCP 连接失败：' + (e && e.message ? e.message : e) });
    cleanup();
    try { ws.close(1011); } catch { /* ignore */ }
    return;
  }

  /* cloudflare:sockets → SshClient transport 适配 */
  const writer = socket.writable.getWriter();
  const t = {
    _onData: null, _onClose: null, _onError: null,
    onData(fn) { this._onData = fn; },
    onClose(fn) { this._onClose = fn; },
    onError(fn) { this._onError = fn; },
    write(u8) { writer.write(u8).catch((e) => this._onError && this._onError(e)); },
    close() { try { socket.close(); } catch { /* ignore */ } },
  };
  (async () => {
    const reader = socket.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && t._onData) t._onData(new Uint8Array(value));
      }
      if (t._onClose) t._onClose();
    } catch (e) {
      if (t._onError) t._onError(e);
    }
  })();

  const ssh = new SSH.SshClient(t);
  ssh.onData((d) => { try { ws.send(d); } catch { /* ignore */ } });
  ssh.onEvent((ev) => {
    if (ev.type === 'ready') send({ type: 'ready' });
    else if (ev.type === 'hostkey') send({ type: 'hostkey', fp: ev.fp, algo: ev.algo });
    else if (ev.type === 'exit') send({ type: 'exit', code: ev.code, signal: ev.signal });
    else if (ev.type === 'closed') {
      send({ type: 'closed', reason: ev.reason });
      cleanup();
      try { ws.close(1000); } catch { /* ignore */ }
    }
  });

  ws.addEventListener('message', (ev) => {
    if (typeof ev.data === 'string') {
      /* 控制帧为 JSON（resize/ping/pong）；其余字符串是终端输入 */
      try {
        const msg = JSON.parse(ev.data);
        if (msg && typeof msg === 'object') {
          if (msg.type === 'resize') return ssh.resize(Number(msg.cols) || 80, Number(msg.rows) || 24);
          if (msg.type === 'ping' || msg.type === 'pong') return;
        }
      } catch { /* 非 JSON：按终端输入处理 */ }
      ssh.write(ev.data);
      return;
    }
    ssh.write(new Uint8Array(ev.data));
  });
  ws.addEventListener('close', () => {
    cleanup();
    ssh.close();
  });
  ws.addEventListener('error', () => {
    cleanup();
    ssh.close();
  });

  ssh.login({
    username: row.ssh_username,
    password: row.ssh_auth === 'key' ? '' : secret,
    privateKey: row.ssh_auth === 'key' ? secret : '',
    cols: 80,
    rows: 24,
  }).then(async () => {
    await addLog(env.db, user, '终端', row.name, `打开 SSH 终端 ${row.ssh_host}:${row.ssh_port}`, ip);
  }).catch((e) => {
    send({ type: 'error', message: '连接失败：' + (e && e.message ? e.message : e) });
    cleanup();
    try { ws.close(1011); } catch { /* ignore */ }
  });
}
/* ==================== /终端 WebSocket 网关 ==================== */

/* ------------------------------ 入口 ------------------------------ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    url.pathname = normalizePathname(url.pathname);

    if (url.pathname.startsWith('/api/')) {
      // WebSocket 升级：浏览器内 SSH 终端（/api/vps/:id/terminal）
      if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
        try {
          return await handleTerminalWS(request, env, url);
        } catch (e) {
          return err(`服务器内部错误: ${e && e.message ? e.message : e}`, 500);
        }
      }
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        return err(`服务器内部错误: ${e && e.message ? e.message : e}`, 500);
      }
    }

    // 非 API 请求兜底（正常情况下 assets 层直接处理，不会走到这里）。
    // 无 run_worker_first 配置的手动部署模式下，这段负责 SPA 回退。
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      if (res.status !== 404 || request.method !== 'GET') return res;
      return env.ASSETS.fetch(new Request(new URL('/', request.url)));
    }
    return new Response('Not Found', { status: 404 });
  },
};
