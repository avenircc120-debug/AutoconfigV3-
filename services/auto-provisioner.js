/**
 * ═══════════════════════════════════════════════════════════════════
 *  services/auto-provisioner.js
 *  AUTO-CRÉATION DE COMPTES & INJECTION DYNAMIQUE
 *  ─────────────────────────────────────────────
 *  · Supabase: createProject() → récupère URL + keys automatiquement
 *  · Vercel:   createProject() → injecte les env vars détectées + keys Supabase
 *  · Dynamic env injection depuis .env.example analysé par identifyStack()
 * ═══════════════════════════════════════════════════════════════════
 */

const axios  = require('axios');
const logger = require('../utils/logger');

// ── Supabase Management API ─────────────────────────────────────
const SUPA_API = 'https://api.supabase.com/v1';

class SupabaseProvisioner {
  constructor(token) {
    this.http = axios.create({
      baseURL : SUPA_API,
      headers : { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout : 30_000,
    });
  }

  async getOrganizations() {
    const { data } = await this.http.get('/organizations');
    return data;
  }

  /**
   * Auto-création d'un projet Supabase complet
   * Retourne les clés sans aucune intervention manuelle
   */
  async provision(name, orgId, dbPassword, region = 'eu-west-1', onStatus) {
    logger.info(`[Supabase] Provisioning "${name}"…`);

    // Déduplique si existe
    const { data: projects } = await this.http.get('/projects');
    const existing = projects.find(p => p.name === name);
    if (existing) {
      logger.warn(`[Supabase] Projet existant "${name}" → récupération des clés`);
      return this.#fetchKeys(existing.id, onStatus);
    }

    if (onStatus) onStatus('CREATING');
    const { data: proj } = await this.http.post('/projects', {
      name,
      organization_id : orgId,
      db_pass         : dbPassword,
      region,
      plan            : 'free',
    });

    if (onStatus) onStatus('COMING_UP');
    await this.#waitReady(proj.id, onStatus);
    return this.#fetchKeys(proj.id, onStatus);
  }

  async #waitReady(ref, onStatus) {
    const deadline = Date.now() + 3 * 60_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 4000));
      const { data } = await this.http.get(`/projects/${ref}`);
      if (onStatus) onStatus(data.status);
      if (data.status === 'ACTIVE_HEALTHY') return;
      if (['INACTIVE','REMOVED'].includes(data.status)) throw new Error(`Supabase: état inattendu ${data.status}`);
    }
    throw new Error('Supabase: timeout initialisation (3min)');
  }

  async #fetchKeys(ref, onStatus) {
    if (onStatus) onStatus('FETCHING_KEYS');
    const [{ data: proj }, { data: keys }] = await Promise.all([
      this.http.get(`/projects/${ref}`),
      this.http.get(`/projects/${ref}/api-keys`),
    ]);
    const anon    = keys.find(k => k.name === 'anon')?.api_key          || '';
    const service = keys.find(k => k.name === 'service_role')?.api_key  || '';
    const url     = `https://${ref}.supabase.co`;
    logger.info(`[Supabase] ✓ Clés récupérées pour ${ref}`);
    return {
      projectRef   : ref,
      url, anon, service,
      dbUrl        : `postgresql://postgres@db.${ref}.supabase.co:5432/postgres`,
      dashboard    : `https://app.supabase.com/project/${ref}`,
    };
  }
}

// ── Vercel Provisioner ──────────────────────────────────────────
const VERCEL_API = 'https://api.vercel.com';

