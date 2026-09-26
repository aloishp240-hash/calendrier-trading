/* Résumé pour le widget (Scriptable) : quelques chiffres seulement, envoyés
   chiffrés avec la clé de synchro dans le dépôt privé (voir sync.js). */
window.TC = window.TC || {};

TC.widgetSummary = (function () {
  'use strict';

  const round2 = (n) => Math.round(n * 100) / 100;
  const CATS = { courant: 'Comptes', livret: 'Livrets', 'assurance-vie': 'Assurance vie', pea: 'PEA', trading212: 'Trading 212', autre: 'Autre' };

  function valueAt(a, day) {
    let v = null;
    for (const s of a.snapshots) { if (s.d <= day) v = s.v; else break; }
    return v;
  }
  function shift(day, delta) {
    const d = TC.cal.parseKey(day);
    d.setDate(d.getDate() + delta);
    return TC.cal.dateKey(d.getFullYear(), d.getMonth(), d.getDate());
  }

  async function build() {
    const cal = TC.cal;
    const today = cal.todayKey();
    const accounts = (await TC.wealthStore.listAccounts()).filter((a) => a.snapshots.length);
    const entries = await TC.storage.loadAll();

    // Patrimoine : total, évolution sur 30 jours (hors nouveaux comptes), courbe
    const total = round2(accounts.reduce((t, a) => t + (valueAt(a, today) || 0), 0));
    const dates = [...new Set(accounts.flatMap((a) => a.snapshots.map((s) => s.d)))].sort();
    let evo = null;
    if (dates.length) {
      const ref = dates[0] > shift(today, -30) ? dates[0] : shift(today, -30);
      if (ref < today) {
        let diff = 0, base = 0, n = 0;
        for (const a of accounts) {
          const b = valueAt(a, ref);
          if (b === null) continue;
          n++; base += b; diff += (valueAt(a, today) || 0) - b;
        }
        if (n) evo = { diff: round2(diff), pct: base ? round2((diff / base) * 100) : null, since: ref };
      }
    }
    const pts = dates.filter((d) => d >= shift(today, -365));
    if (pts.length && pts[pts.length - 1] < today) pts.push(today);
    const series = pts.slice(-24).map((d) => round2(accounts.reduce((t, a) => t + (valueAt(a, d) || 0), 0)));
    const alloc = {};
    for (const a of accounts) {
      const v = valueAt(a, today);
      if (v > 0) alloc[a.category] = round2((alloc[a.category] || 0) + v);
    }

    // Trading du mois en cours
    const now = new Date();
    const month = cal.buildMonth(now.getFullYear(), now.getMonth(), entries);
    const t = entries[today];

    // Prévision à 10 ans (scénario central et fourchette)
    let forecast = null;
    if (accounts.length && TC.forecast) {
      const p = TC.forecast.project(accounts.map((acc) => ({ acc, balance: valueAt(acc, today) || 0 })), 120);
      forecast = { central: round2(p.total.central[120]), low: round2(p.total.low[120]), high: round2(p.total.high[120]) };
    }

    return {
      v: 1,
      day: today,
      wealth: {
        total,
        evo,
        series,
        alloc: Object.entries(alloc).sort((a, b) => b[1] - a[1]).map(([c, v]) => ({ label: CATS[c] || c, value: v, cat: c }))
      },
      trading: {
        label: month.label,
        total: month.stats.total,
        wins: month.stats.wins,
        days: month.stats.active,
        today: t && typeof t.pnl === 'number' ? t.pnl : null
      },
      forecast
    };
  }

  return { build };
})();
