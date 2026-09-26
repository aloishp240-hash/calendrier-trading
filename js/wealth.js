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

  let histPrev = null, histStop = null;

  /* Pendant le glissement du doigt, le grand montant et la date suivent la courbe */
  function scrubHero(totalEl, subEl) {
    let saved = null;
    return {
      show(value, sub, cls) {
        if (!saved) saved = { total: totalEl.textContent, sub: subEl.textContent, cls: subEl.className };
        totalEl.textContent = eur(round2(value));
        subEl.textContent = sub;
        subEl.className = saved.cls.split(' ')[0] + ' ' + (cls || '');
        totalEl.classList.add('is-scrubbing');
      },
      reset() {
        if (!saved) return;
        totalEl.textContent = saved.total;
        subEl.textContent = saved.sub;
        subEl.className = saved.cls;
        totalEl.classList.remove('is-scrubbing');
        saved = null;
      }
    };
  }

  function drawChart(today) {
    const C = TC.chart;
    if (histStop) histStop();
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
    if (!enough) { histPrev = null; return; }

    const stacked = chartPref.cmode === 'stack' && cats.length > 1;
    const points = dates.map((d) => {
      const layers = [];
      let acc = 0;
      for (const c of cats) { acc = round2(acc + sumAt(d, [c])); layers.push(acc); }
      return { d, t: cal.parseKey(d).getTime(), v: acc, layers };
    });

    const width = Math.max(260, els.chart.clientWidth || 320);
    const height = width < 600 ? 170 : 210;
    const m = { top: 16, right: 6, bottom: 24, left: 6 };
    const iw = width - m.left - m.right, ih = height - m.top - m.bottom;
    const vals = points.map((p) => p.v);
    const lo = stacked ? 0 : Math.min(...vals), hi = Math.max(...vals);
    const pad = stacked ? 0 : Math.max((hi - lo) * 0.25, hi * 0.01, 10);
    const ticks = TC.analysis.niceTicks(Math.max(0, lo - pad), hi + pad, 3);
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const t0 = points[0].t, t1 = points[points.length - 1].t;
    const x = (t) => m.left + ((t - t0) / (t1 - t0 || 1)) * iw;
    const y = (v) => m.top + (1 - (v - y0) / (y1 - y0 || 1)) * ih;
    const base = m.top + ih;

    const root = C.el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart-svg', role: 'img' });
    const defs = C.el('defs');
    root.append(defs);
    // repères discrets, étiquettes posées dans le graphique (style épuré)
    for (const t of ticks.slice(1)) {
      root.append(C.el('line', { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), class: 'chart-grid' }));
      const lab = C.el('text', { x: width - m.right, y: y(t) - 4, class: 'chart-tick', 'text-anchor': 'end' });
      lab.textContent = Math.round(t).toLocaleString('fr-FR');
      root.append(lab);
    }
    for (const p of [points[0], points[points.length - 1]]) {
      const lab = C.el('text', { x: x(p.t), y: height - 5, class: 'chart-tick', 'text-anchor': p === points[0] ? 'start' : 'end' });
      lab.textContent = cal.fmtShortDate(p.d).replace(/^\S+ /, '');
      root.append(lab);
    }

    if (stacked) {
      // Couches empilées et lissées, de bas en haut dans l'ordre des couleurs
      const bounds = cats.map((c, i) => C.sample(points.map((p) => [x(p.t), y(p.layers[i])])));
      const floor = bounds[0].map((q) => [q[0], base]);
      cats.forEach((c, i) => {
        const path = C.el('path', { d: C.band(bounds[i], i ? bounds[i - 1] : floor), class: 'chart-stack chart-fade' });
        path.style.fill = `var(--series-${SLOTS.indexOf(c) + 1})`;
        root.append(path);
      });
      histPrev = null;
    } else {
      const pts = C.sample(points.map((p) => [x(p.t), y(p.v)]));
      const fill = C.gradient(defs, 'wg' + Math.random().toString(36).slice(2, 7));
      const areaEl = C.el('path', { d: C.area(pts, base), fill, class: 'chart-grad' });
      const lineEl = C.el('path', { d: C.line(pts), class: 'chart-line accent chart-glow' });
      root.append(areaEl, lineEl);
      if (histPrev && histPrev.width === width) {
        // la courbe précédente se transforme en douceur en la nouvelle
        const from = histPrev.pts;
        histStop = C.tween(480, (k) => {
          const cur = C.mix(from, pts, k);
          lineEl.setAttribute('d', C.line(cur));
          areaEl.setAttribute('d', C.area(cur, base));
        });
      } else {
        lineEl.classList.add('chart-draw');
        lineEl.setAttribute('pathLength', 1);
      }
      histPrev = { pts, width };
    }
    const last = points[points.length - 1];
    root.append(C.el('circle', { cx: x(last.t), cy: y(last.v), r: 4.5, class: 'chart-dot accent chart-pulse' }));

    // Glisser le doigt : le montant en haut suit la courbe
    const cross = C.el('line', { y1: m.top - 6, y2: base, class: 'chart-cross', visibility: 'hidden' });
    const dot = C.el('circle', { r: 6, class: 'chart-dot accent chart-scrub-dot', visibility: 'hidden' });
    const hit = C.el('rect', { x: 0, y: 0, width, height, fill: 'transparent', class: 'chart-hit' });
    root.append(cross, dot, hit);
    const tip = el('div', 'chart-tip');
    tip.hidden = true;
    const hero = scrubHero(els.total, els.delta);
    const show = (clientX) => {
      const box = root.getBoundingClientRect();
      const px = ((clientX - box.left) / box.width) * width;
      const p = points.reduce((best, q) => (Math.abs(x(q.t) - px) < Math.abs(x(best.t) - px) ? q : best));
      cross.setAttribute('x1', x(p.t)); cross.setAttribute('x2', x(p.t)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(p.t)); dot.setAttribute('cy', y(p.v)); dot.setAttribute('visibility', 'visible');
      const diff = round2(p.v - points[0].v);
      hero.show(p.v, `${cal.fmtLongDate(p.d)} · ${cal.fmtEur(diff)} sur la période`, diff > 0 ? 'tone-win' : diff < 0 ? 'tone-loss' : '');
      if (stacked) {
        const rows = [];
        for (let i = cats.length - 1; i >= 0; i--) {
          const r = el('div', 'chart-tip-row');
          const sw = el('span', 'legend-swatch');
          sw.style.background = `var(--series-${SLOTS.indexOf(cats[i]) + 1})`;
          r.append(sw, el('span', null, `${CATEGORIES[cats[i]]} : ${eur(round2(p.layers[i] - (i ? p.layers[i - 1] : 0)))}`));
          rows.push(r);
        }
        tip.replaceChildren(...rows);
        tip.hidden = false;
        const left = (x(p.t) / width) * box.width;
        tip.style.left = Math.max(0, Math.min(box.width - tip.offsetWidth, left - tip.offsetWidth / 2)) + 'px';
        tip.style.top = '0px';
      }
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; hero.reset(); };
    hit.addEventListener('pointermove', (e) => show(e.clientX));
    hit.addEventListener('pointerdown', (e) => show(e.clientX));
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') hide(); });
    hit.addEventListener('pointercancel', hide);
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

  let fcPrev = null, fcStop = null;

  function drawForecastChart(p, today) {
    const C = TC.chart;
    if (fcStop) fcStop();
    els.fcChart.replaceChildren();
    const months = p.months;
    const width = Math.max(260, els.fcChart.clientWidth || 320);
    const height = width < 600 ? 180 : 220;
    const m = { top: 16, right: 6, bottom: 24, left: 6 };
    const iw = width - m.left - m.right, ih = height - m.top - m.bottom;
    const lows = p.total.low, highs = p.total.high, mid = p.total.central;
    const ticks = TC.analysis.niceTicks(Math.max(0, Math.min(...lows, today) * 0.97), Math.max(...highs) * 1.02, 3);
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const x = (i) => m.left + (i / months) * iw;
    const y = (v) => m.top + (1 - (v - y0) / (y1 - y0 || 1)) * ih;
    const base = m.top + ih;

    const root = C.el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart-svg', role: 'img' });
    const defs = C.el('defs');
    root.append(defs);
    for (const t of ticks.slice(1)) {
      root.append(C.el('line', { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), class: 'chart-grid' }));
      const lab = C.el('text', { x: width - m.right, y: y(t) - 4, class: 'chart-tick', 'text-anchor': 'end' });
      lab.textContent = Math.round(t).toLocaleString('fr-FR');
      root.append(lab);
    }
    const lab0 = C.el('text', { x: m.left, y: height - 5, class: 'chart-tick', 'text-anchor': 'start' });
    lab0.textContent = 'aujourd’hui';
    const lab1 = C.el('text', { x: width - m.right, y: height - 5, class: 'chart-tick', 'text-anchor': 'end' });
    lab1.textContent = horizonDate(months);
    root.append(lab0, lab1);

    const toPts = (arr) => C.sample(arr.map((v, i) => [x(i), y(v)]));
    const midPts = toPts(mid), lowPts = toPts(lows), highPts = toPts(highs);
    const bandEl = C.el('path', { d: C.band(highPts, lowPts), class: 'fc-band' });
    if (!p.risky) bandEl.style.display = 'none';
    const fill = C.gradient(defs, 'fg' + Math.random().toString(36).slice(2, 7));
    const areaEl = C.el('path', { d: C.area(midPts, base), fill, class: 'chart-grad' });
    const lineEl = C.el('path', { d: C.line(midPts), class: 'chart-line accent chart-glow' });
    const endDot = C.el('circle', { cx: x(months), cy: y(mid[months]), r: 4.5, class: 'chart-dot accent chart-pulse' });
    root.append(bandEl, areaEl, lineEl, endDot);
    if (fcPrev && fcPrev.width === width) {
      // passage d'un horizon à l'autre : les courbes se transforment en douceur
      const from = fcPrev;
      fcStop = C.tween(520, (k) => {
        const cm = C.mix(from.mid, midPts, k);
        lineEl.setAttribute('d', C.line(cm));
        areaEl.setAttribute('d', C.area(cm, base));
        if (p.risky) bandEl.setAttribute('d', C.band(C.mix(from.high, highPts, k), C.mix(from.low, lowPts, k)));
        endDot.setAttribute('cy', cm[cm.length - 1][1]);
      });
    } else {
      lineEl.classList.add('chart-draw');
      lineEl.setAttribute('pathLength', 1);
    }
    fcPrev = { mid: midPts, low: lowPts, high: highPts, width };

    const cross = C.el('line', { y1: m.top - 6, y2: base, class: 'chart-cross', visibility: 'hidden' });
    const dot = C.el('circle', { r: 6, class: 'chart-dot accent chart-scrub-dot', visibility: 'hidden' });
    const hit = C.el('rect', { x: 0, y: 0, width, height, fill: 'transparent', class: 'chart-hit' });
    root.append(cross, dot, hit);
    const heroTotal = scrubHero(els.fcTotal, els.fcRange);
    const whenSaved = { text: null };
    const show = (clientX) => {
      const box = root.getBoundingClientRect();
      const i = Math.max(0, Math.min(months, Math.round(((((clientX - box.left) / box.width) * width) - m.left) / iw * months)));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(mid[i])); dot.setAttribute('visibility', 'visible');
      if (whenSaved.text === null) whenSaved.text = els.fcWhen.textContent;
      const years = Math.floor(i / 12), rest = i % 12;
      els.fcWhen.textContent = i === 0 ? 'Aujourd’hui'
        : `Dans ${years ? `${years} an${years > 1 ? 's' : ''}` : ''}${years && rest ? ' et ' : ''}${rest ? `${rest} mois` : ''}`;
      heroTotal.show(mid[i], p.risky && i ? `Fourchette : ${eur(round2(lows[i]))} à ${eur(round2(highs[i]))}` : '', '');
    };
    const hide = () => {
      cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden');
      heroTotal.reset();
      if (whenSaved.text !== null) { els.fcWhen.textContent = whenSaved.text; whenSaved.text = null; }
    };
    hit.addEventListener('pointermove', (e) => show(e.clientX));
    hit.addEventListener('pointerdown', (e) => show(e.clientX));
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') hide(); });
    hit.addEventListener('pointercancel', hide);
    root.setAttribute('aria-label', `Prévision du patrimoine : ${eur(today)} aujourd’hui, environ ${eur(round2(mid[months]))} dans ${HORIZONS[months]}` + (p.risky ? `, fourchette ${eur(round2(lows[months]))} à ${eur(round2(highs[months]))}.` : '.'));
    els.fcChart.append(root);
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

  /* Répartition : anneau (camembert) + liste des valeurs */
  function renderAllocation(today, total) {
    const C = TC.chart;
    els.alloc.replaceChildren();
    els.donut.replaceChildren();
    const sums = {};
    for (const a of accounts) {
      const v = valueAt(a, today);
      if (v) sums[a.category] = round2((sums[a.category] || 0) + v);
    }
    const rows = Object.entries(sums).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    els.allocPanel.hidden = !rows.length;
    if (!rows.length) return;
    const sum = rows.reduce((t, [, v]) => t + v, 0);
    const pct = (v) => Math.round((v / sum) * 100);

    const size = 180, r = 68, stroke = 26, circ = 2 * Math.PI * r;
    const svgEl = C.el('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: 'donut-svg', role: 'img',
      'aria-label': 'Répartition : ' + rows.map(([c, v]) => `${CATEGORIES[c]} ${pct(v)} %`).join(', ') });
    const ring = C.el('g', { transform: `rotate(-90 ${size / 2} ${size / 2})` });
    ring.append(C.el('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': stroke, class: 'donut-track' }));
    const gap = rows.length > 1 ? 3 : 0;                 // espace entre les parts
    let start = 0;
    const segs = rows.map(([cat, v]) => {
      const len = (v / sum) * circ;
      const seg = C.el('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': stroke, class: 'donut-seg' });
      seg.style.stroke = `var(--series-${SLOTS.indexOf(cat) + 1})`;
      seg.style.strokeDasharray = `0 ${circ}`;
      seg.style.strokeDashoffset = String(-start);
      seg.dataset.target = `${Math.max(0.5, len - gap)} ${circ}`;
      seg.dataset.cat = cat;
      start += len;
      ring.append(seg);
      return seg;
    });
    const center = C.el('g', { class: 'donut-center' });
    const l1 = C.el('text', { x: size / 2, y: size / 2 - 8, 'text-anchor': 'middle', class: 'donut-label' });
    const l2 = C.el('text', { x: size / 2, y: size / 2 + 14, 'text-anchor': 'middle', class: 'donut-value' });
    center.append(l1, l2);
    svgEl.append(ring, center);
    els.donut.append(svgEl);

    const items = [];
    const select = (cat) => {
      const v = cat ? sums[cat] : sum;
      l1.textContent = cat ? `${CATEGORIES[cat]} · ${pct(v)} %` : 'Total';
      l2.textContent = eur(round2(v));
      segs.forEach((sg) => sg.classList.toggle('is-dim', !!cat && sg.dataset.cat !== cat));
      items.forEach((li) => li.classList.toggle('is-active', li.dataset.cat === cat));
    };
    for (const [cat, v] of rows) {
      const li = el('li', 'alloc-row');
      li.dataset.cat = cat;
      li.tabIndex = 0;
      const sw = el('span', 'legend-swatch');
      sw.style.background = `var(--series-${SLOTS.indexOf(cat) + 1})`;
      const name = el('span', 'alloc-name');
      name.append(sw, document.createTextNode(CATEGORIES[cat]));
      li.append(name, el('span', 'alloc-val', `${eur(v)} · ${pct(v)} %`));
      li.addEventListener('pointerenter', () => select(cat));
      li.addEventListener('pointerleave', () => select(null));
      li.addEventListener('focus', () => select(cat));
      li.addEventListener('blur', () => select(null));
      li.addEventListener('click', () => select(li.classList.contains('is-active') ? null : cat));
      items.push(li);
      els.alloc.append(li);
    }
    segs.forEach((sg) => {
      sg.addEventListener('pointerenter', () => select(sg.dataset.cat));
      sg.addEventListener('pointerleave', () => select(null));
      sg.addEventListener('click', () => select(sg.classList.contains('is-dim') || !items.some((i) => i.classList.contains('is-active')) ? sg.dataset.cat : null));
    });
    select(null);
    // l'anneau se dessine en tournant
    requestAnimationFrame(() => requestAnimationFrame(() => segs.forEach((sg) => { sg.style.strokeDasharray = sg.dataset.target; })));
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
      empty: $('wealthEmpty'), alloc: $('wealthAlloc'), donut: $('wealthDonut'), allocPanel: $('wealthAllocPanel'), accounts: $('wealthAccounts'),
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
    histPrev = null;
    fcPrev = null;
    [els.chart, els.alloc, els.donut, els.accounts, els.accHistory, els.finSummary, els.legend, els.fcChart, els.fcAccounts].forEach((n) => n && n.replaceChildren());
    if (els.total) { els.total.textContent = '–'; els.delta.textContent = ''; }
    if (els.fcTotal) { els.fcTotal.textContent = '–'; els.fcGain.textContent = ''; els.fcRange.textContent = ''; }
    [els.accSheet, els.finSheet, els.fcSheet].forEach((d) => d && d.open && d.close());
  }

  return { init, render, lock, CATEGORIES };
})();