class VercelProvisioner {
  constructor(token, teamId) {
    this.http = axios.create({
      baseURL : VERCEL_API,
      headers : { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout : 30_000,
    });
    if (teamId) {
      this.http.interceptors.request.use(c => {
        c.params = { ...(c.params || {}), teamId };
        return c;
      });
    }
  }

  async provision(name, framework) {
    logger.info(`[Vercel] Provisioning "${name}"…`);
    try {
      const { data } = await this.http.get(`/v9/projects/${name}`);
      logger.warn(`[Vercel] Projet existant "${name}" → réutilisation`);
      return { projectId: data.id, name: data.name, url: `https://${data.name}.vercel.app` };
    } catch (e) { if (e.response?.status !== 404) throw e; }

    const body = { name, ...(framework ? { framework } : {}) };
    const { data } = await this.http.post('/v10/projects', body);
    logger.info(`[Vercel] ✓ Projet créé: ${data.id}`);
    return { projectId: data.id, name: data.name, url: `https://${data.name}.vercel.app` };
  }

  async linkGitHub(projectId, owner, repo, branch = 'main') {
    logger.info(`[Vercel] Liaison GitHub ${owner}/${repo}`);
    await this.http.patch(`/v9/projects/${projectId}`, {
      link: { type: 'github', repo: `${owner}/${repo}`, productionBranch: branch },
    });
    logger.info(`[Vercel] ✓ Repo lié`);
  }

  /**
   * Injection dynamique de variables d'environnement
   * Combine : variables du .env.example + clés Supabase provisionnées
   *
   * @param {string} projectId
   * @param {Array}  detectedVars   - variables depuis .env.example (StackDetector)
   * @param {object} supabaseKeys   - clés retournées par SupabaseProvisioner
   * @param {object} extra          - autres clés à injecter
   */
  async injectEnvVars(projectId, detectedVars = [], supabaseKeys = null, extra = {}) {
    logger.info(`[Vercel] Injection dynamique des variables d'environnement…`);

    // 1. Variables extraites du .env.example
    const envMap = {};
    for (const v of detectedVars) {
      if (!v.isComment && v.key) envMap[v.key] = v.value || '';
    }

    // 2. Écraser/ajouter avec les vraies clés Supabase provisionnées
    if (supabaseKeys) {
      envMap['NEXT_PUBLIC_SUPABASE_URL']      = supabaseKeys.url;
      envMap['SUPABASE_URL']                  = supabaseKeys.url;
      envMap['NEXT_PUBLIC_SUPABASE_ANON_KEY'] = supabaseKeys.anon;
      envMap['SUPABASE_ANON_KEY']             = supabaseKeys.anon;
      envMap['SUPABASE_SERVICE_ROLE_KEY']     = supabaseKeys.service;
      envMap['DATABASE_URL']                  = supabaseKeys.dbUrl;
      envMap['SUPABASE_PROJECT_REF']          = supabaseKeys.projectRef;
    }

    // 3. Variables supplémentaires (tokens, clés API tierces…)
    Object.assign(envMap, extra);

    // 4. Construire le payload Vercel
    const targets = ['production', 'preview', 'development'];
    const payload = Object.entries(envMap)
      .filter(([k]) => k && !k.startsWith('#'))
      .map(([key, value]) => ({ key, value: value || '', target: targets, type: 'plain' }));

    if (!payload.length) {
      logger.warn('[Vercel] Aucune variable à injecter');
      return 0;
    }

    await this.http.post(`/v10/projects/${projectId}/env`, payload);
    logger.info(`[Vercel] ✓ ${payload.length} variable(s) injectées dynamiquement`);
    return payload.length;
  }

  async deploy(projectId, owner, repo, ref = 'main', onStatus) {
    logger.info(`[Vercel] Déclenchement du déploiement ${owner}/${repo}@${ref}`);
    const { data } = await this.http.post('/v13/deployments', {
      name    : projectId,
      gitSource: { type: 'github', org: owner, repo, ref },
      target  : 'production',
    });
    if (onStatus) onStatus('BUILDING');

    // Poll
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000));
      const { data: d } = await this.http.get(`/v13/deployments/${data.id}`);
      if (onStatus) onStatus(d.status);
      if (d.status === 'READY') {
        logger.info(`[Vercel] ✓ Déployé: https://${d.url}`);
        return { deployId: data.id, url: `https://${d.url}`, state: 'READY' };
      }
      if (['ERROR','CANCELED'].includes(d.status)) throw new Error(`Vercel build: ${d.status}`);
    }
    throw new Error('Vercel: timeout déploiement (5min)');
  }
}

module.exports = { SupabaseProvisioner, VercelProvisioner };
