/**
 * ═══════════════════════════════════════════════════════════════════
 *  routes/api.js  —  AUTOCONFIG ULTIMATE · Routes unifiées
 *
 *  Fusionne les 3 projets en un seul router Express :
 *  ┌─ [A] AutoConfig    → /api/auth · /api/github · /api/deploy
 *  ├─ [B] InfraForge v1 → /api/infra · /api/setup · /api/oauth
 *  └─ [C] InfraForge v2 → /api/detect · /api/orchestrate
 * ═══════════════════════════════════════════════════════════════════
 */

const express                      = require('express');
const { v4: uuid }                 = require('uuid');
const ENV                          = require('../utils/env');  // ← source unique des clés

// ── Utilitaires ──────────────────────────────────────────────────
const { sseMiddleware, emit }      = require('../utils/sse');
const { encrypt, decrypt,
        validate, schemas }        = require('../utils/security');
const logger                       = require('../utils/logger');

// ── Services AutoConfig (A) ──────────────────────────────────────
const { GitHubZeroClone }          = require('../services/github');

// ── Services InfraForge v1 (B) ───────────────────────────────────
const { GitHubInfra }              = require('../services/github-infra');
const { SupabaseInfra }            = require('../services/supabase-infra');
const { VercelInfra }              = require('../services/vercel-infra');
const { setupFullStack }           = require('../services/orchestrator');
const { getGoogleAuthUrl,
        exchangeGoogleCode,
        getGitHubAuthUrl,
        exchangeGitHubCode }       = require('../services/oauth');

// ── Services InfraForge v2 (C) ───────────────────────────────────
const { StackDetector }            = require('../services/stack-detector');
const { orchestrateFullStack }     = require('../services/master-orchestrator');

// ── Gemini AI — 3 stratégies (D) ─────────────────────────────────
const { analyzeRepo, quickAnalyze }= require('../services/gemini-client');
const { rotator }                  = require('../utils/gemini-key-rotator');
const { cache: geminiCache }       = require('../utils/gemini-cache');

// ── LLM Router multi-provider (E) ────────────────────────────────
const { routePrompt,
        analyzeRepoWithLLM,
        getRouterStatus }          = require('../services/llm-router');

const router = express.Router();

// ─── Stores en mémoire (remplacer par Redis en prod) ─────────────
const sessions = new Map();   // sessionId → { email, tokens, … }
const jobs     = new Map();   // jobId → { status, result }

// ─── Helpers ─────────────────────────────────────────────────────
const ok   = (res, d)        => res.json({ success: true,  ...d });
const fail = (res, msg, s=400) => {
  logger.error(`[API ${s}] ${msg}`);
  res.status(s).json({ success: false, error: msg });
};
const safeDecrypt = (enc) => {
  try { return decrypt(enc); } catch { return ''; }
};

// ════════════════════════════════════════════════════════════════
//  HEALTH
// ════════════════════════════════════════════════════════════════
router.get('/health', (_, res) => {
  const keyStatus    = rotator.status();
  const routerStatus = getRouterStatus();
  res.json({
    status   : 'ok',
    service  : 'AutoConfig Ultimate',
    version  : '3.1.0',
    modules  : {
      A_autoconfig   : ['gateway','zero-clone','aes-256','sse','zod'],
      B_infraforge_v1: ['oauth-google','oauth-github','supabase','vercel','orchestrator'],
      C_infraforge_v2: ['stack-detector','auto-provisioner','master-orchestrator'],
      D_gemini_ai    : ['cache','exponential-backoff','key-rotation'],
      E_llm_router   : ['gemini','groq','mistral','cohere','huggingface'],
    },
    llm: {
      totalRPM       : routerStatus.totalRPM,
      availableCount : routerStatus.availableCount,
      providers      : routerStatus.providers.map(p => ({
        id        : p.id,
        name      : p.name,
        configured: p.configured,
        available : p.available,
        rpmFree   : p.rpmFree,
        rpmLimit  : p.rpmLimit,
      })),
    },
    gemini: {
      keysConfigured : rotator.totalKeys,
      keysAvailable  : keyStatus.filter(k => k.available).length,
      cacheStats     : geminiCache.stats(),
    },
    uptime: process.uptime().toFixed(1) + 's',
  });
});

// ════════════════════════════════════════════════════════════════
//  [A] AUTOCONFIG — Sécurité / Zero-Clone / Deploy SSE
// ════════════════════════════════════════════════════════════════

