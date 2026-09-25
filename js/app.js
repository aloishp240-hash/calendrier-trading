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
    bioSetupBtn: $('bioSetupBtn'),
    totalLabel: $('totalLabel'),
    calPanel: document.querySelector('.cal-panel'),
    viewMonth: $('viewMonth'),
    viewWeek: $('viewWeek'),
    tradesSection: $('tradesSection'),
    tradesTotal: $('tradesTotal'),
    tradeList: $('tradeList'),
    tradesNote: $('tradesNote'),
    syncBtn: $('syncBtn'),
    syncDot: $('syncDot'),
    syncLabel: $('syncLabel'),
    syncSheet: $('syncSheet'),
    syncOff: $('syncOff'),
    syncOn: $('syncOn'),
    syncInfo: $('syncInfo'),
    tokenInput: $('tokenInput'),
    setupBtn: $('setupBtn'),
    pairInput: $('pairInput'),
    linkBtn: $('linkBtn'),
    syncNowBtn: $('syncNowBtn'),
    copyPairBtn: $('copyPairBtn'),
    pairOutput: $('pairOutput'),
    disableSyncBtn: $('disableSyncBtn'),
    syncError: $('syncError'),
    syncOk: $('syncOk'),
    syncClose: $('syncClose'),
    backupPillBtn: $('backupPillBtn'),
    backupSection: $('backupSection'),
    backupStartBtn: $('backupStartBtn'),
    backupForm: $('backupForm'),
    backupPw: $('backupPw'),
    backupPw2: $('backupPw2'),
    backupMakeBtn: $('backupMakeBtn'),
    backupSaveBtn: $('backupSaveBtn'),
    restoreBtn: $('restoreBtn'),
    restoreInput: $('restoreInput'),
    restoreForm: $('restoreForm'),
    restoreFile: $('restoreFile'),
    restorePw: $('restorePw'),
    restoreGoBtn: $('restoreGoBtn'),
    csvExportBtn: $('csvExportBtn')
  };

  const state = {
    entries: {},
    view: storage.getView(),     // 'month' | 'week'
    year: 0,
    month: 0,
    weekStart: null,             // lundi de la semaine affichée
    selected: null
  };

  const DEFAULT_STATUS = 'Données chiffrées sur cet appareil';
  const AUTO_LOCK_MS = 5 * 60000;     // reverrouille après 5 min en arrière-plan
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

  const WEEKDAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];

  function renderDay(d, isWeek) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'day';
    b.dataset.key = d.key;
    b.append(span('day-num', isWeek ? `${WEEKDAYS[d.weekday]} ${d.day}` : d.day));
    // En vue semaine, montant et note sont regroupés à droite
    const body = isWeek ? document.createElement('span') : b;
    if (isWeek) { body.className = 'day-body'; b.append(body); }

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
      body.append(span('day-amt', isWeek ? cal.fmtEur(pnl) : cal.fmtCompact(pnl)));
      if (note) body.append(span('day-note', note));
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

  /* direction : 1 = période suivante, -1 = précédente, 0 = pas d'animation */
  function render(direction = 0) {
    const isWeek = state.view === 'week';
    const view = isWeek
      ? cal.buildWeek(state.weekStart, state.entries)
      : cal.buildMonth(state.year, state.month, state.entries);
    els.monthLabel.textContent = view.label;
    els.totalLabel.textContent = isWeek ? 'Résultat de la semaine' : 'Résultat du mois';
    els.calPanel.classList.toggle('is-week-view', isWeek);
    els.grid.classList.toggle('is-week', isWeek);
    els.viewMonth.checked = !isWeek;
    els.viewWeek.checked = isWeek;
    els.prevBtn.setAttribute('aria-label', isWeek ? 'Semaine précédente' : 'Mois précédent');
    els.nextBtn.setAttribute('aria-label', isWeek ? 'Semaine suivante' : 'Mois suivant');

    const frag = document.createDocumentFragment();
    for (let i = 0; i < view.leading; i++) {
      const empty = document.createElement('div');
      empty.className = 'day-empty';
      empty.setAttribute('aria-hidden', 'true');
      frag.append(empty);
    }
    view.days.forEach((d) => frag.append(renderDay(d, isWeek)));
    els.grid.replaceChildren(frag);

    if (direction) restartAnimation(els.grid, direction > 0 ? 'slide-next' : 'slide-prev');
    renderStats(view.stats, direction !== 0);
    TC.analysis.render(view, isWeek);
  }

  /* Affiche la période (mois ou semaine) qui contient cette date */
  function showDate(date, direction = 0) {
    state.year = date.getFullYear();
    state.month = date.getMonth();
    state.weekStart = cal.mondayOf(date);
    render(direction);
  }

  function go(delta) {
    if (state.view === 'week') {
      const d = new Date(state.weekStart);
      d.setDate(d.getDate() + 7 * delta);
      state.weekStart = d;
      // le mois suit la semaine (jeudi = semaine « majoritaire »)
      const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 3);
      state.year = thursday.getFullYear();
      state.month = thursday.getMonth();
    } else {
      const d = new Date(state.year, state.month + delta, 1);
      state.year = d.getFullYear();
      state.month = d.getMonth();
    }
    render(delta);
  }

  function setView(view) {
    if (view === state.view) return;
    state.view = view;
    storage.setView(view);
    if (view === 'week') {
      // semaine d'aujourd'hui si on regardait le mois en cours, sinon la 1re semaine du mois
      const today = new Date();
      const inMonth = today.getFullYear() === state.year && today.getMonth() === state.month;
      state.weekStart = cal.mondayOf(inMonth ? today : new Date(state.year, state.month, 1));
    }
    render();
    restartAnimation(els.grid, 'bump');
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

  /* Liste des trades du jour (issue de l'import CSV) */
  function renderTrades(entry) {
    const trades = entry && entry.trades;
    els.tradesSection.hidden = !trades || !trades.length;
    if (els.tradesSection.hidden) return;

    const sum = Math.round(trades.reduce((s, t) => s + t.result, 0) * 100) / 100;
    els.tradesTotal.textContent = `${trades.length} trade${trades.length > 1 ? 's' : ''} · ${cal.fmtEur(sum)}`;
    els.tradesTotal.className = sum > 0 ? 'tone-win' : sum < 0 ? 'tone-loss' : '';

    const frag = document.createDocumentFragment();
    for (const t of trades) {
      const li = document.createElement('li');
      li.className = 'trade';
      const dir = t.dir === 'buy' ? '▲ Buy' : t.dir === 'sell' ? '▼ Sell' : '–';
      const res = span('trade-res', cal.fmtEur(t.result));
      res.classList.add(t.result > 0 ? 'tone-win' : t.result < 0 ? 'tone-loss' : 'neutral');
      li.append(
        span('trade-time', cal.fmtTime(t.closed)),
        span('trade-dir', dir),
        span('trade-name', t.instrument),
        res
      );
      const opened = cal.fmtTime(t.opened);
      li.title = `${t.dir === 'buy' ? 'Achat (hausse)' : t.dir === 'sell' ? 'Vente (baisse)' : ''}`
        + (opened ? ` · ouvert à ${opened}` : '') + ` · clôturé à ${cal.fmtTime(t.closed)}`
        + (t.units ? ` · ${t.units.toLocaleString('fr-FR', { maximumFractionDigits: 4 })} unités` : '');
      frag.append(li);
    }
    els.tradeList.replaceChildren(frag);
    els.tradeList.scrollTop = 0;

    els.tradesNote.textContent = Math.abs(sum - entry.pnl) >= 0.005
      ? `Le résultat saisi (${cal.fmtEur(entry.pnl)}) diffère du total des trades.`
      : '';
  }

  function openSheet(key) {
    state.selected = key;
    const entry = state.entries[key];

    els.sheetTitle.textContent = cal.fmtLongDate(key);
    els.sheetSub.textContent = entry ? 'Modifier le résultat du jour' : 'Nouvelle entrée';
    renderTrades(entry);
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
    const previous = state.entries[key];
    const entry = { pnl: pnl === 0 ? 0 : pnl, note: els.note.value.trim() || null };
    if (previous && previous.trades) entry.trades = previous.trades;   // le détail est conservé

    state.entries[key] = entry;
    render();
    closeSheet();
    highlightDay(key);

    try {
      state.entries[key] = await storage.save(key, entry);
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
    const last = cal.parseKey(result.to);                 // affiche la période du dernier jour importé
    const current = state.view === 'week' ? state.weekStart : new Date(state.year, state.month, 1);
    const anchor = state.view === 'week' ? cal.mondayOf(last) : new Date(last.getFullYear(), last.getMonth(), 1);
    showDate(last, Math.sign(anchor - current));
    closeDialog(els.importSheet);

    const n = Object.keys(result.days).length;
    try {
      await storage.saveMany(result.days);
      state.entries = await storage.loadAll();
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

  /* ---------------- Synchronisation ---------------- */
  const sync = TC.sync;
  const relative = new Intl.RelativeTimeFormat('fr-FR', { numeric: 'auto' });

  function sinceLabel(ts) {
    if (!ts) return 'jamais';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 45) return 'à l’instant';
    if (s < 3600) return relative.format(-Math.round(s / 60), 'minute');
    if (s < 86400) return relative.format(-Math.round(s / 3600), 'hour');
    return relative.format(-Math.round(s / 86400), 'day');
  }

  function renderSyncStatus() {
    const st = sync.getState();
    els.syncDot.className = 'sync-dot' + (st.status === 'idle' ? ' ok' : st.status === 'syncing' ? ' syncing' : st.status === 'error' ? ' error' : '');
    els.syncLabel.textContent =
      st.status === 'off' ? 'Activer la synchronisation'
      : st.status === 'syncing' ? 'Synchronisation…'
      : st.status === 'error' ? 'Synchro en erreur — voir le détail'
      : sync.tokenNeedsRenewal() ? 'Jeton GitHub à renouveler bientôt'
      : `Synchronisé ${sinceLabel(st.lastSync)}`;

    if (els.syncSheet.open) renderSyncSheet();
  }

  function renderSyncSheet() {
    const st = sync.getState();
    const on = sync.isConfigured();
    els.syncOff.hidden = on;
    els.syncOn.hidden = !on;
    if (on) {
      els.syncInfo.replaceChildren();
      const row = (label, value) => {
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = label;
        dd.textContent = value;
        els.syncInfo.append(dt, dd);
      };
      row('État', st.status === 'syncing' ? 'en cours…' : st.status === 'error' ? 'erreur' : 'actif');
      row('Dernière synchro', sinceLabel(st.lastSync));
      row('Dépôt', sync.REPO);
      els.syncNowBtn.disabled = st.status === 'syncing';
    }
    // N'efface que les erreurs venant de l'état de synchro, pas celles d'un formulaire
    if (st.status === 'error') {
      els.syncError.textContent = st.error;
      shownStatusError = st.error;
    } else if (shownStatusError && els.syncError.textContent === shownStatusError) {
      els.syncError.textContent = '';
      shownStatusError = null;
    }
  }
  let shownStatusError = null;

  function openSyncSheet() {
    resetBackupUI();
    els.syncOk.textContent = '';
    els.syncError.textContent = '';
    els.pairOutput.hidden = true;
    els.pairOutput.value = '';
    disarmDisable();
    renderSyncSheet();
    els.syncSheet.classList.remove('closing');
    els.syncSheet.showModal();
  }

  /* Recharge l'affichage après des données reçues de l'autre appareil */
  async function reloadFromStorage() {
    state.entries = await storage.loadAll();
    render();
  }

  async function withBusy(button, task) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Patiente…';
    els.syncError.textContent = '';
    els.syncOk.textContent = '';
    try {
      await task();
    } catch (err) {
      els.syncError.textContent = err.message || 'Erreur inattendue.';
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  function setupSync() {
    return withBusy(els.setupBtn, async () => {
      await sync.setup(els.tokenInput.value);
      els.tokenInput.value = '';
      await reloadFromStorage();
      renderSyncSheet();
      els.syncOk.textContent = 'Synchro activée. Copie maintenant le code de liaison pour ton autre appareil.';
    });
  }

  function linkDevice() {
    return withBusy(els.linkBtn, async () => {
      await sync.link(els.pairInput.value);
      els.pairInput.value = '';
      await reloadFromStorage();
      renderSyncSheet();
      els.syncOk.textContent = 'Appareil relié : tes données sont fusionnées.';
    });
  }

  async function copyPairing() {
    const code = sync.pairingCode();
    try {
      await navigator.clipboard.writeText(code);
      els.syncOk.textContent = 'Code copié. Colle-le sur ton autre appareil.';
    } catch (err) {
      // Presse-papiers indisponible : on affiche le code pour une copie manuelle
      els.pairOutput.hidden = false;
      els.pairOutput.value = code;
      els.pairOutput.select();
      els.syncOk.textContent = 'Copie automatique impossible : sélectionne le code ci-dessous et copie-le.';
    }
  }

  let disableArmed = null;
  function disarmDisable() {
    clearTimeout(disableArmed);
    disableArmed = null;
    els.disableSyncBtn.textContent = 'Désactiver sur cet appareil';
    els.disableSyncBtn.classList.remove('danger');
  }
  async function onDisableSync() {
    if (!disableArmed) {
      els.disableSyncBtn.textContent = 'Touche à nouveau pour confirmer (tes données restent sur cet appareil)';
      els.disableSyncBtn.classList.add('danger');
      disableArmed = setTimeout(disarmDisable, 5000);
      return;
    }
    disarmDisable();
    await sync.disable();
    renderSyncSheet();
    els.syncOk.textContent = 'Synchro désactivée sur cet appareil.';
  }

  /* ---------------- Sauvegarde / export ---------------- */
  let pendingFile = null;          // sauvegarde chiffrée prête à être enregistrée
  let pendingRestore = null;       // sauvegarde choisie, en attente du mot de passe

  function resetBackupUI() {
    pendingFile = null;
    pendingRestore = null;
    els.backupStartBtn.hidden = false;
    els.backupForm.hidden = true;
    els.backupSaveBtn.hidden = true;
    els.restoreForm.hidden = true;
    els.backupPw.value = '';
    els.backupPw2.value = '';
    els.restorePw.value = '';
  }

  function makeBackup() {
    return withBusy(els.backupMakeBtn, async () => {
      const pw = els.backupPw.value;
      if (pw.length < TC.backup.MIN_PASSWORD) throw new Error(`Mot de passe trop court (${TC.backup.MIN_PASSWORD} caractères minimum).`);
      if (pw !== els.backupPw2.value) throw new Error('Les deux mots de passe sont différents.');
      pendingFile = await TC.backup.createEncrypted(await storage.exportAll(), pw);
      els.backupPw.value = '';
      els.backupPw2.value = '';
      els.backupForm.hidden = true;
      els.backupSaveBtn.hidden = false;
      els.syncOk.textContent = 'Sauvegarde prête : touche « Enregistrer le fichier ».';
    });
  }

  async function saveBackupFile() {
    if (!pendingFile) return;
    const result = await TC.backup.deliver(pendingFile);
    if (result !== 'cancelled') els.syncOk.textContent = `Sauvegarde enregistrée (${pendingFile.name}).`;
  }

  async function onRestoreChosen() {
    const file = els.restoreInput.files[0];
    els.restoreInput.value = '';
    if (!file) return;
    els.syncError.textContent = '';
    els.syncOk.textContent = '';
    try {
      pendingRestore = TC.backup.parseBackup(await file.text());
      const created = pendingRestore.createdAt ? new Date(pendingRestore.createdAt) : null;
      els.restoreFile.textContent = file.name + (created && !Number.isNaN(created.getTime())
        ? ` — créée le ${created.toLocaleDateString('fr-FR')} à ${created.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
        : '');
      els.restoreForm.hidden = false;
      els.restorePw.focus();
    } catch (err) {
      els.syncError.textContent = err.message;
    }
  }

  function restoreBackup() {
    return withBusy(els.restoreGoBtn, async () => {
      if (!pendingRestore) return;
      const map = await TC.backup.readEncrypted(pendingRestore, els.restorePw.value);
      const changed = await storage.mergeRemote(map);
      els.restorePw.value = '';
      els.restoreForm.hidden = true;
      pendingRestore = null;
      await reloadFromStorage();
      sync.schedule();                  // la restauration part aussi vers l'autre appareil
      els.syncOk.textContent = changed
        ? 'Sauvegarde restaurée : tes données sont à jour.'
        : 'Rien à changer : tes données sont déjà plus récentes que cette sauvegarde.';
    });
  }

  async function exportCSV() {
    const file = TC.backup.toCSV(state.entries);
    const result = await TC.backup.deliver(file);
    if (result !== 'cancelled') els.syncOk.textContent = `Export CSV créé (${file.name}).`;
  }

  /* ---------------- Coach IA ---------------- */
  /* Période affichée, pour le coach et la copie vers Claude */
  function currentPeriod() {
    const isWeek = state.view === 'week';
    const view = isWeek
      ? cal.buildWeek(state.weekStart, state.entries)
      : cal.buildMonth(state.year, state.month, state.entries);
    const d = state.weekStart;
    const key = isWeek
      ? `w${cal.dateKey(d.getFullYear(), d.getMonth(), d.getDate())}`
      : `m${state.year}-${state.month + 1}`;
    return { view, isWeek, key };
  }

  /* ---------------- Événements ---------------- */
  function bindEvents() {
    els.themeBtn.addEventListener('click', toggleTheme);
    systemDark.addEventListener('change', updateThemeUI);

    els.prevBtn.addEventListener('click', () => go(-1));
    els.nextBtn.addEventListener('click', () => go(1));
    els.viewMonth.addEventListener('change', () => setView('month'));
    els.viewWeek.addEventListener('change', () => setView('week'));

    // Synchronisation
    els.syncBtn.addEventListener('click', openSyncSheet);
    els.syncClose.addEventListener('click', () => closeDialog(els.syncSheet));
    els.syncSheet.addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(els.syncSheet); });
    els.syncSheet.addEventListener('click', (e) => { if (e.target === els.syncSheet) closeDialog(els.syncSheet); });
    els.setupBtn.addEventListener('click', setupSync);
    els.linkBtn.addEventListener('click', linkDevice);
    els.syncNowBtn.addEventListener('click', () => sync.syncNow());
    els.copyPairBtn.addEventListener('click', copyPairing);
    els.disableSyncBtn.addEventListener('click', onDisableSync);
    els.backupPillBtn.addEventListener('click', () => {
      openSyncSheet();
      els.backupSection.scrollIntoView({ block: 'start' });
    });
    els.backupStartBtn.addEventListener('click', () => {
      els.backupStartBtn.hidden = true;
      els.backupForm.hidden = false;
      els.backupPw.focus();
    });
    els.backupMakeBtn.addEventListener('click', makeBackup);
    els.backupSaveBtn.addEventListener('click', saveBackupFile);
    els.restoreBtn.addEventListener('click', () => els.restoreInput.click());
    els.restoreInput.addEventListener('change', onRestoreChosen);
    els.restoreGoBtn.addEventListener('click', restoreBackup);
    els.csvExportBtn.addEventListener('click', exportCSV);
    sync.onStatus(renderSyncStatus);
    sync.onRemoteChange(reloadFromStorage);
    sync.onRemoteChange(() => TC.ai.onRemoteChange());
    TC.aiStore.onChange(() => sync.schedule());
    TC.ai.init({ getPeriod: currentPeriod, close: (dialog) => closeDialog(dialog) });
    $('aiFab').addEventListener('click', () => TC.ai.open());
    storage.onLocalChange(() => sync.schedule());
    window.addEventListener('online', () => sync.schedule(200));
    setInterval(renderSyncStatus, 60000);          // « il y a 3 minutes » reste à jour

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
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
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
    state.weekStart = cal.mondayOf(now);

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
    renderSyncStatus();

    try {
      await sync.load();
      sync.syncNow();
    } catch (err) {
      renderSyncStatus();
    }
  }

  function lockApp() {
    if (els.sheet.open) els.sheet.close();
    if (els.importSheet.open) els.importSheet.close();
    if (els.syncSheet.open) els.syncSheet.close();
    pendingImport = null;
    resetBackupUI();
    TC.ai.lock();
    TC.aiStore.lock();
    sync.lock();
    state.entries = {};
    state.selected = null;
    storage.lock();
    TC.vault.lock();
    render();                          // stats et analyse recalculées à vide
    els.grid.replaceChildren();
    TC.lock.show();
  }

  let hiddenAt = 0;
  function onVisibilityChange() {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else if (hiddenAt && TC.vault.isUnlocked() && Date.now() - hiddenAt > AUTO_LOCK_MS) {
      lockApp();
    } else if (TC.vault.isUnlocked()) {
      sync.schedule(300);            // retour dans l'appli : on récupère les nouveautés
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
