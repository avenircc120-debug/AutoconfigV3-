/**
 * ═══════════════════════════════════════════════════════════════
 *  services/supabase-infra.js
 *  Création automatique d'un projet Supabase via Management API
 *  + récupération des clés (URL, anon key, service_role key)
 * ═══════════════════════════════════════════════════════════════
 */

const axios  = require('axios');
const logger = require('../utils/logger');

const SUPA_API = 'https://api.supabase.com/v1';

// Délai entre les polls de statut (ms)
const POLL_INTERVAL = 4_000;
const POLL_TIMEOUT  = 3 * 60_000; // 3 min max

class SupabaseInfra {
  /**
   * @param {string} accessToken  - Supabase Personal Access Token (Management API)
   */
  constructor(accessToken) {
    this.http = axios.create({
      baseURL : SUPA_API,
      headers : {
        Authorization  : `Bearer ${accessToken}`,
        'Content-Type' : 'application/json',
      },
      timeout: 30_000,
    });
  }

  // ── Utilitaire polling ──────────────────────────────────────
  async #pollUntilReady(projectRef, onProgress) {
    const deadline = Date.now() + POLL_TIMEOUT;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      const { data } = await this.http.get(`/projects/${projectRef}`);
      const status = data.status; // 'COMING_UP' | 'ACTIVE_HEALTHY' | 'INACTIVE'
      logger.debug(`[Supabase] Statut projet ${projectRef}: ${status}`);
      if (onProgress) onProgress(status);
      if (status === 'ACTIVE_HEALTHY') return data;
      if (status === 'INACTIVE' || status === 'REMOVED') {
        throw new Error(`[Supabase] Projet en état inattendu: ${status}`);
      }
    }
    throw new Error('[Supabase] Timeout — projet non prêt après 3 minutes');
  }

  /**
   * Lister les organisations disponibles
   */
  async listOrganizations() {
    const { data } = await this.http.get('/organizations');
    return data; // [{ id, name }]
  }

  /**
   * Créer un projet Supabase complet
   * @param {object} opts
   * @param {string} opts.name          - Nom du projet
   * @param {string} opts.orgId         - ID organisation Supabase
   * @param {string} opts.dbPassword    - Mot de passe PostgreSQL (≥12 chars)
   * @param {string} [opts.region]      - Région AWS (défaut: eu-west-1)
   * @param {function}[opts.onProgress] - Callback(status) pendant l'init
   * @returns {{ projectRef, url, anonKey, serviceKey, dbUrl }}
   */
  async createProject({ name, orgId, dbPassword, region = 'eu-west-1', onProgress }) {
    logger.info(`[Supabase] Création du projet "${name}" (org: ${orgId})…`);

    // Vérifier si un projet avec ce nom existe déjà
    const { data: projects } = await this.http.get('/projects');
    const existing = projects.find(p => p.name === name);
    if (existing) {
      logger.warn(`[Supabase] Projet "${name}" déjà existant → récupération des clés`);
      return this.#getProjectKeys(existing.id);
    }

    // Créer le projet
    const { data: project } = await this.http.post('/projects', {
      name,
      organization_id : orgId,
      db_pass         : dbPassword,
      region,
      plan            : 'free',
    });

    logger.info(`[Supabase] ⏳ Projet créé (ref: ${project.id}) — attente initialisation…`);
    if (onProgress) onProgress('COMING_UP');

    // Attendre que le projet soit prêt
    await this.#pollUntilReady(project.id, onProgress);

    logger.info(`[Supabase] ✓ Projet prêt: ${project.id}`);
    return this.#getProjectKeys(project.id);
  }

  /**
   * Récupère les clés API d'un projet existant
   */
  async #getProjectKeys(projectRef) {
    const [{ data: project }, { data: keys }] = await Promise.all([
      this.http.get(`/projects/${projectRef}`),
      this.http.get(`/projects/${projectRef}/api-keys`),
    ]);

    const anonKey    = keys.find(k => k.name === 'anon')?.api_key   || '';
    const serviceKey = keys.find(k => k.name === 'service_role')?.api_key || '';
    const url        = `https://${projectRef}.supabase.co`;

    return {
      projectRef,
      url,
      anonKey,
      serviceKey,
      dbUrl    : `postgresql://postgres:${project.database?.password || ''}@db.${projectRef}.supabase.co:5432/postgres`,
      dashboard: `https://app.supabase.com/project/${projectRef}`,
    };
  }

  /**
   * Exécuter du SQL sur un projet (pour initialiser le schéma)
   */
  async runSQL(projectRef, sql) {
    logger.info(`[Supabase] Exécution SQL sur ${projectRef}…`);
    const { data } = await this.http.post(`/projects/${projectRef}/database/query`, { query: sql });
    logger.info(`[Supabase] ✓ SQL exécuté`);
    return data;
  }
}

module.exports = { SupabaseInfra };
