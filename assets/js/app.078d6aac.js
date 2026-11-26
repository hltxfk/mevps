/* ==== js/utils.js ==== */
/* ==== utils.js：通用工具与图标 ==== */
window.MEVPS = window.MEVPS || {};

MEVPS.$ = (sel, root) => (root || document).querySelector(sel);
MEVPS.$$ = (sel, root) => [...(root || document).querySelectorAll(sel)];

MEVPS.esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

MEVPS.fmtMoney = (n) => '¥' + Number(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

MEVPS.fmtTime = (s) => (s ? String(s).slice(0, 16) : '-');

MEVPS.debounce = (fn, ms = 300) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

/* 内联 SVG 图标（stroke 风格，与面板统一） */
MEVPS.ICONS = {
  dashboard: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 8h8V3h-8z"/>',
  server: '<rect x="2" y="3" width="20" height="7" rx="2"/><rect x="2" y="14" width="20" height="7" rx="2"/><circle cx="6.5" cy="6.5" r=".8" fill="currentColor"/><circle cx="6.5" cy="17.5" r=".8" fill="currentColor"/><path d="M10 6.5h8M10 17.5h8"/>',
  log: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/>',
  setting: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  money: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
};

MEVPS.icon = (name, size = 16, stroke = 2) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${MEVPS.ICONS[name] || ''}</svg>`;

;
/* ==== js/api.js ==== */
/* ==== api.js：请求封装（Bearer Token） ==== */
(function () {
  const TOKEN_KEY = 'mevps_token';
  const USER_KEY = 'mevps_user';

  MEVPS.getToken = () => localStorage.getItem(TOKEN_KEY);
  MEVPS.setToken = (t, user) => {
    localStorage.setItem(TOKEN_KEY, t);
    if (user) localStorage.setItem(USER_KEY, user);
  };
  MEVPS.clearToken = () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  };
  MEVPS.savedUser = () => localStorage.getItem(USER_KEY) || '';

  MEVPS.api = async function (path, opts = {}) {
    let url = '/api' + path;
    if (opts.params) {
      const qs = new URLSearchParams();
      Object.entries(opts.params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') qs.set(k, v);
      });
      const s = qs.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }
    const headers = { 'Content-Type': 'application/json' };
    const token = MEVPS.getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    let res;
    try {
      res = await fetch(url, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    } catch {
      throw new Error('网络异常，请稍后重试');
    }
    let payload = null;
    try {
      payload = await res.json();
    } catch (e) {
      /* ignore */
    }
    if (res.status === 401) {
      MEVPS.clearToken();
      window.dispatchEvent(new Event('mevps:unauthorized'));
      throw new Error((payload && payload.error) || '登录已过期，请重新登录');
    }
    if (!payload || !payload.ok) throw new Error((payload && payload.error) || '请求失败 (' + res.status + ')');
    return payload.data;
  };
})();

;
/* ==== js/ui.js ==== */
/* ==== ui.js：Toast / Modal / 分页 组件 ==== */
(function () {
  /* ---- Toast ---- */
  MEVPS.toast = function (msg, type = 'info', duration = 2600) {
    const icons = { success: 'check', error: 'x', info: 'info' };
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML = `${MEVPS.icon(icons[type] || 'info', 16)}<span>${MEVPS.esc(msg)}</span>`;
    document.getElementById('toast-root').appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .25s';
      setTimeout(() => el.remove(), 260);
    }, duration);
  };

  /* ---- Modal ---- */
  MEVPS.modal = function ({ title, content, okText = '确 定', cancelText = '取 消', onOk, hideFooter = false, width }) {
    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" ${width ? `style="width:${width}px"` : ''}>
        <div class="modal-header">
          <span>${MEVPS.esc(title)}</span>
          <button class="modal-close" data-act="close">×</button>
        </div>
        <div class="modal-body">${content}</div>
        ${hideFooter ? '' : `<div class="modal-footer"><button class="btn" data-act="close">${cancelText}</button><button class="btn btn-primary" data-act="ok">${okText}</button></div>`}
      </div>`;
    root.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'close') close();
      if (act.dataset.act === 'ok' && onOk) {
        const keep = onOk(overlay, close);
        if (keep !== false) close();
      }
    });
    return { close, overlay };
  };

  /* ---- 确认框 ---- */
  MEVPS.confirm = function (message, title = '提示') {
    return new Promise((resolve) => {
      MEVPS.modal({
        title,
        content: `<p style="line-height:1.8;color:#666">${message}</p>`,
        okText: '确 定',
        onOk: () => {
          resolve(true);
        },
      }).overlay.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-overlay')) resolve(false);
      });
    });
  };

  /* ---- 分页 ---- */
  MEVPS.pager = function (el, { page, pageSize, total, onChange }) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const nums = [];
    const add = (p) => nums.push(`<button class="page-btn ${p === page ? 'active' : ''}" data-page="${p}">${p}</button>`);
    if (pages <= 7) {
      for (let i = 1; i <= pages; i++) add(i);
    } else {
      add(1);
      if (page > 3) nums.push('<span class="muted">…</span>');
      for (let i = Math.max(2, page - 1); i <= Math.min(pages - 1, page + 1); i++) add(i);
      if (page < pages - 2) nums.push('<span class="muted">…</span>');
      add(pages);
    }
    el.innerHTML = `
      <span class="total">共 ${total} 条</span>
      <button class="page-btn" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹</button>
      ${nums.join('')}
      <button class="page-btn" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>›</button>`;
    el.onclick = (e) => {
      const btn = e.target.closest('.page-btn[data-page]');
      if (!btn || btn.disabled) return;
      const p = Number(btn.dataset.page);
      if (p >= 1 && p <= pages && p !== page) onChange(p);
    };
  };
})();

