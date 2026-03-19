/**
 * ═══════════════════════════════════════════════════════════════════════
 *  utils/gemini-cache.js
 *
 *  STRATÉGIE 1 — CACHE DES ANALYSES DE DÉPÔTS
 *  ────────────────────────────────────────────
 *  · Cache en mémoire (Map) avec TTL configurable
 *  · Persistance optionnelle sur disque (JSON) — survit aux redémarrages
 *  · Clé de cache = owner/repo + sha du dernier commit (invalidation auto
 *    si le repo a changé depuis la dernière analyse)
 *  · Statistiques hit/miss pour monitorer l'efficacité
 * ═══════════════════════════════════════════════════════════════════════
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const logger = require('./logger');

// ── Configuration ────────────────────────────────────────────────────
const CACHE_DIR      = path.join(__dirname, '../.cache');
const CACHE_FILE     = path.join(CACHE_DIR, 'gemini-repo-cache.json');
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;  // 24h par défaut
const MAX_ENTRIES    = 500;                      // évite la croissance infinie

// ── Génération de clé ────────────────────────────────────────────────

/**
 * Génère une clé de cache stable pour un repo.
 * Inclut le SHA du dernier commit pour invalider automatiquement
 * quand le code change.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} [commitSha]  SHA du dernier commit (optionnel)
 * @param {string} [ref]        Branche analysée
 */
