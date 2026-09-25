/* Import des exports CSV Trading 212 (compte CFD).
   Règle : on additionne le « Total result » (frais et intérêts compris) de chaque
   position clôturée, par jour de clôture (date UTC, comme dans Trading 212).
   La note résume les instruments : « 5 trades — Instrument A x3, Instrument B, … ».
   Aucune manipulation de la page ici. */
window.TC = window.TC || {};

TC.csvImport = (function () {
  'use strict';

  const COLUMNS = {
    type: 'Record Type',
    closedAt: 'Date closed (UTC)',
    openedAt: 'Date opened (UTC)',
    date: 'Date (UTC)',
    instrument: 'Instrument',
    direction: 'Direction',
    units: 'Units',
    total: 'Total result (account currency)',
    currency: 'Account currency'
  };

  /* « 2026-09-14 15:21:27+00:00 » → date ISO lisible par JavaScript */
  function toIso(value) {
    const v = (value || '').trim();
    if (!v) return null;
    const d = new Date(v.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  /* Découpe un texte CSV en lignes et colonnes (gère les champs entre guillemets). */
  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') inQuotes = false;
        else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  /* « Pétrole-25Sep26 » → « Pétrole » (échéance du contrat retirée) */
  function cleanInstrument(name) {
    return (name || '?').trim().replace(/-\d{1,2}[A-Z][a-z]{2}\d{2}$/, '');
  }

  function buildNote(names) {
    const counts = new Map();
    names.forEach((n) => counts.set(n, (counts.get(n) || 0) + 1));
    const single = counts.size === 1;
    const parts = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])                       // les plus tradés d'abord
      .map(([n, c]) => (c > 1 && !single ? `${n} x${c}` : n));
    return `${names.length} trade${names.length > 1 ? 's' : ''} — ${parts.join(', ')}`;
  }

  /* Renvoie { days: {'AAAA-MM-JJ': {pnl, note}}, trades, from, to, currencies } */
  function parseTrading212(text) {
    const rows = parseCSV(text).filter((r) => r.some((cell) => cell.trim() !== ''));
    if (rows.length < 2) throw new Error('Le fichier est vide.');

    const header = rows[0].map((h) => h.trim());
    const col = {};
    for (const [key, name] of Object.entries(COLUMNS)) col[key] = header.indexOf(name);
    if (col.type < 0 || col.total < 0 || col.instrument < 0 || (col.closedAt < 0 && col.date < 0)) {
      throw new Error('Ce fichier ne ressemble pas à un export CFD Trading 212 (colonnes « Record Type » et « Total result » introuvables).');
    }

    const byDay = new Map();
    const currencies = new Set();
    let trades = 0;

    for (const r of rows.slice(1)) {
      if ((r[col.type] || '').trim() !== 'Closed position') continue;
      const when = (col.closedAt >= 0 && r[col.closedAt]) || r[col.date] || '';
      const day = when.slice(0, 10);
      const total = parseFloat(r[col.total]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(total)) continue;

      if (col.currency >= 0 && r[col.currency]) currencies.add(r[col.currency].trim());
      const d = byDay.get(day) || { sum: 0, items: [] };
      d.sum += total;
      // Le sens d'une position clôturée est celui de son ouverture :
      // Buy = pari à la hausse, Sell = pari à la baisse
      const dir = (col.direction >= 0 ? r[col.direction] : '').trim().toLowerCase();
      d.items.push({
        when,
        name: cleanInstrument(r[col.instrument]),
        trade: {
          instrument: cleanInstrument(r[col.instrument]),
          dir: dir === 'buy' || dir === 'sell' ? dir : null,
          units: col.units >= 0 ? parseFloat(r[col.units]) || null : null,
          opened: col.openedAt >= 0 ? toIso(r[col.openedAt]) : null,
          closed: toIso(when),
          result: Math.round(total * 100) / 100
        }
      });
      byDay.set(day, d);
      trades++;
    }
    if (!trades) throw new Error('Aucune position clôturée dans ce fichier.');

    const days = {};
    for (const [day, d] of byDay) {
      d.items.sort((a, b) => (a.when < b.when ? -1 : a.when > b.when ? 1 : 0));
      const pnl = Math.round(d.sum * 100) / 100;
      days[day] = {
        pnl: pnl === 0 ? 0 : pnl,
        note: buildNote(d.items.map((x) => x.name)),
        trades: d.items.map((x) => x.trade)
      };
    }
    const keys = Object.keys(days).sort();
    return { days, trades, from: keys[0], to: keys[keys.length - 1], currencies: [...currencies] };
  }

  return { parseTrading212, parseCSV };
})();
