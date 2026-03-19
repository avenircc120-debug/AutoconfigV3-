/**
 * ═══════════════════════════════════════════════════════════════════════
 *  services/llm-router.js
 *
 *  ROUTEUR MULTI-LLM — OPTION 3 COMPLÈTE — 100% GRATUIT
 *  ──────────────────────────────────────────────────────
 *
 *  COUCHE 1 — Rotation de clés Gemini (plusieurs comptes Google)
 *    GEMINI_KEYS=["key1","key2","key3"]  →  15 × N RPM
 *
 *  COUCHE 2 — Routeur multi-provider (fallback automatique)
 *    Gemini  → 15 RPM × N clés   (via gemini-key-rotator)
 *    Groq    → 30 RPM             llama-3.1-70b
 *    Mistral →  5 RPM             mistral-small
 *    Cohere  → 20 RPM             command-r
 *    HuggingFace → ∞ (backup)     zephyr-7b
 *
 *  COUCHE 3 — Cache partagé (évite tout appel répété)
 *    Un résultat mis en cache = 0 RPM consommé
 *
 *  Capacité exemple avec 3 clés Gemini + Groq + Cohere :
 *    Gemini (3×15) + Groq (30) + Cohere (20) = 95 RPM gratuit
 *
 *  LOGIQUE DE ROUTAGE :
 *   [A] Round-robin pondéré    → distribue selon les RPM de chaque provider
 *   [B] Fallback en cascade    → A échoue → B → C → D → E
 *   [C] Cache partagé cross-provider (30 min TTL pour LLM)
 * ═══════════════════════════════════════════════════════════════════════
 */

const ENV     = require('../utils/env');  // ← source unique des clés
const axios   = require('axios');
const logger  = require('../utils/logger');
const { cache } = require('../utils/gemini-cache');

// ── Configuration des providers ─────────────────────────────────────

const PROVIDERS = {

  // ── 1. GEMINI — avec rotation de clés intégrée ────────────────────
  // COUCHE 1 + COUCHE 2 combinées : chaque clé Gemini est tournée
  // automatiquement par gemini-key-rotator avant d'appeler l'API.
  gemini: {
    name     : 'Gemini Flash',
    icon     : '🟦',
    rpmLimit : 15,   // par clé — le rotateur gère N clés
    weight   : 15,
    free     : true,
    envKey   : 'GEMINI_KEYS',
    enabled  : () => !!(ENV.GEMINI_KEYS),

    async call(prompt, options = {}) {
      const { callGemini } = require('./gemini-client');
      // callGemini utilise automatiquement gemini-key-rotator
      // → toutes les clés GEMINI_KEYS sont utilisées en round-robin
      return callGemini({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature     : options.temperature ?? 0.1,
          maxOutputTokens : options.maxTokens   ?? 1024,
        },
      });
    },

    // RPM effectif : 15 × nombre de clés Gemini configurées
    effectiveRPM() {
      try {
        const { rotator } = require('../utils/gemini-key-rotator');
        return 15 * Math.max(1, rotator.totalKeys);
      } catch { return 15; }
    },
  },

  // ── 2. GROQ — Llama 3.1 ultra-rapide ──────────────────────────────
  // 30 RPM gratuit · API compatible OpenAI · inscription : console.groq.com
  groq: {
    name     : 'Groq / Llama-3.1',
    icon     : '🟧',
    rpmLimit : 30,
    weight   : 30,
    free     : true,
    envKey   : 'GROQ_API_KEY',
    enabled  : () => !!ENV.GROQ_API_KEY,
    effectiveRPM: () => 30,

    async call(prompt, options = {}) {
      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model      : ENV.GROQ_MODEL,
          messages   : [{ role: 'user', content: prompt }],
          temperature: options.temperature ?? 0.1,
          max_tokens : options.maxTokens   ?? 1024,
        },
        {
          headers : { Authorization: `Bearer ${ENV.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
          timeout : 30_000,
        },
      );
      return res.data.choices[0]?.message?.content || '';
    },
  },

  // ── 3. MISTRAL AI ─────────────────────────────────────────────────
  // ~5 RPM gratuit · inscription : console.mistral.ai
  mistral: {
    name     : 'Mistral Small',
    icon     : '🟪',
    rpmLimit : 5,
    weight   : 5,
    free     : true,
    envKey   : 'MISTRAL_API_KEY',
    enabled  : () => !!ENV.MISTRAL_API_KEY,
    effectiveRPM: () => 5,

    async call(prompt, options = {}) {
      const res = await axios.post(
        'https://api.mistral.ai/v1/chat/completions',
        {
          model      : ENV.MISTRAL_MODEL,
          messages   : [{ role: 'user', content: prompt }],
          temperature: options.temperature ?? 0.1,
          max_tokens : options.maxTokens   ?? 1024,
        },
        {
          headers : { Authorization: `Bearer ${ENV.MISTRAL_API_KEY}`, 'Content-Type': 'application/json' },
          timeout : 30_000,
        },
      );
      return res.data.choices[0]?.message?.content || '';
    },
  },

  // ── 4. COHERE ─────────────────────────────────────────────────────
  // 20 RPM gratuit (Trial key) · inscription : dashboard.cohere.com
  cohere: {
    name     : 'Cohere Command-R',
    icon     : '🟩',
    rpmLimit : 20,
    weight   : 20,
    free     : true,
    envKey   : 'COHERE_API_KEY',
    enabled  : () => !!ENV.COHERE_API_KEY,
    effectiveRPM: () => 20,

    async call(prompt, options = {}) {
      const res = await axios.post(
        'https://api.cohere.com/v1/chat',
        {
          model      : ENV.COHERE_MODEL,
          message    : prompt,
          temperature: options.temperature ?? 0.1,
          max_tokens : options.maxTokens   ?? 1024,
        },
        {
          headers : { Authorization: `Bearer ${ENV.COHERE_API_KEY}`, 'Content-Type': 'application/json' },
          timeout : 30_000,
        },
      );
      return res.data.text || '';
    },
  },

  // ── 5. HUGGING FACE — Backup illimité ─────────────────────────────
  // Illimité mais lent (10-30s) · token gratuit : huggingface.co/settings/tokens
  huggingface: {
    name     : 'HuggingFace Zephyr',
    icon     : '🤗',
    rpmLimit : 999,
    weight   : 3,    // faible poids → utilisé en dernier recours
    free     : true,
    envKey   : 'HUGGINGFACE_TOKEN',
    enabled  : () => !!ENV.HUGGINGFACE_TOKEN,
    effectiveRPM: () => 999,

    async call(prompt, options = {}) {
      const model = ENV.HF_MODEL;
      const res = await axios.post(
        `https://api-inference.huggingface.co/models/${model}`,
        {
          inputs    : prompt,
          parameters: { max_new_tokens: options.maxTokens ?? 512, temperature: options.temperature ?? 0.1 },
        },
        {
          headers : { Authorization: `Bearer ${ENV.HUGGINGFACE_TOKEN}` },
          timeout : 60_000,
        },
      );
      const data = res.data;
      if (Array.isArray(data)) return data[0]?.generated_text?.replace(prompt, '').trim() || '';
      return data?.generated_text?.replace(prompt, '').trim() || '';
    },
  },
};

