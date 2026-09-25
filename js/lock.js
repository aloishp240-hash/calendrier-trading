/* Écran de verrouillage : création du code, déverrouillage par code ou Face ID,
   blocage après plusieurs erreurs, réinitialisation si code oublié. */
window.TC = window.TC || {};

TC.lock = (function () {
  'use strict';

  const { vault, storage } = TC;
  const $ = (id) => document.getElementById(id);

  const PIN_LENGTH = 6;
  const MAX_TRIES = 5;
  const LOCKOUT_KEY = 'ct.lockout';        // { fails, until }
  const ASKED_KEY = 'ct.bioAsked';

  const els = {
    root: $('lock'),
    card: $('lockCard'),
    title: $('lockTitle'),
    msg: $('lockMsg'),
    pad: $('lockPad'),
    dots: $('pinDots'),
    keypad: $('keypad'),
    bioKey: $('bioKey'),
    forgot: $('forgotBtn'),
    offer: $('bioOffer'),
    offerTitle: $('bioOfferTitle'),
    offerText: $('bioOfferText'),
    offerDetail: $('bioOfferDetail'),
    offerYes: $('bioYes'),
    offerNo: $('bioNo')
  };

  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const BIO_NAME = isIOS ? 'Face ID' : /Macintosh/.test(ua) ? 'Touch ID' : 'la biométrie';

  let mode = 'unlock';       // 'setup' | 'confirm' | 'unlock'
  let busy = false;
  let pin = '';
  let firstPin = '';
  let onUnlock = null;
  let onOfferClosed = null;
  let countdown = null;
  let forgotArmed = null;
  let offerStep = 'create';        // 'create' | 'confirm'
  let offerFromApp = false;        // proposition ouverte depuis le calendrier (déjà déverrouillé)

  /* ---------- Affichage ---------- */
  function setMessage(text, isError = false) {
    els.msg.textContent = text;
    els.msg.classList.toggle('is-error', isError);
  }

  function renderDots() {
    [...els.dots.children].forEach((dot, i) => dot.classList.toggle('filled', i < pin.length));
  }

  function shake() {
    els.dots.classList.remove('shake');
    void els.dots.offsetWidth;
    els.dots.classList.add('shake');
    if (navigator.vibrate) navigator.vibrate(80);
  }

  function setBusy(value) {
    busy = value;
    els.pad.classList.toggle('is-busy', value);
  }

  function defaultMessage() {
    if (mode === 'setup') return 'Choisis un code à 6 chiffres';
    if (mode === 'confirm') return 'Confirme ton code';
    return 'Entre ton code';
  }

  /* ---------- Blocage après erreurs ---------- */
  function readLockout() {
    try { return JSON.parse(localStorage.getItem(LOCKOUT_KEY)) || { fails: 0, until: 0 }; }
    catch (e) { return { fails: 0, until: 0 }; }
  }
  function writeLockout(v) {
    try { localStorage.setItem(LOCKOUT_KEY, JSON.stringify(v)); } catch (e) { /* ignoré */ }
  }
  function clearLockout() {
    try { localStorage.removeItem(LOCKOUT_KEY); } catch (e) { /* ignoré */ }
  }

  function remainingLockout() {
    return Math.max(0, readLockout().until - Date.now());
  }

  function startCountdown() {
    clearInterval(countdown);
    const tick = () => {
      const left = remainingLockout();
      if (left <= 0) {
        clearInterval(countdown);
        countdown = null;
        setMessage(defaultMessage());
        return;
      }
      setMessage(`Trop d’essais — réessaie dans ${Math.ceil(left / 1000)} s`, true);
    };
    tick();
    countdown = setInterval(tick, 1000);
  }

  function registerFailure() {
    const lo = readLockout();
    lo.fails += 1;
    if (lo.fails >= MAX_TRIES) {
      // 30 s, puis 1 min, 2 min… jusqu'à 15 min maximum
      const delay = Math.min(30000 * 2 ** (lo.fails - MAX_TRIES), 15 * 60000);
      lo.until = Date.now() + delay;
      writeLockout(lo);
      startCountdown();
    } else {
      writeLockout(lo);
      const left = MAX_TRIES - lo.fails;
      setMessage(`Code incorrect — encore ${left} essai${left > 1 ? 's' : ''}`, true);
    }
  }

  /* ---------- Saisie ---------- */
  function press(digit) {
    if (busy || !els.offer.hidden || remainingLockout() > 0) return;
    if (pin.length >= PIN_LENGTH) return;
    pin += digit;
    renderDots();
    if (pin.length === PIN_LENGTH) setTimeout(submit, 120);   // laisse voir le dernier point
  }

  function backspace() {
    if (busy || !pin) return;
    pin = pin.slice(0, -1);
    renderDots();
  }

  async function submit() {
    const entered = pin;
    pin = '';

    if (mode === 'setup') {
      firstPin = entered;
      mode = 'confirm';
      renderDots();
      setMessage(defaultMessage());
      return;
    }

    if (mode === 'confirm') {
      if (entered !== firstPin) {
        firstPin = '';
        mode = 'setup';
        renderDots();
        shake();
        setMessage('Les deux codes sont différents — recommence', true);
        return;
      }
      setBusy(true);
      setMessage('Création de ton coffre-fort…');
      await vault.setup(entered);
      firstPin = '';
      setBusy(false);
      renderDots();
      afterUnlock();
      return;
    }

    // mode === 'unlock'
    setBusy(true);
    setMessage('Vérification…');
    const ok = await vault.unlockWithPin(entered);
    setBusy(false);
    renderDots();
    if (ok) {
      clearLockout();
      afterUnlock();
    } else {
      shake();
      registerFailure();
    }
  }

  /* ---------- Face ID ---------- */
  async function tryBiometric() {
    if (busy) return;
    setBusy(true);
    setMessage(`Déverrouillage avec ${BIO_NAME}…`);
    try {
      await vault.unlockWithBiometric();
      clearLockout();
      setBusy(false);
      finish();
    } catch (e) {
      setBusy(false);
      // Annulé ou échoué : on revient simplement au code
      if (remainingLockout() > 0) startCountdown();
      else setMessage(defaultMessage());
    }
  }

  async function afterUnlock() {
    let alreadyAsked = false;
    try { alreadyAsked = localStorage.getItem(ASKED_KEY) === '1'; } catch (e) { /* ignoré */ }
    if (!vault.hasBiometric() && !alreadyAsked && await vault.biometricAvailable()) {
      showOffer();
    } else {
      finish();
    }
  }

  function showOffer() {
    offerStep = 'create';
    els.offerTitle.textContent = `Utiliser ${BIO_NAME} ?`;
    els.offerText.textContent = `Déverrouille ton calendrier d’un regard, sans taper ton code. Le code restera toujours utilisable.`;
    els.offerDetail.textContent = '';
    els.offerYes.textContent = `Activer ${BIO_NAME}`;
    els.offerYes.hidden = false;
    els.offerNo.textContent = 'Pas maintenant';
    els.pad.hidden = true;
    els.offer.hidden = false;
  }

  function bioSuccess() {
    try { localStorage.setItem(ASKED_KEY, '1'); } catch (e) { /* ignoré */ }
    finish();
  }

  /* Chaque étape est lancée directement par un toucher : Safari l'exige. */
  async function acceptOffer() {
    els.offerYes.disabled = true;
    els.offerDetail.textContent = '';
    try {
      if (offerStep === 'create') {
        const done = await vault.beginBiometric();
        if (done) return bioSuccess();
        offerStep = 'confirm';
        els.offerTitle.textContent = 'Dernière étape';
        els.offerText.textContent = `Touche le bouton pour confirmer avec ${BIO_NAME}.`;
        els.offerYes.textContent = `Confirmer avec ${BIO_NAME}`;
      } else {
        await vault.confirmBiometric();
        bioSuccess();
      }
    } catch (e) {
      if (e && e.name === 'NotAllowedError') {
        // Annulé (ou refusé par Safari) : on laisse la possibilité de réessayer
        els.offerText.textContent = 'Activation annulée. Tu peux réessayer, ou continuer avec ton code.';
        els.offerYes.textContent = 'Réessayer';
      } else {
        els.offerTitle.textContent = `${BIO_NAME} indisponible`;
        els.offerText.textContent = `L’activation n’a pas abouti. Ton code fonctionne normalement ; tu pourras réessayer depuis le calendrier.`;
        els.offerYes.hidden = true;
        els.offerNo.textContent = 'Continuer';
      }
      // Détail technique, pour pouvoir diagnostiquer
      els.offerDetail.textContent = `Détail : ${(e && e.name) || 'Erreur'} — ${(e && e.message) || e}`;
    } finally {
      els.offerYes.disabled = false;
    }
  }

  function declineOffer() {
    // « Pas maintenant » : on ne repropose plus au déverrouillage
    // (le bouton dans le calendrier reste disponible)
    if (els.offerNo.textContent === 'Pas maintenant') {
      try { localStorage.setItem(ASKED_KEY, '1'); } catch (e) { /* ignoré */ }
    }
    finish();
  }

  /* ---------- Code oublié ---------- */
  function onForgot() {
    if (!forgotArmed) {
      els.forgot.textContent = 'Tout effacer sur cet appareil ? Touche à nouveau pour confirmer';
      els.forgot.classList.add('danger');
      forgotArmed = setTimeout(disarmForgot, 5000);
      return;
    }
    disarmForgot();
    storage.wipe();
    vault.reset();
    clearLockout();
    try { localStorage.removeItem(ASKED_KEY); } catch (e) { /* ignoré */ }
    show();
    setMessage('Données effacées — choisis un nouveau code');
  }
  function disarmForgot() {
    clearTimeout(forgotArmed);
    forgotArmed = null;
    els.forgot.textContent = 'Code oublié ?';
    els.forgot.classList.remove('danger');
  }

  /* ---------- Ouverture / fermeture ---------- */
  function finish() {
    els.root.classList.add('unlocking');
    document.body.classList.remove('is-locked');
    setTimeout(() => {
      els.root.hidden = true;
      els.root.classList.remove('unlocking');
    }, 280);
    if (offerFromApp) {
      offerFromApp = false;
      if (onOfferClosed) onOfferClosed();
    } else if (onUnlock) {
      onUnlock();
    }
  }

  /* Ouvert depuis le calendrier (bouton « Activer Face ID ») */
  function offerBiometric(callback) {
    offerFromApp = true;
    onOfferClosed = callback;
    document.body.classList.add('is-locked');
    els.root.hidden = false;
    showOffer();
  }

  async function show() {
    pin = '';
    firstPin = '';
    offerFromApp = false;
    setBusy(false);
    disarmForgot();
    mode = vault.isSetUp() ? 'unlock' : 'setup';

    document.body.classList.add('is-locked');
    els.root.hidden = false;
    els.pad.hidden = false;
    els.offer.hidden = true;
    els.title.textContent = mode === 'setup' ? 'Bienvenue' : 'Calendrier Trading';
    els.forgot.hidden = mode === 'setup';
    renderDots();

    if (!vault.isSupported()) {
      setBusy(true);
      setMessage('Ce navigateur ne permet pas de chiffrer tes données. Ouvre l’appli depuis son adresse en ligne (https).', true);
      return;
    }

    const bio = mode === 'unlock' && vault.hasBiometric() && await vault.biometricAvailable();
    els.bioKey.classList.toggle('is-invisible', !bio);
    els.bioKey.setAttribute('aria-label', `Déverrouiller avec ${BIO_NAME}`);

    if (remainingLockout() > 0) startCountdown();
    else setMessage(defaultMessage());

    if (bio) tryBiometric();
  }

  function bindEvents() {
    els.keypad.addEventListener('click', (e) => {
      const key = e.target.closest('button');
      if (!key) return;
      if (key.dataset.digit) press(key.dataset.digit);
      else if (key.id === 'delKey') backspace();
      else if (key.id === 'bioKey') tryBiometric();
    });
    els.forgot.addEventListener('click', onForgot);
    els.offerYes.addEventListener('click', acceptOffer);
    els.offerNo.addEventListener('click', declineOffer);

    // Clavier physique (PC)
    document.addEventListener('keydown', (e) => {
      if (els.root.hidden || !els.offer.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) { press(e.key); e.preventDefault(); }
      else if (e.key === 'Backspace') { backspace(); e.preventDefault(); }
    });
  }

  return {
    /* Lance l'écran de verrouillage ; `callback` est appelé à chaque déverrouillage. */
    start(callback) {
      onUnlock = callback;
      bindEvents();
      show();
    },
    show,
    offerBiometric,
    BIO_NAME
  };
})();
