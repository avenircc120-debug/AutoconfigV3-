/**
 * server.js — AutoConfig Ultimate v3.1
 * Fusionne AutoConfig + InfraForge v1 + v2 + Gemini AI
 */

require('dotenv').config();

// ── [VALIDATION] Vérifier les variables AVANT tout le reste ──────────
const { printEnvReport } = require('./utils/env-validator');
printEnvReport(true);  // exitOnCritical=true → arrête si MASTER_SECRET absent

const ENV         = require('./utils/env');   // ← source unique des clés
const express     = require('express');
const cors        = require('cors');
const compression = require('compression');
const path        = require('path');
const logger      = require('./utils/logger');
const api         = require('./routes/api');

const app  = express();
const PORT = ENV.PORT;

// ── [1] MIDDLEWARE CORS ───────────────────────────────────────────
// Permet à l'interface mobile (Samsung A05, autre domaine) de
// communiquer avec le backend sans erreur "blocked by CORS policy"
app.use(cors({
  origin      : ENV.ALLOWED_ORIGIN,
  methods     : ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials : false,
}));

// ── [2] BODY PARSERS ─────────────────────────────────────────────
// express.json() obligatoire pour que les requêtes POST de l'UI
// soient correctement lues côté backend
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// ── Compression Gzip (chargement rapide en 3G/4G Bénin) ──────────
app.use(compression({ level: 6 }));

// ── Headers de sécurité ───────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options',        'DENY');
  res.setHeader('X-XSS-Protection',       '1; mode=block');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Log de chaque requête entrante ────────────────────────────────
app.use((req, _, next) => {
  logger.debug(`→ ${req.method} ${req.path}`);
  next();
});

// ── Fichiers statiques (frontend) ────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge : ENV.isProduction ? '1h' : 0,
  etag   : true,
}));

// ── Routes API ────────────────────────────────────────────────────
app.use('/api', api);

// ── SPA fallback ─────────────────────────────────────────────────
app.get('*', (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ── Gestionnaire d'erreurs global ────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error(`[Server] Erreur non gérée: ${err.message}`);
  res.status(500).json({ success: false, error: 'Erreur serveur interne' });
});

// ── Erreurs Node.js non catchées ─────────────────────────────────
process.on('unhandledRejection', (reason) => {
  logger.error(`[Process] unhandledRejection: ${reason}`);
});
process.on('uncaughtException', (err) => {
  logger.error(`[Process] uncaughtException: ${err.message}`);
  process.exit(1);
});

// ── Démarrage du serveur ──────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {

    // [4] Console.log clair et visible sur terminal mobile
    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    console.log(`║  ✅ Serveur démarré sur le port ${PORT}               ║`);
    console.log('║  🚀 AutoConfig Ultimate v3.1                      ║');
    console.log(`║  🌍 http://0.0.0.0:${PORT}                          ║`);
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  [A] AutoConfig    → gateway · zero-clone · AES-256`);
    console.log(`  [B] InfraForge v1 → OAuth · Supabase · Vercel`);
    console.log(`  [C] InfraForge v2 → identifyStack() · orchestrator`);
    console.log(`  [D] Gemini AI     → cache · backoff · key-rotation`);
    console.log(`  [E] LLM Router    → Gemini · Groq · Mistral · Cohere · HuggingFace`);
    console.log('');
    // Afficher les providers actifs
    try {
      const { getRouterStatus } = require('./services/llm-router');
      const router = getRouterStatus();
      const active = router.providers.filter(p => p.configured);
      console.log(`  🤖 LLM providers actifs (${active.length}) : ${active.map(p => p.name.split('/')[0]).join(' + ')}`);
      console.log(`  ⚡ Capacité totale : ${router.totalRPM} RPM (vs 15 RPM sans rotation)`);
    } catch { /* LLM router optionnel */ }
    console.log('');
    console.log(`  ENV  : ${ENV.NODE_ENV}`);
    console.log(`  CORS : ${ENV.ALLOWED_ORIGIN}`);
    console.log(`  GZIP : activé (niveau 6)`);
    console.log('');

    // Log Winston également pour les fichiers de log
    logger.success(`Serveur démarré sur le port ${PORT}`);
  });
}

module.exports = app;