// ════════════════════════════════════════════════════════════════════
//  État de chaque provider (fenêtre glissante RPM + blacklist)
// ════════════════════════════════════════════════════════════════════
const _state = {};
for (const id of Object.keys(PROVIDERS)) {
  _state[id] = {
    timestamps   : [],   // fenêtre glissante 60s
    blockedUntil : 0,
    successCount : 0,
    errorCount   : 0,
    totalMs      : 0,
    totalRequests: 0,
  };
}

function _countRPM(id) {
  const s = _state[id];
  s.timestamps = s.timestamps.filter(t => t > Date.now() - 60_000);
  return s.timestamps.length;
}

function _isAvailable(id) {
  const p = PROVIDERS[id];
  if (!p.enabled())                    return false;
  if (_state[id].blockedUntil > Date.now()) return false;
  if (_countRPM(id) >= p.rpmLimit)     return false;
  return true;
}

function _record(id, ms, ok) {
  const s = _state[id];
  s.timestamps.push(Date.now());
  s.totalRequests++;
  s.totalMs += ms;
  if (ok) s.successCount++; else s.errorCount++;
}

function _block(id, ms = 61_000) {
  _state[id].blockedUntil = Date.now() + ms;
  logger.warn(`[LLM Router] ${PROVIDERS[id].icon} ${PROVIDERS[id].name} bloqué ${ms / 1000}s`);
}

// ── Sélection pondérée ───────────────────────────────────────────

function _availableList() {
  return Object.entries(PROVIDERS)
    .filter(([id]) => _isAvailable(id))
    .map(([id, p]) => {
      const rpmFree = p.rpmLimit - _countRPM(id);
      return { id, p, rpmFree, score: (rpmFree / p.rpmLimit) * p.weight };
    })
    .sort((a, b) => b.score - a.score);
}

// ════════════════════════════════════════════════════════════════════
//  FONCTION PRINCIPALE : routePrompt()
// ════════════════════════════════════════════════════════════════════

