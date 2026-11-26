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
