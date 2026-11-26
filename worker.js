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

function nowStr() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/* --------------------------- D1 自动初始化 --------------------------- */

async function ensureDb(env) {
  const g = globalThis;
  if (g.__mevpsReady) return;
  if (!g.__mevpsInit) {
    g.__mevpsInit = initDb(env)
      .then(() => {
        g.__mevpsReady = true;
      })
      .catch((e) => {
        g.__mevpsInit = null;
        throw e;
      });
  }
  return g.__mevpsInit;
}

/* --------- vps 表结构升级：SSH 连接参数模型（v2） --------- */
async function migrateVps(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'vps_schema_ver'").first();
  const ver = row ? Number(row.value) || 0 : 0;
  if (ver >= 2) return;
  const info = await db.prepare('PRAGMA table_info(vps)').all();
  const cols = new Set((info.results || []).map((c) => c.name));
  const mark = () =>
    db
      .prepare("INSERT INTO settings (key, value) VALUES ('vps_schema_ver', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run();
  if (!cols.has('ip')) {
    // 全新安装或已是新结构：仅标版本
    await mark();
    return;
  }
  // 旧结构（ip/region/provider/price/expire_date）→ 重建为 SSH 模型，保留可用数据
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
  await mark();
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
    await db
      .prepare('INSERT INTO users (username, password_hash, salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind('admin', hash, salt, nowStr(), nowStr())
      .run();

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
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ event_type: eventType, client_payload: { job_id: jobId, vps_id: vpsId } }),
    });
    if (res.status === 204 || res.ok) return { ok: true };
    const text = await res.text().catch(() => '');
    return { ok: false, error: `GitHub 触发失败（${res.status}）${text.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: `GitHub 调用异常: ${e && e.message ? e.message : e}` };
  }
}

async function handleApi(request, env, url) {
  await ensureDb(env);
  const db = env.db;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;
  const ip = clientIp(request);

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
      .prepare('UPDATE vps SET country=?, city=?, spec=?, online=?, sync_status=?, sync_error=?, last_sync_at=?, updated_at=? WHERE id=?')
      .bind(
        String(payload.country || '').slice(0, 64),
        String(payload.city || '').slice(0, 64),
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
      where.push('(name LIKE ? OR ssh_host LIKE ? OR country LIKE ? OR city LIKE ? OR remark LIKE ?)');
      args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
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
        `SELECT id, name, ssh_host, ssh_port, ssh_username, ssh_auth, country, city, spec, online, sync_status, sync_error, last_sync_at, remark, created_at, updated_at FROM vps ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`
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
      await db.prepare("UPDATE vps SET sync_status='error', sync_error=?, updated_at=? WHERE id=?").bind(d.error.slice(0, 300), nowStr(), id).run();
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

  return err('接口不存在', 404);
}

/* ------------------------------ 入口 ------------------------------ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
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
