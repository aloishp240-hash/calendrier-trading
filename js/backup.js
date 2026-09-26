/* Sauvegarde dans un fichier :
   - sauvegarde chiffrée par mot de passe (PBKDF2 600 000 tours + AES-256-GCM),
     restaurable dans l'appli ;
   - export CSV lisible pour Excel / Numbers (séparateur « ; », virgule décimale). */
window.TC = window.TC || {};

TC.backup = (function () {
  'use strict';

  const { cal } = TC;
  const ITERATIONS = 600000;
  const APP = 'calendrier-trading';
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  class BackupError extends Error {
    constructor(message, code) { super(message); this.name = 'BackupError'; this.code = code; }
  }

  async function keyFromPassword(password, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  function today() {
    const d = new Date();
    return cal.dateKey(d.getFullYear(), d.getMonth(), d.getDate());
  }

  /* ---------- Sauvegarde chiffrée ---------- */
  async function createEncrypted(map, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await keyFromPassword(password, salt, ITERATIONS);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(map)));
    const content = JSON.stringify({
      app: APP, type: 'backup', v: 1, createdAt: new Date().toISOString(),
      kdf: { name: 'PBKDF2-SHA256', salt: b64(salt), iterations: ITERATIONS },
      iv: b64(iv), ct: b64(ct)
    });
    return new File([content], `orbe-sauvegarde-${today()}.json`, { type: 'application/json' });
  }

  function parseBackup(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!data || data.app !== APP || data.type !== 'backup' || !data.kdf || !data.ct) {
      throw new BackupError('Ce fichier n’est pas une sauvegarde d’Orbe.', 'format');
    }
    return data;
  }

  async function readEncrypted(data, password) {
    const key = await keyFromPassword(password, unb64(data.kdf.salt), data.kdf.iterations);
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(data.iv) }, key, unb64(data.ct));
      return JSON.parse(dec.decode(pt));
    } catch (e) {
      throw new BackupError('Mot de passe incorrect (ou fichier abîmé).', 'password');
    }
  }

  /* ---------- Export CSV lisible ---------- */
  function cell(value) {
    const s = value === null || value === undefined ? '' : String(value);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  const num = (n) => (typeof n === 'number' ? n.toFixed(2).replace('.', ',') : '');
  const frDate = (key) => key.split('-').reverse().join('/');

  function toCSV(entries) {
    const header = ['Date', 'Résultat du jour (€)', 'Note', 'Heure de clôture', 'Heure d’ouverture',
      'Instrument', 'Sens', 'Unités', 'Résultat du trade (€)'];
    const rows = [header];
    for (const key of Object.keys(entries).sort()) {
      const e = entries[key];
      const base = [frDate(key), num(e.pnl), e.note || ''];
      if (e.trades && e.trades.length) {
        for (const t of e.trades) {
          rows.push([...base, cal.fmtTime(t.closed), cal.fmtTime(t.opened), t.instrument,
            t.dir === 'buy' ? 'Buy' : t.dir === 'sell' ? 'Sell' : '',
            typeof t.units === 'number' ? String(t.units).replace('.', ',') : '', num(t.result)]);
        }
      } else {
        rows.push([...base, '', '', '', '', '', '']);
      }
    }
    // BOM : Excel reconnaît ainsi les accents (UTF-8)
    const content = '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n');
    return new File([content], `orbe-journal-${today()}.csv`, { type: 'text/csv' });
  }

  /* ---------- Envoi du fichier ---------- */
  /* Sur iPhone : feuille de partage (« Enregistrer dans Fichiers », AirDrop…).
     Sur ordinateur : téléchargement classique. Doit être appelé depuis un toucher. */
  async function deliver(file) {
    const touch = window.matchMedia('(pointer: coarse)').matches;
    if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: file.name });
        return 'shared';
      } catch (e) {
        if (e && e.name === 'AbortError') return 'cancelled';
        // sinon : on tente le téléchargement
      }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return 'downloaded';
  }

  return { createEncrypted, parseBackup, readEncrypted, toCSV, deliver, MIN_PASSWORD: 8 };
})();