/** Chiffrer un token GitHub */
router.post('/auth/encrypt-token', (req, res) => {
  const v = validate(schemas.githubTokenSchema, req.body.githubToken);
  if (!v.success) return fail(res, v.errors.join('; '));
  try { ok(res, { encryptedToken: encrypt(req.body.githubToken) }); }
  catch (e) { fail(res, e.message, 500); }
});

/** Tester un token chiffré */
router.post('/auth/test-token', async (req, res) => {
  try {
    const token    = decrypt(req.body.encryptedToken);
    const gh       = new GitHubZeroClone(token);
    const { data } = await gh.octokit.users.getAuthenticated();
    ok(res, { login: data.login, name: data.name, avatar: data.avatar_url });
  } catch (e) { fail(res, `Token invalide: ${e.message}`); }
});

/** Lire un fichier GitHub */
router.post('/github/read', async (req, res) => {
  const { encryptedToken, owner, repo, path, ref = 'main' } = req.body;
  try {
    const gh   = new GitHubZeroClone(safeDecrypt(encryptedToken));
    const file = await gh.readFile(owner, repo, path, ref);
    ok(res, { file });
  } catch (e) { fail(res, e.message); }
});

/** Écrire un fichier GitHub (Zero-Clone) */
router.post('/github/write', async (req, res) => {
  const { encryptedToken, owner, repo, path, content, message, branch = 'main' } = req.body;
  try {
    const gh     = new GitHubZeroClone(safeDecrypt(encryptedToken));
    const result = await gh.writeFile({ owner, repo, path, content, message, branch });
    ok(res, result);
  } catch (e) { fail(res, e.message); }
});

/** Lister un répertoire */
router.post('/github/list', async (req, res) => {
  const { encryptedToken, owner, repo, path = '', ref = 'main' } = req.body;
  try {
    const gh    = new GitHubZeroClone(safeDecrypt(encryptedToken));
    const files = await gh.listDirectory(owner, repo, path, ref);
    ok(res, { files });
  } catch (e) { fail(res, e.message); }
});

/** Mettre à jour un .env */
router.post('/github/update-env', async (req, res) => {
  const { encryptedToken, owner, repo, vars, path = '.env', branch = 'main' } = req.body;
  try {
    const gh     = new GitHubZeroClone(safeDecrypt(encryptedToken));
    const result = await gh.updateEnvFile({ owner, repo, vars, path, branch });
    ok(res, result);
  } catch (e) { fail(res, e.message); }
});

/** Lancer un déploiement avec SSE (AutoConfig pipeline simple) */
router.post('/deploy/start', async (req, res) => {
  const { encryptedToken, owner, repo, branch = 'main', files = [], workflowId } = req.body;
  const jobId = uuid();
  jobs.set(jobId, { status: 'running', startedAt: Date.now() });

  setImmediate(async () => {
    try {
      const token = safeDecrypt(encryptedToken);
      const gh    = new GitHubZeroClone(token);
      const steps = [
        { label: 'Vérification du dépôt',   fn: () => gh.getRepoInfo(owner, repo) },
        ...files.map(f => ({
          label: `Écriture de ${f.path}`,
          fn   : () => gh.writeFile({ owner, repo, branch, path: f.path, content: f.content,
                                      message: `autoconfig: ${f.path} [job:${jobId.slice(0,8)}]` }),
        })),
        ...(workflowId ? [{ label: `Workflow ${workflowId}`,
            fn: () => gh.triggerWorkflow(owner, repo, workflowId, branch) }] : []),
      ];

      const total = steps.length;
      emit(jobId, { type: 'progress', pct: 0, msg: 'Démarrage…' });
      for (let i = 0; i < total; i++) {
        emit(jobId, { type: 'progress', pct: Math.round((i / total) * 100), msg: steps[i].label, step: i+1, total });
        await steps[i].fn();
      }
      emit(jobId, { type: 'done', pct: 100, msg: '✓ Déploiement terminé !' });
      jobs.set(jobId, { status: 'done' });
    } catch (err) {
      emit(jobId, { type: 'error', msg: err.message });
      jobs.set(jobId, { status: 'error', error: err.message });
    }
  });

  ok(res, { jobId });
});

router.get('/deploy/events/:jobId', sseMiddleware);

// ════════════════════════════════════════════════════════════════
//  [B] INFRAFORGE v1 — OAuth + Setup Full-Stack
// ════════════════════════════════════════════════════════════════

