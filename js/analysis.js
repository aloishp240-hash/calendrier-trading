/* Panneau « Analyse » : courbe du résultat cumulé et statistiques par
   instrument / par sens (Buy, Sell) pour la période affichée (mois ou semaine).
   La courbe est dessinée en SVG, sans bibliothèque. */
window.TC = window.TC || {};

TC.analysis = (function () {
  'use strict';

  const { cal } = TC;
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  const round2 = (n) => Math.round(n * 100) / 100;

  const els = {
    panel: $('analysis'),
    final: $('anaFinal'),
    chart: $('chart'),
    empty: $('anaEmpty'),
    instSection: $('instSection'),
    dirTiles: $('dirTiles'),
    instList: $('instList'),
    note: $('anaNote')
  };

  let current = null;           // dernière période affichée (pour redessiner au redimensionnement)

  /* ---------- Calculs ---------- */

  /* Cumul jour par jour, jusqu'au dernier jour renseigné (ou aujourd'hui) */
  function cumulative(days) {
    let last = -1;
    days.forEach((d, i) => { if (d.entry) last = i; });
    if (last < 0) return null;
    const todayIndex = days.findIndex((d) => d.key === cal.todayKey());
    const end = Math.max(last, todayIndex);

    let cum = 0;
    const points = [];
    for (let i = 0; i <= end; i++) {
      const d = days[i];
      if (d.entry) cum = round2(cum + d.entry.pnl);
      points.push({ i, key: d.key, day: d.entry ? d.entry.pnl : null, cum });
    }
    return points;
  }

  function emptyStats() {
    return { trades: 0, wins: 0, total: 0 };
  }
  function add(s, result) {
    s.trades++;
    if (result > 0) s.wins++;
    s.total = round2(s.total + result);
  }

  function breakdown(days) {
    const instruments = new Map();
    const dirs = { buy: emptyStats(), sell: emptyStats() };
    let daysWithEntry = 0, daysWithTrades = 0;

    for (const d of days) {
      if (!d.entry) continue;
      daysWithEntry++;
      const trades = d.entry.trades || [];
      if (trades.length) daysWithTrades++;
      for (const t of trades) {
        if (!instruments.has(t.instrument)) {
          instruments.set(t.instrument, { name: t.instrument, ...emptyStats(), buy: 0, sell: 0 });
        }
        const s = instruments.get(t.instrument);
        add(s, t.result);
        if (t.dir === 'buy' || t.dir === 'sell') { s[t.dir]++; add(dirs[t.dir], t.result); }
      }
    }
    const list = [...instruments.values()].sort((a, b) => b.total - a.total);
    return { list, dirs, daysWithEntry, daysWithTrades };
  }

  /* Graduations « rondes » (1, 2, 5 × 10ⁿ) */
  function niceTicks(min, max, count = 4) {
    if (min === max) { min -= 10; max += 10; }
    const raw = (max - min) / count;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw);
    const ticks = [];
    for (let v = Math.floor(min / step) * step; v <= max + step * 0.001; v += step) ticks.push(round2(v));
    if (ticks[ticks.length - 1] < max) ticks.push(round2(ticks[ticks.length - 1] + step));
    return ticks;
  }

  const fmtAxis = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString('fr-FR', { maximumFractionDigits: 0 });

  /* ---------- Courbe ---------- */
  function el(name, attrs = {}) {
    const n = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  }

  function xLabels(days, isWeek) {
    if (isWeek) return days.map((d, i) => ({ i, text: cal.fmtShortDate(d.key).split(' ')[0] }));
    return days.filter((d) => [1, 8, 15, 22, 29].includes(d.day))
      .map((d) => ({ i: days.indexOf(d), text: String(d.day) }));
  }

  function drawChart(days, points, isWeek) {
    const wrap = els.chart;
    wrap.replaceChildren();
    const width = Math.max(260, wrap.clientWidth || 320);
    const height = width < 600 ? 180 : 220;
    const m = { top: 12, right: 12, bottom: 24, left: 46 };
    const iw = width - m.left - m.right;
    const ih = height - m.top - m.bottom;

    const values = points.map((p) => p.cum);
    const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
    const yMin = ticks[0], yMax = ticks[ticks.length - 1];
    const slots = Math.max(days.length - 1, 1);
    const x = (i) => m.left + (i / slots) * iw;
    const y = (v) => m.top + (1 - (v - yMin) / (yMax - yMin)) * ih;

    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart-svg', role: 'img' });
    const uid = 'c' + Math.random().toString(36).slice(2, 8);

    // Zones au-dessus / au-dessous de zéro : la courbe et son voile changent de couleur
    const defs = el('defs');
    const clipUp = el('clipPath', { id: uid + 'up' });
    clipUp.append(el('rect', { x: 0, y: 0, width, height: y(0) }));
    const clipDown = el('clipPath', { id: uid + 'down' });
    clipDown.append(el('rect', { x: 0, y: y(0), width, height: height - y(0) }));
    defs.append(clipUp, clipDown);
    svg.append(defs);

    // Grille et graduations (discrètes)
    for (const t of ticks) {
      svg.append(el('line', { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), class: t === 0 ? 'chart-zero' : 'chart-grid' }));
      const label = el('text', { x: m.left - 8, y: y(t), class: 'chart-tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' });
      label.textContent = fmtAxis(t);
      svg.append(label);
    }
    for (const l of xLabels(days, isWeek)) {
      const label = el('text', { x: x(l.i), y: height - 6, class: 'chart-tick', 'text-anchor': 'middle' });
      label.textContent = l.text;
      svg.append(label);
    }

    // Courbe : on part de 0 au début de la période
    const pts = [[x(0), y(0)], ...points.map((p) => [x(p.i), y(p.cum)])];
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const lastX = pts[pts.length - 1][0];
    const area = `${line} L${lastX.toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`;

    for (const [zone, cls] of [['up', 'win'], ['down', 'loss']]) {
      const g = el('g', { 'clip-path': `url(#${uid}${zone})` });
      g.append(el('path', { d: area, class: `chart-area ${cls}` }));
      g.append(el('path', { d: line, class: `chart-line ${cls}` }));
      svg.append(g);
    }

    // Dernier point
    const last = points[points.length - 1];
    svg.append(el('circle', { cx: x(last.i), cy: y(last.cum), r: 4, class: 'chart-dot ' + (last.cum < 0 ? 'loss' : 'win') }));

    // Survol / toucher : ligne verticale + point + bulle
    const cross = el('line', { y1: m.top, y2: m.top + ih, class: 'chart-cross', visibility: 'hidden' });
    const dot = el('circle', { r: 5, class: 'chart-dot', visibility: 'hidden' });
    svg.append(cross, dot);
    const hit = el('rect', { x: m.left, y: 0, width: iw, height, fill: 'transparent', class: 'chart-hit' });
    svg.append(hit);

    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;

    function show(clientX) {
      const box = svg.getBoundingClientRect();
      const px = ((clientX - box.left) / box.width) * width;
      const i = Math.max(0, Math.min(points.length - 1, Math.round(((px - m.left) / iw) * slots)));
      const p = points[i];
      const cx = x(p.i), cy = y(p.cum);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('visibility', 'visible');
      dot.setAttribute('class', 'chart-dot ' + (p.cum < 0 ? 'loss' : 'win'));

      tip.replaceChildren();
      const date = document.createElement('div');
      date.className = 'chart-tip-date';
      date.textContent = cal.fmtShortDate(p.key);
      const day = document.createElement('div');
      day.textContent = p.day === null ? 'Pas de trading' : `Jour : ${cal.fmtEur(p.day)}`;
      const cum = document.createElement('div');
      cum.className = 'chart-tip-cum';
      cum.textContent = `Cumul : ${cal.fmtEur(p.cum)}`;
      tip.append(date, day, cum);
      tip.hidden = false;
      const left = (cx / width) * box.width;
      const tw = tip.offsetWidth;
      tip.style.left = Math.max(0, Math.min(box.width - tw, left - tw / 2)) + 'px';
      tip.style.top = Math.max(0, (cy / height) * box.height - tip.offsetHeight - 12) + 'px';
    }
    function hide() {
      cross.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    }
    hit.addEventListener('pointermove', (e) => show(e.clientX));
    hit.addEventListener('pointerdown', (e) => show(e.clientX));
    hit.addEventListener('pointerleave', hide);

    // Résumé pour les lecteurs d'écran
    const low = points.reduce((a, b) => (b.cum < a.cum ? b : a));
    const high = points.reduce((a, b) => (b.cum > a.cum ? b : a));
    svg.setAttribute('aria-label',
      `Résultat cumulé : ${cal.fmtEur(last.cum)} au ${cal.fmtShortDate(last.key)}. `
      + `Plus haut ${cal.fmtEur(high.cum)} (${cal.fmtShortDate(high.key)}), `
      + `plus bas ${cal.fmtEur(low.cum)} (${cal.fmtShortDate(low.key)}).`);

    wrap.append(svg, tip);
  }

  /* ---------- Stats par sens et par instrument ---------- */
  function span(cls, text) {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }
  const tone = (v) => (v > 0 ? 'tone-win' : v < 0 ? 'tone-loss' : '');
  const pct = (s) => (s.trades ? cal.fmtPercent((s.wins / s.trades) * 100) : '–');

  function renderBreakdown(b) {
    const hasTrades = b.list.length > 0;
    els.instSection.hidden = !hasTrades;
    if (!hasTrades) { clearBreakdown(); return; }

    els.dirTiles.replaceChildren();
    for (const [dir, label] of [['buy', '▲ Buy (hausse)'], ['sell', '▼ Sell (baisse)']]) {
      const s = b.dirs[dir];
      const tile = document.createElement('div');
      tile.className = 'dir-tile';
      tile.append(
        span('dir-label', label),
        span('dir-total ' + tone(s.total), s.trades ? cal.fmtEur(s.total) : '–'),
        span('dir-sub', s.trades ? `${s.trades} trade${s.trades > 1 ? 's' : ''} · ${pct(s)} gagnants` : 'aucun trade')
      );
      els.dirTiles.append(tile);
    }

    const maxAbs = Math.max(...b.list.map((s) => Math.abs(s.total)), 0.01);
    els.instList.replaceChildren();
    for (const s of b.list) {
      const li = document.createElement('li');
      li.className = 'inst-row';
      const head = document.createElement('div');
      head.className = 'inst-head';
      head.append(span('inst-name', s.name), span('inst-total ' + tone(s.total), cal.fmtEur(s.total)));
      const bar = document.createElement('div');
      bar.className = 'inst-bar';
      const fill = span('inst-fill ' + (s.total < 0 ? 'loss' : 'win'), '');
      fill.style.width = Math.max(2, (Math.abs(s.total) / maxAbs) * 100) + '%';
      bar.append(fill);
      const avg = round2(s.total / s.trades);
      const sub = span('inst-sub',
        `${s.trades} trade${s.trades > 1 ? 's' : ''} · ${pct(s)} gagnants · moy. ${cal.fmtEur(avg)} · ▲ ${s.buy} · ▼ ${s.sell}`);
      li.append(head, bar, sub);
      els.instList.append(li);
    }

    const missing = b.daysWithEntry - b.daysWithTrades;
    els.note.textContent = missing > 0
      ? `${missing} jour${missing > 1 ? 's' : ''} sans détail des trades (saisi${missing > 1 ? 's' : ''} à la main ou importé${missing > 1 ? 's' : ''} avant cette fonction) : compté${missing > 1 ? 's' : ''} dans la courbe, pas dans ces stats.`
      : '';
  }

  /* Vide réellement le contenu (pas seulement masqué) : rien ne reste dans la page */
  function clearBreakdown() {
    els.dirTiles.replaceChildren();
    els.instList.replaceChildren();
    els.note.textContent = '';
  }

  /* ---------- Point d'entrée ---------- */
  function render(view, isWeek) {
    current = { view, isWeek };
    const points = cumulative(view.days);
    els.empty.hidden = !!points;
    els.chart.hidden = !points;
    if (!points) {
      els.final.textContent = '';
      els.chart.replaceChildren();
      els.instSection.hidden = true;
      clearBreakdown();
      return;
    }
    const last = points[points.length - 1].cum;
    els.final.textContent = cal.fmtEur(last);
    els.final.className = 'ana-final ' + tone(last);
    drawChart(view.days, points, isWeek);
    renderBreakdown(breakdown(view.days));
  }

  // Redessine la courbe quand la largeur change (rotation du téléphone, fenêtre PC)
  if (window.ResizeObserver) {
    let lastWidth = 0;
    new ResizeObserver(() => {
      const w = els.chart.clientWidth;
      if (current && w && Math.abs(w - lastWidth) > 4) {
        lastWidth = w;
        const points = cumulative(current.view.days);
        if (points) drawChart(current.view.days, points, current.isWeek);
      }
    }).observe(els.panel);
  }

  return { render, cumulative, breakdown, niceTicks };
})();
