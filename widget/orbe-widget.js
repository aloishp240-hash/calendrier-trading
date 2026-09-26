// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: circle;

/* Orbe — widget pour l'appli Scriptable (iPhone, et bureau du Mac via les widgets iPhone).
   Lit le résumé chiffré déposé par Orbe dans ton dépôt GitHub privé, le déchiffre
   ici même avec ta clé de synchro (AES-256-GCM), et affiche tes chiffres.
   La clé et le jeton sont rangés dans le trousseau de l'iPhone (Keychain). */

const APP_URL = 'https://aloishp240-hash.github.io/calendrier-trading/';
const CONFIG_KEY = 'orbe.widget.config';
const CACHE_KEY = 'orbe.widget.cache';
const FILE = 'widget.enc.json';

/* ---------------- AES-256 (norme FIPS-197) ---------------- */
const rotl8 = (x, s) => ((x << s) | (x >> (8 - s))) & 0xff;
const xtime = (b) => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;

/* Table de substitution calculée (plutôt que recopiée) */
const SBOX = (() => {
  const s = new Array(256);
  let p = 1, q = 1;
  do {
    p = (p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    s[p] = (q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63) & 0xff;
  } while (p !== 1);
  s[0] = 0x63;
  return s;
})();

function expandKey(key) {                 // clé de 32 octets → 60 mots
  const w = [];
  for (let i = 0; i < 8; i++) w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
  let rcon = 1;
  for (let i = 8; i < 60; i++) {
    let t = w[i - 1].slice();
    if (i % 8 === 0) {
      t = [t[1], t[2], t[3], t[0]].map((b) => SBOX[b]);
      t[0] ^= rcon;
      rcon = xtime(rcon);
    } else if (i % 8 === 4) {
      t = t.map((b) => SBOX[b]);
    }
    w.push(w[i - 8].map((b, j) => b ^ t[j]));
  }
  return w;
}

function encryptBlock(input, w) {         // bloc de 16 octets
  let s = input.slice();
  const addKey = (round) => { for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) s[4 * c + r] ^= w[round * 4 + c][r]; };
  const subShift = () => {
    const out = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out[r + 4 * c] = SBOX[s[r + 4 * ((c + r) % 4)]];
    s = out;
  };
  addKey(0);
  for (let round = 1; round < 14; round++) {
    subShift();
    for (let c = 0; c < 4; c++) {
      const a = s.slice(4 * c, 4 * c + 4);
      const all = a[0] ^ a[1] ^ a[2] ^ a[3];
      for (let r = 0; r < 4; r++) s[4 * c + r] = a[r] ^ all ^ xtime(a[r] ^ a[(r + 1) % 4]);
    }
    addKey(round);
  }
  subShift();
  addKey(14);
  return s;
}

/* AES-GCM : le déchiffrement est un compteur (CTR) qui démarre à IV‖00000002.
   Les 16 derniers octets (étiquette d'authenticité) ne sont pas nécessaires à la lecture. */
function gcmDecrypt(keyBytes, iv, data) {
  const w = expandKey(keyBytes);
  const ct = data.slice(0, data.length - 16);
  const counter = iv.concat([0, 0, 0, 2]);
  const out = new Array(ct.length);
  for (let off = 0; off < ct.length; off += 16) {
    const ks = encryptBlock(counter, w);
    for (let i = 0; i < 16 && off + i < ct.length; i++) out[off + i] = ct[off + i] ^ ks[i];
    for (let i = 15; i >= 12; i--) { counter[i] = (counter[i] + 1) & 0xff; if (counter[i]) break; }
  }
  return out;
}

/* ---------------- Utilitaires ---------------- */
function b64bytes(s) {
  const clean = s.replace(/\s/g, '');
  if (typeof Data !== 'undefined') return Data.fromBase64String(clean).getBytes();
  return Array.from(atob(clean), (c) => c.charCodeAt(0));   // (tests dans un navigateur)
}
function utf8(bytes) {
  let out = '', i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    let cp;
    if (b < 0x80) cp = b;
    else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
    else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    out += String.fromCodePoint(cp);
  }
  return out;
}

