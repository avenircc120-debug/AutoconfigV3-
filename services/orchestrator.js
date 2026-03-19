/**
 * ═══════════════════════════════════════════════════════════════
 *  services/orchestrator.js
 *  ┌────────────────────────────────────────────────────────┐
 *  │  setupFullStack(email, tokens, options)                │
 *  │  1. Crée le repo GitHub                                │
 *  │  2. Initialise la DB Supabase                          │
 *  │  3. Lie & déploie sur Vercel                           │
 *  │  4. Injecte toutes les clés dans le .env               │
 *  └────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════
 */

const crypto          = require('crypto');
const { GitHubInfra } = require('./github-infra');
const { SupabaseInfra}= require('./supabase-infra');
const { VercelInfra } = require('./vercel-infra');
const { emit }        = require('../utils/sse');
const logger          = require('../utils/logger');

/**
 * Slugifie un email en nom de projet valide
 * ex: john.doe@gmail.com → john-doe-abc123
 */
function slugify(email) {
  const base = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const rand = crypto.randomBytes(3).toString('hex');
  return `${base}-${rand}`.slice(0, 38); // GitHub limit: 100, Vercel: 52
}

/**
 * Génère un mot de passe DB solide
 */
function genDbPassword() {
  return crypto.randomBytes(16).toString('base64url').slice(0, 22) + 'Aa1!';
}

/**
 * Émetteur SSE centralisé pour le pipeline
 */
function progress(jobId, service, pct, msg, status = 'running') {
  emit(jobId, { type: 'service-progress', service, pct, msg, status });
  logger.info(`[${service}] (${pct}%) ${msg}`);
}

/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║  FONCTION PRINCIPALE : setupFullStack                   ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * @param {string} email              - Email Google de l'utilisateur
 * @param {object} tokens
 * @param {string} tokens.github      - GitHub OAuth token
 * @param {string} tokens.supabase    - Supabase Management API token
 * @param {string} tokens.vercel      - Vercel API token
 * @param {object} options
 * @param {string} [options.projectName]  - Nom custom (défaut: slugifié depuis email)
 * @param {string} [options.supabaseOrgId]- ID org Supabase
 * @param {string} [options.framework]    - Framework Vercel (nextjs, vite…)
 * @param {string} [options.region]       - Région Supabase
 * @param {string} jobId                  - ID du job SSE
 * @returns {Promise<ProvisionResult>}
 */
