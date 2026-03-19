/**
 * ═══════════════════════════════════════════════════════════════════
 *  services/master-orchestrator.js
 *  ┌──────────────────────────────────────────────────────────────┐
 *  │  SÉQUENCE COMPLÈTE :                                         │
 *  │  Gmail ➔ Détection Stack ➔ DB Supabase ➔ GitHub ➔ Vercel   │
 *  └──────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════
 */

const crypto                              = require('crypto');
const { Octokit }                         = require('@octokit/rest');
const { StackDetector }                   = require('./stack-detector');
const { SupabaseProvisioner,
        VercelProvisioner }               = require('./auto-provisioner');
const { emit }                            = require('../utils/sse');
const logger                              = require('../utils/logger');

// ── Helpers ─────────────────────────────────────────────────────
const sleep   = ms => new Promise(r => setTimeout(r, ms));
const slugify = email =>
  email.split('@')[0].replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 28)
  + '-' + crypto.randomBytes(3).toString('hex');

const genPass = () => crypto.randomBytes(16).toString('base64url').slice(0, 20) + 'Aa1!';

/**
 * Émet un événement SSE + log console centralisé
 */
function pulse(jobId, phase, pct, msg, status = 'running', data = {}) {
  emit(jobId, { type: 'phase', phase, pct, msg, status, ...data });
  const prefix = { running:'▶', done:'✓', error:'✗', warn:'⚠' }[status] || '·';
  logger.info(`[${phase.toUpperCase()}] ${prefix} (${pct}%) ${msg}`);
}

// ── PHASES ─────────────────────────────────────────────────────
const PHASES = ['detect', 'supabase', 'github', 'vercel', 'inject', 'done'];

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  orchestrateFullStack(input, jobId)                         ║
 * ║                                                             ║
 * ║  input.email          → Gmail de l'utilisateur             ║
 * ║  input.githubToken    → OAuth GitHub token                  ║
 * ║  input.supabaseToken  → Supabase Management token           ║
 * ║  input.vercelToken    → Vercel API token                    ║
 * ║  input.owner          → GitHub owner (user ou org)          ║
 * ║  input.repo           → Nom du repo à analyser              ║
 * ║  input.projectName    → Override nom projet (optionnel)     ║
 * ║  input.region         → Région Supabase (défaut: eu-west-1) ║
 * ╚══════════════════════════════════════════════════════════════╝
 */