/* Code de liaison « CT1-… » (le même que pour relier un appareil) */
function parsePairing(code) {
  const clean = (code || '').trim().replace(/\s/g, '');
  if (!clean.startsWith('CT1-')) throw new Error('Ce n’est pas un code de liaison (il commence par « CT1- »).');
  let s = clean.slice(4).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const p = JSON.parse(utf8(b64bytes(s)));
  if (!p.o || !p.r || !p.t || !p.k) throw new Error('Code de liaison incomplet.');
  return { o: p.o, r: p.r, t: p.t, k: p.k };
}

function decryptSummary(fileText, keyB64) {
  const box = JSON.parse(fileText);
  return JSON.parse(utf8(gcmDecrypt(b64bytes(keyB64), b64bytes(box.iv), b64bytes(box.ct))));
}

const eur = (n, cents) => {
  const v = cents ? Math.round(n * 100) / 100 : Math.round(n);
  const s = Math.abs(v).toLocaleString('fr-FR', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
  return `${v < 0 ? '−' : ''}${s} €`;
};
const signed = (n, cents) => (n > 0 ? '+' : '') + eur(n, cents);

/* ---------------- Données ---------------- */
async function fetchSummary(cfg) {
  const req = new Request(`https://api.github.com/repos/${cfg.o}/${cfg.r}/contents/${FILE}`);
  req.headers = { Authorization: `Bearer ${cfg.t}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  req.timeoutInterval = 15;
  const json = await req.loadJSON();
  const code = req.response && req.response.statusCode;
  if (code === 404) throw new Error('Aucun résumé pour l’instant : ouvre Orbe une fois pour le créer.');
  if (code === 401) throw new Error('Jeton GitHub refusé : reconfigure le widget avec un nouveau code de liaison.');
  if (!json || !json.content) throw new Error('Réponse inattendue de GitHub.');
  return decryptSummary(utf8(b64bytes(json.content)), cfg.k);
}

async function loadData() {
  const cfg = Keychain.contains(CONFIG_KEY) ? JSON.parse(Keychain.get(CONFIG_KEY)) : null;
  if (!cfg) return { state: 'setup' };
  try {
    const data = await fetchSummary(cfg);
    Keychain.set(CACHE_KEY, JSON.stringify({ data, at: Date.now() }));
    return { state: 'ok', data };
  } catch (e) {
    if (Keychain.contains(CACHE_KEY)) {
      const c = JSON.parse(Keychain.get(CACHE_KEY));
      return { state: 'ok', data: c.data, offline: true };
    }
    return { state: 'error', message: e.message || String(e) };
  }
}

/* ---------------- Affichage ---------------- */
const C = {
  text: new Color('#FFFFFF'),
  muted: new Color('#FFFFFF', 0.62),
  win: new Color('#9BE3BF'),
  loss: new Color('#F5B5B5'),
  accent: new Color('#B7CCF7')
};

function background(w) {
  const g = new LinearGradient();
  g.colors = [new Color('#1E2A4F'), new Color('#35305F'), new Color('#1B2A33')];
  g.locations = [0, 0.6, 1];
  g.startPoint = new Point(0, 0);
  g.endPoint = new Point(1, 1);
  w.backgroundGradient = g;
}

function text(stack, value, size, color, weight) {
  const t = stack.addText(value);
  t.font = weight === 'bold' ? Font.boldRoundedSystemFont(size) : weight === 'semi' ? Font.semiboldSystemFont(size) : Font.systemFont(size);
  t.textColor = color || C.text;
  t.minimumScaleFactor = 0.6;
  t.lineLimit = 1;
  return t;
}

function sparkline(values, width, height) {
  const ctx = new DrawContext();
  ctx.size = new Size(width, height);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  if (values.length < 2) return null;            // une seule date : pas encore de courbe
  const lo = Math.min(...values), hi = Math.max(...values);
  const pad = 4;
  const x = (i) => pad + (i / (values.length - 1)) * (width - 2 * pad);
  const y = (v) => (hi === lo ? height / 2 : height - pad - ((v - lo) / (hi - lo)) * (height - 2 * pad));
  const line = new Path();
  values.forEach((v, i) => (i ? line.addLine(new Point(x(i), y(v))) : line.move(new Point(x(i), y(v)))));
  const area = new Path();
  area.move(new Point(x(0), height));
  values.forEach((v, i) => area.addLine(new Point(x(i), y(v))));
  area.addLine(new Point(x(values.length - 1), height));
  area.closeSubpath();
  ctx.addPath(area);
  ctx.setFillColor(new Color('#B7CCF7', 0.18));
  ctx.fillPath();
  ctx.addPath(line);
  ctx.setStrokeColor(C.accent);
  ctx.setLineWidth(3);
  ctx.strokePath();
  const last = values.length - 1;
  ctx.setFillColor(C.accent);
  ctx.fillEllipse(new Rect(x(last) - 4, y(values[last]) - 4, 8, 8));
  return ctx.getImage();
}

function wealthBlock(stack, d, compact) {
  const head = stack.addStack();
  head.centerAlignContent();
  text(head, 'ORBE', 10, C.muted, 'semi');
  head.addSpacer(4);
  text(head, '· Patrimoine', 10, C.muted);
  stack.addSpacer(compact ? 4 : 6);
  text(stack, eur(d.wealth.total), compact ? 26 : 30, C.text, 'bold');
  const evo = d.wealth.evo;
  if (evo) {
    text(stack, `${signed(evo.diff)}${evo.pct !== null ? ` (${evo.pct > 0 ? '+' : ''}${String(evo.pct).replace('.', ',')} %)` : ''} · 30 j`, 11,
      evo.diff > 0 ? C.win : evo.diff < 0 ? C.loss : C.muted, 'semi');
  }
  stack.addSpacer(compact ? 6 : 8);
  const image = sparkline(d.wealth.series || [], 280, compact ? 56 : 70);
  if (image) {
    const img = stack.addImage(image);
    img.resizable = true;
    img.imageSize = new Size(compact ? 130 : 150, compact ? 26 : 34);
  } else {
    text(stack, 'Courbe dès ta 2e mise à jour', 9, C.muted);
  }
}

function tradingBlock(stack, d) {
  const t = d.trading;
  text(stack, `Trading · ${t.label.split(' ')[0]}`, 10, C.muted, 'semi');
  stack.addSpacer(6);
  text(stack, t.days ? signed(t.total, true) : '—', 22, t.total > 0 ? C.win : t.total < 0 ? C.loss : C.text, 'bold');
  stack.addSpacer(4);
  text(stack, t.today !== null ? `Aujourd’hui ${signed(t.today, true)}` : 'Pas de trade aujourd’hui', 11,
    t.today > 0 ? C.win : t.today < 0 ? C.loss : C.muted);
  text(stack, t.days ? `${t.wins}/${t.days} jours gagnants` : '', 11, C.muted);
}

function footer(w, d, offline) {
  w.addSpacer();
  const f = w.addStack();
  const day = d.day.split('-').reverse().slice(0, 2).join('/');
  text(f, offline ? `hors ligne · données du ${day}` : `à jour · ${day}`, 9, C.muted);
}

function build(result, family) {
  const w = new ListWidget();
  background(w);
  w.url = APP_URL;
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  w.setPadding(14, 14, 12, 14);
  if (result.state !== 'ok') {
    text(w, 'ORBE', 11, C.muted, 'semi');
    w.addSpacer(6);
    const msg = result.state === 'setup'
      ? 'Ouvre Scriptable et lance le script « Orbe » pour le configurer avec ton code de liaison.'
      : result.message;
    const t = text(w, msg, 12, C.text);
    t.lineLimit = 5;
    if (result.state === 'setup') w.url = `scriptable:///run/${encodeURIComponent(Script.name())}`;
    return w;
  }
  const d = result.data;
  if (family === 'small') {
    wealthBlock(w, d, true);
  } else {
    const row = w.addStack();
    const left = row.addStack();
    left.layoutVertically();
    wealthBlock(left, d, false);
    row.addSpacer();
    const right = row.addStack();
    right.layoutVertically();
    tradingBlock(right, d);
    if (family === 'large') {
      w.addSpacer(14);
      if (d.forecast) {
        text(w, 'Dans 10 ans (scénario central)', 10, C.muted, 'semi');
        text(w, `≈ ${eur(d.forecast.central)}`, 20, C.text, 'bold');
        text(w, `entre ${eur(d.forecast.low)} et ${eur(d.forecast.high)}`, 10, C.muted);
        w.addSpacer(10);
      }
      const total = d.wealth.alloc.reduce((s, a) => s + a.value, 0) || 1;
      for (const a of d.wealth.alloc.slice(0, 4)) {
        const r = w.addStack();
        r.centerAlignContent();
        text(r, a.label, 11, C.text, 'semi');
        r.addSpacer();
        text(r, `${eur(a.value)} · ${Math.round((a.value / total) * 100)} %`, 11, C.muted);
        w.addSpacer(3);
      }
    }
  }
  footer(w, d, result.offline);
  return w;
}

/* ---------------- Lancement ---------------- */
async function setup() {
  const a = new Alert();
  a.title = 'Configurer le widget Orbe';
  a.message = 'Colle le code de liaison (Orbe → Réglages → Synchronisation → Copier le code de liaison). Il est rangé dans le trousseau de l’iPhone.';
  let prefill = '';
  try { const p = Pasteboard.paste(); if (p && p.startsWith('CT1-')) prefill = p; } catch (e) { /* rien */ }
  a.addTextField('CT1-…', prefill);
  a.addAction('Enregistrer');
  a.addCancelAction('Annuler');
  if ((await a.presentAlert()) === -1) return false;
  const cfg = parsePairing(a.textFieldValue(0));
  Keychain.set(CONFIG_KEY, JSON.stringify(cfg));
  if (Keychain.contains(CACHE_KEY)) Keychain.remove(CACHE_KEY);
  return true;
}

async function main() {
  if (config.runsInWidget) {
    Script.setWidget(build(await loadData(), config.widgetFamily || 'small'));
    Script.complete();
    return;
  }
  const configured = Keychain.contains(CONFIG_KEY);
  const menu = new Alert();
  menu.title = 'Orbe — widget';
  menu.message = configured ? 'Widget configuré.' : 'Première utilisation : configure le widget avec ton code de liaison.';
  if (configured) { menu.addAction('Aperçu petit'); menu.addAction('Aperçu moyen'); menu.addAction('Aperçu grand'); }
  menu.addAction(configured ? 'Changer le code de liaison' : 'Configurer');
  if (configured) menu.addDestructiveAction('Retirer la configuration');
  menu.addCancelAction('Fermer');
  const choice = await menu.presentAlert();
  if (choice === -1) return Script.complete();
  if (configured && choice <= 2) {
    const w = build(await loadData(), ['small', 'medium', 'large'][choice]);
    await (choice === 0 ? w.presentSmall() : choice === 1 ? w.presentMedium() : w.presentLarge());
  } else if ((configured && choice === 3) || (!configured && choice === 0)) {
    try {
      if (await setup()) {
        const w = build(await loadData(), 'medium');
        await w.presentMedium();
      }
    } catch (e) {
      const err = new Alert();
      err.title = 'Code non reconnu';
      err.message = e.message || String(e);
      err.addAction('OK');
      await err.presentAlert();
    }
  } else if (configured && choice === 4) {
    Keychain.remove(CONFIG_KEY);
    if (Keychain.contains(CACHE_KEY)) Keychain.remove(CACHE_KEY);
  }
  Script.complete();
}

if (typeof ORBE_TEST !== 'undefined') {
  ORBE_TEST.api = { SBOX, expandKey, encryptBlock, gcmDecrypt, parsePairing, decryptSummary, build, loadData, utf8, b64bytes };
} else {
  await main();
}