;
/* ==== js/charts.js ==== */
/* ==== charts.js：纯 SVG 图表（无第三方依赖） ==== */
(function () {
  /**
   * 面积折线图（成本趋势）
   * data: [{ date: 'MM-DD', cost: number }]
   */
  MEVPS.chartTrend = function (el, data, { color = '#646cff' } = {}) {
    if (!data || !data.length) {
      el.innerHTML = '<div class="empty">暂无数据</div>';
      return;
    }
    const W = 640;
    const H = 240;
    const pad = { l: 48, r: 16, t: 16, b: 30 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const max = Math.max(...data.map((d) => d.cost), 1) * 1.2;
    const x = (i) => pad.l + (iw * i) / Math.max(1, data.length - 1);
    const y = (v) => pad.t + ih - (ih * v) / max;

    const pts = data.map((d, i) => [x(i), y(d.cost)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const area = `${line} L ${x(data.length - 1).toFixed(1)} ${pad.t + ih} L ${pad.l} ${pad.t + ih} Z`;

    const gridLines = [0, 0.25, 0.5, 0.75, 1]
      .map((r) => {
        const gy = pad.t + ih - ih * r;
        return `<line x1="${pad.l}" y1="${gy}" x2="${W - pad.r}" y2="${gy}" stroke="#efeff2" stroke-width="1"/>
                <text x="${pad.l - 8}" y="${gy + 4}" text-anchor="end" font-size="11" fill="#bbb">¥${Math.round(max * r)}</text>`;
      })
      .join('');

    const xLabels = data
      .map((d, i) => `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#bbb">${d.date}</text>`)
      .join('');

    const dots = pts
      .map((p, i) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.5" fill="#fff" stroke="${color}" stroke-width="2"><title>${data[i].date}：${MEVPS.fmtMoney(data[i].cost)}</title></circle>`)
      .join('');

    el.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="${color}" stop-opacity="0.28"/>
            <stop offset="1" stop-color="${color}" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        ${gridLines}
        <path d="${area}" fill="url(#trendFill)"/>
        <path d="${line}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        ${dots}
        ${xLabels}
      </svg>`;
  };

  /**
   * 环形图（状态分布）
   * data: [{ label, count, color }]
   */
  MEVPS.chartDonut = function (el, data) {
    const total = data.reduce((s, d) => s + d.count, 0);
    if (!total) {
      el.innerHTML = '<div class="empty">暂无数据</div>';
      return;
    }
    const size = 160;
    const r = 60;
    const C = 2 * Math.PI * r;
    let offset = 0;
    const segs = data
      .filter((d) => d.count > 0)
      .map((d) => {
        const len = (C * d.count) / total;
        const seg = `<circle cx="80" cy="80" r="${r}" fill="none" stroke="${d.color}" stroke-width="18"
            stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}"
            stroke-dashoffset="${(-offset).toFixed(2)}"><title>${d.label}：${d.count}</title></circle>`;
        offset += len;
        return seg;
      })
      .join('');

    const legend = data
      .map(
        (d) => `<div class="legend-item"><span class="legend-dot" style="background:${d.color}"></span>${MEVPS.esc(d.label)}<b>${d.count}</b></div>`
      )
      .join('');

    el.innerHTML = `
      <div class="donut-flex">
        <svg viewBox="0 0 160 160" width="${size}" height="${size}" style="flex-shrink:0;transform:rotate(-90deg)">
          <circle cx="80" cy="80" r="${r}" fill="none" stroke="#f0f1f5" stroke-width="18"/>
          ${segs}
          <text x="80" y="76" text-anchor="middle" font-size="26" font-weight="700" fill="#262626" style="transform:rotate(90deg);transform-origin:80px 80px">${total}</text>
          <text x="80" y="98" text-anchor="middle" font-size="11" fill="#999" style="transform:rotate(90deg);transform-origin:80px 80px">VPS 总数</text>
        </svg>
        <div class="donut-legend">${legend}</div>
      </div>`;
  };
})();

;
/* ==== js/views/dashboard.js ==== */
/* ==== views/dashboard.js：数据仪表盘 ==== */
window.Views = window.Views || {};

Views.dashboard = {
  label: '数据仪表盘',
  icon: 'dashboard',
  async render(container) {
    container.innerHTML = `
      <div class="stat-grid" id="stat-cards">
        ${['green', 'blue', 'orange', 'purple'].map((c) => `<div class="stat-card"><div class="stat-icon ${c}">${MEVPS.icon('activity', 24)}</div><div class="stat-info"><div class="stat-label">加载中…</div><div class="stat-value">-</div></div></div>`).join('')}
      </div>
      <div class="charts-grid">
        <div class="card">
          <div class="card-header">近 7 天成本趋势<span class="muted" style="font-size:12px;color:#999;font-weight:400">日均摊成本</span></div>
          <div class="card-body"><div class="chart-wrap" id="chart-trend"></div></div>
        </div>
        <div class="card">
          <div class="card-header">VPS 状态分布</div>
          <div class="card-body" id="chart-donut"></div>
        </div>
      </div>
      <div class="bottom-grid">
        <div class="card">
          <div class="card-header">最近操作</div>
          <div class="card-body"><div class="log-list" id="recent-logs"></div></div>
        </div>
        <div class="card">
          <div class="card-header">系统信息</div>
          <div class="card-body"><div class="info-list" id="sys-info"></div></div>
        </div>
      </div>`;

    let s;
    try {
      s = await MEVPS.api('/stats');
    } catch (e) {
      MEVPS.toast(e.message, 'error');
      return;
    }

    const cards = [
      { label: 'VPS 总数', value: s.total, sub: '全部在册服务器', icon: 'server', cls: 'green' },
      { label: '运行中', value: s.running, sub: '状态正常运行', icon: 'play', cls: 'blue' },
      { label: '已停止 / 维护', value: s.stopped + s.maintenance, sub: `停止 ${s.stopped} · 维护 ${s.maintenance}`, icon: 'stop', cls: 'orange' },
      { label: '月度总成本', value: MEVPS.fmtMoney(s.monthlyCost), sub: '按当前配置估算', icon: 'money', cls: 'purple' },
    ];
    MEVPS.$('#stat-cards').innerHTML = cards
      .map(
        (c) => `<div class="stat-card">
          <div class="stat-icon ${c.cls}">${MEVPS.icon(c.icon, 24)}</div>
          <div class="stat-info">
            <div class="stat-label">${c.label}</div>
            <div class="stat-value">${c.value}</div>
            <div class="stat-sub">${c.sub}</div>
          </div>
        </div>`
      )
      .join('');

    MEVPS.chartTrend(MEVPS.$('#chart-trend'), s.trend);

    const colorMap = { running: '#52c41a', stopped: '#999999', maintenance: '#faad14' };
    const nameMap = { running: '运行中', stopped: '已停止', maintenance: '维护中' };
    MEVPS.chartDonut(
      MEVPS.$('#chart-donut'),
      (s.dist || []).map((d) => ({ label: nameMap[d.status] || d.status, count: d.count, color: colorMap[d.status] || '#646cff' }))
    );

    const tagMap = { 登录: 'tag-success', 新增: 'tag-info', 修改: 'tag-warning', 删除: 'tag-error', 登出: 'tag-default', 初始化: 'tag-default', 启动: 'tag-success', 停止: 'tag-default', 重启: 'tag-warning', 设置: 'tag-info' };
    MEVPS.$('#recent-logs').innerHTML =
      (s.recentLogs || []).map((l) => `
        <div class="log-item">
          <span class="tag ${tagMap[l.action] || 'tag-default'} log-action">${MEVPS.esc(l.action)}</span>
          <span class="log-detail">${MEVPS.esc(l.detail)}</span>
          <span class="log-time">${MEVPS.fmtTime(l.created_at)}</span>
        </div>`).join('') || '<div class="empty">暂无日志</div>';

    const expireRows = (s.expireSoon || [])
      .map((v) => `<div class="info-row"><span class="k">${MEVPS.esc(v.name)}</span><span class="v">${MEVPS.esc(v.expire_date || '-')}</span></div>`)
      .join('');
    MEVPS.$('#sys-info').innerHTML = `
      <div class="info-row"><span class="k">站点名称</span><span class="v">${MEVPS.esc(s.siteName)}</span></div>
      <div class="info-row"><span class="k">系统版本</span><span class="v">v${MEVPS.esc(s.version)}</span></div>
      <div class="info-row"><span class="k">运行平台</span><span class="v">Cloudflare Workers</span></div>
      <div class="info-row"><span class="k">数据存储</span><span class="v">D1 · 绑定 db</span></div>
      <div class="info-row"><span class="k">静态资源</span><span class="v">边缘直出 · 内容哈希缓存</span></div>
      ${expireRows ? `<div style="border-top:1px dashed #efeff2;padding-top:12px;font-size:12px;color:#999">最近到期</div>${expireRows}` : ''}`;
  },
};

;
/* ==== js/views/vps.js ==== */
/* ==== views/vps.js：VPS 管理 ==== */
window.Views = window.Views || {};

Views.vps = {
  label: 'VPS管理',
  icon: 'server',
  state: { page: 1, pageSize: 10, keyword: '', status: '' },

  async render(container) {
    const st = this.state;
    container.innerHTML = `
      <div class="card">
        <div class="card-body" style="padding-top:20px">
          <div class="toolbar">
            <div class="input-wrap"><span class="input-icon">${MEVPS.icon('search', 15)}</span>
              <input class="input" id="vps-keyword" placeholder="搜索名称 / IP / 地区" value="${MEVPS.esc(st.keyword)}" style="padding-left:34px" /></div>
            <select class="select" id="vps-status" style="width:140px">
              <option value="">全部状态</option>
              <option value="running">运行中</option>
              <option value="stopped">已停止</option>
              <option value="maintenance">维护中</option>
            </select>
            <button class="btn btn-sm" id="vps-refresh">${MEVPS.icon('refresh', 14)} 刷新</button>
            <div class="spacer"></div>
            <button class="btn btn-primary btn-sm" id="vps-add">${MEVPS.icon('plus', 14)} 新增 VPS</button>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>ID</th><th>名称</th><th>IP 地址</th><th>地区</th><th>配置</th><th>提供商</th>
                  <th>状态</th><th>月费</th><th>到期时间</th><th style="width:200px">操作</th>
                </tr>
              </thead>
              <tbody id="vps-tbody"><tr><td colspan="10" class="empty">加载中…</td></tr></tbody>
            </table>
          </div>
          <div class="pagination" id="vps-pagination"></div>
        </div>
      </div>`;

    MEVPS.$('#vps-status').value = st.status;
    MEVPS.$('#vps-keyword').addEventListener('input', MEVPS.debounce((e) => {
      st.keyword = e.target.value.trim();
      st.page = 1;
      this.load();
    }, 350));
    MEVPS.$('#vps-status').addEventListener('change', (e) => {
      st.status = e.target.value;
      st.page = 1;
      this.load();
    });
    MEVPS.$('#vps-refresh').addEventListener('click', () => this.load());
    MEVPS.$('#vps-add').addEventListener('click', () => this.openForm());
    this.load();
  },

  async load() {
    const st = this.state;
    const tbody = MEVPS.$('#vps-tbody');
    if (!tbody) return;
    let res;
    try {
      res = await MEVPS.api('/vps', { params: { page: st.page, pageSize: st.pageSize, keyword: st.keyword, status: st.status } });
    } catch (e) {
      MEVPS.toast(e.message, 'error');
      return;
    }
    const statusTag = { running: '<span class="tag tag-success">运行中</span>', stopped: '<span class="tag tag-default">已停止</span>', maintenance: '<span class="tag tag-warning">维护中</span>' };
    tbody.innerHTML =
      res.list.map((v) => `
        <tr>
          <td class="muted">#${v.id}</td>
          <td><b>${MEVPS.esc(v.name)}</b>${v.remark ? `<div class="muted" style="font-size:12px">${MEVPS.esc(v.remark)}</div>` : ''}</td>
          <td><code>${MEVPS.esc(v.ip)}</code></td>
          <td>${MEVPS.esc(v.region || '-')}</td>
          <td>${MEVPS.esc(v.spec || '-')}</td>
          <td>${MEVPS.esc(v.provider || '-')}</td>
          <td>${statusTag[v.status] || MEVPS.esc(v.status)}</td>
          <td>${MEVPS.fmtMoney(v.price)}</td>
          <td>${MEVPS.esc(v.expire_date || '-')}</td>
          <td class="actions">
            <a class="link" data-act="toggle" data-id="${v.id}" data-status="${v.status}">${v.status === 'running' ? '停止' : '启动'}</a>
            <a class="link" data-act="edit" data-id="${v.id}">编辑</a>
            <a class="link" style="color:#f5222d" data-act="del" data-id="${v.id}">删除</a>
          </td>
        </tr>`).join('') || '<tr><td colspan="10" class="empty">暂无数据</td></tr>';

    MEVPS.pager(MEVPS.$('#vps-pagination'), {
      page: res.page,
      pageSize: res.pageSize,
      total: res.total,
      onChange: (p) => {
        st.page = p;
        this.load();
      },
    });

    tbody.onclick = async (e) => {
      const a = e.target.closest('a[data-act]');
      if (!a) return;
      const id = Number(a.dataset.id);
      const item = res.list.find((v) => v.id === id);
      if (!item) return;
      if (a.dataset.act === 'edit') return this.openForm(item);
      if (a.dataset.act === 'del') {
        if (!(await MEVPS.confirm(`确定删除 VPS「${MEVPS.esc(item.name)}」吗？此操作不可恢复。`))) return;
        try {
          await MEVPS.api(`/vps/${id}`, { method: 'DELETE' });
          MEVPS.toast('已删除', 'success');
          this.load();
        } catch (err) {
          MEVPS.toast(err.message, 'error');
        }
      }
      if (a.dataset.act === 'toggle') {
        const action = item.status === 'running' ? 'stop' : 'start';
        try {
          await MEVPS.api(`/vps/${id}/action`, { method: 'POST', body: { action } });
          MEVPS.toast(action === 'stop' ? '已停止' : '已启动', 'success');
          this.load();
        } catch (err) {
          MEVPS.toast(err.message, 'error');
        }
      }
    };
  },

  openForm(item) {
    const isEdit = !!item;
    const v = item || {};
    const content = `
      <div class="form-grid">
        <label class="field"><span class="field-label required">名称</span>
          <input class="input" id="f-name" value="${MEVPS.esc(v.name || '')}" placeholder="如 web-01" /></label>
        <label class="field"><span class="field-label required">IP 地址</span>
          <input class="input" id="f-ip" value="${MEVPS.esc(v.ip || '')}" placeholder="如 192.0.2.11" /></label>
        <label class="field"><span class="field-label">地区</span>
          <input class="input" id="f-region" value="${MEVPS.esc(v.region || '')}" placeholder="如 东京" /></label>
        <label class="field"><span class="field-label">配置</span>
          <input class="input" id="f-spec" value="${MEVPS.esc(v.spec || '')}" placeholder="如 2C4G / 60G SSD" /></label>
        <label class="field"><span class="field-label">提供商</span>
          <input class="input" id="f-provider" value="${MEVPS.esc(v.provider || '')}" placeholder="如 Vultr" /></label>
        <label class="field"><span class="field-label">状态</span>
          <select class="select" id="f-status">
            <option value="running">运行中</option>
            <option value="stopped">已停止</option>
            <option value="maintenance">维护中</option>
          </select></label>
        <label class="field"><span class="field-label">月费 (元)</span>
          <input class="input" id="f-price" type="number" min="0" step="0.01" value="${v.price ?? ''}" placeholder="0.00" /></label>
        <label class="field"><span class="field-label">到期时间</span>
          <input class="input" id="f-expire" type="date" value="${MEVPS.esc(v.expire_date || '')}" /></label>
        <label class="field span-2"><span class="field-label">备注</span>
          <textarea class="input" id="f-remark" placeholder="备注信息">${MEVPS.esc(v.remark || '')}</textarea></label>
      </div>`;

    const self = this;
    MEVPS.modal({
      title: isEdit ? '编辑 VPS' : '新增 VPS',
      content,
      okText: isEdit ? '保 存' : '创 建',
      onOk(overlay, close) {
        const g = (id) => overlay.querySelector('#' + id).value.trim();
        const name = g('f-name');
        const ip = g('f-ip');
        if (!name || !ip) {
          MEVPS.toast('名称和 IP 为必填项', 'error');
          return false;
        }
        const body = {
          name,
          ip,
          region: g('f-region'),
          spec: g('f-spec'),
          provider: g('f-provider'),
          status: overlay.querySelector('#f-status').value,
          price: Number(g('f-price')) || 0,
          expire_date: g('f-expire'),
          remark: g('f-remark'),
        };
        MEVPS.api(isEdit ? `/vps/${v.id}` : '/vps', { method: isEdit ? 'PUT' : 'POST', body })
          .then(() => {
            MEVPS.toast(isEdit ? '已保存' : '已创建', 'success');
            close();
            self.load();
          })
          .catch((e) => MEVPS.toast(e.message, 'error'));
        return false;
      },
    });
    if (isEdit) MEVPS.$('#f-status', document.getElementById('modal-root')).value = v.status || 'running';
  },
};

;
/* ==== js/views/logs.js ==== */
/* ==== views/logs.js：操作日志 ==== */
window.Views = window.Views || {};

Views.logs = {
  label: '操作日志',
  icon: 'log',
  state: { page: 1, pageSize: 12, keyword: '', action: '' },

  async render(container) {
    const st = this.state;
    container.innerHTML = `
      <div class="card">
        <div class="card-body" style="padding-top:20px">
          <div class="toolbar">
            <div class="input-wrap"><span class="input-icon">${MEVPS.icon('search', 15)}</span>
              <input class="input" id="log-keyword" placeholder="搜索操作人 / 目标 / 详情" value="${MEVPS.esc(st.keyword)}" style="padding-left:34px" /></div>
            <select class="select" id="log-action" style="width:140px">
              <option value="">全部类型</option>
              <option value="登录">登录</option>
              <option value="登出">登出</option>
              <option value="新增">新增</option>
              <option value="修改">修改</option>
              <option value="删除">删除</option>
              <option value="启动">启动</option>
              <option value="停止">停止</option>
              <option value="重启">重启</option>
              <option value="设置">设置</option>
            </select>
            <button class="btn btn-sm" id="log-refresh">${MEVPS.icon('refresh', 14)} 刷新</button>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr><th>ID</th><th>时间</th><th>操作人</th><th>类型</th><th>目标</th><th>详情</th><th>IP</th><th>结果</th></tr>
              </thead>
              <tbody id="log-tbody"><tr><td colspan="8" class="empty">加载中…</td></tr></tbody>
            </table>
          </div>
          <div class="pagination" id="log-pagination"></div>
        </div>
      </div>`;

    MEVPS.$('#log-action').value = st.action;
    MEVPS.$('#log-keyword').addEventListener('input', MEVPS.debounce((e) => {
      st.keyword = e.target.value.trim();
      st.page = 1;
      this.load();
    }, 350));
    MEVPS.$('#log-action').addEventListener('change', (e) => {
      st.action = e.target.value;
      st.page = 1;
      this.load();
    });
    MEVPS.$('#log-refresh').addEventListener('click', () => this.load());
    this.load();
  },

  async load() {
    const st = this.state;
    const tbody = MEVPS.$('#log-tbody');
    if (!tbody) return;
    let res;
    try {
      res = await MEVPS.api('/logs', { params: { page: st.page, pageSize: st.pageSize, keyword: st.keyword, action: st.action } });
    } catch (e) {
      MEVPS.toast(e.message, 'error');
      return;
    }
    const tagMap = { 登录: 'tag-success', 新增: 'tag-info', 修改: 'tag-warning', 删除: 'tag-error', 登出: 'tag-default', 初始化: 'tag-default', 启动: 'tag-success', 停止: 'tag-default', 重启: 'tag-warning', 设置: 'tag-info' };
    tbody.innerHTML =
      res.list.map((l) => `
        <tr>
          <td class="muted">#${l.id}</td>
          <td class="muted">${MEVPS.fmtTime(l.created_at)}</td>
          <td><b>${MEVPS.esc(l.username)}</b></td>
          <td><span class="tag ${tagMap[l.action] || 'tag-default'}">${MEVPS.esc(l.action)}</span></td>
          <td>${MEVPS.esc(l.target)}</td>
          <td class="muted">${MEVPS.esc(l.detail)}</td>
          <td><code>${MEVPS.esc(l.ip || '-')}</code></td>
          <td>${l.status === 'fail' ? '<span class="tag tag-error">失败</span>' : '<span class="tag tag-success">成功</span>'}</td>
        </tr>`).join('') || '<tr><td colspan="8" class="empty">暂无日志</td></tr>';

    MEVPS.pager(MEVPS.$('#log-pagination'), {
      page: res.page,
      pageSize: res.pageSize,
      total: res.total,
      onChange: (p) => {
        st.page = p;
        this.load();
      },
    });
  },
};

;
/* ==== js/views/settings.js ==== */
/* ==== views/settings.js：系统设置（变量全部存 D1） ==== */
window.Views = window.Views || {};

Views.settings = {
  label: '系统设置',
  icon: 'setting',

  async render(container) {
    container.innerHTML = `
      <div class="settings-grid">
        <div class="card">
          <div class="card-header">基础设置</div>
          <div class="card-body">
            <div class="settings-form">
              <label class="field"><span class="field-label">站点名称</span>
                <input class="input" id="s-name" maxlength="50" /></label>
              <label class="field"><span class="field-label">站点描述</span>
                <textarea class="input" id="s-desc" maxlength="200"></textarea></label>
              <label class="field"><span class="field-label">会话有效期（小时）</span>
                <input class="input" id="s-session" type="number" min="1" max="720" /></label>
              <div class="form-actions"><button class="btn btn-primary" id="s-save">保存设置</button></div>
              <p style="margin-top:14px;font-size:12px;color:#999;line-height:1.8">
                所有变量均保存在 D1 数据库 <code>settings</code> 表中，不使用环境变量。<br/>初始化时间：<span id="s-init-at">-</span>
              </p>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-header">账号安全</div>
          <div class="card-body">
            <div class="settings-form">
              <label class="field"><span class="field-label">当前用户名</span>
                <input class="input" id="p-username" /></label>
              <label class="field"><span class="field-label required">当前密码</span>
                <input class="input" id="p-old" type="password" placeholder="修改任意项都需验证当前密码" /></label>
              <label class="field"><span class="field-label">新密码（留空则不修改）</span>
                <input class="input" id="p-new" type="password" placeholder="至少 6 位" /></label>
              <label class="field"><span class="field-label">确认新密码</span>
                <input class="input" id="p-new2" type="password" placeholder="再次输入新密码" /></label>
              <div class="form-actions"><button class="btn btn-primary" id="p-save">保存账号信息</button></div>
              <p style="margin-top:14px;font-size:12px;color:#999;line-height:1.8">
                提示：默认账号 <code>admin</code> / <code>123456</code>，首次部署后请立即修改。
              </p>
            </div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">部署信息</div>
        <div class="card-body">
          <div class="info-list" style="max-width:640px">
            <div class="info-row"><span class="k">前端资源</span><span class="v">assets/ 静态资源 · Cloudflare 边缘直接响应</span></div>
            <div class="info-row"><span class="k">缓存策略</span><span class="v">内容哈希文件名 · 长期缓存（immutable）</span></div>
            <div class="info-row"><span class="k">Worker 额度</span><span class="v">静态资源命中不进入 Worker，不消耗请求额度</span></div>
            <div class="info-row"><span class="k">数据存储</span><span class="v">D1（绑定变量名 db · 库名 mevps），表结构自动初始化</span></div>
            <div class="info-row"><span class="k">主题风格</span><span class="v">SoybeanAdmin（NaiveUI 设计语言）</span></div>
          </div>
        </div>
      </div>`;

    let s;
    try {
      s = await MEVPS.api('/settings');
    } catch (e) {
      MEVPS.toast(e.message, 'error');
      return;
    }
    MEVPS.$('#s-name').value = s.site_name;
    MEVPS.$('#s-desc').value = s.site_desc;
    MEVPS.$('#s-session').value = s.session_hours;
    MEVPS.$('#s-init-at').textContent = s.init_at || '-';
    MEVPS.$('#p-username').value = MEVPS.savedUser() || 'admin';

    MEVPS.$('#s-save').addEventListener('click', async () => {
      try {
        await MEVPS.api('/settings', {
          method: 'PUT',
          body: {
            site_name: MEVPS.$('#s-name').value,
            site_desc: MEVPS.$('#s-desc').value,
            session_hours: Number(MEVPS.$('#s-session').value) || 24,
          },
        });
        MEVPS.toast('设置已保存', 'success');
      } catch (e) {
        MEVPS.toast(e.message, 'error');
      }
    });

    MEVPS.$('#p-save').addEventListener('click', async () => {
      const oldPassword = MEVPS.$('#p-old').value;
      const newPassword = MEVPS.$('#p-new').value;
      const new2 = MEVPS.$('#p-new2').value;
      const username = MEVPS.$('#p-username').value.trim();
      if (!oldPassword) return MEVPS.toast('请输入当前密码', 'error');
      if (newPassword && newPassword.length < 6) return MEVPS.toast('新密码至少 6 位', 'error');
      if (newPassword !== new2) return MEVPS.toast('两次输入的新密码不一致', 'error');
      try {
        const r = await MEVPS.api('/profile', {
          method: 'PUT',
          body: { username, old_password: oldPassword, new_password: newPassword },
        });
        MEVPS.setToken(MEVPS.getToken(), r.username);
        MEVPS.$('#user-name').textContent = r.username;
        MEVPS.$('#user-avatar').textContent = (r.username || 'A')[0].toUpperCase();
        MEVPS.toast('账号信息已更新', 'success');
        MEVPS.$('#p-old').value = '';
        MEVPS.$('#p-new').value = '';
        MEVPS.$('#p-new2').value = '';
      } catch (e) {
        MEVPS.toast(e.message, 'error');
      }
    });
  },
};

;
/* ==== js/app.js ==== */
/* ==== app.js：登录 / 布局 / 路由 / 多标签页 ==== */
(function () {
  const MENU = ['dashboard', 'vps', 'logs', 'settings'];
  let tabs = []; // { key, closable }

  /* ---------------- 登录页 ---------------- */
  const loginPage = () => document.getElementById('login-page');
  const appLayout = () => document.getElementById('app-layout');

  function showLogin() {
    loginPage().classList.remove('hidden');
    appLayout().classList.add('hidden');
  }

  function showLayout() {
    loginPage().classList.add('hidden');
    appLayout().classList.remove('hidden');
    const user = MEVPS.savedUser() || 'admin';
    document.getElementById('user-name').textContent = user;
    document.getElementById('user-avatar').textContent = user[0].toUpperCase();
    renderMenu(currentKey());
  }

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('login-btn');
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    if (!username || !password) return MEVPS.toast('请输入用户名和密码', 'error');
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const r = await MEVPS.api('/login', { method: 'POST', body: { username, password } });
      MEVPS.setToken(r.token, r.username);
      MEVPS.toast('登录成功', 'success');
      tabs = [];
      location.hash = '#/dashboard';
      showLayout();
      route();
    } catch (err) {
      MEVPS.toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '登 录';
    }
  });

  /* ---------------- 侧边菜单 ---------------- */
  function renderMenu(active) {
    document.getElementById('side-menu').innerHTML = MENU.map((key) => {
      const v = Views[key];
      return `<div class="menu-item ${key === active ? 'active' : ''}" data-key="${key}">
        ${MEVPS.icon(v.icon, 18)}<span>${v.label}</span>
      </div>`;
    }).join('');
    document.getElementById('side-menu').onclick = (e) => {
      const item = e.target.closest('.menu-item[data-key]');
      if (item) location.hash = '#/' + item.dataset.key;
    };
  }

  /* ---------------- 多标签页（TagsView） ---------------- */
  function renderTabs(active) {
    const bar = document.getElementById('tabs-bar');
    bar.innerHTML = tabs
      .map((t) => {
        const v = Views[t.key];
        return `<div class="tab-chip ${t.key === active ? 'active' : ''}" data-key="${t.key}">
          ${t.closable ? '' : '<span class="tab-dot"></span>'}
          <span>${v.label}</span>
          ${t.closable ? `<span class="tab-close" data-close="${t.key}">${MEVPS.icon('x', 10, 3)}</span>` : ''}
        </div>`;
      })
      .join('');
    bar.onclick = (e) => {
      const close = e.target.closest('[data-close]');
      if (close) {
        e.stopPropagation();
        closeTab(close.dataset.close);
        return;
      }
      const chip = e.target.closest('.tab-chip');
      if (chip) location.hash = '#/' + chip.dataset.key;
    };
  }

  function openTab(key) {
    if (!tabs.find((t) => t.key === key)) {
      tabs.push({ key, closable: key !== 'dashboard' });
    }
  }

  function closeTab(key) {
    const idx = tabs.findIndex((t) => t.key === key);
    if (idx < 0 || !tabs[idx].closable) return;
    tabs.splice(idx, 1);
    if (currentKey() === key) {
      const next = tabs[idx] || tabs[tabs.length - 1] || { key: 'dashboard' };
      location.hash = '#/' + next.key;
    } else {
      renderTabs(currentKey());
    }
  }

  /* ---------------- 路由 ---------------- */
  function currentKey() {
    const key = (location.hash || '#/dashboard').replace(/^#\//, '').split('?')[0];
    return MENU.includes(key) ? key : 'dashboard';
  }

  async function route() {
    if (!MEVPS.getToken()) return showLogin();
    const key = currentKey();
    openTab(key);
    renderMenu(key);
    renderTabs(key);
    document.getElementById('breadcrumb-current').textContent = Views[key].label;
    document.title = Views[key].label + ' · MEVPS';
    const container = document.getElementById('view-container');
    container.innerHTML = '<div class="empty">加载中…</div>';
    try {
      await Views[key].render(container);
    } catch (e) {
      container.innerHTML = `<div class="empty">${MEVPS.esc(e.message || '加载失败')}</div>`;
    }
    container.scrollTop = 0;
  }

  window.addEventListener('hashchange', route);

  /* ---------------- 顶栏交互 ---------------- */
  document.getElementById('collapse-btn').addEventListener('click', () => {
    const sider = document.getElementById('sider');
    const collapsed = sider.dataset.collapsed === '1';
    sider.dataset.collapsed = collapsed ? '0' : '1';
    sider.style.width = collapsed ? 'var(--sidebar-width)' : 'var(--sidebar-collapsed)';
    MEVPS.$$('.menu-item span', sider).forEach((el) => (el.style.display = collapsed ? '' : 'none'));
    MEVPS.$('.logo-text', sider).style.display = collapsed ? '' : 'none';
  });

  const userChip = document.getElementById('user-chip');
  userChip.addEventListener('click', (e) => {
    if (!e.target.closest('.dropdown')) userChip.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!userChip.contains(e.target)) userChip.classList.remove('open');
  });

  document.getElementById('menu-logout').addEventListener('click', async () => {
    try {
      await MEVPS.api('/logout', { method: 'POST', body: {} });
    } catch (e) {
      /* ignore */
    }
    MEVPS.clearToken();
    tabs = [];
    showLogin();
    MEVPS.toast('已退出登录', 'info');
  });

  document.getElementById('menu-settings').addEventListener('click', () => {
    location.hash = '#/settings';
  });

  document.getElementById('menu-profile').addEventListener('click', () => {
    location.hash = '#/settings';
    setTimeout(() => {
      const el = document.getElementById('p-old');
      if (el) el.focus();
    }, 120);
  });

  /* ---------------- 未授权跳转 ---------------- */
  window.addEventListener('mevps:unauthorized', () => {
    tabs = [];
    showLogin();
    MEVPS.toast('登录已过期，请重新登录', 'error');
  });

  /* ---------------- 启动 ---------------- */
  (async function boot() {
    if (!MEVPS.getToken()) {
      showLogin();
      return;
    }
    try {
      const me = await MEVPS.api('/me');
      MEVPS.setToken(MEVPS.getToken(), me.username);
      showLayout();
      if (!location.hash) location.hash = '#/dashboard';
      route();
    } catch (e) {
      /* 401 已由 api.js 处理 */
    }
  })();
})();
