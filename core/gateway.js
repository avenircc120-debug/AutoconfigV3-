/**
 * ═══════════════════════════════════════════════════════════════
 *  PILIER 1 — LE CONNECTEUR UNIVERSEL  (core/gateway.js)
 *  Moteur axios capable de parler à n'importe quelle API
 *  via Headers dynamiques + Body JSON structuré
 * ═══════════════════════════════════════════════════════════════
 */

const axios  = require('axios');
const logger = require('../utils/logger');

// Délais et tentatives
const DEFAULT_TIMEOUT  = 15_000; // 15 s
const MAX_RETRIES      = 3;
const RETRY_DELAY_MS   = 800;

/**
 * Pause non-bloquante
 * @param {number} ms
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Crée une instance axios préconfigurée pour un service donné.
 *
 * @param {object} config
 * @param {string} config.baseURL      - Racine de l'API  (ex: https://api.github.com)
 * @param {string} [config.token]      - Bearer token (optionnel)
 * @param {string} [config.authScheme] - 'Bearer' | 'token' | 'Basic' …
 * @param {object} [config.headers]    - Headers additionnels
 * @param {number} [config.timeout]    - Timeout en ms
 * @returns {import('axios').AxiosInstance}
 */
function createClient(config = {}) {
  const {
    baseURL,
    token,
    authScheme = 'Bearer',
    headers    = {},
    timeout    = DEFAULT_TIMEOUT,
  } = config;

  if (!baseURL) throw new Error('[Gateway] baseURL est obligatoire');

  const instance = axios.create({
    baseURL,
    timeout,
    headers: {
      'Content-Type' : 'application/json',
      'Accept'       : 'application/json',
      ...(token ? { Authorization: `${authScheme} ${token}` } : {}),
      ...headers,
    },
  });

  // ── Intercepteur requête : log avant envoi ──────────────────
  instance.interceptors.request.use((req) => {
    logger.debug(`[Gateway →] ${req.method?.toUpperCase()} ${req.baseURL}${req.url}`);
    return req;
  });

  // ── Intercepteur réponse : log + normalisation erreur ───────
  instance.interceptors.response.use(
    (res) => {
      logger.debug(`[Gateway ←] ${res.status} ${res.config.url}`);
      return res;
    },
    (err) => {
      const status = err.response?.status;
      const msg    = err.response?.data?.message || err.message;
      logger.error(`[Gateway ✗] ${status || 'NETWORK'} — ${msg}`);
      return Promise.reject(err);
    },
  );

  return instance;
}

/**
 * Requête universelle avec retry automatique.
 *
 * @param {import('axios').AxiosInstance} client
 * @param {object} options
 * @param {string}  options.method   - GET | POST | PUT | PATCH | DELETE
 * @param {string}  options.endpoint - Chemin relatif (ex: /repos/owner/repo)
 * @param {object}  [options.body]   - Payload JSON
 * @param {object}  [options.params] - Query string
 * @param {object}  [options.headers]- Headers supplémentaires par requête
 * @param {number}  [options.retries]- Nombre de tentatives (défaut: MAX_RETRIES)
 * @returns {Promise<any>}           - data de la réponse
 */
async function request(client, options = {}) {
  const {
    method   = 'GET',
    endpoint = '/',
    body,
    params,
    headers  = {},
    retries  = MAX_RETRIES,
  } = options;

  let attempt = 0;

  while (attempt <= retries) {
    try {
      const res = await client.request({
        method,
        url    : endpoint,
        data   : body,
        params,
        headers,
      });
      return res.data;

    } catch (err) {
      attempt++;
      const status = err.response?.status;

      // Pas de retry sur les erreurs client (4xx sauf 429)
      if (status && status >= 400 && status < 500 && status !== 429) {
        throw err;
      }

      if (attempt > retries) throw err;

      const delay = RETRY_DELAY_MS * attempt;
      logger.warn(`[Gateway] Tentative ${attempt}/${retries} — attente ${delay}ms…`);
      await sleep(delay);
    }
  }
}

/**
 * Requête en streaming (Server-Sent Events vers un provider externe).
 * Yield chaque chunk texte brut reçu.
 *
 * @param {import('axios').AxiosInstance} client
 * @param {string} endpoint
 * @param {object} [body]
 */
async function* streamRequest(client, endpoint, body = {}) {
  const res = await client.post(endpoint, body, { responseType: 'stream' });
  for await (const chunk of res.data) {
    yield chunk.toString('utf8');
  }
}

module.exports = { createClient, request, streamRequest };
