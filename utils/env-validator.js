/**
 * ═══════════════════════════════════════════════════════════════════════
 *  utils/env-validator.js
 *
 *  VALIDATION DES VARIABLES D'ENVIRONNEMENT AU DÉMARRAGE
 *  ──────────────────────────────────────────────────────
 *  Vérifie que toutes les clés nécessaires sont présentes dans process.env
 *  AVANT que le serveur commence à accepter des requêtes.
 *
 *  Trois niveaux :
 *    CRITICAL  → manquante = le serveur refuse de démarrer
 *    WARNING   → manquante = le module concerné sera désactivé
 *    INFO      → optionnelle, juste un rappel
 * ═══════════════════════════════════════════════════════════════════════
 */

// ── Définition de toutes les variables attendues ────────────────────
const ENV_SCHEMA = [

  // ── SERVEUR ────────────────────────────────────────────────────────
  {
    key      : 'MASTER_SECRET',
    level    : 'CRITICAL',
    minLength: 32,
    module   : 'Fortress AES-256-GCM',
    hint     : 'Générer avec : node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
  },
  {
    key   : 'NODE_ENV',
    level : 'INFO',
    module: 'Serveur',
    hint  : 'Valeurs : development | production | test',
  },
  {
    key   : 'PORT',
    level : 'INFO',
    module: 'Serveur',
    hint  : 'Défaut: 3000 si absent',
  },

  // ── OAUTH GOOGLE ──────────────────────────────────────────────────
  {
    key   : 'GOOGLE_CLIENT_ID',
    level : 'WARNING',
    module: 'OAuth Google',
    hint  : 'Créer sur https://console.cloud.google.com → Credentials → OAuth 2.0',
  },
  {
    key   : 'GOOGLE_CLIENT_SECRET',
    level : 'WARNING',
    module: 'OAuth Google',
    hint  : 'Obtenu avec GOOGLE_CLIENT_ID',
  },

  // ── OAUTH GITHUB ──────────────────────────────────────────────────
  {
    key   : 'GITHUB_CLIENT_ID',
    level : 'WARNING',
    module: 'OAuth GitHub',
    hint  : 'Créer sur https://github.com/settings/developers → New OAuth App',
  },
  {
    key   : 'GITHUB_CLIENT_SECRET',
    level : 'WARNING',
    module: 'OAuth GitHub',
    hint  : 'Obtenu avec GITHUB_CLIENT_ID',
  },

  // ── GITHUB TOKEN PERSONNEL ────────────────────────────────────────
  {
    key   : 'GITHUB_TOKEN',
    level : 'WARNING',
    module: 'GitHub Zero-Clone',
    hint  : 'Créer sur https://github.com/settings/tokens — scopes: repo, workflow',
  },

  // ── SUPABASE ──────────────────────────────────────────────────────
  {
    key   : 'SUPABASE_MANAGEMENT_TOKEN',
    level : 'WARNING',
    module: 'Supabase Auto-Provisioning',
    hint  : 'Obtenir sur https://app.supabase.com/account/tokens',
  },

  // ── VERCEL ────────────────────────────────────────────────────────
  {
    key   : 'VERCEL_API_TOKEN',
    level : 'WARNING',
    module: 'Vercel Auto-Provisioning',
    hint  : 'Obtenir sur https://vercel.com/account/tokens',
  },

  // ── GEMINI AI ─────────────────────────────────────────────────────
  {
    key   : 'GEMINI_KEYS',
    level : 'INFO',
    module: 'Gemini AI (Free Tier)',
    hint  : 'Format JSON : ["AIzaSy_key1","AIzaSy_key2"] — https://aistudio.google.com/app/apikey\n           ↳ Fallback : GEMINI_API_KEY=AIzaSy_... (clé unique)',
  },

  // ── FEDAPAY ───────────────────────────────────────────────────────
  {
    key   : 'FEDAPAY_SECRET_KEY',
    level : 'INFO',
    module: 'FedaPay Mobile Money',
    hint  : 'Obtenir sur https://app.fedapay.com/settings/api (prefix: sk_sandbox_ ou sk_live_)',
  },
];

// ── Helpers d'affichage ─────────────────────────────────────────────
const ICONS  = { CRITICAL: '🔴', WARNING: '🟡', INFO: '🔵', OK: '✅' };
const COLORS = {
  reset : '\x1b[0m',
  red   : '\x1b[31m',
  yellow: '\x1b[33m',
  green : '\x1b[32m',
  cyan  : '\x1b[36m',
  bold  : '\x1b[1m',
  dim   : '\x1b[2m',
};

