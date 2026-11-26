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

async function initDb(env) {
  const db = env.db;
  if (!db) throw new Error('D1 绑定缺失');

  await db.batch([
    'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)',
    'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT, updated_at TEXT)',
    'CREATE TABLE IF NOT EXISTS vps (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ip TEXT NOT NULL, region TEXT DEFAULT \"\", spec TEXT DEFAULT \"\", provider TEXT DEFAULT \"\", status TEXT DEFAULT \"running\", price REAL DEFAULT 0, expire_date TEXT DEFAULT \"\", remark TEXT DEFAULT \"\", created_at TEXT, updated_at TEXT)',
    'CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT DEFAULT \"\", action TEXT DEFAULT \"\", target TEXT DEFAULT \"\", detail TEXT DEFAULT \"\", ip TEXT DEFAULT \"\", status TEXT DEFAULT \"success\", created_at TEXT)',
    'CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_vps_status ON vps(status)',
  ].map((sql) => db.prepare(sql)));

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
      ['web-01', '192.0.2.11', '东京', '2C4G / 60G SSD', 'Vultr', 'running', 48, '2027-06-30', '官网 Web 节点'],
      ['web-02', '192.0.2.12', '新加坡', '2C4G / 60G SSD', 'Vultr', 'running', 48, '2027-06-30', '官网备用节点'],
      ['api-01', '198.51.100.21', '香港', '4C8G / 120G SSD', '阿里云', 'running', 168, '2027-03-15', '业务 API 服务器'],
      ['db-01', '198.51.100.22', '香港', '4C16G / 240G SSD', '阿里云', 'maintenance', 299, '2027-03-15', '数据库主节点'],
      ['dev-01', '203.0.113.31', '洛杉矶', '1C2G / 40G SSD', 'DigitalOcean', 'stopped', 35, '2027-01-20', '开发测试机'],
      ['cdn-01', '203.0.113.32', '法兰克福', '2C2G / 50G SSD', 'Hetzner', 'running', 42, '2027-08-01', '欧洲边缘缓存'],
    ];
    const ins = db.prepare(
      'INSERT INTO vps (name, ip, region, spec, provider, status, price, expire_date, remark, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const t = nowStr();
    await db.batch(demo.map((d) => ins.bind(...d, t, t)));

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
    const counts = await db
      .prepare("SELECT status, COUNT(*) AS c, IFNULL(SUM(price),0) AS cost FROM vps GROUP BY status")
      .all();
    let total = 0;
    let monthly = 0;
    const dist = [];
    for (const row of counts.results || []) {
      total += row.c;
      monthly += row.cost;
      dist.push({ status: row.status, count: row.c });
    }
    // 近 7 天成本趋势（按月费均摊 + 确定性小波动）
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const wave = 1 + Math.sin((d.getDate() + d.getMonth() * 30) * 1.7) * 0.06;
      trend.push({
        date: `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        cost: Math.round(((monthly / 30) * wave + Number.EPSILON) * 100) / 100,
      });
    }
    const recent = await db
      .prepare('SELECT id, username, action, target, detail, status, created_at FROM logs ORDER BY id DESC LIMIT 8')
      .all();
    const expireSoon = await db
      .prepare("SELECT id, name, expire_date FROM vps WHERE expire_date != '' ORDER BY expire_date ASC LIMIT 5")
      .all();
    return ok({
      total,
      running: (counts.results || []).filter((r) => r.status === 'running').reduce((s, r) => s + r.c, 0),
      stopped: (counts.results || []).filter((r) => r.status === 'stopped').reduce((s, r) => s + r.c, 0),
      maintenance: (counts.results || []).filter((r) => r.status === 'maintenance').reduce((s, r) => s + r.c, 0),
      monthlyCost: Math.round((monthly + Number.EPSILON) * 100) / 100,
      trend,
      dist,
      recentLogs: recent.results || [],
      expireSoon: expireSoon.results || [],
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
      where.push('(name LIKE ? OR ip LIKE ? OR region LIKE ? OR remark LIKE ?)');
      args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    if (status) {
      where.push('status = ?');
      args.push(status);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = await db.prepare(`SELECT COUNT(*) AS c FROM vps ${clause}`).bind(...args).first();
    const list = await db
      .prepare(`SELECT * FROM vps ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...args, pageSize, (page - 1) * pageSize)
      .all();
    return ok({ list: list.results || [], total: totalRow ? totalRow.c : 0, page, pageSize });
  }

  // 新增 VPS
  if (path === '/api/vps' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const name = String(b.name || '').trim();
    const ipAddr = String(b.ip || '').trim();
    if (!name || !ipAddr) return err('名称和 IP 为必填项');
    const status = ['running', 'stopped', 'maintenance'].includes(b.status) ? b.status : 'running';
    const t = nowStr();
    const r = await db
      .prepare(
        'INSERT INTO vps (name, ip, region, spec, provider, status, price, expire_date, remark, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        name,
        ipAddr,
        String(b.region || ''),
        String(b.spec || ''),
        String(b.provider || ''),
        status,
        Number(b.price) || 0,
        String(b.expire_date || ''),
        String(b.remark || ''),
        t,
        t
      )
      .run();
    await addLog(db, username, '新增', name, `创建 VPS 记录 ${name}（${ipAddr}）`, ip);
    return ok({ id: r.meta.last_row_id });
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
      const status = ['running', 'stopped', 'maintenance'].includes(b.status) ? b.status : row.status;
      await db
        .prepare(
          'UPDATE vps SET name=?, ip=?, region=?, spec=?, provider=?, status=?, price=?, expire_date=?, remark=?, updated_at=? WHERE id=?'
        )
        .bind(
          String(b.name ?? row.name).trim(),
          String(b.ip ?? row.ip).trim(),
          String(b.region ?? row.region),
          String(b.spec ?? row.spec),
          String(b.provider ?? row.provider),
          status,
          Number(b.price ?? row.price) || 0,
          String(b.expire_date ?? row.expire_date),
          String(b.remark ?? row.remark),
          nowStr(),
          id
        )
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
    const map = { start: 'running', stop: 'stopped', restart: 'running' };
    const next = map[b.action];
    if (!next) return err('未知操作');
    await db.prepare('UPDATE vps SET status = ?, updated_at = ? WHERE id = ?').bind(next, nowStr(), id).run();
    const label = { start: '启动', stop: '停止', restart: '重启' }[b.action];
    await addLog(db, username, label, row.name, `${label} VPS #${id}`, ip);
    return ok({ status: next });
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