async function orchestrateFullStack(input, jobId) {
  const {
    email,
    githubToken,
    supabaseToken,
    vercelToken,
    owner,
    repo,
    projectName : forcedName,
    region      = 'eu-west-1',
    supabaseOrgId,
  } = input;

  const projectName = forcedName || slugify(email);
  const dbPassword  = genPass();

  logger.sep();
  logger.info(`[Orchestrator] 🚀 orchestrateFullStack("${email}") → "${projectName}"`);
  logger.sep();

  const result = {
    projectName, email,
    stack    : null,
    supabase : null,
    github   : null,
    vercel   : null,
    envFile  : '',
    envVarsInjected: 0,
    errors   : [],
    phases   : {},
  };

  // ════════════════════════════════════════════════════════════
  //  PHASE 1 — DÉTECTION DU STACK
  // ════════════════════════════════════════════════════════════
  pulse(jobId, 'detect', 5, `Analyse du dépôt ${owner}/${repo}…`);
  try {
    const detector = new StackDetector(githubToken);
    const stack    = await detector.identifyStack(owner, repo);

    result.stack = stack;
    result.phases.detect = 'done';

    const detail = stack.primary
      ? `${stack.summary} · ${stack.envVars.filter(v => !v.isComment).length} var(s) .env détectées`
      : 'Stack non reconnu — configuration générique';

    pulse(jobId, 'detect', 100, detail, 'done', {
      stackIcon    : stack.primary?.icon || '❓',
      stackName    : stack.primary?.name || 'Inconnu',
      framework    : stack.primary?.framework || null,
      hasDocker    : stack.hasDocker,
      envVarsCount : stack.envVars.filter(v => !v.isComment).length,
    });

  } catch (err) {
    result.errors.push({ phase: 'detect', msg: err.message });
    result.phases.detect = 'error';
    pulse(jobId, 'detect', 100, `Erreur détection: ${err.message}`, 'error');
    // Non bloquant — on continue avec un stack vide
    result.stack = { primary: null, all: [], envVars: [], hasDocker: false };
  }

  // ════════════════════════════════════════════════════════════
  //  PHASE 2 — SUPABASE AUTO-PROVISIONING
  // ════════════════════════════════════════════════════════════
  pulse(jobId, 'supabase', 5, 'Connexion à Supabase Management API…');
  try {
    const supa = new SupabaseProvisioner(supabaseToken);

    let orgId = supabaseOrgId;
    if (!orgId) {
      pulse(jobId, 'supabase', 15, 'Récupération des organisations…');
      const orgs = await supa.getOrganizations();
      if (!orgs.length) throw new Error('Aucune organisation Supabase trouvée');
      orgId = orgs[0].id;
      pulse(jobId, 'supabase', 20, `Organisation sélectionnée: ${orgs[0].name}`);
    }

    pulse(jobId, 'supabase', 25, `Création du projet "${projectName}"…`);
    const keys = await supa.provision(projectName, orgId, dbPassword, region, (status) => {
      const msgs = {
        CREATING      : 'Compte Supabase créé… démarrage du cluster',
        COMING_UP     : 'Cluster PostgreSQL en cours d\'initialisation…',
        ACTIVE_HEALTHY: 'Base de données opérationnelle !',
        FETCHING_KEYS : 'Récupération automatique des clés API…',
      };
      const pct = { CREATING:35, COMING_UP:55, ACTIVE_HEALTHY:80, FETCHING_KEYS:90 }[status] || 60;
      pulse(jobId, 'supabase', pct, msgs[status] || status);
    });

    result.supabase = keys;
    result.phases.supabase = 'done';
    pulse(jobId, 'supabase', 100, `✓ DB prête · ${keys.url}`, 'done', {
      supabaseUrl      : keys.url,
      supabaseRef      : keys.projectRef,
      supabaseDashboard: keys.dashboard,
    });

  } catch (err) {
    result.errors.push({ phase: 'supabase', msg: err.message });
    result.phases.supabase = 'error';
    pulse(jobId, 'supabase', 100, `✗ ${err.message}`, 'error');
  }

  // ════════════════════════════════════════════════════════════
  //  PHASE 3 — GITHUB (liaison / création repo si nécessaire)
  // ════════════════════════════════════════════════════════════
  pulse(jobId, 'github', 10, `Connexion au repo ${owner}/${repo}…`);
  try {
    const octokit = new Octokit({ auth: githubToken, userAgent: 'AutoConfig-Ultimate/3.1 (https://github.com/autoconfig)' });
    const { data: repoData } = await octokit.repos.get({ owner, repo });

    result.github = {
      owner,
      repoName     : repoData.name,
      fullName     : repoData.full_name,
      htmlUrl      : repoData.html_url,
      cloneUrl     : repoData.clone_url,
      defaultBranch: repoData.default_branch,
    };
    result.phases.github = 'done';
    pulse(jobId, 'github', 100, `✓ Repo confirmé: ${repoData.full_name}`, 'done', {
      repoUrl: repoData.html_url,
    });

  } catch (err) {
    result.errors.push({ phase: 'github', msg: err.message });
    result.phases.github = 'error';
    pulse(jobId, 'github', 100, `✗ ${err.message}`, 'error');
  }

  // ════════════════════════════════════════════════════════════
  //  PHASE 4 — VERCEL : Création + Liaison GitHub
  // ════════════════════════════════════════════════════════════
  pulse(jobId, 'vercel', 5, 'Provisioning Vercel…');
  try {
    const vc = new VercelProvisioner(vercelToken);

    // Déterminer le framework Vercel depuis le stack détecté
    const frameworkMap = {
      'Next.js'  : 'nextjs',  'Nuxt.js'  : 'nuxtjs',
      'Remix'    : 'remix',   'SvelteKit': 'svelte',
      'Vite'     : 'vite',    'Gatsby'   : 'gatsby',
      'Astro'    : 'astro',   'Angular'  : 'angular',
    };
    const vcFramework = frameworkMap[result.stack?.primary?.framework] || null;

    pulse(jobId, 'vercel', 20, `Création du projet Vercel "${projectName}"…`);
    const vcProject = await vc.provision(projectName, vcFramework);

    // Liaison GitHub
    if (result.github) {
      pulse(jobId, 'vercel', 45, `Liaison du repo ${result.github.fullName}…`);
      await vc.linkGitHub(
        vcProject.projectId,
        result.github.owner,
        result.github.repoName,
        result.github.defaultBranch || 'main',
      );
    }

    result.vercel = vcProject;
    result.phases.vercel = 'done';
    pulse(jobId, 'vercel', 60, `✓ Projet Vercel créé`, 'done', {
      vercelUrl: vcProject.url,
      projectId: vcProject.projectId,
    });

  } catch (err) {
    result.errors.push({ phase: 'vercel', msg: err.message });
    result.phases.vercel = 'error';
    pulse(jobId, 'vercel', 100, `✗ ${err.message}`, 'error');
  }

  // ════════════════════════════════════════════════════════════
  //  PHASE 5 — INJECTION DYNAMIQUE des variables
  // ════════════════════════════════════════════════════════════
  pulse(jobId, 'inject', 10, 'Injection dynamique des secrets…');
  try {
    if (!result.vercel) throw new Error('Projet Vercel non disponible');

    const vc           = new VercelProvisioner(vercelToken);
    const detectedVars = result.stack?.envVars || [];

    pulse(jobId, 'inject', 30,
      `${detectedVars.filter(v => !v.isComment).length} variable(s) extraites du .env.example…`);

    const count = await vc.injectEnvVars(
      result.vercel.projectId,
      detectedVars,
      result.supabase,
      { NODE_ENV: 'production' },
    );

    result.envVarsInjected = count;
    result.envFile = buildEnvFile(result);

    // Pousser le .env.example dans le repo GitHub
    if (result.github) {
      pulse(jobId, 'inject', 70, 'Écriture du .env.generated sur GitHub…');
      const octokit = new Octokit({ auth: githubToken, userAgent: 'AutoConfig-Ultimate/3.1 (https://github.com/autoconfig)' });
      await writeGitHubFile(octokit, result.github, '.env.generated',
        result.envFile, 'chore: inject provisioned secrets [InfraForge]');
    }

    result.phases.inject = 'done';
    pulse(jobId, 'inject', 100,
      `✓ ${count} clés injectées dans Vercel + .env.generated poussé`, 'done', {
      envVarsCount: count,
    });

  } catch (err) {
    result.errors.push({ phase: 'inject', msg: err.message });
    result.phases.inject = 'error';
    pulse(jobId, 'inject', 100, `✗ ${err.message}`, 'error');
    // Générer le .env quand même
    result.envFile = buildEnvFile(result);
  }

  // ════════════════════════════════════════════════════════════
  //  DÉPLOIEMENT FINAL (si tout est en place)
  // ════════════════════════════════════════════════════════════
  if (result.vercel && result.github && result.phases.vercel === 'done') {
    pulse(jobId, 'deploy', 10, 'Déclenchement du déploiement Vercel…');
    try {
      const vc = new VercelProvisioner(vercelToken);
      const deployment = await vc.deploy(
        result.vercel.projectId,
        result.github.owner,
        result.github.repoName,
        result.github.defaultBranch || 'main',
        (state) => {
          const pct = state === 'READY' ? 95 : 60;
          pulse(jobId, 'deploy', pct, `Build Vercel: ${state}…`);
        },
      );
      result.vercel.deployment = deployment;
      pulse(jobId, 'deploy', 100, `✓ Live: ${deployment.url}`, 'done', {
        deployUrl: deployment.url,
      });
    } catch (err) {
      pulse(jobId, 'deploy', 100, `⚠ Déploiement: ${err.message}`, 'warn');
    }
  }

  // ── Résumé final ─────────────────────────────────────────
  const success = result.errors.filter(e => ['supabase','vercel','inject'].includes(e.phase)).length === 0;
  emit(jobId, { type: 'done', success, summary: summarize(result), envFile: result.envFile });
  logger.sep();
  logger.info(`[Orchestrator] ${success ? '✅' : '⚠️'} Terminé — ${result.errors.length} erreur(s)`);

  return result;
}

