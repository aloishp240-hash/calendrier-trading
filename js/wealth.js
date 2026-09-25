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

  const els = {};
  let accounts = [];
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
  }

  function drawChart(today) {
    els.chart.replaceChildren();
    const dates = [...new Set(accounts.flatMap((a) => a.snapshots.map((s) => s.d)))].sort();
    if (dates.length && dates[dates.length - 1] < today) dates.push(today);
    els.chartHint.hidden = dates.length >= 2 || !accounts.length;
    if (dates.length < 2) return;

    const points = dates.map((d) => ({ d, v: totalAt(d), t: cal.parseKey(d).getTime() }));
    const width = Math.max(260, els.chart.clientWidth || 320);
    const height = width < 600 ? 150 : 190;
    const m = { top: 10, right: 12, bottom: 22, left: 58 };
    const iw = width - m.left - m.right, ih = height - m.top - m.bottom;
    const vals = points.map((p) => p.v);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.15, hi * 0.01, 10);
    const ticks = TC.analysis.niceTicks(lo - pad, hi + pad, 3);
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const t0 = points[0].t, t1 = points[points.length - 1].t;
    const x = (t) => m.left + ((t - t0) / (t1 - t0 || 1)) * iw;
    const y = (v) => m.top + (1 - (v - y0) / (y1 - y0 || 1)) * ih;

    const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart-svg', role: 'img' });
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
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
    root.append(svg('path', { d: `${line} L${x(t1).toFixed(1)} ${m.top + ih} L${x(t0).toFixed(1)} ${m.top + ih} Z`, class: 'chart-area accent' }));
    root.append(svg('path', { d: line, class: 'chart-line accent' }));
    const last = points[points.length - 1];
    root.append(svg('circle', { cx: x(last.t), cy: y(last.v), r: 4, class: 'chart-dot accent' }));

    // Survol / toucher
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
      tip.replaceChildren(el('div', 'chart-tip-date', cal.fmtShortDate(p.d)), el('div', 'chart-tip-cum', eur(p.v)));
      tip.hidden = false;
      const left = (x(p.t) / width) * box.width;
      tip.style.left = Math.max(0, Math.min(box.width - tip.offsetWidth, left - tip.offsetWidth / 2)) + 'px';
      tip.style.top = Math.max(0, (y(p.v) / height) * box.height - tip.offsetHeight - 12) + 'px';
    };
    hit.addEventListener('pointermove', (e) => show(e.clientX));
    hit.addEventListener('pointerdown', (e) => show(e.clientX));
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; });
    root.setAttribute('aria-label', `Évolution du patrimoine : ${eur(points[0].v)} le ${cal.fmtShortDate(points[0].d)}, ${eur(last.v)} le ${cal.fmtShortDate(last.d)}.`);
    els.chart.append(root, tip);
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
      finConfirm: $('finaryConfirm'), finCancel: $('finaryCancel')
    });
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
    }
  }

  /* Au verrouillage : rien ne reste dans la page */
  function lock() {
    accounts = [];
    editing = null;
    pendingFinary = null;
    [els.chart, els.alloc, els.accounts, els.accHistory, els.finSummary].forEach((n) => n && n.replaceChildren());
    if (els.total) { els.total.textContent = '–'; els.delta.textContent = ''; }
    [els.accSheet, els.finSheet].forEach((d) => d && d.open && d.close());
  }

  return { init, render, lock, CATEGORIES };
})();
