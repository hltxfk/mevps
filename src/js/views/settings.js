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
            <div class="info-row"><span class="k">数据存储</span><span class="v">D1（绑定变量名 db · 库名 mymail），表结构自动初始化</span></div>
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
