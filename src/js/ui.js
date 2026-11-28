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
  /* windowed: true 时启用窗口化能力——标题栏最小化/最大化按钮（× 左侧）、
   * 拖拽标题栏移动位置、右下角拖角缩放；最小化后收起到浏览器右下角浮标。*/
  MEVPS.modal = function ({ title, content, okText = '确 定', cancelText = '取 消', onOk, onClose, hideFooter = false, width, height, windowed = false }) {
    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const sizeStyle = [width ? `width:${width}px` : '', height ? `height:${height}px` : ''].filter(Boolean).join(';');
    overlay.innerHTML = `
      <div class="modal${windowed ? ' modal-windowed' : ''}" ${sizeStyle ? `style="${sizeStyle}"` : ''}>
        <div class="modal-header">
          <span class="modal-title">${MEVPS.esc(title)}</span>
          <div class="modal-actions">
            ${windowed ? `<button class="modal-winbtn" data-win="min" title="最小化（收起到右下角）">—</button>
              <button class="modal-winbtn" data-win="max" title="最大化 / 还原">▢</button>` : ''}
            <button class="modal-close" data-act="close" title="关闭">×</button>
          </div>
        </div>
        <div class="modal-body">${content}</div>
        ${hideFooter ? '' : `<div class="modal-footer"><button class="btn" data-act="close">${cancelText}</button><button class="btn btn-primary" data-act="ok">${okText}</button></div>`}
      </div>`;
    root.appendChild(overlay);

    const modalEl = overlay.querySelector('.modal');
    let minChip = null;

    const close = () => {
      if (onClose) onClose();
      overlay.remove();
      if (minChip) { minChip.remove(); minChip = null; }
    };

    /* 最小化：隐藏弹窗，在浏览器右下角放一个可点击还原的浮标 */
    const setMinimized = (on) => {
      overlay.classList.toggle('minimized', on);
      if (on && !minChip) {
        minChip = document.createElement('button');
        minChip.type = 'button';
        minChip.className = 'modal-min-chip';
        minChip.innerHTML = `<span class="dot"></span><span>${MEVPS.esc(title)}</span>`;
        minChip.title = '点击还原窗口';
        minChip.addEventListener('click', () => setMinimized(false));
        document.body.appendChild(minChip);
      } else if (!on && minChip) {
        minChip.remove();
        minChip = null;
      }
    };

    /* 最大化 / 还原 二态切换 */
    const setMaximized = (on) => {
      modalEl.classList.toggle('maximized', on);
      const btn = overlay.querySelector('[data-win="max"]');
      if (btn) {
        btn.textContent = on ? '❐' : '▢';
        btn.title = on ? '还原' : '最大化 / 还原';
      }
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
      const win = e.target.closest('[data-win]');
      if (win) {
        e.stopPropagation();
        if (win.dataset.win === 'min') setMinimized(true);
        else setMaximized(!modalEl.classList.contains('maximized'));
        return;
      }
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'close') close();
      if (act.dataset.act === 'ok' && onOk) {
        const keep = onOk(overlay, close);
        if (keep !== false) close();
      }
    });

    if (windowed) enableWindowOps(modalEl);
    return { close, overlay };
  };

  /* ---- 窗口化弹窗：拖拽标题栏移动 + 右下角拖角缩放 ---- */
  function enableWindowOps(modalEl) {
    const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
    /* 首次拖动/缩放时从居中布局转为固定定位，之后用 left/top 控制 */
    const toPositioned = () => {
      if (modalEl.classList.contains('positioned')) return;
      const r = modalEl.getBoundingClientRect();
      modalEl.classList.add('positioned');
      modalEl.style.left = r.left + 'px';
      modalEl.style.top = r.top + 'px';
      modalEl.style.width = r.width + 'px';
      modalEl.style.height = r.height + 'px';
    };

    const header = modalEl.querySelector('.modal-header');
    header.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return; // 按钮区不触发拖拽
      if (modalEl.classList.contains('maximized')) return; // 最大化时不拖动（先点还原）
      e.preventDefault();
      toPositioned();
      const r = modalEl.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      const move = (ev) => {
        // 约束在视口内（允许拖出一部分，但始终留出可抓回的边）
        modalEl.style.left = clamp(ev.clientX - ox, 120 - r.width, window.innerWidth - 120) + 'px';
        modalEl.style.top = clamp(ev.clientY - oy, 0, window.innerHeight - 48) + 'px';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    const handle = document.createElement('div');
    handle.className = 'modal-resize';
    handle.title = '拖拽缩放窗口';
    modalEl.appendChild(handle);
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (modalEl.classList.contains('maximized')) return; // 最大化时不缩放
      e.preventDefault();
      e.stopPropagation();
      toPositioned();
      const r = modalEl.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY;
      const move = (ev) => {
        modalEl.style.width = clamp(r.width + ev.clientX - sx, 360, window.innerWidth - 16) + 'px';
        modalEl.style.height = clamp(r.height + ev.clientY - sy, 260, window.innerHeight - 16) + 'px';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

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
    if (!el) return; // 分页容器已被切走/重渲染（异步返回后视图已切换），安全退出
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