// ── Utils ───────────────────────────────────────────────────────

async function writeGitHubFile(octokit, ghInfo, path, content, message) {
  let sha;
  try {
    const { data } = await octokit.repos.getContent({
      owner: ghInfo.owner, repo: ghInfo.repoName, path,
    });
    sha = data.sha;
  } catch {}
  await octokit.repos.createOrUpdateFileContents({
    owner: ghInfo.owner, repo: ghInfo.repoName, path,
    message, branch: ghInfo.defaultBranch || 'main',
    content: Buffer.from(content).toString('base64'),
    ...(sha ? { sha } : {}),
  });
}

function buildEnvFile(r) {
  const stack = r.stack?.primary;
  return [
    `# ════════════════════════════════════════════════════`,
    `# InfraForge v2 — Secrets auto-provisionnés`,
    `# Projet   : ${r.projectName}`,
    `# Email    : ${r.email}`,
    `# Stack    : ${r.stack?.summary || 'inconnu'}`,
    `# Généré   : ${new Date().toISOString()}`,
    `# ════════════════════════════════════════════════════`,
    '',
    ...(stack ? [`# ── ${stack.icon} ${stack.name} ──`, ...(stack.envTemplate || []), ''] : []),
    '# ── GitHub ──────────────────────────────────────────',
    `GITHUB_REPO=${r.github?.fullName || ''}`,
    `GITHUB_URL=${r.github?.htmlUrl   || ''}`,
    '',
    '# ── Supabase ─────────────────────────────────────────',
    `NEXT_PUBLIC_SUPABASE_URL=${r.supabase?.url      || ''}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${r.supabase?.anon  || ''}`,
    `SUPABASE_SERVICE_ROLE_KEY=${r.supabase?.service || ''}`,
    `DATABASE_URL=${r.supabase?.dbUrl     || ''}`,
    `SUPABASE_PROJECT_REF=${r.supabase?.projectRef || ''}`,
    '',
    '# ── Vercel ───────────────────────────────────────────',
    `VERCEL_PROJECT_ID=${r.vercel?.projectId || ''}`,
    `VERCEL_URL=${r.vercel?.deployment?.url || r.vercel?.url || ''}`,
    '',
    '# ── App ──────────────────────────────────────────────',
    'NODE_ENV=production',
    'PORT=3000',
  ].join('\n');
}

function summarize(r) {
  return {
    projectName  : r.projectName,
    stack        : r.stack?.summary,
    envVarsCount : r.envVarsInjected,
    github       : r.github ? { url: r.github.htmlUrl, repo: r.github.fullName } : null,
    supabase     : r.supabase ? { url: r.supabase.url, dashboard: r.supabase.dashboard } : null,
    vercel       : r.vercel ? { url: r.vercel.deployment?.url || r.vercel.url } : null,
    errors       : r.errors,
  };
}

module.exports = { orchestrateFullStack };
