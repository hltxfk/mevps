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
