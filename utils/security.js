/**
 * ═══════════════════════════════════════════════════════════════
 *  SÉCURITÉ — AES-256-GCM + Validation Zod  (utils/security.js)
 *  Chiffre les tokens en mémoire · Valide les entrées utilisateur
 * ═══════════════════════════════════════════════════════════════
 */

const crypto = require('crypto');
const { z }  = require('zod');
const ENV    = require('./env');  // ← source unique des clés

// ── Constantes crypto ───────────────────────────────────────────
const ALGO       = 'aes-256-gcm';
const KEY_LEN    = 32;   // 256 bits
const IV_LEN     = 12;   // 96 bits — recommandé GCM
const TAG_LEN    = 16;   // 128 bits
const SALT       = 'autoconfig_salt_v1';

// ── Clé dérivée depuis MASTER_SECRET ────────────────────────────
let _key = null;
function getKey() {
  if (!_key) {
    const secret = ENV.MASTER_SECRET;
    if (!secret || secret.length < 16) {
      throw new Error('[Security] MASTER_SECRET manquant ou trop court (min 16 chars)');
    }
    _key = crypto.scryptSync(secret, SALT, KEY_LEN);
  }
  return _key;
}

// ── Chiffrement ─────────────────────────────────────────────────

/**
 * Chiffre une chaîne sensible (token, clé API)
 * @param {string} plaintext
 * @returns {string}  format: iv:tag:ciphertext (base64 séparé par ':')
 */
function encrypt(plaintext) {
  const iv     = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv, { authTagLength: TAG_LEN });

  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

/**
 * Déchiffre un payload retourné par encrypt()
 * @param {string} payload
 * @returns {string} texte clair
 */
function decrypt(payload) {
  const parts = payload.split(':');
  if (parts.length !== 3) throw new Error('[Security] Payload chiffré invalide');

  const [ivB64, tagB64, ciphB64] = parts;
  const iv       = Buffer.from(ivB64,  'base64');
  const tag      = Buffer.from(tagB64, 'base64');
  const cipher   = Buffer.from(ciphB64,'base64');
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8');
}

/**
 * HMAC-SHA256 pour vérifier les signatures webhook
 * @param {string} rawBody
 * @param {string} signature
 * @param {string} secret
 */
function verifyWebhook(rawBody, signature, secret) {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const sig = signature.replace(/^sha256=/, '');
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
}

// ── Schémas Zod ─────────────────────────────────────────────────

/** Token GitHub : commence par ghp_, ghs_, ou github_pat_ */
const githubTokenSchema = z
  .string()
  .min(20, 'Token trop court')
  .regex(/^(ghp_|ghs_|github_pat_|gho_)/, 'Format token GitHub invalide');

/** URL HTTPS générique */
const urlSchema = z
  .string()
  .url('URL invalide')
  .startsWith('https://', 'HTTPS obligatoire');

/** Schéma d'une configuration de déploiement complète */
const deployConfigSchema = z.object({
  owner        : z.string().min(1).max(39).regex(/^[a-zA-Z0-9-]+$/),
  repo         : z.string().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/),
  branch       : z.string().min(1).max(100).default('main'),
  githubToken  : githubTokenSchema,
  targetFiles  : z.array(z.object({
    path    : z.string().min(1),
    content : z.string(),
  })).optional(),
});

/** Schéma paiement */
const paymentSchema = z.object({
  amount        : z.number().int().min(100, 'Montant minimum 100 FCFA'),
  customerName  : z.string().min(2).max(100),
  customerEmail : z.string().email('Email invalide'),
  planId        : z.enum(['starter', 'pro', 'enterprise']),
});

/**
 * Valide des données contre un schéma Zod.
 * @returns {{ success: boolean, data?, errors?: string[] }}
 */
function validate(schema, data) {
  const result = schema.safeParse(data);
  if (result.success) return { success: true, data: result.data };
  return {
    success : false,
    errors  : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  };
}

module.exports = {
  encrypt,
  decrypt,
  verifyWebhook,
  schemas : { githubTokenSchema, urlSchema, deployConfigSchema, paymentSchema },
  validate,
};