function makeCacheKey(owner, repo, commitSha = '', ref = 'main') {
  const raw = `${owner.toLowerCase()}/${repo.toLowerCase()}@${ref}:${commitSha}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

/**
 * Clé "souple" sans commitSha — pour la recherche par owner/repo
 * sans connaître le SHA courant.
 */
function makeLooseCacheKey(owner, repo) {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

// ════════════════════════════════════════════════════════════════════
//  Classe principale
// ════════════════════════════════════════════════════════════════════
class GeminiCache {
  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs   = ttlMs;
    this._memory = new Map();   // key → { data, expiresAt, looseKey, createdAt }
    this._stats  = { hits: 0, misses: 0, writes: 0, evictions: 0 };
    this._loadFromDisk();
  }

  // ── Persistance disque ────────────────────────────────────────────

  _ensureCacheDir() {
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
  }

  _loadFromDisk() {
    try {
      this._ensureCacheDir();
      if (!fs.existsSync(CACHE_FILE)) return;
      const raw   = fs.readFileSync(CACHE_FILE, 'utf8');
      const saved = JSON.parse(raw);
      let loaded  = 0;
      for (const [key, entry] of Object.entries(saved)) {
        if (entry.expiresAt > Date.now()) {
          this._memory.set(key, entry);
          loaded++;
        }
      }
      logger.debug(`[GeminiCache] ${loaded} entrée(s) rechargée(s) depuis le disque`);
    } catch (e) {
      logger.debug(`[GeminiCache] Impossible de lire le cache disque: ${e.message}`);
    }
  }

  _saveToDisk() {
    try {
      this._ensureCacheDir();
      const obj = {};
      for (const [k, v] of this._memory) obj[k] = v;
      fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
      logger.debug(`[GeminiCache] Impossible d'écrire le cache: ${e.message}`);
    }
  }

  // ── Éviction ─────────────────────────────────────────────────────

  _evictExpired() {
    const now = Date.now();
    for (const [key, entry] of this._memory) {
      if (entry.expiresAt <= now) {
        this._memory.delete(key);
        this._stats.evictions++;
      }
    }
  }

  _evictOldestIfFull() {
    if (this._memory.size < MAX_ENTRIES) return;
    // Supprimer la 1ère entrée (la plus ancienne — Map garde l'ordre d'insertion)
    const firstKey = this._memory.keys().next().value;
    this._memory.delete(firstKey);
    this._stats.evictions++;
    logger.debug(`[GeminiCache] Éviction de l'entrée la plus ancienne (cache plein)`);
  }

  // ── API publique ──────────────────────────────────────────────────

  /**
   * Récupérer une entrée du cache.
   *
   * @param {string} owner
   * @param {string} repo
   * @param {string} [commitSha]  Si fourni → cache strict par commit
   * @param {string} [ref]
   * @returns {object|null}  La donnée mise en cache, ou null si absent/expiré
   */
  get(owner, repo, commitSha = '', ref = 'main') {
    this._evictExpired();

    // Recherche stricte (avec commitSha)
    if (commitSha) {
      const key   = makeCacheKey(owner, repo, commitSha, ref);
      const entry = this._memory.get(key);
      if (entry && entry.expiresAt > Date.now()) {
        this._stats.hits++;
        logger.debug(`[GeminiCache] ✓ HIT  ${owner}/${repo}@${ref} (${commitSha.slice(0,7)}…)`);
        return entry.data;
      }
    }

    // Recherche souple (owner/repo sans SHA) — utile quand le SHA n'est pas connu
    const looseKey = makeLooseCacheKey(owner, repo);
    for (const [, entry] of this._memory) {
      if (entry.looseKey === looseKey && entry.expiresAt > Date.now()) {
        this._stats.hits++;
        logger.debug(`[GeminiCache] ✓ HIT (loose)  ${owner}/${repo}`);
        return entry.data;
      }
    }

    this._stats.misses++;
    logger.debug(`[GeminiCache] ✗ MISS  ${owner}/${repo}`);
    return null;
  }

  /**
   * Stocker un résultat d'analyse dans le cache.
   *
   * @param {string} owner
   * @param {string} repo
   * @param {object} data       Résultat de identifyStack() ou analyse Gemini
   * @param {string} [commitSha]
   * @param {string} [ref]
   * @param {number} [ttlMs]    TTL personnalisé (défaut: this.ttlMs)
   */
  set(owner, repo, data, commitSha = '', ref = 'main', ttlMs) {
    this._evictExpired();
    this._evictOldestIfFull();

    const key      = makeCacheKey(owner, repo, commitSha, ref);
    const looseKey = makeLooseCacheKey(owner, repo);
    const entry    = {
      data,
      looseKey,
      commitSha,
      ref,
      owner,
      repo,
      createdAt  : Date.now(),
      expiresAt  : Date.now() + (ttlMs || this.ttlMs),
    };

    this._memory.set(key, entry);
    this._stats.writes++;
    logger.debug(`[GeminiCache] ✎ WRITE  ${owner}/${repo}@${ref} (TTL: ${Math.round((ttlMs || this.ttlMs) / 60_000)}min)`);

    // Sauvegarder sur disque de façon asynchrone (non bloquant)
    setImmediate(() => this._saveToDisk());
  }

  /**
   * Invalider manuellement le cache d'un repo (ex: après un push).
   */
  invalidate(owner, repo) {
    const looseKey = makeLooseCacheKey(owner, repo);
    let count = 0;
    for (const [key, entry] of this._memory) {
      if (entry.looseKey === looseKey) {
        this._memory.delete(key);
        count++;
      }
    }
    if (count) {
      logger.info(`[GeminiCache] Invalidé ${count} entrée(s) pour ${owner}/${repo}`);
      setImmediate(() => this._saveToDisk());
    }
    return count;
  }

  /**
   * Vider entièrement le cache.
   */
  clear() {
    this._memory.clear();
    try { fs.unlinkSync(CACHE_FILE); } catch {}
    logger.info('[GeminiCache] Cache vidé');
  }

  /**
   * Statistiques hit/miss pour le monitoring.
   */
  stats() {
    this._evictExpired();
    const hitRate = this._stats.hits + this._stats.misses > 0
      ? Math.round((this._stats.hits / (this._stats.hits + this._stats.misses)) * 100)
      : 0;
    return {
      entries   : this._memory.size,
      maxEntries: MAX_ENTRIES,
      hits      : this._stats.hits,
      misses    : this._stats.misses,
      writes    : this._stats.writes,
      evictions : this._stats.evictions,
      hitRate   : `${hitRate}%`,
      ttlHours  : Math.round(this.ttlMs / 3_600_000),
    };
  }

  /**
   * Liste toutes les entrées (pour l'interface admin).
   */
  list() {
    this._evictExpired();
    return [...this._memory.values()].map(e => ({
      repo     : `${e.owner}/${e.repo}`,
      ref      : e.ref,
      sha      : e.commitSha ? e.commitSha.slice(0, 7) : '—',
      stack    : e.data?.summary || e.data?.primary?.name || '?',
      ageMin   : Math.round((Date.now() - e.createdAt) / 60_000),
      expiresIn: Math.round((e.expiresAt - Date.now()) / 60_000) + 'min',
    }));
  }
}

// Singleton
const cache = new GeminiCache();

module.exports = { GeminiCache, cache, makeCacheKey };