/**
 * Envoie un prompt au meilleur provider disponible.
 * Fallback automatique si un provider échoue ou est saturé.
 *
 * @param {string}  prompt
 * @param {object}  [opts]
 * @param {number}  [opts.temperature]     Défaut: 0.1
 * @param {number}  [opts.maxTokens]       Défaut: 1024
 * @param {string}  [opts.preferProvider]  Forcer un provider ('gemini','groq'…)
 * @param {string}  [opts.cacheKey]        Clé de cache (évite les appels répétés)
 * @param {boolean} [opts.jsonMode]        Nettoyer les backticks markdown
 * @returns {Promise<{ text, provider, providerName, fromCache, durationMs }>}
 */
async function routePrompt(prompt, opts = {}) {
  const { preferProvider, cacheKey, jsonMode = false } = opts;

  // ── Vérifier le cache ─────────────────────────────────────────────
  if (cacheKey) {
    const hit = cache.get('_llm', cacheKey);
    if (hit) {
      logger.debug(`[LLM Router] ✓ Cache HIT "${cacheKey}"`);
      return { text: hit.text, provider: 'cache', providerName: 'Cache', fromCache: true, durationMs: 0 };
    }
  }

  // ── Liste des providers à essayer ─────────────────────────────────
  let tryList = _availableList().map(p => p.id);

  if (preferProvider && _isAvailable(preferProvider)) {
    tryList = [preferProvider, ...tryList.filter(id => id !== preferProvider)];
  }

  if (!tryList.length) {
    throw new Error(
      '[LLM Router] Aucun provider disponible.\n' +
      '  → Ajouter plus de clés Gemini dans GEMINI_KEYS\n' +
      '  → Ou configurer GROQ_API_KEY / COHERE_API_KEY (gratuit)\n' +
      '  → Capacité actuelle : ' + getTotalEffectiveRPM() + ' RPM'
    );
  }

  logger.debug(`[LLM Router] Ordre : ${tryList.map(id => PROVIDERS[id].icon + id).join(' → ')}`);

  // ── Cascade de fallback ───────────────────────────────────────────
  let lastErr;
  for (const id of tryList) {
    const p     = PROVIDERS[id];
    const t0    = Date.now();
    try {
      logger.info(`[LLM Router] ${p.icon} ${p.name} (${_countRPM(id)}/${p.rpmLimit} RPM utilisés)`);
      let text = await p.call(prompt, opts);
      const ms = Date.now() - t0;

      if (jsonMode) text = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

      _record(id, ms, true);
      logger.info(`[LLM Router] ✓ ${p.name} → ${text.length} chars en ${ms}ms`);

      if (cacheKey) cache.set('_llm', cacheKey, { text }, '', 'main', 30 * 60_000);

      return { text, provider: id, providerName: p.name, fromCache: false, durationMs: ms };

    } catch (err) {
      _record(id, Date.now() - t0, false);
      const status = err?.response?.status;
      if (status === 429) {
        const wait = parseInt(err?.response?.headers?.['retry-after'] || '61', 10) * 1_000;
        _block(id, wait);
      }
      lastErr = err;
      logger.warn(`[LLM Router] ${p.icon} ${p.name} échoué (${status || err.message}) → fallback`);
    }
  }

  throw new Error(`[LLM Router] Tous les providers ont échoué. Dernier: ${lastErr?.message}`);
}

// ════════════════════════════════════════════════════════════════════
//  Wrappers spécialisés
// ════════════════════════════════════════════════════════════════════

async function analyzeRepoWithLLM(owner, repo, stackInfo) {
  const cacheKey = `repo:${owner}/${repo}`;
  const prompt = `Expert DevOps. Analyse ce projet GitHub. Réponds en JSON UNIQUEMENT (sans backticks).

Repo: ${owner}/${repo}
Stack: ${stackInfo.summary}
Framework: ${stackInfo.primary?.framework || 'inconnu'}
Fichiers: ${(stackInfo.repoRoot || []).slice(0, 15).join(', ')}
Vars .env: ${(stackInfo.envVars || []).filter(v => !v.isComment).map(v => v.key).slice(0, 10).join(', ') || 'aucune'}

JSON attendu:
{"deploymentRecommendations":["conseil"],"requiredEnvVars":["VAR"],"suggestedBuildCommand":"npm run build","suggestedStartCommand":"npm start","databaseRequired":true,"estimatedDeployTime":"2 min","warnings":[]}`;

  const result = await routePrompt(prompt, { cacheKey, jsonMode: true, maxTokens: 600 });
  try {
    return { ...JSON.parse(result.text), _provider: result.provider, _fromCache: result.fromCache };
  } catch {
    return { _provider: result.provider, _error: 'parse_failed', _raw: result.text };
  }
}

