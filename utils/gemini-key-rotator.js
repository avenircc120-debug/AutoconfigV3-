const ENV = require('./env');  // ← source unique
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  utils/gemini-key-rotator.js
 *
 *  STRATÉGIE 3 — ROTATION DE CLÉS API GEMINI
 *  ──────────────────────────────────────────
 *  · Accepte un tableau de clés : GEMINI_KEYS=["key1","key2","key3"]
 *  · Tourne automatiquement vers la prochaine clé si une limite est atteinte
 *  · Chaque clé porte son propre compteur RPM + fenêtre de temps
 *  · Si toutes les clés sont épuisées → attend la clé la plus proche
 *    de sa réinitialisation avant de lever une erreur
 * ═══════════════════════════════════════════════════════════════════════
 */

const logger = require('./logger');

// ── Constantes Gemini Free Tier ─────────────────────────────────────
const GEMINI_RPM_LIMIT  = 15;          // requêtes par minute (Free Tier)
const GEMINI_RPD_LIMIT  = 1_500;       // requêtes par jour (Free Tier)
const WINDOW_MS         = 60_000;      // fenêtre glissante de 1 minute

// ── Parseur de clés depuis l'env ────────────────────────────────────
function parseKeys() {
  const raw = ENV.GEMINI_KEYS || '';
  if (!raw) return [];

  // Accepte : JSON array  → ["key1","key2"]
  //           CSV string  → key1,key2,key3
  //           Single key  → AIzaSy...
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
  } catch {}

  return raw.split(',').map(k => k.trim()).filter(Boolean);
}

// ── Modèle d'état d'une clé ─────────────────────────────────────────
function createKeyState(apiKey) {
  return {
    apiKey,
    // Compteur RPM — fenêtre glissante
    requestTimestamps : [],   // timestamps des N dernières requêtes
    // Compteur RPD
    dailyCount        : 0,
    dailyResetAt      : Date.now() + 24 * 60 * 60 * 1_000,
    // État
    exhaustedUntil    : 0,    // timestamp epoch ms — 0 = disponible
    errorCount        : 0,
    totalRequests     : 0,
    lastUsed          : 0,
  };
}

// ════════════════════════════════════════════════════════════════════
//  Classe principale
// ════════════════════════════════════════════════════════════════════
class GeminiKeyRotator {
  constructor() {
    const rawKeys = parseKeys();
    if (!rawKeys.length) {
      logger.warn('[KeyRotator] ⚠️  Aucune clé Gemini configurée — GEMINI_KEYS non défini');
    }
    this.keys    = rawKeys.map(createKeyState);
    this.current = 0;
    logger.info(`[KeyRotator] ${this.keys.length} clé(s) Gemini chargée(s)`);
  }

  // ── Accesseurs ────────────────────────────────────────────────────

  get totalKeys() { return this.keys.length; }

  get hasKeys() { return this.keys.length > 0; }

  /** Retourne un masque sécurisé de la clé (pour les logs) */
  static maskKey(k) {
    if (!k || k.length < 8) return '****';
    return k.slice(0, 6) + '…' + k.slice(-4);
  }

  // ── Fenêtre glissante RPM ─────────────────────────────────────────

  /**
   * Compte les requêtes dans la dernière minute (fenêtre glissante)
   * et supprime les timestamps expirés.
   */
  _countRecentRPM(state) {
    const now    = Date.now();
    const cutoff = now - WINDOW_MS;
    // Purger les anciennes entrées
    state.requestTimestamps = state.requestTimestamps.filter(ts => ts > cutoff);
    return state.requestTimestamps.length;
  }

  /** Enregistre une requête dans la fenêtre glissante */
  _recordRequest(state) {
    state.requestTimestamps.push(Date.now());
    state.totalRequests++;
    state.lastUsed = Date.now();
    // Compteur journalier
    if (Date.now() > state.dailyResetAt) {
      state.dailyCount  = 0;
      state.dailyResetAt = Date.now() + 24 * 60 * 60 * 1_000;
    }
    state.dailyCount++;
  }

  // ── Sélection de clé ──────────────────────────────────────────────

  /**
   * Retourne le délai restant (ms) avant que la clé soit disponible.
   * 0 = disponible maintenant.
   */
  _availableInMs(state) {
    const now = Date.now();

    // Bloquée manuellement (suite à un 429 avec Retry-After)
    if (state.exhaustedUntil > now) return state.exhaustedUntil - now;

    // Quota journalier dépassé
    if (state.dailyCount >= GEMINI_RPD_LIMIT) {
      return state.dailyResetAt - now;
    }

    // RPM dépassé → attendre que la fenêtre glisse
    const rpm = this._countRecentRPM(state);
    if (rpm >= GEMINI_RPM_LIMIT) {
      const oldest = state.requestTimestamps[0];
      return (oldest + WINDOW_MS) - now + 50; // +50ms de marge
    }

    return 0;
  }

