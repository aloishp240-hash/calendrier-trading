/* Coffre-fort : chiffrement des données et déverrouillage (code ou Face ID).

   Principe :
   - une « clé de données » aléatoire chiffre toutes tes entrées (AES-256-GCM) ;
   - cette clé est rangée chiffrée par ton code (dérivé avec PBKDF2, 600 000 tours,
     pour rendre chaque essai lent) ;
   - si Face ID est activé, elle est aussi rangée chiffrée par un secret que seule
     ta passkey peut produire (extension WebAuthn « PRF »).
   Le code lui-même n'est jamais enregistré nulle part. */
window.TC = window.TC || {};

TC.vault = (function () {
  'use strict';

  const META_KEY = 'ct.vault';
  const ITERATIONS = 600000;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  let dataKey = null;          // présente en mémoire uniquement quand c'est déverrouillé
  let bioSupport = null;       // mis en cache après la première vérification
  let pendingBio = null;       // passkey créée, en attente de la 2e validation

  function readMeta() {
    try { return JSON.parse(localStorage.getItem(META_KEY)); }
    catch (e) { return null; }
  }
  function writeMeta(meta) {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  }

  /* ---------- Briques de chiffrement ---------- */
  async function seal(key, bytes) {
    const iv = rand(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
    return { iv: b64(iv), ct: b64(ct) };
  }
  async function unseal(key, box) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
    return new Uint8Array(pt);
  }
  function importDataKey(raw) {
    // « extractable » pour pouvoir la ranger aussi sous Face ID
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
  }
  async function keyFromPin(pin, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function keyFromPrf(secret) {
    const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('calendrier-trading/biometrie/v1') },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  /* ---------- Face ID / Touch ID (passkey + PRF) ---------- */
  async function prfSecret(credentialId, salt) {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: rand(32),
        allowCredentials: [{ type: 'public-key', id: credentialId }],
        userVerification: 'required',
        timeout: 60000,
        extensions: { prf: { eval: { first: salt } } }
      }
    });
    const prf = assertion.getClientExtensionResults().prf;
    if (!prf || !prf.results || !prf.results.first) throw new Error('prf-unsupported');
    return prf.results.first;
  }

  async function storeBiometric(credentialId, prfSalt, secret) {
    const bioKey = await keyFromPrf(secret);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', dataKey));
    const meta = readMeta();
    meta.bio = { id: b64(credentialId), salt: b64(prfSalt), key: await seal(bioKey, raw) };
    writeMeta(meta);
    raw.fill(0);
  }

  async function biometricAvailable() {
    if (bioSupport !== null) return bioSupport;
    bioSupport = false;
    try {
      if (!window.isSecureContext || !window.PublicKeyCredential || location.protocol === 'file:') return false;
      if (!(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())) return false;
      if (PublicKeyCredential.getClientCapabilities) {
        const caps = await PublicKeyCredential.getClientCapabilities();
        if (caps['extension:prf'] === false) return false;
      }
      bioSupport = true;
    } catch (e) { bioSupport = false; }
    return bioSupport;
  }

  return {
    isSupported() { return !!(window.crypto && crypto.subtle); },
    isSetUp() { return !!readMeta(); },
    isUnlocked() { return !!dataKey; },
    hasBiometric() { const m = readMeta(); return !!(m && m.bio); },
    biometricAvailable,

    /* Premier lancement : crée le coffre protégé par le code choisi. */
    async setup(pin) {
      const raw = rand(32);
      const salt = rand(16);
      const pinKey = await keyFromPin(pin, salt, ITERATIONS);
      writeMeta({ v: 1, salt: b64(salt), iterations: ITERATIONS, pin: await seal(pinKey, raw), bio: null });
      dataKey = await importDataKey(raw);
      raw.fill(0);
    },

    /* Renvoie true si le code est bon. */
    async unlockWithPin(pin) {
      const meta = readMeta();
      if (!meta) return false;
      const pinKey = await keyFromPin(pin, unb64(meta.salt), meta.iterations);
      let raw;
      try { raw = await unseal(pinKey, meta.pin); }
      catch (e) { return false; }                  // mauvais code : le déchiffrement échoue
      dataKey = await importDataKey(raw);
      raw.fill(0);
      return true;
    },

    /* Activation de Face ID, étape 1 (à appeler directement depuis un toucher) :
       crée la passkey. Renvoie true si c'est terminé, false s'il faut une
       2e validation (Safari exige un nouveau toucher pour celle-ci). */
    async beginBiometric() {
      if (!dataKey) throw new Error('locked');
      const prfSalt = rand(32);
      const cred = await navigator.credentials.create({
        publicKey: {
          rp: { name: 'Orbe' },
          user: { id: rand(16), name: 'Orbe', displayName: 'Orbe' },
          challenge: rand(32),
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
          timeout: 60000,
          extensions: { prf: { eval: { first: prfSalt } } }
        }
      });
      const prf = cred.getClientExtensionResults().prf;
      if (!prf || prf.enabled === false) {
        const err = new Error('La clé d’accès a été enregistrée à un endroit qui ne gère pas le chiffrement (extension PRF absente).');
        err.name = 'PrfUnsupported';
        throw err;
      }
      if (prf.results && prf.results.first) {
        await storeBiometric(cred.rawId, prfSalt, prf.results.first);
        return true;
      }
      pendingBio = { id: cred.rawId, salt: prfSalt };
      return false;
    },

    /* Activation de Face ID, étape 2 (nouveau toucher) : obtient le secret de la passkey. */
    async confirmBiometric() {
      if (!pendingBio) throw new Error('no-pending');
      const secret = await prfSecret(pendingBio.id, pendingBio.salt);
      await storeBiometric(pendingBio.id, pendingBio.salt, secret);
      pendingBio = null;
    },

    async unlockWithBiometric() {
      const meta = readMeta();
      if (!meta || !meta.bio) throw new Error('no-biometric');
      const secret = await prfSecret(unb64(meta.bio.id), unb64(meta.bio.salt));
      const raw = await unseal(await keyFromPrf(secret), meta.bio.key);
      dataKey = await importDataKey(raw);
      raw.fill(0);
    },

    lock() { dataKey = null; },

    /* Efface le coffre (code oublié) : les données chiffrées deviennent illisibles. */
    reset() {
      localStorage.removeItem(META_KEY);
      dataKey = null;
      pendingBio = null;
    },

    async encryptJSON(value) {
      if (!dataKey) throw new Error('locked');
      return seal(dataKey, enc.encode(JSON.stringify(value)));
    },
    async decryptJSON(box) {
      if (!dataKey) throw new Error('locked');
      return JSON.parse(dec.decode(await unseal(dataKey, box)));
    }
  };
})();