async function suggestEnvVars(owner, repo, stackInfo, existingVars = []) {
  const prompt = `Expert DevOps. Variables d'env manquantes pour ${owner}/${repo} (${stackInfo.summary}). Existantes: ${existingVars.slice(0,10).join(', ')||'aucune'}. JSON UNIQUEMENT:
{"additionalVars":{"NOM":"description"},"optionalVars":{"NOM":"description"}}`;
  const result = await routePrompt(prompt, { cacheKey: `env:${owner}/${repo}`, jsonMode: true, maxTokens: 400 });
  try { return JSON.parse(result.text); } catch { return { additionalVars: {}, optionalVars: {} }; }
}

// ════════════════════════════════════════════════════════════════════
//  Statut et monitoring
// ════════════════════════════════════════════════════════════════════

function getTotalEffectiveRPM() {
  return Object.entries(PROVIDERS)
    .filter(([id]) => PROVIDERS[id].enabled())
    .reduce((sum, [id, p]) => sum + (p.effectiveRPM ? p.effectiveRPM() : p.rpmLimit), 0);
}

function getRouterStatus() {
  const now = Date.now();
  let geminiKeyCount = 1;
  try { const { rotator } = require('../utils/gemini-key-rotator'); geminiKeyCount = rotator.totalKeys || 1; } catch {}

  return {
    totalEffectiveRPM : getTotalEffectiveRPM(),
    geminiKeyCount,
    availableCount    : Object.keys(PROVIDERS).filter(_isAvailable).length,
    providers: Object.entries(PROVIDERS).map(([id, p]) => {
      const s    = _state[id];
      const used = _countRPM(id);
      return {
        id,
        name         : p.name,
        icon         : p.icon,
        configured   : p.enabled(),
        available    : _isAvailable(id),
        rpmUsed      : used,
        rpmLimit     : p.rpmLimit,
        effectiveRPM : p.effectiveRPM ? p.effectiveRPM() : p.rpmLimit,
        rpmFree      : Math.max(0, p.rpmLimit - used),
        blockedForSec: s.blockedUntil > now ? Math.ceil((s.blockedUntil - now) / 1000) : null,
        successCount : s.successCount,
        errorCount   : s.errorCount,
        avgLatencyMs : s.totalRequests > 0 ? Math.round(s.totalMs / s.totalRequests) : 0,
        envKey       : p.envKey,
      };
    }),
  };
}


// ── Wrappers spécialisés ─────────────────────────────────────────────

async function analyzeRepoWithLLM(owner, repo, stackInfo) {
  const prompt =
    `Expert DevOps. Analyse ce projet GitHub. JSON UNIQUEMENT (sans backticks).\n` +
    `Repo: ${owner}/${repo} | Stack: ${stackInfo.summary} | Framework: ${stackInfo.primary?.framework || 'inconnu'}\n` +
    `Fichiers: ${(stackInfo.repoRoot || []).slice(0, 15).join(', ')}\n` +
    `Vars: ${(stackInfo.envVars || []).filter(v => !v.isComment).map(v => v.key).slice(0, 10).join(', ') || 'aucune'}\n` +
    `{"deploymentRecommendations":["conseil"],"requiredEnvVars":["VAR"],"suggestedBuildCommand":"npm run build","suggestedStartCommand":"npm start","databaseRequired":true,"estimatedDeployTime":"2 min","warnings":[]}`;

  const result = await routePrompt(prompt, { cacheKey: `repo:${owner}/${repo}`, jsonMode: true, maxTokens: 600 });
  try {
    return { ...JSON.parse(result.text), _provider: result.provider, _fromCache: result.fromCache };
  } catch {
    return { _provider: result.provider, _error: 'parse_failed', _raw: result.text };
  }
}

async function suggestEnvVars(owner, repo, stackInfo, existingVars = []) {
  const prompt =
    `Expert DevOps. Variables manquantes pour ${owner}/${repo} (${stackInfo.summary}). ` +
    `Existantes: ${existingVars.slice(0, 10).join(', ') || 'aucune'}. JSON UNIQUEMENT:\n` +
    `{"additionalVars":{"NOM":"description"},"optionalVars":{"NOM":"description"}}`;
  const result = await routePrompt(prompt, { cacheKey: `env:${owner}/${repo}`, jsonMode: true, maxTokens: 400 });
  try { return JSON.parse(result.text); } catch { return { additionalVars: {}, optionalVars: {} }; }
}

function getTotalEffectiveRPM() {
  return Object.entries(PROVIDERS)
    .filter(([id]) => PROVIDERS[id].enabled())
    .reduce((sum, [id, p]) => sum + (p.effectiveRPM ? p.effectiveRPM() : p.rpmLimit), 0);
}

module.exports = {
  routePrompt,
  analyzeRepoWithLLM,
  suggestEnvVars,
  getRouterStatus,
  getTotalEffectiveRPM,
  PROVIDERS,
};
