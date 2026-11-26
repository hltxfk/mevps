/* ==== charts.js：纯 SVG 图表（无第三方依赖） ==== */
(function () {
  /**
   * 面积折线图（成本趋势）
   * data: [{ date: 'MM-DD', cost: number }]
   */
  MEVPS.chartTrend = function (el, data, { color = '#18a058' } = {}) {
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
