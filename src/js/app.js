/* ==== app.js：登录 / 布局 / 路由 / 多标签页 ==== */
(function () {
  const MENU = ['dashboard', 'vps', 'logs', 'settings'];
  let tabs = []; // { key, closable }

  /* ---------------- 登录页 ---------------- */
  const loginPage = () => document.getElementById('login-page');
  const appLayout = () => document.getElementById('app-layout');

  function showLogin() {
    document.documentElement.classList.remove('authed');
    loginPage().classList.remove('hidden');
    appLayout().classList.add('hidden');
  }

  function showLayout() {
    document.documentElement.classList.add('authed');
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
    document.getElementById('side-menu').innerHTML =
      MENU.map((key) => {
        const v = Views[key];
        return `<div class="menu-item ${key === active ? 'active' : ''}" data-key="${key}">
          ${MEVPS.icon(v.icon, 18)}<span>${v.label}</span>
        </div>`;
      }).join('') +
      `<div class="menu-item menu-item-logout" data-key="logout">
        ${MEVPS.icon('logout', 18)}<span>退出登录</span>
      </div>`;
    document.getElementById('side-menu').onclick = (e) => {
      const item = e.target.closest('.menu-item[data-key]');
      if (!item) return;
      if (item.dataset.key === 'logout') return MEVPS.logout();
      location.hash = '#/' + item.dataset.key;
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

  /* ---------------- 退出登录（系统设置页调用） ---------------- */
  MEVPS.logout = async function () {
    try {
      await MEVPS.api('/logout', { method: 'POST', body: {} });
    } catch (e) {
      /* ignore */
    }
    MEVPS.clearToken();
    tabs = [];
    showLogin();
    MEVPS.toast('已退出登录', 'info');
  };

  /* ---------------- 未授权跳转 ---------------- */
  window.addEventListener('mevps:unauthorized', () => {
    tabs = [];
    showLogin();
    MEVPS.toast('登录已过期，请重新登录', 'error');
  });

  /* ---------------- 登录页装饰交互（选项卡 / 快捷角色 / 第三方） ---------------- */
  MEVPS.$$('.login-tab').forEach((t) => {
    t.addEventListener('click', () => {
      if (t.classList.contains('active')) return;
      MEVPS.$$('.login-tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      MEVPS.toast('演示环境仅开放密码登录', 'info');
    });
  });
  MEVPS.$$('.quick-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.getElementById('login-username').value = 'admin';
      document.getElementById('login-password').value = '123456';
      MEVPS.toast('已选择「' + b.dataset.role + '」演示账号', 'info');
      document.getElementById('login-form').requestSubmit();
    });
  });
  MEVPS.$$('.social').forEach((s) => s.addEventListener('click', () => MEVPS.toast('演示环境暂未开放第三方登录', 'info')));
  MEVPS.$$('.login-icon-btn').forEach((s) => s.addEventListener('click', () => MEVPS.toast('演示环境暂未开放该功能', 'info')));

  /* ---------------- 启动 ---------------- */
  (function boot() {
    if (!MEVPS.getToken()) {
      showLogin();
      return;
    }
    // 乐观渲染：本地已有登录态就立刻进后台，不阻塞在 /me 网络往返上，
    // 避免刷新时闪现登录框；会话校验放后台静默进行，
    // 若已过期，api.js 的 401 → mevps:unauthorized 会自动跳回登录页。
    showLayout();
    if (!location.hash) location.hash = '#/dashboard';
    route();
    MEVPS.api('/me')
      .then((me) => MEVPS.setToken(MEVPS.getToken(), me.username))
      .catch(() => {
        /* 401 已由 mevps:unauthorized 处理 */
      });
  })();
})();
