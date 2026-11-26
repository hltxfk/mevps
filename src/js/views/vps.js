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
