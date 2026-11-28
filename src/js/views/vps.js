/* ==== views/vps.js：VPS 管理 ==== */
window.Views = window.Views || {};

Views.vps = {
  label: 'VPS管理',
  icon: 'server',
  state: { page: 1, pageSize: 10, keyword: '', status: '', selected: new Set() },

  async render(container) {
    const st = this.state;
    container.innerHTML = `
      <div class="card">
        <div class="card-body" style="padding-top:20px">
          <div class="toolbar">
            <div class="input-wrap"><span class="input-icon">${MEVPS.icon('search', 15)}</span>
              <input class="input" id="vps-keyword" placeholder="搜索名称 / IP / 地区" value="${MEVPS.esc(st.keyword)}" style="padding-left:34px" /></div>
            <select class="select" id="vps-status" style="width:150px">
              <option value="">全部同步状态</option>
              <option value="ok">已同步</option>
              <option value="running">同步中</option>
              <option value="pending">待同步</option>
              <option value="error">同步失败</option>
              <option value="idle">未同步</option>
            </select>
            <button class="btn btn-sm" id="vps-refresh">${MEVPS.icon('refresh', 14)} 刷新</button>
            <button class="btn btn-danger btn-sm" id="vps-batch-del" disabled>${MEVPS.icon('trash', 14)} 批量删除</button>
            <div class="spacer"></div>
            <button class="btn btn-primary btn-sm" id="vps-add">${MEVPS.icon('plus', 14)} 新增 VPS</button>
            <button class="btn btn-sm" id="vps-ssh-cfg" title="配置 GitHub Actions 触发凭据">${MEVPS.icon('key', 14)} SSH设置</button>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th class="col-check"><input type="checkbox" id="vps-check-all" title="全选 / 取消全选" /></th>
                  <th>ID</th><th>名称</th><th>IP 地址</th><th>配置</th>
                  <th>添加时间</th><th>同步状态</th><th style="width:260px">操作</th>
                </tr>
              </thead>
              <tbody id="vps-tbody"><tr><td colspan="8" class="empty">加载中…</td></tr></tbody>
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
    MEVPS.$('#vps-ssh-cfg').addEventListener('click', () => this.openActionsCfg());
    const tbodyEl = MEVPS.$('#vps-tbody');
    MEVPS.$('#vps-check-all').addEventListener('change', (e) => {
      MEVPS.$$('.row-check', tbodyEl).forEach((b) => {
        b.checked = e.target.checked;
        const id = Number(b.dataset.id);
        if (e.target.checked) st.selected.add(id);
        else st.selected.delete(id);
      });
      this.updateBatchUI();
    });
    tbodyEl.addEventListener('change', (e) => {
      const b = e.target.closest('.row-check');
      if (!b) return;
      const id = Number(b.dataset.id);
      if (b.checked) st.selected.add(id);
      else st.selected.delete(id);
      this.updateBatchUI();
    });
    MEVPS.$('#vps-batch-del').addEventListener('click', () => this.batchDelete());
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
    const syncTag = {
      ok: '<span class="tag tag-success">已同步</span>',
      running: '<span class="tag tag-warning">同步中</span>',
      pending: '<span class="tag tag-warning">待同步</span>',
      error: '<span class="tag tag-error">失败</span>',
      idle: '<span class="tag tag-default">未同步</span>',
    };
    tbody.innerHTML =
      res.list.map((v) => {
        return `
        <tr>
          <td class="col-check"><input type="checkbox" class="row-check" data-id="${v.id}" ${st.selected.has(v.id) ? 'checked' : ''} /></td>
          <td class="muted">#${v.id}</td>
          <td><b>${MEVPS.esc(v.name)}</b>${v.remark ? `<div class="muted" style="font-size:12px">${MEVPS.esc(v.remark)}</div>` : ''}</td>
          <td>${MEVPS.hostCell(v)}</td>
          <td>${MEVPS.specCell(v.spec)}</td>
          <td class="muted">${MEVPS.esc((v.created_at || '').slice(0, 10))}</td>
          <td>${syncTag[v.sync_status] || MEVPS.esc(v.sync_status)}${v.sync_error ? `<div class="muted" style="font-size:11px">${MEVPS.esc(v.sync_error)}</div>` : ''}</td>
          <td class="actions">
            <a class="link" data-act="sync" data-id="${v.id}">获取配置</a>
            <a class="link" data-act="term" data-id="${v.id}">终端</a>
            <a class="link" data-act="edit" data-id="${v.id}">编辑</a>
            <a class="link" style="color:#f5222d" data-act="del" data-id="${v.id}">删除</a>
          </td>
        </tr>`;
      }).join('') || '<tr><td colspan="8" class="empty">暂无数据</td></tr>';

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
      if (a.dataset.act === 'term') return this.openTerminal(item);
      if (a.dataset.act === 'del') {
        if (!(await MEVPS.confirm(`确定删除 VPS「${MEVPS.esc(item.name)}」吗？此操作不可恢复。`))) return;
        try {
          await MEVPS.api(`/vps/${id}`, { method: 'DELETE' });
          st.selected.delete(id);
          MEVPS.toast('已删除', 'success');
          this.load();
        } catch (err) {
          MEVPS.toast(err.message, 'error');
        }
      }
      if (a.dataset.act === 'sync') {
        try {
          await MEVPS.api(`/vps/${id}/action`, { method: 'POST', body: { action: 'sync' } });
          MEVPS.toast('已触发同步，稍后自动刷新', 'success');
          this.load();
        } catch (err) {
          MEVPS.toast(err.message, 'error');
        }
      }
    };

    this.updateBatchUI();
  },

  /* 同步批量删除按钮与表头全选状态 */
  updateBatchUI() {
    const btn = MEVPS.$('#vps-batch-del');
    const tbody = MEVPS.$('#vps-tbody');
    if (!btn || !tbody) return;
    const n = this.state.selected.size;
    btn.disabled = n === 0;
    btn.innerHTML = `${MEVPS.icon('trash', 14)} 批量删除${n ? `（${n}）` : ''}`;
    MEVPS.syncCheckAll(MEVPS.$('#vps-check-all'), tbody, this.state.selected);
  },

  async batchDelete() {
    const st = this.state;
    const ids = [...st.selected];
    if (!ids.length) return MEVPS.toast('请先勾选要删除的记录', 'info');
    if (!(await MEVPS.confirm(`确定删除选中的 ${ids.length} 条 VPS 记录吗？此操作不可恢复。`))) return;
    try {
      const r = await MEVPS.api('/vps/batch-delete', { method: 'POST', body: { ids } });
      MEVPS.toast(`已删除 ${r.deleted} 条`, 'success');
      st.selected.clear();
      this.load();
    } catch (e) {
      MEVPS.toast(e.message, 'error');
    }
  },

  /* ---- SSH 设置：配置 GitHub Actions 触发凭据（Token 加密存储、不回显） ---- */
  async openActionsCfg() {
    let cfg;
    try {
      cfg = await MEVPS.api('/actions');
    } catch (e) {
      return MEVPS.toast(e.message, 'error');
    }
    const content = `
      <div class="form-grid">
        <label class="field span-2"><span class="field-label required">GitHub 仓库（Actions 所在仓库）</span>
          <input class="input" id="a-repo" value="${MEVPS.esc(cfg.repo || '')}" placeholder="如 hltxfk/mevps" spellcheck="false" autocomplete="off" /></label>
        <label class="field"><span class="field-label">触发事件类型</span>
          <input class="input" id="a-event" value="${MEVPS.esc(cfg.event || 'vps-sync')}" placeholder="vps-sync" spellcheck="false" autocomplete="off" /></label>
        <label class="field"><span class="field-label">启用哪个 Token</span>
          <select class="select" id="a-token-type">
            <option value="classic" ${cfg.active_type !== 'fine' ? 'selected' : ''}>Classic PAT（repo 权限）</option>
            <option value="fine" ${cfg.active_type === 'fine' ? 'selected' : ''}>细粒度 PAT（Contents + Secrets 读写）</option>
          </select></label>
        <label class="field"><span class="field-label">Classic Token</span>
          <input class="input" id="a-token-classic" type="password" value="" autocomplete="off" spellcheck="false"
            placeholder="${cfg.has_classic ? '已配置，留空保持不变' : 'ghp_... （需勾 repo 权限）'}" /></label>
        <label class="field"><span class="field-label">细粒度 Token</span>
          <input class="input" id="a-token-fine" type="password" value="" autocomplete="off" spellcheck="false"
            placeholder="${cfg.has_fine ? '已配置，留空保持不变' : 'github_pat_... （需 Contents 与 Secrets 均为 Read and write）'}" /></label>
        <label class="field span-2"><span class="field-label">回调密钥（CALLBACK_SECRET）</span>
          <input class="input" id="a-callback" type="password" value="" autocomplete="off" spellcheck="false"
            placeholder="${cfg.callback_set ? '已配置，留空保持不变' : '与 GitHub Secrets 的 CALLBACK_SECRET 填同一个值'}" /></label>
        <div class="field span-2">
          <button class="btn" id="a-sync-secrets" type="button">⚡ 一键同步到 GitHub Secrets</button>
          <div class="muted" style="font-size:12px;margin-top:6px">
            自动把 <code>WORKER_URL</code>（本面板地址）与 <code>CALLBACK_SECRET</code> 写入仓库的 Actions Secrets，
            不用再去 GitHub 后台手动填。回调密钥未设置时会自动生成。
          </div>
        </div>
        <div class="field span-2">
          <p class="muted" style="font-size:12px;line-height:1.9;margin:0">
            ${MEVPS.icon('info', 13)} Token 仅用于调用 GitHub API 触发 Actions（<code>repository_dispatch</code>）。<br/>
            ${MEVPS.icon('info', 13)} 回调密钥用于 Actions 回传结果时的 HMAC 签名，需与 GitHub Secrets 的 <code>CALLBACK_SECRET</code> 一致。<br/>
            ${MEVPS.icon('check', 13)} 两个 Token 可<strong>同时保存</strong>，用「启用哪个 Token」随时切换，互不影响。<br/>
            ${MEVPS.icon('info', 13)} Classic PAT 需勾 <code>repo</code>（私有仓库必需，范围较广）；细粒度 PAT 需 <code>Contents: Read and write</code>——这是 <code>repository_dispatch</code> 的要求，<b>不是</b> <code>Actions: write</code>（填错会报 403）。<br/>
            ${MEVPS.icon('info', 13)} 若用「一键同步」按钮，细粒度 PAT 还需 <code>Secrets: Read and write</code>（写入 Actions Secrets）。<br/>
            ${MEVPS.icon('check', 13)} 保存后 Token 以 <strong>AES-256-GCM</strong> 加密落库，界面永不回显明文，日志不打印。<br/>
            ${MEVPS.icon('info', 13)} 加密密钥来源：<code>${cfg.enc_source === 'secret' ? 'SSH_ENC_KEY（Cloudflare Secret）' : 'D1 settings 表'}</code>
          </p>
        </div>
      </div>`;

    const dlg = MEVPS.modal({
      title: 'SSH 设置 · GitHub Actions 触发凭据',
      content,
      okText: '保 存',
      onOk(overlay, close) {
        const g = (id) => overlay.querySelector('#' + id).value.trim();
        const repo = g('a-repo');
        if (!repo) {
          MEVPS.toast('请填写 GitHub 仓库（owner/repo）', 'error');
          return false;
        }
        const body = {
          gh_repo: repo,
          gh_event: g('a-event') || 'vps-sync',
          gh_token_type: overlay.querySelector('#a-token-type').value,
        };
        const classic = g('a-token-classic');
        const fine = g('a-token-fine');
        if (classic) body.gh_token_classic = classic;
        if (fine) body.gh_token_fine = fine;
        const cb = g('a-callback');
        if (cb) body.callback_secret = cb;
        MEVPS.api('/actions', { method: 'PUT', body })
          .then(() => {
            MEVPS.toast('SSH 设置已保存', 'success');
            close();
          })
          .catch((e) => MEVPS.toast(e.message, 'error'));
        return false;
      },
    });

    // 一键同步到 GitHub Secrets：写入 WORKER_URL 与 CALLBACK_SECRET
    const syncBtn = dlg.overlay.querySelector('#a-sync-secrets');
    if (syncBtn) {
      syncBtn.addEventListener('click', async () => {
        if (syncBtn.disabled) return;
        const oldText = syncBtn.textContent;
        syncBtn.disabled = true;
        syncBtn.textContent = '同步中…';
        try {
          const r = await MEVPS.api('/actions/sync-secrets', { method: 'POST' });
          MEVPS.toast(`已写入 GitHub Secrets：${(r.synced || []).join('、')}`, 'success');
        } catch (e) {
          MEVPS.toast(e.message, 'error');
        } finally {
          syncBtn.disabled = false;
          syncBtn.textContent = oldText;
        }
      });
    }
  },

  /* ---- 浏览器内 SSH 终端（xterm.js + WebSocket → Worker → VPS:22） ---- */
  async openTerminal(item) {
    if (typeof Terminal === 'undefined') return MEVPS.toast('终端组件未加载，请刷新页面重试', 'error');
    let ticket;
    try {
      const r = await MEVPS.api(`/vps/${item.id}/terminal-ticket`, { method: 'POST' });
      ticket = r.ticket;
    } catch (e) {
      return MEVPS.toast(e.message, 'error');
    }

    const title = `SSH 终端 · ${item.name}（${item.ssh_host}:${item.ssh_port}）`;
    const content = `
      <div class="term-shell">
        <div class="term-box" id="term-host"></div>
        <div class="term-status" id="term-status">连接中…</div>
      </div>`;

    let ws = null;
    let term = null;
    let fit = null;
    let ro = null;
    let disposed = false;
    const statusEl = (msg, isErr) => {
      const el = document.getElementById('term-status');
      if (el) {
        el.textContent = msg;
        el.classList.toggle('err', !!isErr);
      }
    };
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('resize', onWinResize);
      try { if (ro) { ro.disconnect(); ro = null; } } catch (e) { /* ignore */ }
      try { if (ws && ws.readyState <= 1) ws.close(); } catch (e) { /* ignore */ }
      try { if (term) term.dispose(); } catch (e) { /* ignore */ }
    };
    /* 尺寸自适应：先按容器算出 cols/rows，再主动让出一行——
     * 保证终端内容下方永远有一整行空白，最后一行提示符/光标
     * 不会贴着圆角边框被裁掉（fit 行高取整会吃掉半行） */
    const fitSafe = () => {
      try {
        fit && fit.fit();
        if (term && term.rows > 2) term.resize(term.cols, term.rows - 1);
      } catch (e) { /* ignore */ }
    };
    const onWinResize = () => fitSafe();

    MEVPS.modal({ title, content, hideFooter: true, width: 860, height: 560, windowed: true, onClose: cleanup });

    term = new Terminal({
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
      cursorBlink: true,
      theme: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc' },
      scrollback: 5000,
    });
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(document.getElementById('term-host'));
    fitSafe();
    /* 弹窗尺寸变化（最大化/还原/拖角缩放）时自动重排行列（fitSafe 已含底部让行） */
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => fitSafe());
      ro.observe(document.getElementById('term-host'));
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/api/vps/${item.id}/terminal?ticket=${encodeURIComponent(ticket)}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      statusEl('已连接，正在协商 SSH…');
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      term.focus();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
          if (m.type === 'ready') { statusEl('已连接 · 输入 exit 或关闭窗口断开'); return; }
          if (m.type === 'hostkey') {
            term.write(`\r\n\x1b[33m⚑ 主机密钥 ${m.algo} ${m.fp}\x1b[0m\r\n`);
            return;
          }
          if (m.type === 'error') {
            statusEl(m.message, true);
            term.write(`\r\n\x1b[31m✘ ${m.message}\x1b[0m\r\n`);
            return;
          }
          if (m.type === 'closed') {
            statusEl('连接已断开' + (m.reason ? '：' + m.reason : ''), true);
            term.write('\r\n\x1b[90m[连接已断开]\x1b[0m\r\n');
            return;
          }
        } catch (e) { /* ignore */ }
        return;
      }
      term.write(new Uint8Array(ev.data));
    };
    ws.onclose = () => { if (!disposed) statusEl('连接已关闭', true); };
    ws.onerror = () => { if (!disposed) statusEl('WebSocket 连接错误', true); };
    term.onData((d) => { if (ws && ws.readyState === 1) ws.send(d); });
    term.onResize(({ cols, rows }) => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });
    window.addEventListener('resize', onWinResize);
  },

  openForm(item) {
    const isEdit = !!item;
    const v = item || {};
    const content = `
      <div class="form-grid">
        <label class="field"><span class="field-label required">名称</span>
          <input class="input" id="f-name" value="${MEVPS.esc(v.name || '')}" placeholder="如 web-01" /></label>
        <label class="field"><span class="field-label required">主机 / IP</span>
          <input class="input" id="f-host" value="${MEVPS.esc(v.ssh_host || '')}" placeholder="如 192.0.2.11" spellcheck="false" autocomplete="off" /></label>
        <label class="field"><span class="field-label">端口</span>
          <input class="input" id="f-port" type="number" min="1" max="65535" value="${v.ssh_port || 22}" /></label>
        <label class="field"><span class="field-label">用户名</span>
          <input class="input" id="f-user" value="${MEVPS.esc(v.ssh_username || 'root')}" placeholder="root" spellcheck="false" autocomplete="off" /></label>
        <label class="field"><span class="field-label">认证方式</span>
          <select class="select" id="f-auth">
            <option value="password" ${(v.ssh_auth || 'password') === 'password' ? 'selected' : ''}>密码</option>
            <option value="key" ${v.ssh_auth === 'key' ? 'selected' : ''}>私钥</option>
          </select></label>
        <label class="field span-2"><span class="field-label">密码 / 私钥</span>
          <textarea class="input" id="f-secret" rows="3" spellcheck="false" autocapitalize="off" autocorrect="off"
            placeholder="${isEdit ? '留空则保持原值不变' : '按上方认证方式填写密码或私钥'}"></textarea></label>
        <label class="field span-2"><span class="field-label">备注</span>
          <textarea class="input" id="f-remark" rows="2" placeholder="备注信息">${MEVPS.esc(v.remark || '')}</textarea></label>
        <div class="field span-2">
          <p class="muted" style="font-size:12px;line-height:1.8;margin:0">
            ${MEVPS.icon('info', 13)} 保存后点列表里的「获取配置」触发同步，自动回填 IP 归属地（国家/城市）与配置。<br/>
            ${MEVPS.icon('check', 13)} SSH 凭据加密存储，界面永不回显。
          </p>
        </div>
      </div>`;

    const self = this;
    MEVPS.modal({
      title: isEdit ? '编辑 VPS · SSH 连接' : '新增 VPS · SSH 连接',
      content,
      okText: isEdit ? '保 存' : '创 建',
      onOk(overlay, close) {
        const g = (id) => overlay.querySelector('#' + id).value.trim();
        const name = g('f-name');
        const host = g('f-host');
        if (!name || !host) {
          MEVPS.toast('名称和主机/IP 为必填项', 'error');
          return false;
        }
        const body = {
          name,
          ssh_host: host,
          ssh_port: Number(g('f-port')) || 22,
          ssh_username: g('f-user') || 'root',
          ssh_auth: overlay.querySelector('#f-auth').value,
          remark: g('f-remark'),
        };
        const secret = overlay.querySelector('#f-secret').value;
        if (secret.trim()) body.ssh_secret = secret;
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
  },
};
