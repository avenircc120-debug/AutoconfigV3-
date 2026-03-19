/**
 * ═══════════════════════════════════════════════════════════════════════
 *  utils/env.js
 *
 *  SOURCE UNIQUE DE VÉRITÉ — Toutes les variables d'environnement
 *  ───────────────────────────────────────────────────────────────
 *  RÈGLE : Aucun fichier de l'application ne doit appeler
 *          process.env.XXX directement sauf ce fichier.
 *
 *  Avantages :
 *   · Un seul endroit à auditer pour vérifier la sécurité
 *   · Valeurs par défaut documentées ici
 *   · Facilite les tests (mock d'un seul module)
 *   · Détection claire des variables manquantes
 * ═══════════════════════════════════════════════════════════════════════
 */

// ── Serveur ──────────────────────────────────────────────────────────
const NODE_ENV      = process.env.NODE_ENV      || 'development';
const PORT          = parseInt(process.env.PORT || '3000', 10);
const BASE_URL      = process.env.BASE_URL      || `http://localhost:${PORT}`;
const ALLOWED_ORIGIN= process.env.ALLOWED_ORIGIN|| '*';
const LOG_LEVEL     = process.env.LOG_LEVEL     || (NODE_ENV === 'production' ? 'info' : 'debug');

// ── Sécurité AES-256-GCM ─────────────────────────────────────────────
// CRITIQUE — sans cette clé, aucun token ne peut être chiffré/déchiffré
const MASTER_SECRET = process.env.MASTER_SECRET || '';

// ── GitHub ────────────────────────────────────────────────────────────
// Token personnel pour les opérations Zero-Clone autonomes (sans OAuth)
const GITHUB_TOKEN         = process.env.GITHUB_TOKEN          || '';
// Clés OAuth (pour "Login with GitHub")
const GITHUB_CLIENT_ID     = process.env.GITHUB_CLIENT_ID      || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET  || '';

// ── Google OAuth ─────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID      || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET  || '';

// ── Supabase Management API ───────────────────────────────────────────
// Clé pour créer des projets Supabase automatiquement
const SUPABASE_MANAGEMENT_TOKEN = process.env.SUPABASE_MANAGEMENT_TOKEN || '';
// Région par défaut pour les nouveaux projets
const DEFAULT_SUPABASE_REGION   = process.env.DEFAULT_SUPABASE_REGION   || 'eu-west-1';

// ── Vercel API ────────────────────────────────────────────────────────
const VERCEL_API_TOKEN = process.env.VERCEL_API_TOKEN || '';
const VERCEL_TEAM_ID   = process.env.VERCEL_TEAM_ID   || '';  // optionnel (comptes team)

// ── Gemini AI ─────────────────────────────────────────────────────────
// GEMINI_KEYS prend priorité sur GEMINI_API_KEY
// Format : JSON array ["key1","key2"] ou CSV "key1,key2"
const GEMINI_KEYS      = process.env.GEMINI_KEYS      || process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL     = process.env.GEMINI_MODEL     || 'gemini-1.5-flash';
const GEMINI_CACHE_TTL = parseInt(process.env.GEMINI_CACHE_TTL_SECONDS || '86400', 10) * 1000;

// ── FedaPay Mobile Money ──────────────────────────────────────────────
const FEDAPAY_SECRET_KEY     = process.env.FEDAPAY_SECRET_KEY     || '';
const FEDAPAY_WEBHOOK_SECRET = process.env.FEDAPAY_WEBHOOK_SECRET || '';
const FEDAPAY_ENV            = process.env.FEDAPAY_ENV            || 'sandbox'; // 'sandbox' | 'live'

// ── Export groupé ─────────────────────────────────────────────────────
module.exports = {
  // Serveur
  NODE_ENV,
  PORT,
  BASE_URL,
  ALLOWED_ORIGIN,
  LOG_LEVEL,

  // Sécurité
  MASTER_SECRET,

  // GitHub
  GITHUB_TOKEN,
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,

  // Google
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,

  // Supabase
  SUPABASE_MANAGEMENT_TOKEN,
  DEFAULT_SUPABASE_REGION,

  // Vercel
  VERCEL_API_TOKEN,
  VERCEL_TEAM_ID,

  // Gemini
  GEMINI_KEYS,
  GEMINI_MODEL,
  GEMINI_CACHE_TTL,

  // FedaPay
  FEDAPAY_SECRET_KEY,
  FEDAPAY_WEBHOOK_SECRET,
  FEDAPAY_ENV,

  // ── Helpers ────────────────────────────────────────────────────────

  /** Vrai si le serveur est en production */
  isProduction: NODE_ENV === 'production',

  /** Vrai si au moins une clé Gemini est configurée */
  hasGemini: Boolean(GEMINI_KEYS),

  /** Vrai si les clés OAuth Google sont configurées */
  hasGoogleOAuth: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),

  /** Vrai si les clés OAuth GitHub sont configurées */
  hasGitHubOAuth: Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET),

  /** Vrai si le token Supabase Management est configuré */
  hasSupabase: Boolean(SUPABASE_MANAGEMENT_TOKEN),

  /** Vrai si le token Vercel est configuré */
  hasVercel: Boolean(VERCEL_API_TOKEN),

  /** Vrai si FedaPay est configuré */
  hasFedaPay: Boolean(FEDAPAY_SECRET_KEY),
};

// ── LLM Router — providers additionnels ──────────────────────────────
const GROQ_API_KEY      = process.env.GROQ_API_KEY      || '';
const GROQ_MODEL        = process.env.GROQ_MODEL        || 'llama-3.1-70b-versatile';
const MISTRAL_API_KEY   = process.env.MISTRAL_API_KEY   || '';
const MISTRAL_MODEL     = process.env.MISTRAL_MODEL     || 'mistral-small-latest';
const COHERE_API_KEY    = process.env.COHERE_API_KEY    || '';
const COHERE_MODEL      = process.env.COHERE_MODEL      || 'command-r';
const HUGGINGFACE_TOKEN = process.env.HUGGINGFACE_TOKEN || '';
const HF_MODEL          = process.env.HF_MODEL          || 'HuggingFaceH4/zephyr-7b-beta';

// Ajouter au module.exports existant
Object.assign(module.exports, {
  GROQ_API_KEY, GROQ_MODEL,
  MISTRAL_API_KEY, MISTRAL_MODEL,
  COHERE_API_KEY, COHERE_MODEL,
  HUGGINGFACE_TOKEN, HF_MODEL,
  hasGroq      : Boolean(GROQ_API_KEY),
  hasMistral   : Boolean(MISTRAL_API_KEY),
  hasCohere    : Boolean(COHERE_API_KEY),
  hasHuggingFace: Boolean(HUGGINGFACE_TOKEN),
  totalLLMProviders: [GEMINI_KEYS, GROQ_API_KEY, MISTRAL_API_KEY, COHERE_API_KEY, HUGGINGFACE_TOKEN].filter(Boolean).length,
});
