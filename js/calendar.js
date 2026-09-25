/* Calculs du calendrier : grille du mois, statistiques, intensité des couleurs,
   formatage des montants et des dates. Aucune manipulation de la page ici. */
window.TC = window.TC || {};

TC.cal = (function () {
  'use strict';

  const MONTHS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet',
                  'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
  const MINUS = '−';          // vrai signe moins typographique
  const NNBSP = ' ';          // espace fine insécable (avant € et %)

  const num2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
  const longDate = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const shortDate = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });

  const pad = (n) => String(n).padStart(2, '0');

  function dateKey(y, m, d) { return `${y}-${pad(m + 1)}-${pad(d)}`; }
  function todayKey() {
    const t = new Date();
    return dateKey(t.getFullYear(), t.getMonth(), t.getDate());
  }
  function parseKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function sign(n) { return n > 0 ? '+' : n < 0 ? MINUS : ''; }

  /* +49,66 € / −24,88 € / 0,00 € */
  function fmtEur(n) {
    return sign(n) + num2.format(Math.abs(n)) + NNBSP + '€';
  }
  /* Version courte pour les cases : +49,66 / −1,2 k */
  function fmtCompact(n) {
    const a = Math.abs(n);
    return sign(n) + (a >= 1000 ? compact.format(a) : num2.format(a));
  }
  function fmtPercent(n) { return Math.round(n) + NNBSP + '%'; }
  function fmtLongDate(key) { return longDate.format(parseKey(key)); }
  function fmtShortDate(key) { return shortDate.format(parseKey(key)); }

  /* Intensité de 1 à 4 : taille du montant comparée au plus gros gain
     (ou à la plus grosse perte) du mois. 0 = journée neutre. */
  function levelFor(pnl, maxWin, maxLoss) {
    if (pnl === 0) return 0;
    const max = pnl > 0 ? maxWin : maxLoss;
    const ratio = Math.abs(pnl) / max;
    return Math.min(4, Math.max(1, Math.ceil(ratio * 4)));
  }

  function hasPnl(entry) {
    return entry && typeof entry.pnl === 'number' && Number.isFinite(entry.pnl);
  }

  /* Stats + cases pour une liste de dates (mois ou semaine) */
  function buildDays(dates, entries) {
    const today = todayKey();
    const stats = { total: 0, wins: 0, active: 0, best: null, bestKey: null };
    let maxWin = 0, maxLoss = 0;

    const keys = dates.map((dt) => dateKey(dt.getFullYear(), dt.getMonth(), dt.getDate()));
    for (const key of keys) {
      const e = entries[key];
      if (!hasPnl(e)) continue;
      stats.active++;
      stats.total += e.pnl;
      if (e.pnl > 0) { stats.wins++; maxWin = Math.max(maxWin, e.pnl); }
      if (e.pnl < 0) maxLoss = Math.max(maxLoss, -e.pnl);
      if (stats.best === null || e.pnl > stats.best) { stats.best = e.pnl; stats.bestKey = key; }
    }
    stats.total = Math.round(stats.total * 100) / 100;   // évite 0,30000000004

    const days = dates.map((dt, i) => {
      const key = keys[i];
      const entry = hasPnl(entries[key]) ? entries[key] : null;
      return {
        key,
        day: dt.getDate(),
        weekday: dt.getDay(),
        entry,
        isToday: key === today,
        level: entry ? levelFor(entry.pnl, maxWin, maxLoss) : 0
      };
    });
    return { days, stats };
  }

  /* Construit tout ce qu'il faut pour afficher un mois. */
  function buildMonth(year, month, entries) {
    const leading = (new Date(year, month, 1).getDay() + 6) % 7;   // lundi = 0
    const count = new Date(year, month + 1, 0).getDate();
    const dates = Array.from({ length: count }, (_, i) => new Date(year, month, i + 1));
    return { year, month, label: `${MONTHS[month]} ${year}`, leading, ...buildDays(dates, entries) };
  }

  /* Lundi de la semaine qui contient `date` */
  function mondayOf(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d;
  }

  /* « 14 – 20 sept. 2026 » ou « 28 sept. – 4 oct. 2026 » */
  function weekLabel(monday) {
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    const month = (d) => new Intl.DateTimeFormat('fr-FR', { month: 'short' }).format(d);
    const start = monday.getMonth() === sunday.getMonth()
      ? `${monday.getDate()}`
      : `${monday.getDate()} ${month(monday)}`
        + (monday.getFullYear() !== sunday.getFullYear() ? ` ${monday.getFullYear()}` : '');
    return `${start} – ${sunday.getDate()} ${month(sunday)} ${sunday.getFullYear()}`;
  }

  /* Construit tout ce qu'il faut pour afficher une semaine (lundi → dimanche). */
  function buildWeek(monday, entries) {
    const dates = Array.from({ length: 7 }, (_, i) =>
      new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i));
    return { monday, label: weekLabel(monday), leading: 0, ...buildDays(dates, entries) };
  }

  const timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
  /* Heure locale « 15:21 » à partir d'une date ISO */
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : timeFmt.format(d);
  }

  return {
    dateKey, todayKey, parseKey, buildMonth, buildWeek, mondayOf, levelFor,
    fmtEur, fmtCompact, fmtPercent, fmtLongDate, fmtShortDate, fmtTime
  };
})();
