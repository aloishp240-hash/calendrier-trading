/* Onglet « Patrimoine » : total, évolution, répartition par catégorie,
   liste des comptes, mise à jour des soldes et import depuis Finary. */
window.TC = window.TC || {};

TC.wealth = (function () {
  'use strict';

  const { cal, wealthStore } = TC;
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  const round2 = (n) => Math.round(n * 100) / 100;
  const STALE_DAYS = 45;

  const CATEGORIES = {
    courant: 'Comptes courants',
    livret: 'Livrets',
    'assurance-vie': 'Assurance vie',
    pea: 'PEA',
    trading212: 'Trading 212',
    autre: 'Autre'
  };

  /* Ordre des couleurs (palette validée pour les empilements) : une catégorie
     garde toujours la même couleur */
  const SLOTS = ['livret', 'pea', 'assurance-vie', 'courant', 'trading212', 'autre'];
  const HORIZONS = { 1: '1 mois', 6: '6 mois', 12: '1 an', 60: '5 ans', 120: '10 ans' };
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* Préférences d'affichage (non sensibles) */
  function loadPref(key, fallback) {
    try { return { ...fallback, ...(JSON.parse(localStorage.getItem(key)) || {}) }; } catch (e) { return { ...fallback }; }
  }
  function savePref(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignoré */ }
  }
  const chartPref = loadPref('ct.wchart', { period: 0, cmode: 'total', hidden: [] });
  const fcPref = loadPref('ct.fc', { h: 120, infl: false, mode: 'history' });

  const els = {};
  let accounts = [];
  let fcEditing = null;          // compte dont on modifie les hypothèses
  let lastFcTotal = null;        // pour animer le passage d'un horizon à l'autre
  let editing = null;            // compte ouvert dans la fiche
  let pendingFinary = null;      // import Finary en attente de confirmation
  let deleteArmed = null;
  let options = null;

  /* ---------------- Calculs ---------------- */
  const latest = (a) => (a.snapshots.length ? a.snapshots[a.snapshots.length - 1] : null);

  function valueAt(a, day) {
    let v = null;
    for (const s of a.snapshots) { if (s.d <= day) v = s.v; else break; }
    return v;
  }
  function totalAt(day) {
    return round2(accounts.reduce((sum, a) => sum + (valueAt(a, day) || 0), 0));
  }
  function daysBetween(a, b) {
    return Math.round((cal.parseKey(b) - cal.parseKey(a)) / 86400000);
  }
  function shiftDay(day, delta) {
    const d = cal.parseKey(day);
    d.setDate(d.getDate() + delta);
    return cal.dateKey(d.getFullYear(), d.getMonth(), d.getDate());
  }

  /* Variation sur 30 jours, uniquement sur les comptes qui existaient déjà :
     ajouter un compte n'est pas un « gain ». */
  function delta(today) {
    const dates = accounts.flatMap((a) => a.snapshots.map((s) => s.d)).sort();
    if (!dates.length) return null;
    const ref = dates[0] > shiftDay(today, -30) ? dates[0] : shiftDay(today, -30);
    if (ref >= today) return null;
    let diff = 0, base = 0, counted = 0;
    for (const a of accounts) {
      const before = valueAt(a, ref);
      if (before === null) continue;
      counted++;
      base += before;
      diff += (valueAt(a, today) || 0) - before;
    }
    if (!counted) return null;
    return { diff: round2(diff), pct: base ? (diff / base) * 100 : null, ref };
  }

  /* ---------------- Mise en forme ---------------- */
  const eur = (n) => cal.fmtEur(n).replace(/^\+/, '');           // un solde n'a pas de « + »
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function svg(name, attrs = {}) {
    const n = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  }

  /* ---------------- Rendu ---------------- */
  async function render() {
    if (!els.total) return;
    accounts = await wealthStore.listAccounts();
    const today = cal.todayKey();
    const total = totalAt(today);
    const has = accounts.some((a) => a.snapshots.length);

    els.total.textContent = has ? eur(total) : '–';
    els.empty.hidden = accounts.length > 0;
    const dlt = has ? delta(today) : null;
    els.delta.textContent = '';
    els.delta.className = 'wealth-delta';
    if (dlt) {
      els.delta.textContent = `${cal.fmtEur(dlt.diff)}${dlt.pct !== null ? ` (${dlt.pct >= 0 ? '+' : '−'}${Math.abs(dlt.pct).toFixed(1).replace('.', ',')} %)` : ''} depuis le ${cal.fmtShortDate(dlt.ref)}`;
      els.delta.classList.add(dlt.diff > 0 ? 'tone-win' : dlt.diff < 0 ? 'tone-loss' : 'neutral');
    } else if (has) {
      els.delta.textContent = 'L’évolution apparaîtra à ta prochaine mise à jour.';
    }

    drawChart(today);
    renderAllocation(today, total);
    renderAccounts(today);
    if (fcPref.mode === 'forecast') renderForecast();
  }

  function applyMode() {
    const fc = fcPref.mode === 'forecast';
    els.wmHistory.checked = !fc;
    els.wmForecast.checked = fc;
    els.history.hidden = fc;
    els.forecast.hidden = !fc;
  }

  /* Valeurs d'une catégorie (ou du total) à une date */
  function sumAt(day, cats) {
    return round2(accounts.filter((a) => cats.includes(a.category)).reduce((t, a) => t + (valueAt(a, day) || 0), 0));
  }

  function renderLegend(cats) {
    els.legend.replaceChildren();
    for (const cat of cats) {
      const b = el('button', 'legend-item' + (chartPref.hidden.includes(cat) ? ' is-off' : ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(!chartPref.hidden.includes(cat)));
      const sw = el('span', 'legend-swatch');
      sw.style.background = `var(--series-${SLOTS.indexOf(cat) + 1})`;
      b.append(sw, el('span', null, CATEGORIES[cat]));
      b.addEventListener('click', () => {
        const i = chartPref.hidden.indexOf(cat);
        if (i >= 0) chartPref.hidden.splice(i, 1); else chartPref.hidden.push(cat);
        savePref('ct.wchart', chartPref);
        drawChart(cal.todayKey());
      });
      els.legend.append(b);
    }
  }

  function syncControls() {
    els.controls.querySelectorAll('[data-period]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.period) === chartPref.period)));
    els.controls.querySelectorAll('[data-cmode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cmode === chartPref.cmode)));
  }

  function drawChart(today) {
    els.chart.replaceChildren();
    syncControls();
    const present = SLOTS.filter((c) => accounts.some((a) => a.category === c && a.snapshots.length));
    renderLegend(present);
    const cats = present.filter((c) => !chartPref.hidden.includes(c));

    let dates = [...new Set(accounts.flatMap((a) => a.snapshots.map((s) => s.d)))].sort();
    if (dates.length && dates[dates.length - 1] < today) dates.push(today);
    if (chartPref.period) {
      const from = shiftDay(today, -Math.round(chartPref.period * 30.44));
      const before = dates.filter((d) => d < from);
      dates = dates.filter((d) => d >= from);
      if (before.length) dates.unshift(from);            // point de départ : la valeur à la date de début
    }
    const enough = dates.length >= 2 && cats.length > 0;
    els.controls.hidden = !accounts.some((a) => a.snapshots.length);
    els.chartHint.hidden = enough || !accounts.length;
    els.chartHint.textContent = !cats.length ? 'Aucune catégorie sélectionnée.' : 'La courbe d’évolution apparaîtra dès ta 2e mise à jour sur cette période.';
    if (!enough) return;

    const stacked = chartPref.cmode === 'stack' && cats.length > 1;
    const points = dates.map((d) => {
      const layers = [];
      let acc = 0;
      for (const c of cats) { acc = round2(acc + sumAt(d, [c])); layers.push(acc); }
      return { d, t: cal.parseKey(d).getTime(), v: acc, layers };
    });

    const width = Math.max(260, els.chart.clientWidth || 320);
    const height = width < 600 ? 160 : 200;
    const m = { top: 10, right: 12, bottom: 22, left: 58 };
    const iw = width - m.left - m.right, ih = height - m.top - m.bottom;
    const vals = points.map((p) => p.v);
    const lo = stacked ? 0 : Math.min(...vals), hi = Math.max(...vals);
    const pad = stacked ? 0 : Math.max((hi - lo) * 0.15, hi * 0.01, 10);
    const ticks = TC.analysis.niceTicks(Math.max(0, lo - pad), hi + pad, 3);
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const t0 = points[0].t, t1 = points[points.length - 1].t;
    const x = (t) => m.left + ((t - t0) / (t1 - t0 || 1)) * iw;
    const y = (v) => m.top + (1 - (v - y0) / (y1 - y0 || 1)) * ih;

    const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart-svg chart-in', role: 'img' });
    for (const t of ticks) {
      root.append(svg('line', { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), class: 'chart-grid' }));
      const lab = svg('text', { x: m.left - 8, y: y(t), class: 'chart-tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' });
      lab.textContent = Math.round(t).toLocaleString('fr-FR');
      root.append(lab);
    }
    for (const p of [points[0], points[points.length - 1]]) {
      const lab = svg('text', { x: x(p.t), y: height - 5, class: 'chart-tick', 'text-anchor': p === points[0] ? 'start' : 'end' });
      lab.textContent = cal.fmtShortDate(p.d).replace(/^\S+ /, '');
      root.append(lab);
    }
    const path = (fn) => points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(fn(p)).toFixed(1)}`).join(' ');
    if (stacked) {
      // Couches empilées, de bas en haut dans l'ordre des couleurs
      cats.forEach((c, i) => {
        const top = path((p) => p.layers[i]);
        const bottom = points.slice().reverse().map((p) => `L${x(p.t).toFixed(1)} ${y(i ? p.layers[i - 1] : 0).toFixed(1)}`).join(' ');
        const area = svg('path', { d: `${top} ${bottom} Z`, class: 'chart-stack' });
        area.style.fill = `var(--series-${SLOTS.indexOf(c) + 1})`;
        root.append(area);
      });
    } else {
      const line = path((p) => p.v);
      root.append(svg('path', { d: `${line} L${x(t1).toFixed(1)} ${m.top + ih} L${x(t0).toFixed(1)} ${m.top + ih} Z`, class: 'chart-area accent' }));
      root.append(svg('path', { d: line, class: 'chart-line accent chart-draw', pathLength: 1 }));
    }
    const last = points[points.length - 1];
    root.append(svg('circle', { cx: x(last.t), cy: y(last.v), r: 4, class: 'chart-dot accent' }));

    // Survol / toucher : date, total affiché et détail par catégorie
    const cross = svg('line', { y1: m.top, y2: m.top + ih, class: 'chart-cross', visibility: 'hidden' });
    const dot = svg('circle', { r: 5, class: 'chart-dot accent', visibility: 'hidden' });
    const hit = svg('rect', { x: m.left, y: 0, width: iw, height, fill: 'transparent', class: 'chart-hit' });
    root.append(cross, dot, hit);
    const tip = el('div', 'chart-tip');
    tip.hidden = true;
    const show = (clientX) => {
      const box = root.getBoundingClientRect();
      const px = ((clientX - box.left) / box.width) * width;
      const p = points.reduce((best, q) => (Math.abs(x(q.t) - px) < Math.abs(x(best.t) - px) ? q : best));
      cross.setAttribute('x1', x(p.t)); cross.setAttribute('x2', x(p.t)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(p.t)); dot.setAttribute('cy', y(p.v)); dot.setAttribute('visibility', 'visible');
      const rows = [el('div', 'chart-tip-date', cal.fmtShortDate(p.d)), el('div', 'chart-tip-cum', eur(p.v))];
      if (stacked) {
        for (let i = cats.length - 1; i >= 0; i--) {
          const r = el('div', 'chart-tip-row');
          const sw = el('span', 'legend-swatch');
          sw.style.background = `var(--series-${SLOTS.indexOf(cats[i]) + 1})`;
          r.append(sw, el('span', null, `${CATEGORIES[cats[i]]} : ${eur(round2(p.layers[i] - (i ? p.layers[i - 1] : 0)))}`));
          rows.push(r);
        }
      }
      tip.replaceChildren(...rows);
      tip.hidden = false;
      const left = (x(p.t) / width) * box.width;
      tip.style.left = Math.max(0, Math.min(box.width - tip.offsetWidth, left - tip.offsetWidth / 2)) + 'px';
      tip.style.top = Math.max(0, (y(p.v) / height) * box.height - tip.offsetHeight - 12) + 'px';
    };
    hit.addEventListener('pointermove', (e) => show(e.clientX));
    hit.addEventListener('pointerdown', (e) => show(e.clientX));
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; });
    root.setAttribute('aria-label', `Évolution du patrimoine (${cats.map((c) => CATEGORIES[c]).join(', ')}) : ${eur(points[0].v)} le ${cal.fmtShortDate(points[0].d)}, ${eur(last.v)} le ${cal.fmtShortDate(last.d)}.`);
    els.chart.append(root, tip);
  }

  /* ---------------- Prévisions ---------------- */
  const F = () => TC.forecast;
  const pctTxt = (n) => `${String(F().round2(n)).replace('.', ',')} %`;

  /* Chiffre qui défile en douceur d'une valeur à l'autre */
  function tween(node, from, to, format) {
    if (from === null || reducedMotion.matches || Math.abs(to - from) < 0.005) { node.textContent = format(to); return; }
    const start = performance.now(), dur = 520;
    const step = (now) => {
      const k = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      node.textContent = format(from + (to - from) * e);
      if (k < 1 && node.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function horizonDate(months) {
    const d = new Date();
    d.setMonth(d.getMonth() + months);
    return new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(d);
  }

  function hypothesisText(s) {
    const parts = [s.rate ? `${pctTxt(s.rate)}/an` : '0 %/an'];
    parts.push(s.source);
    if (s.monthly) parts.push(`+${Math.round(s.monthly).toLocaleString('fr-FR')} €/mois`);
    if (s.cap) parts.push(`plafond ${Math.round(s.cap).toLocaleString('fr-FR')} €`);
    if (s.vol) parts.push('fourchette de risque');
    return parts.join(' · ');
  }

  function sparkline(series, risky) {
    const w = 96, h = 30, n = series.length - 1;
    const lo = Math.min(...series), hi = Math.max(...series);
    const y = (v) => (hi === lo ? h / 2 : h - 3 - ((v - lo) / (hi - lo)) * (h - 6));
    const d = series.map((v, i) => `${i ? 'L' : 'M'}${((i / (n || 1)) * (w - 4) + 2).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    const root = svg('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, class: 'fc-spark', 'aria-hidden': 'true' });
    root.append(svg('path', { d, class: 'chart-line accent' + (risky ? ' is-risky' : '') }));
    return root;
  }

  function renderForecast() {
    const months = fcPref.h;
    els.fcHorizon.forEach((r) => { r.checked = Number(r.value) === months; });
    els.fcInflation.checked = fcPref.infl;
    const items = accounts.map((acc) => ({ acc, balance: (latest(acc) || { v: 0 }).v })).filter((i) => latest(i.acc));
    els.fcWhen.textContent = `Dans ${HORIZONS[months]} · ${horizonDate(months)}`;
    if (!items.length) {
      els.fcTotal.textContent = '–';
      els.fcGain.textContent = 'Ajoute d’abord tes comptes dans « Historique ».';
      els.fcRange.textContent = '';
      els.fcChart.replaceChildren();
      els.fcAccounts.replaceChildren();
      return;
    }
    const p = F().project(items, months, { inflation: fcPref.infl });
    const today = round2(items.reduce((t, i) => t + i.balance, 0));
    const end = p.total.central[months];
    tween(els.fcTotal, lastFcTotal, end, (v) => eur(round2(v)));
    lastFcTotal = end;
    const gain = round2(end - today - (fcPref.infl ? 0 : p.deposits));
    els.fcGain.textContent = fcPref.infl
      ? `soit ${cal.fmtEur(round2(end - today))} en pouvoir d’achat par rapport à aujourd’hui`
      : `${cal.fmtEur(gain)} d’intérêts et de performance${p.deposits ? `, + ${eur(round2(p.deposits))} de versements` : ''}`;
    els.fcGain.className = 'fc-gain ' + (gain > 0 ? 'tone-win' : gain < 0 ? 'tone-loss' : '');
    els.fcRange.textContent = p.risky
      ? `Fourchette : ${eur(round2(p.total.low[months]))} (prudent) à ${eur(round2(p.total.high[months]))} (favorable) — 1 chance sur 10 de faire moins bien ou mieux`
      : '';
    drawForecastChart(p, today);
    renderForecastAccounts(p);
    els.fcNote.textContent = `Estimations avant impôts, qui ne garantissent rien : les performances passées ne préjugent pas des performances futures. Bourse : MSCI World en euros, moyenne ${F().MSCI.tenYears.toString().replace('.', ',')} %/an sur 10 ans (source MSCI, ${F().MSCI.asOf}), moins les frais de l’ETF.`;
  }

  function drawForecastChart(p, today) {
    els.fcChart.replaceChildren();
    const months = p.months;
    const width = Math.max(260, els.fcChart.clientWidth || 320);
    const height = width < 600 ? 170 : 210;
    const m = { top: 12, right: 12, bottom: 22, left: 58 };
    const iw = width - m.left - m.right, ih = height - m.top - m.bottom;
    const lows = p.total.low, highs = p.total.high, mid = p.total.central;
    const ticks = TC.analysis.niceTicks(Math.max(0, Math.min(...lows, today) * 0.97), Math.max(...highs) * 1.02, 3);
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const x = (i) => m.left + (i / months) * iw;
    const y = (v) => m.top + (1 - (v - y0) / (y1 - y0 || 1)) * ih;

    const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart-svg chart-in', role: 'img' });
    for (const t of ticks) {
      root.append(svg('line', { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), class: 'chart-grid' }));
      const lab = svg('text', { x: m.left - 8, y: y(t), class: 'chart-tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' });
      lab.textContent = Math.round(t).toLocaleString('fr-FR');
      root.append(lab);
    }
    const lab0 = svg('text', { x: m.left, y: height - 5, class: 'chart-tick', 'text-anchor': 'start' });
    lab0.textContent = 'aujourd’hui';
    const lab1 = svg('text', { x: width - m.right, y: height - 5, class: 'chart-tick', 'text-anchor': 'end' });
    lab1.textContent = horizonDate(months);
    root.append(lab0, lab1);

    const line = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    if (p.risky) {
      const band = `${line(highs)} ${lows.slice().reverse().map((v, j) => `L${x(months - j).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')} Z`;
      root.append(svg('path', { d: band, class: 'fc-band' }));
    }
    root.append(svg('path', { d: `${line(mid)} L${x(months)} ${m.top + ih} L${x(0)} ${m.top + ih} Z`, class: 'chart-area accent' }));
    root.append(svg('path', { d: line(mid), class: 'chart-line accent chart-draw', pathLength: 1 }));
    root.append(svg('circle', { cx: x(months), cy: y(mid[months]), r: 4, class: 'chart-dot accent' }));

    const cross = svg('line', { y1: m.top, y2: m.top + ih, class: 'chart-cross', visibility: 'hidden' });
    const dot = svg('circle', { r: 5, class: 'chart-dot accent', visibility: 'hidden' });
    const hit = svg('rect', { x: m.left, y: 0, width: iw, height, fill: 'transparent', class: 'chart-hit' });
    root.append(cross, dot, hit);
    const tip = el('div', 'chart-tip');
    tip.hidden = true;
    const show = (clientX) => {
      const box = root.getBoundingClientRect();
      const i = Math.max(0, Math.min(months, Math.round(((((clientX - box.left) / box.width) * width) - m.left) / iw * months)));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(mid[i])); dot.setAttribute('visibility', 'visible');
      const when = i === 0 ? 'Aujourd’hui' : i < 12 ? `Dans ${i} mois` : `Dans ${(i / 12).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} an${i >= 24 ? 's' : ''}`;
      const rows = [el('div', 'chart-tip-date', when), el('div', 'chart-tip-cum', eur(round2(mid[i])))];
      if (p.risky && i) rows.push(el('div', 'chart-tip-date', `${eur(round2(lows[i]))} – ${eur(round2(highs[i]))}`));
      tip.replaceChildren(...rows);
      tip.hidden = false;
      const left = (x(i) / width) * box.width;
      tip.style.left = Math.max(0, Math.min(box.width - tip.offsetWidth, left - tip.offsetWidth / 2)) + 'px';
      tip.style.top = Math.max(0, (y(mid[i]) / height) * box.height - tip.offsetHeight - 12) + 'px';
    };
    hit.addEventListener('pointermove', (e) => show(e.clientX));
    hit.addEventListener('pointerdown', (e) => show(e.clientX));
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; });
    root.setAttribute('aria-label', `Prévision du patrimoine : ${eur(today)} aujourd’hui, environ ${eur(round2(mid[months]))} dans ${HORIZONS[months]}` + (p.risky ? `, fourchette ${eur(round2(lows[months]))} à ${eur(round2(highs[months]))}.` : '.'));
    els.fcChart.append(root, tip);
  }

  function renderForecastAccounts(p) {
    els.fcAccounts.replaceChildren();
    const sorted = p.accounts.slice().sort((a, b) => b.central[p.months] - a.central[p.months]);
    for (const a of sorted) {
      const end = a.central[p.months];
      const card = el('button', 'fc-card glass');
      card.type = 'button';
      const head = el('div', 'fc-card-head');
      head.append(el('span', 'acc-name', a.acc.name), el('span', 'fc-card-end', eur(round2(end))));
      const mid = el('div', 'fc-card-mid');
      const nums = el('div', 'fc-card-nums');
      const growth = round2(end - a.balance - (p.inflation ? 0 : a.deposits));
      nums.append(
        el('span', 'acc-meta', `aujourd’hui ${eur(a.balance)}`),
        el('span', 'fc-card-gain ' + (growth > 0 ? 'tone-win' : growth < 0 ? 'tone-loss' : ''), growth ? `${cal.fmtEur(growth)} ${p.inflation ? 'en pouvoir d’achat' : 'd’intérêts / performance'}` : 'pas de rendement')
      );
      if (a.s.vol) nums.append(el('span', 'acc-meta', `entre ${eur(round2(a.low[p.months]))} et ${eur(round2(a.high[p.months]))}`));
      mid.append(nums, sparkline(a.central, !!a.s.vol));
      card.append(head, mid, el('span', 'fc-hyp', hypothesisText(a.s) + (a.s.custom ? ' (personnalisé)' : '')));
      card.setAttribute('aria-label', `${a.acc.name} : ${eur(round2(end))} dans ${HORIZONS[p.months]}. Modifier les hypothèses`);
      card.addEventListener('click', () => openHypothesis(a.acc));
      els.fcAccounts.append(card);
    }
  }

  /* ---------------- Hypothèses d'un compte ---------------- */
  const fmtIn = (n) => (n === null || n === undefined ? '' : String(F().round2(n)).replace('.', ','));

  function fillHypothesis(s) {
    els.fcRate.value = fmtIn(s.rate);
    els.fcMonthly.value = s.monthly ? fmtIn(s.monthly) : '';
    els.fcCap.value = s.cap ? fmtIn(s.cap) : '';
    els.fcRisky.checked = !!s.vol;
    els.fcPresets.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(s.preset === b.dataset.preset)));
  }

  function openHypothesis(acc) {
    fcEditing = acc;
    els.fcSheetTitle.textContent = acc.name;
    els.fcError.textContent = '';
    els.fcPresets.hidden = !['pea', 'autre'].includes(acc.category);
    fillHypothesis(F().settings(acc));
    els.fcSheet.classList.remove('closing');
    els.fcSheet.showModal();
  }

  async function saveHypothesis(e) {
    e.preventDefault();
    const rate = parseAmount(els.fcRate.value || '0');
    const monthly = els.fcMonthly.value.trim() ? parseAmount(els.fcMonthly.value) : 0;
    const cap = els.fcCap.value.trim() ? parseAmount(els.fcCap.value) : null;
    if (!Number.isFinite(rate) || rate < -50 || rate > 50) { els.fcError.textContent = 'Rendement invalide — exemple : 2,5'; return; }
    if (!Number.isFinite(monthly) || monthly < 0) { els.fcError.textContent = 'Versement invalide — exemple : 50'; return; }
    if (cap !== null && (!Number.isFinite(cap) || cap < 0)) { els.fcError.textContent = 'Plafond invalide — exemple : 22 950'; return; }
    const preset = els.fcPresets.querySelector('[aria-pressed="true"]');
    const presetId = preset && F().PRESETS[preset.dataset.preset] && F().PRESETS[preset.dataset.preset].rate === F().round2(rate) ? preset.dataset.preset : null;
    const acc = await wealthStore.getAccount(fcEditing.id);
    acc.forecast = { rate, monthly, cap, vol: els.fcRisky.checked ? F().MSCI.vol10y : 0, preset: presetId };
    await wealthStore.saveAccount(acc);
    options.close(els.fcSheet);
    render();
  }

  async function resetHypothesis() {
    const acc = await wealthStore.getAccount(fcEditing.id);
    acc.forecast = null;
    await wealthStore.saveAccount(acc);
    options.close(els.fcSheet);
    render();
  }

  function renderAllocation(today, total) {
    els.alloc.replaceChildren();
    const sums = {};
    for (const a of accounts) {
      const v = valueAt(a, today);
      if (v) sums[a.category] = round2((sums[a.category] || 0) + v);
    }
    const rows = Object.entries(sums).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    els.allocPanel.hidden = !rows.length;
    const max = Math.max(...rows.map(([, v]) => v), 1);
    for (const [cat, v] of rows) {
      const li = el('li', 'alloc-row');
      const head = el('div', 'alloc-head');
      head.append(el('span', 'alloc-name', CATEGORIES[cat]), el('span', 'alloc-val', `${eur(v)} · ${total > 0 ? Math.round((v / total) * 100) : 0} %`));
      const bar = el('div', 'inst-bar');
      const fill = el('span', 'inst-fill accent');
      fill.style.width = Math.max(2, (v / max) * 100) + '%';
      bar.append(fill);
      li.append(head, bar);
      els.alloc.append(li);
    }
  }

  function renderAccounts(today) {
    els.accounts.replaceChildren();
    for (const cat of Object.keys(CATEGORIES)) {
      const list = accounts.filter((a) => a.category === cat).sort((a, b) => (valueAt(b, today) || 0) - (valueAt(a, today) || 0));
      if (!list.length) continue;
      const group = el('section', 'acc-group glass');
      const sub = round2(list.reduce((s, a) => s + (valueAt(a, today) || 0), 0));
      const head = el('div', 'acc-group-head');
      head.append(el('h2', null, CATEGORIES[cat]), el('span', 'acc-group-total', eur(sub)));
      group.append(head);
      for (const a of list) {
        const row = el('button', 'acc-row');
        row.type = 'button';
        const last = latest(a);
        const left = el('span', 'acc-main');
        left.append(el('span', 'acc-name', a.name));
        const meta = [a.institution, a.rate !== null ? `${String(a.rate).replace('.', ',')} %/an` : null].filter(Boolean).join(' · ');
        if (meta) left.append(el('span', 'acc-meta', meta));
        const right = el('span', 'acc-side');
        right.append(el('span', 'acc-value', last ? eur(last.v) : '–'));
        const age = last ? daysBetween(last.d, today) : null;
        const when = el('span', 'acc-when' + (age !== null && age > STALE_DAYS ? ' is-stale' : ''),
          !last ? 'aucun solde' : age === 0 ? 'à jour aujourd’hui' : age > STALE_DAYS ? `à mettre à jour (${age} j)` : `il y a ${age} j`);
        right.append(when);
        row.append(left, right);
        row.setAttribute('aria-label', `${a.name}, ${last ? eur(last.v) : 'aucun solde'}. Modifier`);
        row.addEventListener('click', () => openAccount(a.id));
        group.append(row);
      }
      els.accounts.append(group);
    }
  }

  /* ---------------- Fiche d'un compte ---------------- */
  function parseAmount(raw) {
    const s = String(raw || '').trim().replace(/[\s  €]/g, '').replace(/−/g, '-').replace(',', '.');
    if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return NaN;
    return Number(s);
  }

  function disarmDelete() {
    clearTimeout(deleteArmed);
    deleteArmed = null;
    els.accDelete.textContent = 'Supprimer';
  }

  function renderHistory() {
    els.accHistory.replaceChildren();
    const snaps = editing ? [...editing.snapshots].reverse().slice(0, 12) : [];
    els.accHistoryWrap.hidden = !snaps.length;
    for (const s of snaps) {
      const li = el('li', 'acc-hist-row');
      li.append(el('span', 'acc-hist-date', cal.fmtShortDate(s.d)), el('span', 'acc-hist-src', s.s === 'finary' ? 'Finary' : 'manuel'), el('span', 'acc-hist-val', eur(s.v)));
      const del = el('button', 'ai-hist-del', '×');
      del.type = 'button';
      del.setAttribute('aria-label', `Supprimer le solde du ${cal.fmtShortDate(s.d)}`);
      del.addEventListener('click', () => {
        editing.snapshots = editing.snapshots.filter((x) => x.d !== s.d);
        editing.dirty = true;
        renderHistory();
      });
      li.append(del);
      els.accHistory.append(li);
    }
  }

  async function openAccount(id) {
    editing = id ? await wealthStore.getAccount(id) : null;
    const a = editing || { name: '', category: 'livret', institution: '', rate: null };
    els.accTitle.textContent = editing ? a.name : 'Nouveau compte';
    els.accSub.textContent = editing ? 'Mettre à jour le solde ou modifier le compte' : 'Banque, livret, PEA, assurance vie…';
    els.accName.value = a.name;
    els.accCat.value = a.category;
    els.accInst.value = a.institution || '';
    els.accRate.value = a.rate !== null && a.rate !== undefined ? String(a.rate).replace('.', ',') : '';
    const last = editing ? latest(editing) : null;
    els.accBalance.value = '';
    els.accBalance.placeholder = last ? `dernier : ${eur(last.v)}` : '0,00';
    els.accDate.value = cal.todayKey();
    els.accError.textContent = '';
    els.accDelete.hidden = !editing;
    disarmDelete();
    renderHistory();
    els.accSheet.classList.remove('closing');
    els.accSheet.showModal();
  }

  async function saveAccount(e) {
    e.preventDefault();
    els.accError.textContent = '';
    const name = els.accName.value.trim();
    if (!name) { els.accError.textContent = 'Donne un nom au compte.'; els.accName.focus(); return; }
    const rateRaw = els.accRate.value.trim();
    const rate = rateRaw ? parseAmount(rateRaw) : null;
    if (rateRaw && !Number.isFinite(rate)) { els.accError.textContent = 'Taux invalide — exemple : 2,5'; return; }
    const balRaw = els.accBalance.value.trim();
    const balance = balRaw ? parseAmount(balRaw) : null;
    if (balRaw && !Number.isFinite(balance)) { els.accError.textContent = 'Solde invalide — exemple : 1 250,40'; els.accBalance.focus(); return; }
    const date = els.accDate.value;
    if (balRaw && !/^\d{4}-\d{2}-\d{2}$/.test(date)) { els.accError.textContent = 'Date invalide.'; return; }

    const account = editing || wealthStore.newAccount({});
    Object.assign(account, { name, category: els.accCat.value, institution: els.accInst.value.trim() || null, rate });
    if (balRaw) {
      account.snapshots = account.snapshots.filter((s) => s.d !== date);
      account.snapshots.push({ d: date, v: round2(balance), s: 'manuel' });
    }
    await wealthStore.saveAccount(account);
    options.close(els.accSheet);
    render();
  }

  async function deleteAccount() {
    if (!editing) return;
    if (!deleteArmed) {
      els.accDelete.textContent = 'Confirmer';
      deleteArmed = setTimeout(disarmDelete, 4000);
      return;
    }
    disarmDelete();
    await wealthStore.deleteAccount(editing.id);
    options.close(els.accSheet);
    render();
  }

  /* ---------------- Import Finary ---------------- */
  async function onFinaryChosen() {
    const file = els.finaryInput.files[0];
    els.finaryInput.value = '';
    if (!file) return;
    els.finSummary.replaceChildren();
    els.finWarning.textContent = '';
    els.finWarning.classList.remove('is-error');
    els.finConfirm.hidden = false;
    pendingFinary = null;
    try {
      const data = JSON.parse(await file.text());
      if (!data || data.type !== 'finary-import' || !Array.isArray(data.accounts) || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) throw new Error('format');
      const existing = await wealthStore.listAccounts();
      const plan = data.accounts.map((f) => ({ f, match: existing.find((a) => f.finaryId && a.finaryId === f.finaryId) || null }));
      for (const { f, match } of plan) {
        const li = el('div', 'fin-row');
        const status = f.skip ? `ignoré — ${f.reason || 'valeur non fiable'}` : match ? 'mise à jour' : 'nouveau compte';
        li.append(el('span', 'fin-name', f.name), el('span', 'fin-status' + (f.skip ? ' is-skip' : ''), status),
          el('span', 'fin-val', f.skip ? '' : eur(Number(f.balance))));
        els.finSummary.append(li);
      }
      const kept = plan.filter((p) => !p.f.skip).length;
      els.finFile.textContent = `${file.name} — soldes du ${cal.fmtShortDate(data.date)}`;
      els.finWarning.textContent = kept
        ? `${kept} compte${kept > 1 ? 's' : ''} ${kept > 1 ? 'seront mis' : 'sera mis'} à jour. Tes saisies manuelles et les noms que tu as modifiés sont conservés.`
        : 'Aucun compte exploitable dans ce fichier.';
      els.finConfirm.hidden = !kept;
      pendingFinary = { data, plan };
    } catch (err) {
      els.finFile.textContent = file.name;
      els.finWarning.textContent = 'Ce fichier n’est pas un export Finary préparé pour l’appli.';
      els.finWarning.classList.add('is-error');
      els.finConfirm.hidden = true;
    }
    els.finSheet.classList.remove('closing');
    els.finSheet.showModal();
  }

  async function confirmFinary() {
    if (!pendingFinary) return;
    const { data, plan } = pendingFinary;
    pendingFinary = null;
    const toSave = [];
    for (const { f, match } of plan) {
      if (f.skip || !Number.isFinite(Number(f.balance))) continue;
      const acc = match || wealthStore.newAccount({ name: f.name, category: f.category, finaryId: f.finaryId });
      if (!match) acc.category = f.category;
      if (f.institution) acc.institution = f.institution;
      if (f.rate !== null && f.rate !== undefined) acc.rate = Number(f.rate);
      acc.snapshots = acc.snapshots.filter((s) => s.d !== data.date);
      acc.snapshots.push({ d: data.date, v: round2(Number(f.balance)), s: 'finary' });
      toSave.push(acc);
    }
    await wealthStore.saveMany(toSave);
    options.close(els.finSheet);
    options.status(`Import Finary : ${toSave.length} compte${toSave.length > 1 ? 's' : ''} mis à jour. Pense à supprimer le fichier de tes Téléchargements.`);
    render();
  }

  /* ---------------- Initialisation ---------------- */
  function init(opts) {
    options = opts;
    Object.assign(els, {
      total: $('wealthTotal'), delta: $('wealthDelta'), chart: $('wealthChart'), chartHint: $('wealthChartHint'),
      empty: $('wealthEmpty'), alloc: $('wealthAlloc'), allocPanel: $('wealthAllocPanel'), accounts: $('wealthAccounts'),
      addBtn: $('wealthAddBtn'), finaryBtn: $('finaryImportBtn'), finaryInput: $('finaryInput'),
      accSheet: $('accountSheet'), accForm: $('accountForm'), accTitle: $('accountTitle'), accSub: $('accountSub'),
      accName: $('accName'), accCat: $('accCat'), accInst: $('accInst'), accRate: $('accRate'),
      accBalance: $('accBalance'), accDate: $('accDate'), accError: $('accError'),
      accHistory: $('accHistory'), accHistoryWrap: $('accHistoryWrap'), accDelete: $('accDelete'), accCancel: $('accCancel'),
      finSheet: $('finarySheet'), finFile: $('finaryFile'), finSummary: $('finarySummary'), finWarning: $('finaryWarning'),
      finConfirm: $('finaryConfirm'), finCancel: $('finaryCancel'),
      controls: $('wealthChartControls'), legend: $('wealthLegend'),
      wmHistory: $('wmHistory'), wmForecast: $('wmForecast'), history: $('wealthHistory'), forecast: $('wealthForecast'),
      fcHorizon: [...document.querySelectorAll('input[name="fch"]')], fcWhen: $('fcWhen'), fcTotal: $('fcTotal'),
      fcGain: $('fcGain'), fcRange: $('fcRange'), fcChart: $('fcChart'), fcInflation: $('fcInflation'),
      fcAccounts: $('fcAccounts'), fcNote: $('fcNote'),
      fcSheet: $('fcSheet'), fcForm: $('fcForm'), fcSheetTitle: $('fcSheetTitle'), fcPresets: $('fcPresets'),
      fcRate: $('fcRate'), fcMonthly: $('fcMonthly'), fcCap: $('fcCap'), fcRisky: $('fcRisky'),
      fcError: $('fcError'), fcReset: $('fcReset'), fcCancel: $('fcCancel')
    });
    // Graphique : période, affichage
    els.controls.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => {
      chartPref.period = Number(b.dataset.period);
      savePref('ct.wchart', chartPref);
      drawChart(cal.todayKey());
    }));
    els.controls.querySelectorAll('[data-cmode]').forEach((b) => b.addEventListener('click', () => {
      chartPref.cmode = b.dataset.cmode;
      savePref('ct.wchart', chartPref);
      drawChart(cal.todayKey());
    }));
    // Historique / Prévisions
    const setMode = (mode) => {
      fcPref.mode = mode;
      savePref('ct.fc', fcPref);
      applyMode();
      if (mode === 'forecast') { lastFcTotal = null; renderForecast(); } else drawChart(cal.todayKey());
    };
    els.wmHistory.addEventListener('change', () => setMode('history'));
    els.wmForecast.addEventListener('change', () => setMode('forecast'));
    applyMode();
    els.fcHorizon.forEach((r) => r.addEventListener('change', () => {
      fcPref.h = Number(r.value);
      savePref('ct.fc', fcPref);
      renderForecast();
    }));
    els.fcInflation.addEventListener('change', () => {
      fcPref.infl = els.fcInflation.checked;
      savePref('ct.fc', fcPref);
      renderForecast();
    });
    // Hypothèses
    els.fcPresets.querySelectorAll('[data-preset]').forEach((b) => {
      const pr = TC.forecast.PRESETS[b.dataset.preset];
      b.textContent = `${pr.label} · ${pctTxt(pr.rate)}`;
      b.addEventListener('click', () => fillHypothesis({ rate: pr.rate, vol: pr.vol, preset: b.dataset.preset, monthly: parseAmount(els.fcMonthly.value || '0') || 0, cap: els.fcCap.value.trim() ? parseAmount(els.fcCap.value) : null }));
    });
    els.fcForm.addEventListener('submit', saveHypothesis);
    els.fcReset.addEventListener('click', resetHypothesis);
    els.fcCancel.addEventListener('click', () => options.close(els.fcSheet));
    els.fcSheet.addEventListener('cancel', (e) => { e.preventDefault(); options.close(els.fcSheet); });
    els.accCat.replaceChildren(...Object.entries(CATEGORIES).map(([v, label]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      return o;
    }));
    els.addBtn.addEventListener('click', () => openAccount(null));
    els.accForm.addEventListener('submit', saveAccount);
    els.accCancel.addEventListener('click', () => options.close(els.accSheet));
    els.accDelete.addEventListener('click', deleteAccount);
    els.accSheet.addEventListener('cancel', (e) => { e.preventDefault(); options.close(els.accSheet); });
    els.finaryBtn.addEventListener('click', () => els.finaryInput.click());
    els.finaryInput.addEventListener('change', onFinaryChosen);
    els.finConfirm.addEventListener('click', confirmFinary);
    els.finCancel.addEventListener('click', () => options.close(els.finSheet));
    els.finSheet.addEventListener('cancel', (e) => { e.preventDefault(); options.close(els.finSheet); });
    if (window.ResizeObserver) {
      let w = 0;
      new ResizeObserver(() => {
        const cw = els.chart.clientWidth;
        if (cw && Math.abs(cw - w) > 4 && accounts.length) { w = cw; drawChart(cal.todayKey()); }
      }).observe(els.chart);
      let fw = 0;
      new ResizeObserver(() => {
        const cw = els.fcChart.clientWidth;
        if (cw && Math.abs(cw - fw) > 4 && accounts.length && fcPref.mode === 'forecast') { fw = cw; renderForecast(); }
      }).observe(els.fcChart);
    }
  }

  /* Au verrouillage : rien ne reste dans la page */
  function lock() {
    accounts = [];
    editing = null;
    pendingFinary = null;
    fcEditing = null;
    lastFcTotal = null;
    [els.chart, els.alloc, els.accounts, els.accHistory, els.finSummary, els.legend, els.fcChart, els.fcAccounts].forEach((n) => n && n.replaceChildren());
    if (els.total) { els.total.textContent = '–'; els.delta.textContent = ''; }
    if (els.fcTotal) { els.fcTotal.textContent = '–'; els.fcGain.textContent = ''; els.fcRange.textContent = ''; }
    [els.accSheet, els.finSheet, els.fcSheet].forEach((d) => d && d.open && d.close());
  }

  return { init, render, lock, CATEGORIES };
})();