function c(color, text) {
  // Désactiver les couleurs si NO_COLOR est défini (certains terminaux mobile)
  if (process.env.NO_COLOR) return text;
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

/**
 * Valide la valeur d'une variable
 */
function checkVar(def) {
  const value = process.env[def.key];
  if (!value || value.trim() === '') return { ok: false, reason: 'absente' };
  if (value.includes('CHANGE_MEI') || value.includes('REMPLACER') || value.includes('xxxxxxx')) {
    return { ok: false, reason: 'valeur par défaut non remplacée' };
  }
  if (def.minLength && value.length < def.minLength) {
    return { ok: false, reason: `trop courte (${value.length} chars, minimum ${def.minLength})` };
  }
  return { ok: true };
}

/**
 * Valide toutes les variables et retourne un rapport.
 *
 * @returns {{ ok: boolean, criticals: string[], warnings: string[], report: string }}
 */
function validateEnv() {
  const criticals = [];
  const warnings  = [];
  const infos     = [];
  const oks       = [];

  for (const def of ENV_SCHEMA) {
    const { ok, reason } = checkVar(def);
    if (ok) {
      oks.push(def.key);
    } else {
      if (def.level === 'CRITICAL') criticals.push({ ...def, reason });
      else if (def.level === 'WARNING') warnings.push({ ...def, reason });
      else infos.push({ ...def, reason });
    }
  }

  // Vérification spéciale : GEMINI_API_KEY comme fallback de GEMINI_KEYS
  if (!process.env.GEMINI_KEYS && process.env.GEMINI_API_KEY) {
    // GEMINI_API_KEY est présent → pas d'alerte
    const geminiInfoIdx = infos.findIndex(i => i.key === 'GEMINI_KEYS');
    if (geminiInfoIdx !== -1) infos.splice(geminiInfoIdx, 1);
    oks.push('GEMINI_API_KEY (fallback)');
  }

  return { ok: criticals.length === 0, criticals, warnings, infos, oks };
}

/**
 * Affiche le rapport de validation dans la console.
 * Appelé au démarrage du serveur.
 *
 * @param {boolean} [exitOnCritical=true]  Arrêter le process si des CRITICAL manquent
 */
function printEnvReport(exitOnCritical = true) {
  const { ok, criticals, warnings, infos, oks } = validateEnv();

  console.log('');
  console.log(c('bold', '┌─────────────────────────────────────────────────────┐'));
  console.log(c('bold', '│        AUTOCONFIG — Vérification des variables       │'));
  console.log(c('bold', '└─────────────────────────────────────────────────────┘'));

  // ── Variables OK ────────────────────────────────────────────────
  oks.forEach(key => {
    console.log(` ${ICONS.OK}  ${c('green', key)}`);
  });

  // ── Warnings ────────────────────────────────────────────────────
  if (warnings.length) {
    console.log('');
    console.log(c('yellow', ` ${ICONS.WARNING}  ATTENTION — Modules désactivés (variables manquantes) :`));
    warnings.forEach(w => {
      console.log(c('yellow', `    • ${w.key} [${w.module}] — ${w.reason}`));
      console.log(c('dim',    `      ↳ ${w.hint}`));
    });
  }

  // ── Infos ────────────────────────────────────────────────────────
  if (infos.length) {
    console.log('');
    infos.forEach(i => {
      console.log(c('cyan', `  ${ICONS.INFO}  ${i.key} [${i.module}] — optionnelle (${i.reason})`));
      console.log(c('dim',  `      ↳ ${i.hint}`));
    });
  }

  // ── CRITIQUES ────────────────────────────────────────────────────
  if (criticals.length) {
    console.log('');
    console.log(c('red', ` ${ICONS.CRITICAL} ERREUR CRITIQUE — Le serveur ne peut pas démarrer :`));
    console.log('');
    criticals.forEach(cr => {
      console.log(c('red',  `  ✗  ${cr.key} [${cr.module}]`));
      console.log(c('red',  `     Problème : ${cr.reason}`));
      console.log(c('dim',  `     Solution : ${cr.hint}`));
      console.log('');
    });
    console.log(c('red',  ' Ajoute ces variables dans ton fichier .env ou dans le'));
    console.log(c('red',  ' Dashboard Vercel → Settings → Environment Variables'));
    console.log('');

    if (exitOnCritical) {
      process.exit(1);
    }
  } else {
    console.log('');
    console.log(c('green', ` ✅ Toutes les variables critiques sont présentes.`));
  }

  console.log(c('dim', ' ──────────────────────────────────────────────────────'));
  console.log('');

  return { ok, criticals, warnings };
}

module.exports = { validateEnv, printEnvReport };