// ── Sessions ─────────────────────────────────────────────────────
router.post('/session/create', (req, res) => {
  const { email, githubToken, supabaseToken, vercelToken, owner, repo } = req.body;
  if (!email) return fail(res, 'email requis');
  const id = uuid();
  sessions.set(id, { email, githubToken, supabaseToken, vercelToken, owner, repo, tokens: {} });
  ok(res, { sessionId: id });
});

router.patch('/session/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return fail(res, 'Session inconnue', 404);
  Object.assign(s, req.body);
  ok(res, { updated: true });
});

router.get('/session/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return fail(res, 'Session inconnue', 404);
  ok(res, { email: s.email, owner: s.owner, repo: s.repo,
            hasGitHub: !!(s.githubToken || s.tokens?.github),
            hasSupabase: !!(s.supabaseToken || s.tokens?.supabase),
            hasVercel: !!(s.vercelToken || s.tokens?.vercel) });
});

// ── OAuth Google ─────────────────────────────────────────────────
router.get('/oauth/google', (req, res) => {
  const redirectUri = `${ENV.BASE_URL}/api/oauth/google/callback`;
  const { url } = getGoogleAuthUrl(redirectUri);
  res.redirect(url);
});

router.get('/oauth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  try {
    const redirectUri = `${ENV.BASE_URL}/api/oauth/google/callback`;
    const user = await exchangeGoogleCode(code, redirectUri, state);
    const sessionId = uuid();
    sessions.set(sessionId, { email: user.email, name: user.name, picture: user.picture, tokens: {} });
    res.redirect(`/?session=${sessionId}&email=${encodeURIComponent(user.email)}`);
  } catch (err) {
    res.redirect(`/?error=${encodeURIComponent(err.message)}`);
  }
});

// ── OAuth GitHub ─────────────────────────────────────────────────
router.get('/oauth/github', (req, res) => {
  const { sessionId } = req.query;
  const s = sessions.get(sessionId);
  if (!s) return fail(res, 'Session invalide');
  const { url } = getGitHubAuthUrl(s.email);
  res.redirect(url);
});

router.get('/oauth/github/callback', async (req, res) => {
  const { code, state } = req.query;
  try {
    const { token, email } = await exchangeGitHubCode(code, state);
    let sessionId = null;
    for (const [id, s] of sessions) {
      if (s.email === email) { s.githubToken = token; sessionId = id; break; }
    }
    if (!sessionId) {
      sessionId = uuid();
      sessions.set(sessionId, { email, githubToken: token, tokens: {} });
    }
    res.redirect(`/?session=${sessionId}&github=connected`);
  } catch (err) {
    res.redirect(`/?error=${encodeURIComponent(err.message)}`);
  }
});

/** Setup Full-Stack v1 (GitHub + Supabase + Vercel) */
router.post('/setup/start', async (req, res) => {
  const { sessionId, projectName, supabaseOrgId, framework, region } = req.body;
  const s = sessions.get(sessionId);
  if (!s) return fail(res, 'Session inconnue');

  const github   = s.githubToken   || s.tokens?.github;
  const supabase = s.supabaseToken || s.tokens?.supabase;
  const vercel   = s.vercelToken   || s.tokens?.vercel;

  if (!github)   return fail(res, 'Token GitHub manquant');
  if (!supabase) return fail(res, 'Token Supabase manquant');
  if (!vercel)   return fail(res, 'Token Vercel manquant');

  const jobId = uuid();
  jobs.set(jobId, { status: 'running', startedAt: Date.now() });

  setImmediate(async () => {
    try {
      const result = await setupFullStack(s.email, { github, supabase, vercel },
        { projectName, supabaseOrgId, framework, region }, jobId);
      jobs.set(jobId, { status: 'done', result });
    } catch (err) {
      jobs.set(jobId, { status: 'error', error: err.message });
      emit(jobId, { type: 'done', success: false, error: err.message });
    }
  });

  ok(res, { jobId });
});

router.get('/setup/events/:jobId', sseMiddleware);
router.get('/setup/result/:jobId', (req, res) => {
  const j = jobs.get(req.params.jobId);
  if (!j) return fail(res, 'Job inconnu', 404);
  ok(res, j);
});

// ════════════════════════════════════════════════════════════════
//  [C] INFRAFORGE v2 — Stack Detection + Master Orchestrator
// ════════════════════════════════════════════════════════════════

