/* Interface : affichage du calendrier, panneau de saisie, thème, navigation. */
(function (TC) {
  'use strict';

  const { cal, storage } = TC;
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;

  const els = {
    themeBtn: $('themeBtn'),
    lockBtn: $('lockBtn'),
    monthLabel: $('monthLabel'),
    prevBtn: $('prevBtn'),
    nextBtn: $('nextBtn'),
    grid: $('calGrid'),
    status: $('status'),
    total: $('sumTotal'),
    totalSub: $('sumTotalSub'),
    winrate: $('sumWinrate'),
    winrateSub: $('sumWinrateSub'),
    winMeter: $('winMeter'),
    best: $('sumBest'),
    bestSub: $('sumBestSub'),
    sheet: $('sheet'),
    form: $('sheetForm'),
    sheetTitle: $('sheetTitle'),
    sheetSub: $('sheetSub'),
    signWin: $('signWin'),
    signLoss: $('signLoss'),
    pnl: $('pnlInput'),
    note: $('noteInput'),
    error: $('formError'),
    cancelBtn: $('cancelBtn'),
    delBtn: $('delBtn'),
    importBtn: $('importBtn'),
    csvInput: $('csvInput'),
    importSheet: $('importSheet'),
    importFile: $('importFile'),
    importSummary: $('importSummary'),
    importWarning: $('importWarning'),
    importCancel: $('importCancel'),
    importConfirm: $('importConfirm'),
    bioSetupBtn: $('bioSetupBtn')
  };

  const state = {
    entries: {},
    year: 0,
    month: 0,
    selected: null
  };

  const DEFAULT_STATUS = 'Données chiffrées sur cet appareil';
  const AUTO_LOCK_MS = 60000;         // reverrouille après 1 min en arrière-plan
  const finePointer = window.matchMedia('(pointer: fine)');

  /* ---------------- Thème clair / sombre ---------------- */
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  const THEME_COLORS = { light: '#EEF1F6', dark: '#0B0E14' };
  let themeTimer = null;

  function effectiveTheme() {
    return root.dataset.theme || (systemDark.matches ? 'dark' : 'light');
  }

  function updateThemeUI() {
    const t = effectiveTheme();
    els.themeBtn.dataset.current = t;
    els.themeBtn.setAttribute('aria-label', t === 'dark' ? 'Passer en mode clair' : 'Passer en mode sombre');
    document.querySelector('meta[name="theme-color"]').setAttribute('content', THEME_COLORS[t]);
  }

  function toggleTheme() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    root.classList.add('theme-switching');
    root.dataset.theme = next;
    storage.setTheme(next);
    updateThemeUI();
    clearTimeout(themeTimer);
    themeTimer = setTimeout(() => root.classList.remove('theme-switching'), 450);
  }

  /* ---------------- Affichage ---------------- */
  function restartAnimation(el, cls) {
    el.classList.remove('slide-next', 'slide-prev', 'bump', 'just-saved');
    void el.offsetWidth;            // force le navigateur à rejouer l'animation
    el.classList.add(cls);
  }

  function span(cls, text) {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }

  function renderDay(d) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'day';
    b.dataset.key = d.key;
    b.append(span('day-num', d.day));

    let label = cal.fmtLongDate(d.key);
    if (d.isToday) {
      b.classList.add('today');
      b.setAttribute('aria-current', 'date');
      label += ' (aujourd’hui)';
    }

    if (d.entry) {
      const { pnl, note } = d.entry;
      if (pnl > 0) b.classList.add('win');
      else if (pnl < 0) b.classList.add('loss');
      b.dataset.level = d.level;
      b.append(span('day-amt', cal.fmtCompact(pnl)));
      if (note) b.append(span('day-note', note));
      label += ` : ${pnl > 0 ? 'gain' : pnl < 0 ? 'perte' : 'neutre'} ${cal.fmtEur(pnl)}` + (note ? `, ${note}` : '');
    } else {
      label += ' : aucune entrée';
    }
    b.setAttribute('aria-label', label);
    return b;
  }

  function setTone(el, value, active) {
    el.classList.remove('tone-win', 'tone-loss');
    if (!active || value === 0) return;
    el.classList.add(value > 0 ? 'tone-win' : 'tone-loss');
  }

  function renderStats(s, animate) {
    els.total.textContent = cal.fmtEur(s.total);
    setTone(els.total, s.total, s.active > 0);
    els.totalSub.textContent = s.active
      ? `${s.active} jour${s.active > 1 ? 's' : ''} tradé${s.active > 1 ? 's' : ''}`
      : 'Aucune entrée';

    const rate = s.active ? (s.wins / s.active) * 100 : 0;
    els.winrate.textContent = s.active ? cal.fmtPercent(rate) : '–';
    els.winrateSub.textContent = s.active ? `${s.wins} sur ${s.active}` : '';
    els.winMeter.style.setProperty('--p', rate + '%');

    els.best.textContent = s.best !== null ? cal.fmtEur(s.best) : '–';
    setTone(els.best, s.best, s.best !== null);
    els.bestSub.textContent = s.bestKey ? cal.fmtShortDate(s.bestKey) : '';

    if (animate) [els.total, els.winrate, els.best].forEach((el) => restartAnimation(el, 'bump'));
  }

  /* direction : 1 = mois suivant, -1 = précédent, 0 = pas d'animation */
  function render(direction = 0) {
    const view = cal.buildMonth(state.year, state.month, state.entries);
    els.monthLabel.textContent = view.label;

    const frag = document.createDocumentFragment();
    for (let i = 0; i < view.leading; i++) {
      const empty = document.createElement('div');
      empty.className = 'day-empty';
      empty.setAttribute('aria-hidden', 'true');
      frag.append(empty);
    }
    view.days.forEach((d) => frag.append(renderDay(d)));
    els.grid.replaceChildren(frag);

    if (direction) restartAnimation(els.grid, direction > 0 ? 'slide-next' : 'slide-prev');
    renderStats(view.stats, direction !== 0);
  }

  function goMonth(delta) {
    const d = new Date(state.year, state.month + delta, 1);
    state.year = d.getFullYear();
    state.month = d.getMonth();
    render(delta);
  }

  function setStatus(message, isError = false) {
    els.status.textContent = message;
    els.status.classList.toggle('is-error', isError);
  }

  function highlightDay(key) {
    const cell = els.grid.querySelector(`[data-key="${key}"]`);
    if (cell) restartAnimation(cell, 'just-saved');
  }

  /* ---------------- Panneau de saisie ---------------- */
  function formatInput(n) {
    return n.toFixed(2).replace('.', ',');
  }

  /* Accepte « 12,5 », « 12.50 », « -8 », « −8 € », « 1 234,56 » */
  function parseAmount(raw) {
    const s = raw.trim()
      .replace(/[\s  €]/g, '')
      .replace(/−/g, '-')
      .replace(',', '.');
    if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return NaN;
    return Number(s);
  }

  function setSign(isLoss) {
    els.signWin.checked = !isLoss;
    els.signLoss.checked = isLoss;
  }

  function openSheet(key) {
    state.selected = key;
    const entry = state.entries[key];

    els.sheetTitle.textContent = cal.fmtLongDate(key);
    els.sheetSub.textContent = entry ? 'Modifier le résultat du jour' : 'Nouvelle entrée';
    setSign(entry ? entry.pnl < 0 : false);
    els.pnl.value = entry ? formatInput(Math.abs(entry.pnl)) : '';
    els.note.value = entry && entry.note ? entry.note : '';
    els.delBtn.disabled = !entry;
    els.error.textContent = '';

    els.sheet.classList.remove('closing');
    els.sheet.showModal();
    // Sur PC, on place directement le curseur dans le montant.
    // Sur téléphone, on évite d'ouvrir le clavier d'office.
    if (finePointer.matches) {
      els.pnl.focus();
      els.pnl.select();
    }
  }

  /* Fermeture animée d'un panneau (saisie ou import) */
  function closeDialog(dialog, onClosed) {
    if (!dialog.open || dialog.classList.contains('closing')) return;
    dialog.classList.add('closing');

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      dialog.classList.remove('closing');
      dialog.close();
      if (onClosed) onClosed();
    };
    dialog.addEventListener('animationend', (e) => { if (e.target === dialog) finish(); });
    setTimeout(finish, 350);        // filet de sécurité si l'animation ne se déclenche pas
  }

  function closeSheet() {
    closeDialog(els.sheet, () => {
      if (state.selected) highlightDayFocusOnly(state.selected);
      state.selected = null;
    });
  }

  function highlightDayFocusOnly(key) {
    const cell = els.grid.querySelector(`[data-key="${key}"]`);
    if (cell) cell.focus({ preventScroll: true });
  }

  async function saveEntry(e) {
    e.preventDefault();
    const key = state.selected;
    if (!key) return;

    const raw = els.pnl.value;
    if (!raw.trim()) {
      els.error.textContent = 'Indique un montant (ou « Effacer » pour supprimer).';
      els.pnl.focus();
      return;
    }
    const amount = parseAmount(raw);
    if (Number.isNaN(amount)) {
      els.error.textContent = 'Montant invalide — exemple : 12,50';
      els.pnl.focus();
      return;
    }

    const isLoss = amount < 0 || els.signLoss.checked;
    const pnl = Math.round(Math.abs(amount) * 100) / 100 * (isLoss ? -1 : 1);
    const entry = { pnl: pnl === 0 ? 0 : pnl, note: els.note.value.trim() || null };

    state.entries[key] = entry;
    render();
    closeSheet();
    highlightDay(key);

    try {
      await storage.save(key, entry);
      setStatus(DEFAULT_STATUS);
    } catch (err) {
      setStatus('Échec de la sauvegarde — cette entrée sera perdue à la fermeture.', true);
    }
  }

  async function deleteEntry() {
    const key = state.selected;
    if (!key || !state.entries[key]) return;
    delete state.entries[key];
    render();
    closeSheet();
    try {
      await storage.remove(key);
      setStatus(DEFAULT_STATUS);
    } catch (err) {
      setStatus('Échec de la suppression sur cet appareil.', true);
    }
  }

  /* ---------------- Import CSV Trading 212 ---------------- */
  let pendingImport = null;

  function summaryRow(label, value) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    els.importSummary.append(dt, dd);
  }

  async function onCsvChosen() {
    const file = els.csvInput.files[0];
    els.csvInput.value = '';                 // permet de re-choisir le même fichier
    if (!file) return;

    pendingImport = null;
    els.importFile.textContent = file.name;
    els.importSummary.replaceChildren();
    els.importWarning.classList.remove('is-error');

    try {
      const result = TC.csvImport.parseTrading212(await file.text());
      const keys = Object.keys(result.days);
      const total = Math.round(keys.reduce((s, k) => s + result.days[k].pnl, 0) * 100) / 100;
      const replaced = keys.filter((k) => state.entries[k]).length;

      summaryRow('Période', `${cal.fmtShortDate(result.from)} → ${cal.fmtShortDate(result.to)}`);
      summaryRow('Jours de trading', String(keys.length));
      summaryRow('Trades clôturés', String(result.trades));
      summaryRow('Résultat total', cal.fmtEur(total));

      const notes = [replaced
        ? `${replaced} jour${replaced > 1 ? 's' : ''} déjà saisi${replaced > 1 ? 's' : ''} ser${replaced > 1 ? 'ont' : 'a'} remplacé${replaced > 1 ? 's' : ''} (montant et note).`
        : 'Aucun jour déjà saisi ne sera modifié.'];
      const other = result.currencies.filter((c) => c !== 'EUR');
      if (other.length) notes.push(`Attention : devise du compte ${other.join(', ')} (l’appli affiche en €).`);
      els.importWarning.textContent = notes.join(' ');

      pendingImport = result;
      els.importConfirm.hidden = false;
      els.importCancel.textContent = 'Annuler';
    } catch (err) {
      els.importWarning.textContent = err.message || 'Fichier illisible.';
      els.importWarning.classList.add('is-error');
      els.importConfirm.hidden = true;
      els.importCancel.textContent = 'Fermer';
    }

    els.importSheet.classList.remove('closing');
    els.importSheet.showModal();
  }

  async function confirmImport() {
    const result = pendingImport;
    if (!result) return;
    pendingImport = null;

    Object.assign(state.entries, result.days);
    const [y, m] = result.to.split('-').map(Number);     // affiche le mois le plus récent importé
    const direction = Math.sign((y * 12 + m - 1) - (state.year * 12 + state.month));
    state.year = y;
    state.month = m - 1;
    render(direction);
    closeDialog(els.importSheet);

    const n = Object.keys(result.days).length;
    try {
      await storage.saveMany(result.days);
      setStatus(`Import terminé : ${n} jour${n > 1 ? 's' : ''} mis à jour`);
    } catch (err) {
      setStatus('Échec de l’enregistrement de l’import sur cet appareil.', true);
    }
  }

  /* ---------------- Face ID depuis le calendrier ---------------- */
  async function refreshBioButton() {
    const show = TC.vault.isUnlocked() && !TC.vault.hasBiometric() && await TC.vault.biometricAvailable();
    els.bioSetupBtn.textContent = `Activer ${TC.lock.BIO_NAME}`;
    els.bioSetupBtn.hidden = !show;
  }

  /* ---------------- Événements ---------------- */
  function bindEvents() {
    els.themeBtn.addEventListener('click', toggleTheme);
    systemDark.addEventListener('change', updateThemeUI);

    els.prevBtn.addEventListener('click', () => goMonth(-1));
    els.nextBtn.addEventListener('click', () => goMonth(1));

    els.grid.addEventListener('click', (e) => {
      const cell = e.target.closest('.day');
      if (cell) openSheet(cell.dataset.key);
    });

    // Glisser le doigt à gauche / à droite pour changer de mois
    let touch = null;
    els.grid.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      touch = { x: t.clientX, y: t.clientY };
    }, { passive: true });
    els.grid.addEventListener('touchend', (e) => {
      if (!touch) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touch.x;
      const dy = t.clientY - touch.y;
      touch = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) goMonth(dx < 0 ? 1 : -1);
    }, { passive: true });

    els.importBtn.addEventListener('click', () => els.csvInput.click());
    els.csvInput.addEventListener('change', onCsvChosen);
    els.importConfirm.addEventListener('click', confirmImport);
    els.importCancel.addEventListener('click', () => closeDialog(els.importSheet));
    els.importSheet.addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(els.importSheet); });
    els.importSheet.addEventListener('click', (e) => { if (e.target === els.importSheet) closeDialog(els.importSheet); });

    els.bioSetupBtn.addEventListener('click', () => TC.lock.offerBiometric(refreshBioButton));

    els.form.addEventListener('submit', saveEntry);
    els.cancelBtn.addEventListener('click', closeSheet);
    els.delBtn.addEventListener('click', deleteEntry);

    // Échap : fermeture animée plutôt que brutale
    els.sheet.addEventListener('cancel', (e) => { e.preventDefault(); closeSheet(); });
    // Clic en dehors du panneau
    els.sheet.addEventListener('click', (e) => { if (e.target === els.sheet) closeSheet(); });

    // Taper « - » dans le montant bascule automatiquement sur « Perte »
    els.pnl.addEventListener('input', () => {
      els.error.textContent = '';
      const v = els.pnl.value;
      if (/^\s*[-−]/.test(v)) {
        setSign(true);
        els.pnl.value = v.replace(/^\s*[-−]/, '');
      }
    });
  }

  /* ---------------- Verrouillage ---------------- */
  async function onUnlocked() {
    const now = new Date();
    state.year = now.getFullYear();
    state.month = now.getMonth();

    try {
      await storage.applySeed(TC.SEED);
      state.entries = await storage.loadAll();
      setStatus(storage.isAvailable()
        ? DEFAULT_STATUS
        : 'Stockage indisponible — les données ne seront pas sauvegardées.', !storage.isAvailable());
    } catch (err) {
      state.entries = {};
      setStatus('Impossible de lire les données de cet appareil.', true);
    }
    render();
    refreshBioButton();
  }

  function lockApp() {
    if (els.sheet.open) els.sheet.close();
    if (els.importSheet.open) els.importSheet.close();
    pendingImport = null;
    state.entries = {};
    state.selected = null;
    storage.lock();
    TC.vault.lock();
    els.grid.replaceChildren();
    TC.lock.show();
  }

  let hiddenAt = 0;
  function onVisibilityChange() {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else if (hiddenAt && TC.vault.isUnlocked() && Date.now() - hiddenAt > AUTO_LOCK_MS) {
      lockApp();
    }
  }

  /* ---------------- Démarrage ---------------- */
  function registerServiceWorker() {
    // Uniquement en ligne (https) : sans effet quand on ouvre le fichier depuis le Mac
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* l'appli marche sans */ });
    }
  }

  function init() {
    updateThemeUI();
    bindEvents();
    els.lockBtn.addEventListener('click', lockApp);
    document.addEventListener('visibilitychange', onVisibilityChange);
    registerServiceWorker();
    TC.lock.start(onUnlocked);
  }

  init();
})(window.TC);