  /**
   * Sélectionne la prochaine clé disponible.
   * Tourne en round-robin parmi les clés non épuisées.
   *
   * @returns {{ state, index } | null}
   */
  _selectKey() {
    if (!this.keys.length) return null;

    // Parcourir toutes les clés en commençant par this.current
    for (let i = 0; i < this.keys.length; i++) {
      const idx   = (this.current + i) % this.keys.length;
      const state = this.keys[idx];
      if (this._availableInMs(state) === 0) {
        this.current = idx;
        return { state, index: idx };
      }
    }
    return null; // Toutes les clés sont épuisées
  }

  /**
   * Récupère la prochaine clé disponible.
   * Si toutes les clés sont limitées, attend automatiquement
   * le délai minimum nécessaire puis retourne la clé.
   *
   * @param {number} [maxWaitMs=75000] Délai max avant abandon (défaut 75s)
   * @returns {Promise<{ apiKey: string, index: number }>}
   */
  async getAvailableKey(maxWaitMs = 75_000) {
    // Tentative immédiate
    const immediate = this._selectKey();
    if (immediate) {
      this._recordRequest(immediate.state);
      logger.debug(`[KeyRotator] Clé #${immediate.index + 1}/${this.keys.length} sélectionnée (${GeminiKeyRotator.maskKey(immediate.state.apiKey)})`);
      return { apiKey: immediate.state.apiKey, index: immediate.index };
    }

    // Toutes les clés sont momentanément épuisées → calculer le délai minimum
    const delays  = this.keys.map(s => this._availableInMs(s));
    const minWait = Math.min(...delays);

    if (minWait > maxWaitMs) {
      throw new Error(`[KeyRotator] Toutes les clés Gemini épuisées. Prochaine disponible dans ${Math.ceil(minWait / 1000)}s (max autorisé: ${maxWaitMs / 1000}s)`);
    }

    logger.warn(`[KeyRotator] ⏳ Toutes les clés au RPM max. Attente de ${Math.ceil(minWait / 1000)}s…`);
    await new Promise(r => setTimeout(r, minWait + 100));

    // Retenter après l'attente
    const retry = this._selectKey();
    if (!retry) throw new Error('[KeyRotator] Toutes les clés Gemini sont épuisées même après attente');

    this._recordRequest(retry.state);
    return { apiKey: retry.state.apiKey, index: retry.index };
  }

  /**
   * Signale qu'une clé a reçu une erreur 429 (rate limit).
   * La bloque pendant `retryAfterMs` millisecondes.
   *
   * @param {number} index        Index de la clé fautive
   * @param {number} [retryAfterMs=61000] Durée de blocage
   */
  markExhausted(index, retryAfterMs = 61_000) {
    if (!this.keys[index]) return;
    const state          = this.keys[index];
    state.exhaustedUntil = Date.now() + retryAfterMs;
    state.errorCount++;
    logger.warn(`[KeyRotator] Clé #${index + 1} (${GeminiKeyRotator.maskKey(state.apiKey)}) bloquée pour ${retryAfterMs / 1000}s (erreur #${state.errorCount})`);
    // Passer à la suivante
    this.current = (index + 1) % this.keys.length;
  }

  /**
   * Signale qu'une clé a reçu une erreur 429 et essaie automatiquement
   * une autre clé disponible.
   */
  async rotateOnRateLimit(currentIndex, retryAfterMs) {
    this.markExhausted(currentIndex, retryAfterMs);
    return this.getAvailableKey();
  }

  /** Résumé de l'état de toutes les clés (pour logs/debug) */
  status() {
    return this.keys.map((s, i) => ({
      index        : i + 1,
      key          : GeminiKeyRotator.maskKey(s.apiKey),
      rpmUsed      : this._countRecentRPM(s),
      rpmLimit     : GEMINI_RPM_LIMIT,
      dailyUsed    : s.dailyCount,
      dailyLimit   : GEMINI_RPD_LIMIT,
      available    : this._availableInMs(s) === 0,
      blockedForMs : Math.max(0, this._availableInMs(s)),
      totalReqs    : s.totalRequests,
      errors       : s.errorCount,
    }));
  }
}

// Singleton — une seule instance partagée par toute l'application
const rotator = new GeminiKeyRotator();

module.exports = { GeminiKeyRotator, rotator, GEMINI_RPM_LIMIT, GEMINI_RPD_LIMIT };