/** Détecter le stack d'un repo GitHub */
router.post('/detect', async (req, res) => {
  const { sessionId, owner: bodyOwner, repo: bodyRepo, githubToken: bodyToken } = req.body;

  let token = bodyToken;
  let owner = bodyOwner;
  let repo  = bodyRepo;

  if (sessionId) {
    const s = sessions.get(sessionId);
    if (s) {
      token = token || s.githubToken || s.tokens?.github;
      owner = owner || s.owner;
      repo  = repo  || s.repo;
    }
  }

  if (!token) return fail(res, 'Token GitHub requis');
  if (!owner || !repo) return fail(res, 'owner et repo requis');

  try {
    const det   = new StackDetector(token);
    const stack = await det.identifyStack(owner, repo);
    ok(res, {
      summary  : stack.summary,
      primary  : stack.primary ? {
        id       : stack.primary.id,
        name     : stack.primary.name,
        icon     : stack.primary.icon,
        framework: stack.primary.framework,
        color    : stack.primary.color,
        buildConfig: stack.buildConfig,
      } : null,
      all      : stack.all.map(a => ({ id: a.id, name: a.name, icon: a.icon, framework: a.framework })),
      hasDocker : stack.hasDocker,
      envCount  : stack.envVars.filter(v => !v.isComment).length,
      envVars   : stack.envVars.filter(v => !v.isComment).map(v => v.key),
    });
  } catch (e) { fail(res, e.message); }
});

/** Orchestration complète v2 (Gmail → Stack → Supabase → GitHub → Vercel → Inject) */
router.post('/orchestrate/start', async (req, res) => {
  const { sessionId, projectName, supabaseOrgId, region } = req.body;
  const s = sessions.get(sessionId);
  if (!s) return fail(res, 'Session inconnue');

  const githubToken   = s.githubToken   || s.tokens?.github;
  const supabaseToken = s.supabaseToken || s.tokens?.supabase;
  const vercelToken   = s.vercelToken   || s.tokens?.vercel;

  const missing = [];
  if (!githubToken)   missing.push('GitHub');
  if (!supabaseToken) missing.push('Supabase');
  if (!vercelToken)   missing.push('Vercel');
  if (!s.owner || !s.repo) missing.push('owner/repo');
  if (missing.length) return fail(res, `Tokens manquants: ${missing.join(', ')}`);

  const jobId = uuid();
  jobs.set(jobId, { status: 'running', startedAt: Date.now() });

  setImmediate(async () => {
    try {
      const result = await orchestrateFullStack({
        email: s.email, githubToken, supabaseToken, vercelToken,
        owner: s.owner, repo: s.repo, projectName, supabaseOrgId, region,
      }, jobId);
      jobs.set(jobId, { status: 'done', result });
    } catch (err) {
      jobs.set(jobId, { status: 'error', error: err.message });
      emit(jobId, { type: 'done', success: false, error: err.message });
    }
  });

  ok(res, { jobId });
});

router.get('/orchestrate/events/:jobId', sseMiddleware);
router.get('/orchestrate/result/:jobId', (req, res) => {
  const j = jobs.get(req.params.jobId);
  if (!j) return fail(res, 'Job inconnu', 404);
  ok(res, j);
});

// ════════════════════════════════════════════════════════════════
//  [D] GEMINI AI — Cache · Retry · Rotation de clés
// ════════════════════════════════════════════════════════════════

/**
 * Analyse complète d'un repo via Gemini (cache + retry + rotation)
 * POST /api/gemini/analyze
 * Body: { githubToken, owner, repo, commitSha?, forceRefresh? }
 *       ou { sessionId } si session déjà créée
 */
router.post('/gemini/analyze', async (req, res) => {
  const { sessionId, githubToken: bodyToken, owner: bOwner, repo: bRepo,
          commitSha, forceRefresh = false, supabaseUrl } = req.body;

  let token = bodyToken, owner = bOwner, repo = bRepo;

  if (sessionId) {
    const s = sessions.get(sessionId);
    if (s) {
      token = token || s.githubToken || s.tokens?.github;
      owner = owner || s.owner;
      repo  = repo  || s.repo;
    }
  }

  if (!token) return fail(res, 'githubToken requis');
  if (!owner || !repo) return fail(res, 'owner et repo requis');

  try {
    const result = await analyzeRepo(owner, repo, token, { forceRefresh, commitSha, supabaseUrl });
    ok(res, {
      summary              : result.summary,
      fromCache            : result.fromCache,
      stack                : result.primary
        ? { id: result.primary.id, name: result.primary.name, icon: result.primary.icon, framework: result.primary.framework }
        : null,
      hasDocker            : result.hasDocker,
      envVarsCount         : (result.envVars || []).filter(v => !v.isComment).length,
      geminiAnalysis       : result.geminiAnalysis       || null,
      geminiEnvSuggestions : result.geminiEnvSuggestions || null,
      analyzedAt           : result.analyzedAt,
    });
  } catch (e) { fail(res, e.message); }
});

