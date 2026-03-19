/**
 * ═══════════════════════════════════════════════════════════════
 *  services/vercel-infra.js
 *  Création de projet Vercel + liaison GitHub + déploiement
 *  via l'API REST Vercel v9/v10
 * ═══════════════════════════════════════════════════════════════
 */

const axios  = require('axios');
const logger = require('../utils/logger');

const VERCEL_API = 'https://api.vercel.com';
const POLL_INTERVAL = 5_000;
const DEPLOY_TIMEOUT = 5 * 60_000; // 5 min

class VercelInfra {
  /**
   * @param {string} token  - Vercel API Token (user ou team)
   * @param {string} [teamId] - Optionnel pour les comptes team
   */
  constructor(token, teamId) {
    this.teamId = teamId;
    this.http = axios.create({
      baseURL : VERCEL_API,
      headers : { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout : 30_000,
    });
    // Injecter teamId automatiquement si présent
    this.http.interceptors.request.use(cfg => {
      if (this.teamId && !cfg.params?.teamId) {
        cfg.params = { ...(cfg.params || {}), teamId: this.teamId };
      }
      return cfg;
    });
  }

  // ── Polling déploiement ─────────────────────────────────────
  async #pollDeployment(deploymentId, onProgress) {
    const deadline = Date.now() + DEPLOY_TIMEOUT;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      const { data } = await this.http.get(`/v13/deployments/${deploymentId}`);
      const state = data.status; // QUEUED | BUILDING | READY | ERROR | CANCELED
      logger.debug(`[Vercel] Deploy ${deploymentId}: ${state}`);
      if (onProgress) onProgress(state);
      if (state === 'READY')  return data;
      if (state === 'ERROR' || state === 'CANCELED') {
        throw new Error(`[Vercel] Déploiement échoué: ${state}`);
      }
    }
    throw new Error('[Vercel] Timeout — déploiement non terminé après 5 minutes');
  }

  /**
   * Créer ou récupérer un projet Vercel
   * @param {object} opts
   * @param {string} opts.name         - Nom du projet
   * @param {string} opts.framework    - 'nextjs' | 'react' | 'vite' | null
   * @returns {{ projectId, projectName, url }}
   */
  async createProject({ name, framework = null }) {
    logger.info(`[Vercel] Création du projet "${name}"…`);

    // Vérifier existence
    try {
      const { data } = await this.http.get(`/v9/projects/${name}`);
      logger.warn(`[Vercel] Projet "${name}" déjà existant → réutilisation`);
      return { projectId: data.id, projectName: data.name, url: `https://${data.name}.vercel.app` };
    } catch (e) {
      if (e.response?.status !== 404) throw e;
    }

    const body = { name, ...(framework ? { framework } : {}) };
    const { data } = await this.http.post('/v10/projects', body);

    logger.info(`[Vercel] ✓ Projet créé: ${data.id}`);
    return { projectId: data.id, projectName: data.name, url: `https://${data.name}.vercel.app` };
  }

  /**
   * Lier un repo GitHub au projet Vercel
   */
  async linkGitHubRepo({ projectId, owner, repo, productionBranch = 'main' }) {
    logger.info(`[Vercel] Liaison GitHub: ${owner}/${repo} → projet ${projectId}`);

    await this.http.patch(`/v9/projects/${projectId}`, {
      link: {
        type           : 'github',
        repo           : `${owner}/${repo}`,
        productionBranch,
      },
    });
    logger.info(`[Vercel] ✓ Repo GitHub lié`);
  }

  /**
   * Injecter des variables d'environnement dans Vercel
   * @param {string} projectId
   * @param {Array}  envVars  - [{ key, value, target: ['production','preview','development'] }]
   */
  async setEnvVars(projectId, envVars) {
    logger.info(`[Vercel] Injection de ${envVars.length} variables d'environnement…`);

    const payload = envVars.map(({ key, value, target = ['production', 'preview', 'development'] }) => ({
      key, value, target, type: 'plain',
    }));

    await this.http.post(`/v10/projects/${projectId}/env`, payload);
    logger.info(`[Vercel] ✓ Variables injectées`);
  }

  /**
   * Déclencher un déploiement depuis le repo GitHub lié
   * @param {object} opts
   * @param {string} opts.projectId
   * @param {string} opts.owner     - GitHub owner
   * @param {string} opts.repo
   * @param {string} [opts.ref]     - Branch/tag/sha (défaut: main)
   * @param {function}[opts.onProgress]
   * @returns {{ deployId, url, state }}
   */
  async deployFromGitHub({ projectId, owner, repo, ref = 'main', onProgress }) {
    logger.info(`[Vercel] Déclenchement du déploiement ${owner}/${repo}@${ref}…`);

    const { data } = await this.http.post('/v13/deployments', {
      name    : projectId,
      gitSource: { type: 'github', org: owner, repo, ref },
      target  : 'production',
    });

    logger.info(`[Vercel] ⏳ Build lancé (id: ${data.id})…`);
    if (onProgress) onProgress('BUILDING');

    const final = await this.#pollDeployment(data.id, onProgress);

    logger.info(`[Vercel] ✓ Déployé: https://${final.url}`);
    return {
      deployId : data.id,
      url      : `https://${final.url}`,
      state    : final.status,
      inspectUrl: final.inspectorUrl,
    };
  }

  /**
   * Récupérer le token d'un projet (utile pour le .env)
   */
  async getProjectInfo(projectId) {
    const { data } = await this.http.get(`/v9/projects/${projectId}`);
    return {
      id        : data.id,
      name      : data.name,
      url       : `https://${data.name}.vercel.app`,
      framework : data.framework,
      createdAt : data.createdAt,
    };
  }
}

module.exports = { VercelInfra };
