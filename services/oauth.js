/**
 * ═══════════════════════════════════════════════════════════════
 *  services/oauth.js
 *  Flux OAuth 2.0 — Google + GitHub
 *  Récupère email/profil Google, génère URL d'autorisation GitHub
 * ═══════════════════════════════════════════════════════════════
 */

const axios   = require('axios');
const crypto  = require('crypto');
const logger  = require('../utils/logger');
const ENV     = require('../utils/env');  // ← source unique des clés

// ── Google OAuth ────────────────────────────────────────────────
const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_INFO_URL  = 'https://www.googleapis.com/oauth2/v2/userinfo';

// ── GitHub OAuth ────────────────────────────────────────────────
const GITHUB_AUTH_URL  = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

// Scopes GitHub nécessaires pour créer des repos + Actions secrets
const GITHUB_SCOPES = ['repo', 'workflow', 'user:email', 'admin:repo_hook'].join(',');

// Anti CSRF : stocke les states temporaires en mémoire
const _states = new Map(); // state → { provider, email, expiresAt }

function generateState(provider, email = '') {
  const state = crypto.randomBytes(16).toString('hex');
  _states.set(state, { provider, email, expiresAt: Date.now() + 10 * 60_000 }); // 10 min
  return state;
}

function consumeState(state) {
  const data = _states.get(state);
  if (!data) throw new Error('[OAuth] État invalide ou expiré');
  if (Date.now() > data.expiresAt) { _states.delete(state); throw new Error('[OAuth] État expiré'); }
  _states.delete(state);
  return data;
}

// ── Google ──────────────────────────────────────────────────────

/**
 * Génère l'URL de redirection pour le consent Google
 * @param {string} redirectUri  - URL de callback enregistrée dans Google Cloud Console
 * @returns {{ url, state }}
 */
function getGoogleAuthUrl(redirectUri) {
  const state  = generateState('google');
  const params = new URLSearchParams({
    client_id     : ENV.GOOGLE_CLIENT_ID,
    redirect_uri  : redirectUri,
    response_type : 'code',
    scope         : 'openid email profile',
    state,
    access_type   : 'offline',
    prompt        : 'consent',
  });
  return { url: `${GOOGLE_AUTH_URL}?${params}`, state };
}

/**
 * Échange le code Google contre un token, puis récupère l'email
 * @returns {{ email, name, picture, sub }}
 */
async function exchangeGoogleCode(code, redirectUri, state) {
  consumeState(state); // Valider anti-CSRF

  const tokenRes = await axios.post(GOOGLE_TOKEN_URL, {
    code,
    client_id     : ENV.GOOGLE_CLIENT_ID,
    client_secret : ENV.GOOGLE_CLIENT_SECRET,
    redirect_uri  : redirectUri,
    grant_type    : 'authorization_code',
  });

  const { access_token } = tokenRes.data;
  const { data: user }   = await axios.get(GOOGLE_INFO_URL, {
    headers: { Authorization: `Bearer ${access_token}` },
  });

  logger.info(`[OAuth] Google ✓ — ${user.email}`);
  return {
    email  : user.email,
    name   : user.name,
    picture: user.picture,
    sub    : user.id,
  };
}

// ── GitHub ──────────────────────────────────────────────────────

/**
 * Génère l'URL d'autorisation GitHub OAuth
 * @param {string} email   - Email associé (pour le lier au job)
 * @returns {{ url, state }}
 */
function getGitHubAuthUrl(email) {
  const state  = generateState('github', email);
  const params = new URLSearchParams({
    client_id   : ENV.GITHUB_CLIENT_ID,
    scope       : GITHUB_SCOPES,
    state,
    allow_signup: 'true',
  });
  return { url: `${GITHUB_AUTH_URL}?${params}`, state };
}

/**
 * Échange le code GitHub contre un access token
 * @returns {{ token, scope, email }}
 */
async function exchangeGitHubCode(code, state) {
  const { email } = consumeState(state);

  const res = await axios.post(GITHUB_TOKEN_URL, {
    client_id    : ENV.GITHUB_CLIENT_ID,
    client_secret: ENV.GITHUB_CLIENT_SECRET,
    code,
  }, { headers: { Accept: 'application/json' } });

  if (res.data.error) throw new Error(`[OAuth] GitHub: ${res.data.error_description}`);

  logger.info(`[OAuth] GitHub ✓ — scopes: ${res.data.scope}`);
  return { token: res.data.access_token, scope: res.data.scope, email };
}

module.exports = { getGoogleAuthUrl, exchangeGoogleCode, getGitHubAuthUrl, exchangeGitHubCode };