/**
 * Analyse rapide (cache uniquement, pas d'appel Gemini)
 * POST /api/gemini/quick
 */
router.post('/gemini/quick', async (req, res) => {
  const { githubToken, owner, repo } = req.body;
  if (!githubToken || !owner || !repo) return fail(res, 'githubToken, owner et repo requis');
  try {
    const result = await quickAnalyze(owner, repo, githubToken);
    ok(res, { summary: result.summary, fromCache: result.fromCache, stack: result.primary });
  } catch (e) { fail(res, e.message); }
});

/**
 * Invalider le cache d'un repo (ex: après un push)
 * DELETE /api/gemini/cache/:owner/:repo
 */
router.delete('/gemini/cache/:owner/:repo', (req, res) => {
  const count = geminiCache.invalidate(req.params.owner, req.params.repo);
  ok(res, { invalidated: count, repo: `${req.params.owner}/${req.params.repo}` });
});

/** Statistiques du cache Gemini */
router.get('/gemini/cache/stats', (_, res) => {
  ok(res, { stats: geminiCache.stats(), entries: geminiCache.list() });
});

/** Vider entièrement le cache */
router.delete('/gemini/cache', (_, res) => {
  geminiCache.clear();
  ok(res, { cleared: true });
});

/** Statut des clés Gemini (rotation) */
router.get('/gemini/keys/status', (_, res) => {
  ok(res, {
    totalKeys : rotator.totalKeys,
    keys      : rotator.status(),
  });
});

// ════════════════════════════════════════════════════════════════
//  [E] LLM ROUTER — Gemini + Groq + Mistral + Cohere + HuggingFace
// ════════════════════════════════════════════════════════════════

/** Statut temps réel de tous les providers LLM */
router.get('/llm/status', (_, res) => {
  ok(res, getRouterStatus());
});

/**
 * Envoyer un prompt au meilleur provider disponible
 * POST /api/llm/prompt
 * Body: { prompt, preferProvider?, maxTokens?, temperature?, jsonMode? }
 */
router.post('/llm/prompt', async (req, res) => {
  const { prompt, preferProvider, maxTokens, temperature, jsonMode, cacheKey } = req.body;
  if (!prompt) return fail(res, 'prompt requis');
  try {
    const result = await routePrompt(prompt, { preferProvider, maxTokens, temperature, jsonMode, cacheKey });
    ok(res, result);
  } catch (e) { fail(res, e.message); }
});

/**
 * Analyser un repo GitHub avec le meilleur LLM disponible
 * POST /api/llm/analyze-repo
 * Body: { githubToken, owner, repo }
 */
router.post('/llm/analyze-repo', async (req, res) => {
  const { sessionId, githubToken: bodyToken, owner: bOwner, repo: bRepo } = req.body;
  let token = bodyToken, owner = bOwner, repo = bRepo;
  if (sessionId) {
    const s = sessions.get(sessionId);
    if (s) { token = token || s.githubToken; owner = owner || s.owner; repo = repo || s.repo; }
  }
  if (!token || !owner || !repo) return fail(res, 'githubToken, owner et repo requis');
  try {
    // Détection du stack (Octokit — gratuit)
    const { StackDetector } = require('../services/stack-detector');
    const det       = new StackDetector(token);
    const stackInfo = await det.identifyStack(owner, repo);
    // Analyse via le meilleur LLM disponible
    const analysis  = await analyzeRepoWithLLM(owner, repo, stackInfo);
    ok(res, {
      stack    : { summary: stackInfo.summary, primary: stackInfo.primary, hasDocker: stackInfo.hasDocker },
      analysis,
      provider : analysis._provider,
      fromCache: analysis._fromCache || false,
    });
  } catch (e) { fail(res, e.message); }
});

module.exports = router;
module.exports._sessions = sessions; // exposé pour les tests
module.exports._jobs     = jobs;
