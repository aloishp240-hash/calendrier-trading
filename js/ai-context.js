/* Texte de contexte envoyé à une IA (coach Gemini intégré ou copie pour Claude) :
   - trading : la période affichée, ses stats, le détail jour par jour et trade par trade ;
   - patrimoine : comptes, soldes et historique, répartition, prévisions et hypothèses. */
window.TC = window.TC || {};

TC.aiContext = (function () {
  'use strict';

  const { cal } = TC;

  /* Consigne de rôle, commune au coach intégré et à la copie pour Claude */
  const COACH_RULES = [
    'Tu es mon coach financier personnel. Je vis en France. Je trade des CFD sur Trading 212 (compte en euros) et je suis mon patrimoine (comptes, livrets, PEA, assurance vie…).',
    'Tu reçois deux parties : (1) mon journal de trading pour une période — résultat de chaque jour, détail de chaque trade (heures d’ouverture et de clôture en heure locale, instrument, sens : Buy = pari à la hausse, Sell = pari à la baisse, unités, résultat en euros frais inclus) et des statistiques ; (2) mon patrimoine — chaque compte avec son solde, son taux et l’historique des soldes, la répartition, et des prévisions calculées par mon appli avec leurs hypothèses.',
    'Réponds à la question posée : trading, patrimoine, ou les deux. Réponds en français, de façon franche, concrète et chiffrée, en t’appuyant uniquement sur ces données : cite les jours, instruments, comptes et montants concernés. Si les données ne suffisent pas pour conclure (solde ancien, historique trop court…), dis-le.',
    'Trading : tu peux commenter la gestion du risque, la discipline, les horaires, la taille des positions, la régularité et les habitudes qui coûtent ou rapportent, et le poids du trading par rapport au reste du patrimoine.',
    'Patrimoine : tu peux commenter la répartition et la diversification, l’épargne de précaution, les plafonds et taux des livrets réglementés, l’horizon de placement, les frais, le risque de chaque poche, les grands principes de fiscalité française (PEA, assurance vie, livrets) et les hypothèses des prévisions (une moyenne passée n’est pas une promesse).',
    'N’invente jamais de trade, de cours, de taux ni d’actualité de marché : tu n’as pas accès aux marchés en direct.',
    'Ce n’est pas un conseil en investissement personnalisé : ne me recommande pas d’acheter ou de vendre un titre ou un fonds précis ; tu peux en revanche expliquer les options et leurs compromis.',
    'Sois concis : quelques paragraphes courts ou une liste, avec du gras pour l’essentiel.'
  ].join('\n');

  const CATEGORIES = { courant: 'Compte courant', livret: 'Livret', 'assurance-vie': 'Assurance vie', pea: 'PEA', trading212: 'Trading 212', autre: 'Autre' };
  const round2 = (n) => Math.round(n * 100) / 100;
  const eur = (n) => cal.fmtEur(n).replace(/^\+/, '');
  const pctTxt = (n) => `${String(round2(n)).replace('.', ',')} %`;

  function valueAt(a, day) {
    let v = null;
    for (const snap of a.snapshots) { if (snap.d <= day) v = snap.v; else break; }
    return v;
  }
  function shift(day, delta) {
    const d = cal.parseKey(day);
    d.setDate(d.getDate() + delta);
    return cal.dateKey(d.getFullYear(), d.getMonth(), d.getDate());
  }

  /* Partie patrimoine : accounts = TC.wealthStore.listAccounts() */
  function buildWealth(accounts) {
    const list = (accounts || []).filter((a) => a.snapshots && a.snapshots.length);
    const lines = ['PATRIMOINE'];
    if (!list.length) {
      lines.push('Aucun compte renseigné dans l’appli.');
      return lines.join('\n');
    }
    const today = cal.todayKey();
    const total = round2(list.reduce((t, a) => t + (valueAt(a, today) || 0), 0));
    lines.push(`Total : ${eur(total)} (au ${cal.fmtShortDate(today)}).`);

    // évolution sur 30 jours, sur les comptes qui existaient déjà
    const ref = shift(today, -30);
    let diff = 0, base = 0, n = 0;
    for (const a of list) {
      const b = valueAt(a, ref);
      if (b === null) continue;
      n++; base += b; diff += (valueAt(a, today) || 0) - b;
    }
    lines.push(n ? `Évolution sur 30 jours : ${cal.fmtEur(round2(diff))}${base ? ` (${diff >= 0 ? '+' : '−'}${pctTxt(Math.abs((diff / base) * 100))})` : ''}.`
      : 'Évolution sur 30 jours : historique trop court pour la calculer.');

    const byCat = {};
    for (const a of list) byCat[a.category] = round2((byCat[a.category] || 0) + (valueAt(a, today) || 0));
    lines.push('', 'Répartition :');
    for (const [c, v] of Object.entries(byCat).sort((x, y) => y[1] - x[1])) {
      lines.push(`- ${CATEGORIES[c] || c} : ${eur(v)} (${total ? Math.round((v / total) * 100) : 0} %)`);
    }

    lines.push('', 'Comptes :');
    for (const a of list.slice().sort((x, y) => (valueAt(y, today) || 0) - (valueAt(x, today) || 0))) {
      const last = a.snapshots[a.snapshots.length - 1];
      const age = Math.round((cal.parseKey(today) - cal.parseKey(last.d)) / 86400000);
      const meta = [CATEGORIES[a.category] || a.category, a.institution, a.rate !== null && a.rate !== undefined ? `taux ${pctTxt(a.rate)}/an` : null].filter(Boolean).join(', ');
      lines.push(`- ${a.name} (${meta}) : ${eur(last.v)}, solde du ${cal.fmtShortDate(last.d)}${age > 45 ? ` (non mis à jour depuis ${age} jours)` : ''}`);
      const hist = a.snapshots.slice(-8);
      if (hist.length > 1) lines.push(`    historique : ${hist.map((h) => `${cal.fmtShortDate(h.d).replace(/^\S+ /, '')} ${eur(h.v)}`).join(' → ')}`);
    }

    if (TC.forecast) {
      const items = list.map((acc) => ({ acc, balance: valueAt(acc, today) || 0 }));
      lines.push('', 'Prévisions de l’appli (scénario central, avant impôts ; fourchette 1 chance sur 10 pour la part en bourse) :');
      for (const [m, label] of [[12, '1 an'], [60, '5 ans'], [120, '10 ans']]) {
        const p = TC.forecast.project(items, m);
        lines.push(`- Dans ${label} : ${eur(round2(p.total.central[m]))}${p.risky ? ` (entre ${eur(round2(p.total.low[m]))} et ${eur(round2(p.total.high[m]))})` : ''}`);
      }
      lines.push('Hypothèses par compte :');
      for (const { acc } of items) {
        const h = TC.forecast.settings(acc);
        const parts = [`${pctTxt(h.rate || 0)}/an (${h.source})`];
        if (h.monthly) parts.push(`versement ${eur(h.monthly)}/mois`);
        if (h.cap) parts.push(`plafond ${eur(h.cap)}`);
        if (h.vol) parts.push(`volatilité ${pctTxt(h.vol)}`);
        lines.push(`- ${acc.name} : ${parts.join(', ')}`);
      }
    }
    return lines.join('\n');
  }

  const pct = (w, n) => (n ? `${Math.round((w / n) * 100)} %` : '–');
  const units = (u) => (typeof u === 'number' ? `${u.toLocaleString('fr-FR', { maximumFractionDigits: 4 })} u.` : '');

  /* view : résultat de cal.buildMonth / cal.buildWeek */
  /* Contexte complet : trading de la période + patrimoine (si accounts est fourni) */
  function build(view, isWeek, accounts) {
    const trading = buildTrading(view, isWeek);
    return accounts === undefined ? trading : `TRADING\n${trading}\n\n${buildWealth(accounts)}`;
  }

  function buildTrading(view, isWeek) {
    const s = view.stats;
    const days = view.days.filter((d) => d.entry);
    const lines = [];

    lines.push(`Période analysée : ${isWeek ? 'semaine du ' : ''}${view.label}`);
    if (!days.length) {
      lines.push('Aucun résultat enregistré sur cette période.');
      return lines.join('\n');
    }

    const worst = days.reduce((a, b) => (b.entry.pnl < a.entry.pnl ? b : a));
    lines.push(
      `Résumé : résultat total ${cal.fmtEur(s.total)} sur ${s.active} jour${s.active > 1 ? 's' : ''} tradé${s.active > 1 ? 's' : ''}, `
      + `${s.wins} jour${s.wins > 1 ? 's' : ''} gagnant${s.wins > 1 ? 's' : ''} (${pct(s.wins, s.active)}), `
      + `meilleur jour ${cal.fmtEur(s.best)} (${cal.fmtShortDate(s.bestKey)}), pire jour ${cal.fmtEur(worst.entry.pnl)} (${cal.fmtShortDate(worst.key)}).`
    );

    const b = TC.analysis.breakdown(view.days);
    if (b.list.length) {
      const dir = (name, x) => `${name} : ${x.trades} trade${x.trades > 1 ? 's' : ''}, ${cal.fmtEur(x.total)}, ${pct(x.wins, x.trades)} gagnants`;
      lines.push('', 'Par sens :', `- ${dir('Buy (hausse)', b.dirs.buy)}`, `- ${dir('Sell (baisse)', b.dirs.sell)}`);
      lines.push('', 'Par instrument (du plus rentable au plus coûteux) :');
      for (const x of b.list) {
        lines.push(`- ${x.name} : ${x.trades} trade${x.trades > 1 ? 's' : ''}, ${cal.fmtEur(x.total)}, ${pct(x.wins, x.trades)} gagnants, `
          + `moyenne ${cal.fmtEur(Math.round((x.total / x.trades) * 100) / 100)} par trade (${x.buy} Buy / ${x.sell} Sell)`);
      }
      const missing = b.daysWithEntry - b.daysWithTrades;
      if (missing > 0) lines.push(`(${missing} jour${missing > 1 ? 's' : ''} sans détail des trades, saisi${missing > 1 ? 's' : ''} à la main.)`);
    }

    lines.push('', 'Détail jour par jour :');
    for (const d of days) {
      const e = d.entry;
      lines.push(`- ${cal.fmtShortDate(d.key)} : ${cal.fmtEur(e.pnl)}${e.note ? ` — note : ${e.note}` : ''}`);
      for (const t of e.trades || []) {
        const open = cal.fmtTime(t.opened);
        const close = cal.fmtTime(t.closed);
        const parts = [
          open && close ? `${open} → ${close}` : close,
          t.instrument,
          t.dir === 'buy' ? 'Buy' : t.dir === 'sell' ? 'Sell' : '',
          units(t.units)
        ].filter(Boolean);
        lines.push(`    • ${parts.join(' ')} : ${cal.fmtEur(t.result)}`);
      }
    }
    return lines.join('\n');
  }

  /* Texte complet à coller dans Claude */
  function forClaude(view, isWeek, accounts) {
    return `${COACH_RULES}\n\n=== MES DONNÉES ===\n${build(view, isWeek, accounts)}\n=== FIN DES DONNÉES ===\n\n`
      + 'Commence par une analyse globale : mon trading sur cette période (points forts, points faibles, habitudes à corriger) et mon patrimoine (répartition, points d’attention), puis je te poserai mes questions.';
  }

  return { COACH_RULES, build, buildWealth, forClaude };
})();
