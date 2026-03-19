/**
 * ═══════════════════════════════════════════════════════════════
 *  PILIER 2 — L'EXPERT ZERO-CLONE  (services/github.js)
 *  Modifie des fichiers (.env, config.json…) directement sur
 *  un dépôt distant via @octokit/rest — ZÉRO git clone local
 * ═══════════════════════════════════════════════════════════════
 */

const { Octokit } = require('@octokit/rest');
const logger      = require('../utils/logger');

class GitHubZeroClone {
  /**
   * @param {string} token  GitHub Personal Access Token (champ déchiffré)
   */
  constructor(token) {
    if (!token) throw new Error('[GitHub] Token obligatoire');
    this.octokit = new Octokit({
      auth       : token,
      // [3] User-Agent obligatoire — l'API GitHub rejette les requêtes sans ce header
      userAgent  : 'AutoConfig-Ultimate/3.1 (https://github.com/autoconfig)',
      log        : {
        debug : (msg) => logger.debug(`[Octokit] ${msg}`),
        info  : (msg) => logger.info (`[Octokit] ${msg}`),
        warn  : (msg) => logger.warn (`[Octokit] ${msg}`),
        error : (msg) => logger.error(`[Octokit] ${msg}`),
      },
    });
  }

  // ── Utilitaires internes ────────────────────────────────────

  /** Encode une chaîne en Base64 (upload GitHub) */
  static toBase64(str) { return Buffer.from(str, 'utf8').toString('base64'); }

  /** Décode du Base64 en chaîne UTF-8 (download GitHub) */
  static fromBase64(b64) { return Buffer.from(b64, 'base64').toString('utf8'); }

  /**
   * Récupère le SHA d'un fichier existant (requis pour l'écriture).
   * Retourne null si le fichier n'existe pas encore.
   */
  async #getSha(owner, repo, path, ref = 'main') {
    try {
      const { data } = await this.octokit.repos.getContent({ owner, repo, path, ref });
      return data.sha;
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  // ── API Publique ────────────────────────────────────────────

  /**
   * Lire le contenu d'un fichier distant
   * @returns {{ content: string, sha: string, path: string }}
   */
  async readFile(owner, repo, path, ref = 'main') {
    logger.info(`[GitHub] Lecture → ${owner}/${repo}:${path} (${ref})`);
    const { data } = await this.octokit.repos.getContent({ owner, repo, path, ref });

    if (data.type !== 'file') throw new Error(`[GitHub] "${path}" n'est pas un fichier`);

    return {
      content : GitHubZeroClone.fromBase64(data.content),
      sha     : data.sha,
      path    : data.path,
      size    : data.size,
      url     : data.html_url,
    };
  }

  /**
   * Écrire / mettre à jour un fichier distant (Zéro clone)
   * @param {object} p
   * @param {string} p.owner
   * @param {string} p.repo
   * @param {string} p.path       - ex: '.env', 'config/settings.json'
   * @param {string} p.content    - Contenu brut (sera encodé en Base64)
   * @param {string} p.message    - Message de commit
   * @param {string} [p.branch]   - Défaut: 'main'
   * @returns {{ commitSha: string, fileUrl: string }}
   */
  async writeFile({ owner, repo, path, content, message, branch = 'main' }) {
    logger.info(`[GitHub] Écriture → ${owner}/${repo}:${path}`);

    const sha = await this.#getSha(owner, repo, path, branch);

    const payload = {
      owner,
      repo,
      path,
      message,
      content : GitHubZeroClone.toBase64(content),
      branch,
      ...(sha ? { sha } : {}),           // SHA requis pour update, absent pour create
    };

    const { data } = await this.octokit.repos.createOrUpdateFileContents(payload);

    logger.info(`[GitHub] ✓ Commit: ${data.commit.sha.slice(0, 7)} — ${message}`);
    return {
      commitSha : data.commit.sha,
      fileUrl   : data.content.html_url,
    };
  }

  /**
   * Mettre à jour un fichier .env en fusionnant les variables
   * (les clés existantes sont écrasées, les nouvelles ajoutées)
   */
  async updateEnvFile({ owner, repo, path = '.env', vars, branch = 'main' }) {
    logger.info(`[GitHub] Mise à jour .env → ${owner}/${repo}:${path}`);

    // Lire le .env existant (ou partir d'un fichier vide)
    let existing = {};
    try {
      const { content } = await this.readFile(owner, repo, path, branch);
      content.split('\n').forEach((line) => {
        const idx = line.indexOf('=');
        if (idx > 0) {
          const key = line.slice(0, idx).trim();
          const val = line.slice(idx + 1).trim();
          existing[key] = val;
        }
      });
    } catch { /* fichier absent — on crée */ }

    // Fusionner
    const merged = { ...existing, ...vars };
    const newContent = Object.entries(merged)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n';

    return this.writeFile({
      owner, repo, path, branch,
      content : newContent,
      message : `chore: mise à jour ${path} via AutoConfig`,
    });
  }

  /**
   * Lister le contenu d'un répertoire
   */
  async listDirectory(owner, repo, dirPath = '', ref = 'main') {
    const { data } = await this.octokit.repos.getContent({ owner, repo, path: dirPath, ref });
    return Array.isArray(data) ? data.map((f) => ({
      name : f.name,
      path : f.path,
      type : f.type,
      size : f.size,
      sha  : f.sha,
      url  : f.html_url,
    })) : [data];
  }

  /**
   * Déclencher un GitHub Actions workflow
   */
  async triggerWorkflow(owner, repo, workflowId, ref = 'main', inputs = {}) {
    logger.info(`[GitHub] Déclenchement workflow ${workflowId}`);
    await this.octokit.actions.createWorkflowDispatch({ owner, repo, workflow_id: workflowId, ref, inputs });
    logger.info('[GitHub] ✓ Workflow dispatched');
  }

  /**
   * Récupérer les derniers runs d'un workflow
   */
  async getWorkflowRuns(owner, repo, workflowId, perPage = 5) {
    const { data } = await this.octokit.actions.listWorkflowRuns({
      owner, repo, workflow_id: workflowId, per_page: perPage,
    });
    return data.workflow_runs.map((r) => ({
      id         : r.id,
      status     : r.status,
      conclusion : r.conclusion,
      branch     : r.head_branch,
      createdAt  : r.created_at,
      url        : r.html_url,
    }));
  }

  /**
   * Informations sur un dépôt
   */
  async getRepoInfo(owner, repo) {
    const { data } = await this.octokit.repos.get({ owner, repo });
    return {
      fullName      : data.full_name,
      defaultBranch : data.default_branch,
      private       : data.private,
      language      : data.language,
      stars         : data.stargazers_count,
      lastPush      : data.pushed_at,
    };
  }
}

module.exports = { GitHubZeroClone };
