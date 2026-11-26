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
          <div class="card-header">近 7 天新增 VPS<span class="muted" style="font-size:12px;color:#999;font-weight:400">每日新增记录</span></div>
          <div class="card-body"><div class="chart-wrap" id="chart-trend"></div></div>
        </div>
        <div class="card">
          <div class="card-header">同步状态分布</div>
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
      { label: '在线', value: s.online, sub: '连接检测可达', icon: 'play', cls: 'blue' },
      { label: '离线 / 未检测', value: s.offline + s.unknown, sub: `离线 ${s.offline} · 未检测 ${s.unknown}`, icon: 'stop', cls: 'orange' },
      { label: '已同步', value: (s.dist || []).filter((d) => d.status === 'ok').reduce((a, b) => a + b.count, 0), sub: '配置 / 归属地已回填', icon: 'check', cls: 'purple' },
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

    MEVPS.chartTrend(MEVPS.$('#chart-trend'), s.trend, { valueKey: 'count', prefix: '' });

    const colorMap = { ok: '#52c41a', running: '#646cff', pending: '#faad14', error: '#f5222d', idle: '#999999' };
    const nameMap = { ok: '已同步', running: '同步中', pending: '待同步', error: '同步失败', idle: '未同步' };
    MEVPS.chartDonut(
      MEVPS.$('#chart-donut'),
      (s.dist || []).map((d) => ({ label: nameMap[d.status] || d.status, count: d.count, color: colorMap[d.status] || '#646cff' }))
    );

    const tagMap = { 登录: 'tag-success', 新增: 'tag-info', 修改: 'tag-warning', 删除: 'tag-error', 登出: 'tag-default', 初始化: 'tag-default', 启动: 'tag-success', 停止: 'tag-default', 重启: 'tag-warning', 设置: 'tag-info', 同步: 'tag-info' };
    MEVPS.$('#recent-logs').innerHTML =
      (s.recentLogs || []).map((l) => `
        <div class="log-item">
          <span class="tag ${tagMap[l.action] || 'tag-default'} log-action">${MEVPS.esc(l.action)}</span>
          <span class="log-detail">${MEVPS.esc(l.detail)}</span>
          <span class="log-time">${MEVPS.fmtTime(l.created_at)}</span>
        </div>`).join('') || '<div class="empty">暂无日志</div>';

    const needRows = (s.needSync || [])
      .map((v) => `<div class="info-row"><span class="k">${MEVPS.esc(v.name)}</span><span class="v">${MEVPS.esc(v.sync_status === 'error' ? (v.sync_error || '同步失败') : v.sync_status)}</span></div>`)
      .join('');
    MEVPS.$('#sys-info').innerHTML = `
      <div class="info-row"><span class="k">站点名称</span><span class="v">${MEVPS.esc(s.siteName)}</span></div>
      <div class="info-row"><span class="k">系统版本</span><span class="v">v${MEVPS.esc(s.version)}</span></div>
      <div class="info-row"><span class="k">运行平台</span><span class="v">Cloudflare Workers</span></div>
      <div class="info-row"><span class="k">数据存储</span><span class="v">D1 · 绑定 db</span></div>
      <div class="info-row"><span class="k">静态资源</span><span class="v">边缘直出 · 内容哈希缓存</span></div>
      ${needRows ? `<div style="border-top:1px dashed #efeff2;padding-top:12px;font-size:12px;color:#999">待同步 / 同步失败</div>${needRows}` : ''}`;
  },
};
