/* Texte de contexte envoyé à une IA (coach Gemini intégré ou copie pour Claude) :
   la période affichée, ses stats, et le détail jour par jour et trade par trade. */
window.TC = window.TC || {};

TC.aiContext = (function () {
  'use strict';

  const { cal } = TC;

  /* Consigne de rôle, commune au coach intégré et à la copie pour Claude */
  const COACH_RULES = [
    'Tu es mon coach de trading personnel. Je trade des CFD sur Trading 212 (compte en euros).',
    'Tu reçois mon journal pour une période : résultat de chaque jour, détail de chaque trade (heures d’ouverture et de clôture en heure locale, instrument, sens — Buy = pari à la hausse, Sell = pari à la baisse —, unités, résultat en euros frais inclus) et des statistiques.',
    'Réponds en français, de façon franche, concrète et chiffrée, en t’appuyant uniquement sur ces données : cite les jours, les instruments et les montants concernés. Si les données ne suffisent pas pour conclure, dis-le.',
    'N’invente jamais de trade, de cours ni d’actualité de marché : tu n’as pas accès aux marchés en direct.',
    'Tu peux commenter la gestion du risque, la discipline, les horaires, la taille des positions, la régularité et les habitudes qui coûtent ou rapportent.',
    'Ce n’est pas un conseil en investissement personnalisé : ne me recommande pas d’acheter ou de vendre un actif précis.',
    'Sois concis : quelques paragraphes courts ou une liste, avec du gras pour l’essentiel.'
  ].join('\n');

  const pct = (w, n) => (n ? `${Math.round((w / n) * 100)} %` : '–');
  const units = (u) => (typeof u === 'number' ? `${u.toLocaleString('fr-FR', { maximumFractionDigits: 4 })} u.` : '');

  /* view : résultat de cal.buildMonth / cal.buildWeek */
  function build(view, isWeek) {
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
  function forClaude(view, isWeek) {
    return `${COACH_RULES}\n\n=== MON JOURNAL ===\n${build(view, isWeek)}\n=== FIN DU JOURNAL ===\n\n`
      + 'Commence par une analyse globale de cette période (points forts, points faibles, habitudes à corriger), puis je te poserai mes questions.';
  }

  return { COACH_RULES, build, forClaude };
})();
