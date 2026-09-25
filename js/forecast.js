/* Prévisions de patrimoine : projection de chaque compte à 1 mois … 10 ans.

   - Livrets, fonds euros, comptes : intérêts composés (capitalisation mensuelle
     équivalente au taux annuel), versements mensuels arrêtés au plafond.
   - Placements en bourse (PEA…) : croissance au rendement annuel choisi pour le
     scénario central ; fourchette « prudente / favorable » = 1 chance sur 10 de
     faire moins bien / mieux, d'après la volatilité historique (modèle log-normal).
   Aucune manipulation de la page ici. */
window.TC = window.TC || {};

TC.forecast = (function () {
  'use strict';

  /* Référence : fiche officielle MSCI World (EUR, dividendes réinvestis), 31/08/2026 */
  const MSCI = { tenYears: 12.53, since2000: 6.64, vol10y: 13.45, asOf: '31 août 2026' };
  const DCAM_FEES = 0.20;                  // frais annuels de l'ETF DCAM
  const round2 = (n) => Math.round(n * 100) / 100;

  const PRESETS = {
    msci10: { label: 'MSCI World · moyenne 10 ans', rate: round2(MSCI.tenYears - DCAM_FEES), vol: MSCI.vol10y },
    msci2000: { label: 'MSCI World · moyenne depuis 2000', rate: round2(MSCI.since2000 - DCAM_FEES), vol: MSCI.vol10y }
  };

  const Z90 = 1.2816;                      // 10 % / 90 % d'une loi normale
  const INFLATION = 2;                     // %/an, pour « euros d'aujourd'hui »

  /* Plafonds réglementaires reconnus d'après le nom du livret */
  const CAPS = [
    { re: /jeune/i, cap: 1600 },
    { re: /\bldds?\b|durable/i, cap: 12000 },
    { re: /\blep\b|populaire/i, cap: 10000 },
    { re: /livret\s*a\b/i, cap: 22950 }
  ];

  /* Hypothèses par défaut selon le type de compte */
  function defaults(acc) {
    const rate = acc.rate !== null && acc.rate !== undefined ? Number(acc.rate) : null;
    switch (acc.category) {
      case 'livret': {
        const c = CAPS.find((x) => x.re.test(acc.name || ''));
        return { rate: rate !== null ? rate : 1.7, vol: 0, monthly: 0, cap: c ? c.cap : null, source: 'taux du livret' };
      }
      case 'assurance-vie':
        return { rate: rate !== null ? rate : 2.65, vol: 0, monthly: 0, cap: null, source: rate !== null ? 'taux du contrat' : 'moyenne des fonds euros 2025' };
      case 'pea':
        return { rate: PRESETS.msci10.rate, vol: PRESETS.msci10.vol, monthly: 0, cap: null, preset: 'msci10', source: PRESETS.msci10.label };
      case 'courant':
        return { rate: 0, vol: 0, monthly: 0, cap: null, source: 'pas de rémunération' };
      default:
        return { rate: rate !== null ? rate : 0, vol: 0, monthly: 0, cap: null, source: rate !== null ? 'taux indiqué' : 'aucun rendement supposé' };
    }
  }

  /* Hypothèses effectives : défauts + réglages que tu as modifiés sur le compte */
  function settings(acc) {
    const d = defaults(acc);
    const f = acc.forecast || {};
    const s = { ...d };
    for (const k of ['rate', 'vol', 'monthly', 'cap', 'preset']) if (f[k] !== undefined) s[k] = f[k];
    if (f.rate !== undefined && f.preset === undefined) { s.preset = null; s.source = 'taux personnalisé'; }
    if (s.preset && PRESETS[s.preset]) s.source = PRESETS[s.preset].label;
    s.custom = !!acc.forecast;
    return s;
  }

  /* Valeur mois par mois (index 0 = aujourd'hui) pour un scénario z (0 = central) */
  function simulate(balance, s, months, z = 0) {
    const r = (Number(s.rate) || 0) / 100;
    const sigma = (Number(s.vol) || 0) / 100;
    const monthly = Math.max(0, Number(s.monthly) || 0);
    const out = new Array(months + 1);
    if (!sigma) {
      const g = Math.pow(1 + r, 1 / 12) - 1;
      let v = balance;
      out[0] = v;
      for (let m = 1; m <= months; m++) {
        v *= 1 + g;
        if (monthly) {
          const room = s.cap !== null && s.cap !== undefined ? Math.max(0, s.cap - v) : Infinity;
          v += Math.min(monthly, room);
        }
        out[m] = v;
      }
      return out;
    }
    // Bourse : croissance médiane (1 + r)^T, décalée de z écarts-types sur la durée
    const G = (T) => Math.pow(1 + r, T) * Math.exp(z * sigma * Math.sqrt(T));
    for (let m = 0; m <= months; m++) {
      let v = balance * G(m / 12);
      for (let k = 1; k <= m; k++) v += monthly * G((m - k) / 12);
      out[m] = v;
    }
    return out;
  }

  /* Somme des versements effectivement faits (plafond compris) sur la période */
  function contributed(balance, s, months) {
    const monthly = Math.max(0, Number(s.monthly) || 0);
    if (!monthly) return 0;
    if (s.vol || s.cap === null || s.cap === undefined) return monthly * months;
    const g = Math.pow(1 + (Number(s.rate) || 0) / 100, 1 / 12) - 1;
    let v = balance, sum = 0;
    for (let m = 1; m <= months; m++) {
      v *= 1 + g;
      const c = Math.min(monthly, Math.max(0, s.cap - v));
      v += c;
      sum += c;
    }
    return sum;
  }

  /* Projection de tous les comptes. items : [{ acc, balance }] */
  function project(items, months, { inflation = false } = {}) {
    const deflate = (m) => (inflation ? Math.pow(1 + INFLATION / 100, m / 12) : 1);
    const total = { central: new Array(months + 1).fill(0), low: new Array(months + 1).fill(0), high: new Array(months + 1).fill(0) };
    let deposits = 0, risky = false;
    const accounts = items.map(({ acc, balance }) => {
      const s = settings(acc);
      const central = simulate(balance, s, months, 0);
      const low = s.vol ? simulate(balance, s, months, -Z90) : central;
      const high = s.vol ? simulate(balance, s, months, Z90) : central;
      if (s.vol) risky = true;
      const dep = contributed(balance, s, months);
      deposits += dep;
      for (let m = 0; m <= months; m++) {
        const d = deflate(m);
        central[m] /= d; if (low !== central) low[m] /= d; if (high !== central) high[m] /= d;
        total.central[m] += central[m];
        total.low[m] += low[m];
        total.high[m] += high[m];
      }
      return { acc, s, balance, central, low, high, deposits: dep };
    });
    return { months, accounts, total, deposits, risky, inflation };
  }

  return { MSCI, PRESETS, INFLATION, defaults, settings, simulate, project, round2 };
})();