async function setupFullStack(email, tokens, options = {}, jobId) {
  const projectName = options.projectName || slugify(email);
  const dbPassword  = genDbPassword();

  logger.sep();
  logger.info(`[Orchestrator] 🚀 setupFullStack("${email}") → "${projectName}"`);
  logger.sep();

  const result = {
    projectName,
    email,
    github   : null,
    supabase : null,
    vercel   : null,
    envFile  : '',
    errors   : [],
  };

  // ── ÉTAPE 1 : GitHub ───────────────────────────────────────
  progress(jobId, 'github', 5, 'Connexion à GitHub…');
  try {
    const gh   = new GitHubInfra(tokens.github);
    const user = await gh.getUser();

    progress(jobId, 'github', 30, `Création du repo "${projectName}"…`);
    const repo = await gh.createRepo({
      name       : projectName,
      description: `Projet InfraForge pour ${email}`,
      isPrivate  : false,
    });

    progress(jobId, 'github', 70, 'Écriture du fichier de base…');

    // Pousser un README initial
    await gh.writeFile({
      owner  : repo.owner,
      repo   : repo.repoName,
      path   : 'README.md',
      content: `# ${projectName}\n\nProjet configuré automatiquement par [InfraForge](https://github.com/infraforge).\n\n> Email: ${email}`,
      message: 'feat: initial setup by InfraForge',
    });

    result.github = { ...repo };
    progress(jobId, 'github', 100, `✓ Repo prêt: ${repo.htmlUrl}`, 'done');

  } catch (err) {
    logger.error(`[Orchestrator] GitHub ERROR: ${err.message}`);
    result.errors.push({ service: 'github', message: err.message });
    progress(jobId, 'github', 100, `✗ Erreur: ${err.message}`, 'error');
  }

  // ── ÉTAPE 2 : Supabase ─────────────────────────────────────
  progress(jobId, 'supabase', 5, 'Connexion à Supabase…');
  try {
    const supa = new SupabaseInfra(tokens.supabase);

    // Récupérer l'org ID si non fourni
    let orgId = options.supabaseOrgId;
    if (!orgId) {
      progress(jobId, 'supabase', 15, 'Récupération des organisations…');
      const orgs = await supa.listOrganizations();
      if (!orgs.length) throw new Error('Aucune organisation Supabase trouvée');
      orgId = orgs[0].id;
    }

    progress(jobId, 'supabase', 30, `Création du projet "${projectName}"…`);
    const project = await supa.createProject({
      name     : projectName,
      orgId,
      dbPassword,
      region   : options.region || 'eu-west-1',
      onProgress: (status) => {
        const pct = status === 'ACTIVE_HEALTHY' ? 90 : 60;
        progress(jobId, 'supabase', pct, `Initialisation DB (${status})…`);
      },
    });

    result.supabase = { ...project, dbPassword };
    progress(jobId, 'supabase', 100, `✓ DB prête: ${project.url}`, 'done');

  } catch (err) {
    logger.error(`[Orchestrator] Supabase ERROR: ${err.message}`);
    result.errors.push({ service: 'supabase', message: err.message });
    progress(jobId, 'supabase', 100, `✗ Erreur: ${err.message}`, 'error');
  }

  // ── ÉTAPE 3 : Vercel ───────────────────────────────────────
  progress(jobId, 'vercel', 5, 'Connexion à Vercel…');
  try {
    const vc = new VercelInfra(tokens.vercel);

    progress(jobId, 'vercel', 20, `Création du projet "${projectName}"…`);
    const vcProject = await vc.createProject({
      name     : projectName,
      framework: options.framework || null,
    });

    // Lier le repo GitHub si disponible
    if (result.github && result.github.owner) {
      progress(jobId, 'vercel', 40, 'Liaison du repo GitHub…');
      await vc.linkGitHubRepo({
        projectId      : vcProject.projectId,
        owner          : result.github.owner,
        repo           : result.github.repoName,
        productionBranch: result.github.defaultBranch || 'main',
      });
    }

    // ── SECRET PROVISIONING ───────────────────────────────
    // Injecter automatiquement les clés Supabase dans Vercel
    if (result.supabase) {
      progress(jobId, 'vercel', 60, 'Injection des secrets Supabase dans Vercel…');
      await vc.setEnvVars(vcProject.projectId, [
        { key: 'NEXT_PUBLIC_SUPABASE_URL',       value: result.supabase.url },
        { key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',  value: result.supabase.anonKey },
        { key: 'SUPABASE_SERVICE_ROLE_KEY',       value: result.supabase.serviceKey },
        { key: 'DATABASE_URL',                    value: result.supabase.dbUrl },
      ]);
    }

    // Déployer depuis GitHub
    if (result.github) {
      progress(jobId, 'vercel', 70, 'Déclenchement du déploiement…');
      const deployment = await vc.deployFromGitHub({
        projectId : vcProject.projectId,
        owner     : result.github.owner,
        repo      : result.github.repoName,
        ref       : result.github.defaultBranch || 'main',
        onProgress: (state) => {
          const pct = state === 'READY' ? 95 : 80;
          progress(jobId, 'vercel', pct, `Build ${state}…`);
        },
      });
      result.vercel = { ...vcProject, deployment };
    } else {
      result.vercel = vcProject;
    }

    progress(jobId, 'vercel', 100, `✓ Live: ${result.vercel.deployment?.url || vcProject.url}`, 'done');

  } catch (err) {
    logger.error(`[Orchestrator] Vercel ERROR: ${err.message}`);
    result.errors.push({ service: 'vercel', message: err.message });
    progress(jobId, 'vercel', 100, `✗ Erreur: ${err.message}`, 'error');
  }

  // ── ÉTAPE 4 : Génération du .env ───────────────────────────
  progress(jobId, 'env', 50, 'Génération du fichier .env…');
  result.envFile = buildEnvFile(result);

  // Pousser le .env dans le repo GitHub
  if (result.github) {
    try {
      const gh = new GitHubInfra(tokens.github);
      await gh.writeFile({
        owner  : result.github.owner,
        repo   : result.github.repoName,
        path   : '.env.example',          // .env.example (pas .env — sécurité)
        content: result.envFile,
        message: 'chore: inject provisioned secrets into .env.example',
      });
      progress(jobId, 'env', 100, '✓ .env.example poussé sur GitHub', 'done');
    } catch (err) {
      progress(jobId, 'env', 100, `⚠ .env généré localement (GitHub write échoué)`, 'warn');
    }
  }

  // ── RÉSUMÉ FINAL ──────────────────────────────────────────
  const success = result.errors.length === 0;
  emit(jobId, {
    type   : 'done',
    success,
    result : summarize(result),
    envFile: result.envFile,
  });
  logger.sep();
  logger.info(`[Orchestrator] ${success ? '✅' : '⚠️'} setupFullStack terminé — ${result.errors.length} erreur(s)`);

  return result;
}

/**
 * Construit le fichier .env avec toutes les clés provisionnées
 */
function buildEnvFile(result) {
  const lines = [
    `# ═══════════════════════════════════════════════════`,
    `# InfraForge — Variables provisionnées automatiquement`,
    `# Projet : ${result.projectName}`,
    `# Email  : ${result.email}`,
    `# Généré : ${new Date().toISOString()}`,
    `# ═══════════════════════════════════════════════════`,
    '',
    '# ── GitHub ──────────────────────────────────────────',
    `GITHUB_REPO_URL=${result.github?.cloneUrl || ''}`,
    `GITHUB_HTML_URL=${result.github?.htmlUrl  || ''}`,
    `GITHUB_OWNER=${result.github?.owner       || ''}`,
    `GITHUB_REPO=${result.github?.repoName     || ''}`,
    '',
    '# ── Supabase ─────────────────────────────────────────',
    `NEXT_PUBLIC_SUPABASE_URL=${result.supabase?.url      || ''}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${result.supabase?.anonKey  || ''}`,
    `SUPABASE_SERVICE_ROLE_KEY=${result.supabase?.serviceKey || ''}`,
    `DATABASE_URL=${result.supabase?.dbUrl     || ''}`,
    `SUPABASE_PROJECT_REF=${result.supabase?.projectRef || ''}`,
    '',
    '# ── Vercel ───────────────────────────────────────────',
    `VERCEL_PROJECT_ID=${result.vercel?.projectId || ''}`,
    `VERCEL_DEPLOY_URL=${result.vercel?.deployment?.url || result.vercel?.url || ''}`,
    '',
    '# ── App ──────────────────────────────────────────────',
    `NODE_ENV=production`,
    `PORT=3000`,
  ];
  return lines.join('\n');
}

/**
 * Résumé lisible pour le frontend
 */
function summarize(r) {
  return {
    projectName : r.projectName,
    email       : r.email,
    github      : r.github ? { url: r.github.htmlUrl, repo: r.github.fullName } : null,
    supabase    : r.supabase ? { url: r.supabase.url, dashboard: r.supabase.dashboard } : null,
    vercel      : r.vercel ? { url: r.vercel.deployment?.url || r.vercel.url } : null,
    errors      : r.errors,
  };
}

module.exports = { setupFullStack };
