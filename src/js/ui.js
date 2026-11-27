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
  MEVPS.modal = function ({ title, content, okText = '确 定', cancelText = '取 消', onOk, onClose, hideFooter = false, width }) {
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

    const close = () => { if (onClose) onClose(); overlay.remove(); };
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
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      MEVPS.modal({
        title,
        content: `<p style="line-height:1.8;color:#666">${message}</p>`,
        okText: '确 定',
        onOk: () => {
          done(true);
        },
      }).overlay.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-overlay') || e.target.closest('[data-act="close"]')) done(false);
      });
    });
  };

  /* ---- 表格多选：同步表头全选框状态 ---- */
  MEVPS.syncCheckAll = function (headBox, tbody, selected) {
    if (!headBox || !tbody) return;
    const boxes = MEVPS.$$('.row-check', tbody);
    const checkedCount = boxes.filter((b) => selected.has(Number(b.dataset.id))).length;
    headBox.checked = boxes.length > 0 && checkedCount === boxes.length;
    headBox.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
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
