/**
 * ═══════════════════════════════════════════════════════════════════════
 *  services/gemini-client.js
 *
 *  CLIENT GEMINI OPTIMISÉ — FREE TIER (15 RPM)
 *  ─────────────────────────────────────────────
 *  Combine les 3 stratégies :
 *
 *  [1] CACHE          → Ré-utilise les analyses déjà faites
 *  [2] RETRY + BACKOFF→ Réessaie intelligemment sur 429/503
 *  [3] ROTATION       → Passe à la clé suivante si limite atteinte
 *
 *  Usage principal : analyzeRepo(owner, repo, githubToken)
 *  → Identifie le stack ET enrichit l'analyse via Gemini
 * ═══════════════════════════════════════════════════════════════════════
 */

const axios                = require('axios');
const logger               = require('../utils/logger');
const { rotator }          = require('../utils/gemini-key-rotator');
const { cache }            = require('../utils/gemini-cache');
const { StackDetector }    = require('./stack-detector');

// ── Constantes ───────────────────────────────────────────────────────
const GEMINI_API_BASE   = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL     = 'gemini-1.5-flash';   // Gratuit · 15 RPM · 1M tokens/min

// ── Retry config (Exponential Backoff) ──────────────────────────────
const RETRY_CONFIG = {
  maxRetries      : 4,
  baseDelayMs     : 2_000,    // délai initial : 2s
  maxDelayMs      : 64_000,   // délai max : 64s
  jitterFraction  : 0.25,     // ±25% de variation aléatoire (anti-thundering herd)
  retryableStatuses: [429, 500, 502, 503, 504],
};

// ── Calcul du backoff exponentiel ────────────────────────────────────

/**
 * Calcule le délai d'attente pour la tentative N.
 * Formule : min(base * 2^n, max) + jitter aléatoire
 *
 * Exemple avec base=2s, max=64s :
 *   Tentative 1 → ~2s   (2^1 = 2)
 *   Tentative 2 → ~4s   (2^2 = 4)
 *   Tentative 3 → ~8s   (2^3 = 8)
 *   Tentative 4 → ~16s  (2^4 = 16)
 */
function calcBackoff(attempt) {
  const base   = Math.min(
    RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt),
    RETRY_CONFIG.maxDelayMs,
  );
  const jitter = base * RETRY_CONFIG.jitterFraction * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}

/**
 * Extrait le délai Retry-After depuis les headers d'une réponse 429.
 * Retourne null si non présent.
 */
function extractRetryAfter(error) {
  const header = error?.response?.headers?.['retry-after'];
  if (!header) return null;
  const seconds = parseInt(header, 10);
  return isNaN(seconds) ? null : seconds * 1_000;
}

// ════════════════════════════════════════════════════════════════════
//  Fonction de base : appel Gemini avec retry + rotation
// ════════════════════════════════════════════════════════════════════

/**
 * Effectue un appel à l'API Gemini avec :
 *  - Sélection automatique de la meilleure clé disponible
 *  - Retry exponentiel sur erreurs transitoires (429, 5xx)
 *  - Rotation de clé si une clé spécifique est épuisée
 *
 * @param {object} payload   Corps de la requête Gemini (contents, generationConfig…)
 * @param {string} [model]   Modèle Gemini à utiliser
 * @returns {Promise<string>} Texte généré
 */
async function callGemini(payload, model = DEFAULT_MODEL) {
  if (!rotator.hasKeys) {
    throw new Error('[Gemini] Aucune clé API configurée — définir GEMINI_KEYS dans .env');
  }

  let lastError;

  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {

    // [3] Récupérer une clé disponible (rotation automatique)
    let keyInfo;
    try {
      keyInfo = await rotator.getAvailableKey();
    } catch (e) {
      throw new Error(`[Gemini] Toutes les clés épuisées: ${e.message}`);
    }

    const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${keyInfo.apiKey}`;

    try {
      logger.debug(`[Gemini] Tentative ${attempt + 1}/${RETRY_CONFIG.maxRetries + 1} — clé #${keyInfo.index + 1}`);

      const response = await axios.post(url, payload, {
        headers : { 'Content-Type': 'application/json' },
        timeout : 30_000,
      });

      // Succès — extraire le texte
      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      logger.debug(`[Gemini] ✓ Réponse reçue (${text.length} chars)`);
      return text;

    } catch (error) {
      lastError = error;
      const status = error?.response?.status;

      // ── Erreur 429 : Rate Limit ──────────────────────────────────
      if (status === 429) {
        const retryAfterMs = extractRetryAfter(error) || calcBackoff(attempt);
        logger.warn(`[Gemini] 429 sur clé #${keyInfo.index + 1} — blocage ${Math.ceil(retryAfterMs / 1000)}s`);

        // [3] Marquer la clé comme épuisée ET tenter rotation
        rotator.markExhausted(keyInfo.index, retryAfterMs);

        // Si d'autres clés disponibles → réessayer immédiatement avec une autre
        const alt = rotator._selectKey();
        if (alt) {
          logger.info(`[Gemini] Rotation → clé #${alt.index + 1}`);
          continue; // Nouvelle itération avec la nouvelle clé
        }

        // Sinon → attendre le backoff
        const wait = calcBackoff(attempt);
        logger.warn(`[Gemini] [2] Backoff ${Math.ceil(wait / 1000)}s avant tentative ${attempt + 2}…`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      // ── Erreurs serveur (5xx) : retry avec backoff ───────────────
      if (RETRY_CONFIG.retryableStatuses.includes(status)) {
        if (attempt < RETRY_CONFIG.maxRetries) {
          const wait = calcBackoff(attempt);
          logger.warn(`[Gemini] Erreur ${status} — backoff ${Math.ceil(wait / 1000)}s (tentative ${attempt + 2}/${RETRY_CONFIG.maxRetries + 1})`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
      }

      // ── Erreur non récupérable (400, 401, 403…) ──────────────────
      const msg = error?.response?.data?.error?.message || error.message;
      logger.error(`[Gemini] Erreur non récupérable (${status || 'NETWORK'}): ${msg}`);
      throw new Error(`[Gemini] ${status || 'ERREUR'}: ${msg}`);
    }
  }

  throw new Error(`[Gemini] Échec après ${RETRY_CONFIG.maxRetries + 1} tentatives: ${lastError?.message}`);
}

// ════════════════════════════════════════════════════════════════════
//  Prompts spécialisés
// ════════════════════════════════════════════════════════════════════

function buildRepoAnalysisPrompt(owner, repo, stackInfo) {
  return {
    contents: [{
      role: 'user',
      parts: [{
        text: `Tu es un expert DevOps. Analyse ce dépôt GitHub et fournis une réponse JSON uniquement (sans markdown, sans backticks).

Dépôt: ${owner}/${repo}
Stack détecté: ${stackInfo.summary}
Framework: ${stackInfo.primary?.framework || 'inconnu'}
Fichiers racine: ${(stackInfo.repoRoot || []).slice(0, 20).join(', ')}
Variables .env.example: ${(stackInfo.envVars || []).filter(v => !v.isComment).map(v => v.key).join(', ') || 'aucune'}

Réponds avec exactement ce JSON:
{
  "deploymentRecommendations": ["conseil 1", "conseil 2", "conseil 3"],
  "requiredEnvVars": ["VAR1", "VAR2"],
  "suggestedBuildCommand": "npm run build",
  "suggestedStartCommand": "npm start",
  "databaseRequired": true,
  "estimatedDeployTime": "2-3 minutes",
  "warnings": ["avertissement éventuel"]
}`
      }]
    }],
    generationConfig: {
      temperature     : 0.1,
      maxOutputTokens : 800,
      responseMimeType: 'application/json',
    },
  };
}

function buildEnvSuggestPrompt(owner, repo, stackInfo, supabaseUrl) {
  return {
    contents: [{
      role: 'user',
      parts: [{
        text: `Tu es un expert configuration. Génère les variables d'environnement manquantes pour ce projet. Réponds JSON uniquement.

Projet: ${owner}/${repo}
Stack: ${stackInfo.summary}
Supabase URL: ${supabaseUrl || 'non configuré'}
Variables déjà présentes: ${(stackInfo.envVars || []).filter(v => !v.isComment && v.hasValue).map(v => v.key).join(', ') || 'aucune'}

Réponds avec:
{
  "additionalVars": { "NOM_VAR": "valeur_exemple_ou_description" },
  "optionalVars": { "NOM_VAR": "description" }
}`
      }]
    }],
    generationConfig: {
      temperature     : 0.1,
      maxOutputTokens : 400,
      responseMimeType: 'application/json',
    },
  };
}

// ════════════════════════════════════════════════════════════════════
//  API principale : analyzeRepo()
// ════════════════════════════════════════════════════════════════════

/**
 * Analyse complète d'un repo GitHub avec Gemini.
 * Combine : détection de stack (Octokit) + enrichissement IA (Gemini)
 * Avec [1] CACHE — ne rappelle pas l'IA si le résultat est déjà connu.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} githubToken
 * @param {object} [options]
 * @param {boolean} [options.forceRefresh]  Ignore le cache
 * @param {string}  [options.commitSha]     SHA pour l'invalidation fine
 * @param {string}  [options.supabaseUrl]   Pour les suggestions de vars
 * @returns {Promise<AnalysisResult>}
 */
async function analyzeRepo(owner, repo, githubToken, options = {}) {
  const { forceRefresh = false, commitSha = '', supabaseUrl = '' } = options;

  logger.info(`[Gemini] analyzeRepo("${owner}/${repo}") — cache: ${!forceRefresh}`);

  // ── [1] Vérifier le cache ─────────────────────────────────────────
  if (!forceRefresh) {
    const cached = cache.get(owner, repo, commitSha);
    if (cached) {
      logger.info(`[Gemini] ✓ Résultat servi depuis le cache (${cache.stats().hitRate} hit rate)`);
      return { ...cached, fromCache: true };
    }
  }

  // ── Détection de stack (Octokit — gratuit, pas de quota Gemini) ───
  logger.info(`[Gemini] Détection du stack via Octokit…`);
  const detector = new StackDetector(githubToken);
  const stackInfo = await detector.identifyStack(owner, repo);

  // Si Gemini n'est pas configuré, retourner uniquement le stack
  if (!rotator.hasKeys) {
    logger.warn('[Gemini] Clés non configurées — retour de la détection Octokit uniquement');
    const result = { ...stackInfo, geminiAnalysis: null, geminiEnvSuggestions: null, fromCache: false };
    cache.set(owner, repo, result, commitSha);
    return result;
  }

  // ── Appel Gemini 1 : Recommandations de déploiement ───────────────
  let geminiAnalysis = null;
  try {
    logger.info(`[Gemini] Analyse IA du repo…`);
    const prompt   = buildRepoAnalysisPrompt(owner, repo, stackInfo);
    const rawText  = await callGemini(prompt);
    geminiAnalysis = JSON.parse(rawText);
    logger.info(`[Gemini] ✓ Analyse reçue — ${geminiAnalysis.deploymentRecommendations?.length || 0} recommandations`);
  } catch (e) {
    logger.warn(`[Gemini] Analyse IA échouée (non bloquant): ${e.message}`);
  }

  // ── Appel Gemini 2 : Suggestions de variables .env ────────────────
  let geminiEnvSuggestions = null;
  try {
    const envPrompt       = buildEnvSuggestPrompt(owner, repo, stackInfo, supabaseUrl);
    const rawEnv          = await callGemini(envPrompt);
    geminiEnvSuggestions  = JSON.parse(rawEnv);
    logger.info(`[Gemini] ✓ Suggestions env: ${Object.keys(geminiEnvSuggestions?.additionalVars || {}).length} vars additionnelles`);
  } catch (e) {
    logger.warn(`[Gemini] Suggestions env échouées (non bloquant): ${e.message}`);
  }

  // ── Construire le résultat final ──────────────────────────────────
  const result = {
    ...stackInfo,
    geminiAnalysis,
    geminiEnvSuggestions,
    analyzedAt : new Date().toISOString(),
    fromCache  : false,
  };

  // ── [1] Mettre en cache ───────────────────────────────────────────
  cache.set(owner, repo, result, commitSha);
  logger.info(`[Gemini] Résultat mis en cache pour ${owner}/${repo}`);

  return result;
}

/**
 * Version légère : utilise uniquement le cache ou la détection Octokit.
 * N'appelle JAMAIS Gemini — utile pour les vérifications rapides.
 */
async function quickAnalyze(owner, repo, githubToken) {
  const cached = cache.get(owner, repo);
  if (cached) return { ...cached, fromCache: true };

  const detector  = new StackDetector(githubToken);
  const stackInfo = await detector.identifyStack(owner, repo);
  cache.set(owner, repo, stackInfo);
  return { ...stackInfo, fromCache: false };
}

module.exports = {
  callGemini,
  analyzeRepo,
  quickAnalyze,
  RETRY_CONFIG,
  DEFAULT_MODEL,
};
