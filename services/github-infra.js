/**
 * ═══════════════════════════════════════════════════════════════
 *  services/github-infra.js
 *  Création automatique de repo GitHub via Management API
 * ═══════════════════════════════════════════════════════════════
 */

const { Octokit } = require('@octokit/rest');
const logger      = require('../utils/logger');

class GitHubInfra {
  /**
   * @param {string} token  - GitHub OAuth access token (user scope)
   */
  constructor(token) {
    // [3] User-Agent obligatoire — l'API GitHub rejette les requêtes sans ce header
    this.octokit = new Octokit({
      auth      : token,
      userAgent : 'AutoConfig-Ultimate/3.1 (https://github.com/autoconfig)',
    });
  }

  /**
   * Crée un repo GitHub pour l'utilisateur authentifié
   * @param {object} opts
   * @param {string} opts.name          - Nom du repo (slug)
   * @param {string} [opts.description]
   * @param {boolean}[opts.private]     - Défaut: false (public)
   * @param {boolean}[opts.autoInit]    - Initialiser avec README (défaut: true)
   * @returns {{ repoName, fullName, cloneUrl, htmlUrl, defaultBranch }}
   */
  async createRepo({ name, description = 'Created by InfraForge', isPrivate = false, autoInit = true }) {
    logger.info(`[GitHub] Création du repo "${name}"…`);

    // Vérifier si le repo existe déjà
    const { data: user } = await this.octokit.users.getAuthenticated();
    try {
      const { data: existing } = await this.octokit.repos.get({ owner: user.login, repo: name });
      logger.warn(`[GitHub] Repo "${name}" déjà existant → réutilisation`);
      return {
        repoName      : existing.name,
        fullName      : existing.full_name,
        cloneUrl      : existing.clone_url,
        htmlUrl       : existing.html_url,
        defaultBranch : existing.default_branch,
        owner         : user.login,
        alreadyExisted: true,
      };
    } catch (e) {
      if (e.status !== 404) throw e;
    }

    const { data } = await this.octokit.repos.createForAuthenticatedUser({
      name,
      description,
      private     : isPrivate,
      auto_init   : autoInit,
      gitignore_template: 'Node',
      license_template  : 'mit',
    });

    logger.info(`[GitHub] ✓ Repo créé: ${data.full_name}`);
    return {
      repoName      : data.name,
      fullName      : data.full_name,
      cloneUrl      : data.clone_url,
      htmlUrl       : data.html_url,
      defaultBranch : data.default_branch,
      owner         : user.login,
      alreadyExisted: false,
    };
  }

  /**
   * Pousse un fichier directement sur le repo (Zero-Clone)
   */
  async writeFile({ owner, repo, path, content, message = 'chore: autoconfig setup', branch = 'main' }) {
    let sha;
    try {
      const { data } = await this.octokit.repos.getContent({ owner, repo, path, ref: branch });
      sha = data.sha;
    } catch { /* nouveau fichier */ }

    await this.octokit.repos.createOrUpdateFileContents({
      owner, repo, path, message, branch,
      content: Buffer.from(content).toString('base64'),
      ...(sha ? { sha } : {}),
    });
    logger.info(`[GitHub] ✓ Fichier écrit: ${path}`);
  }

  /**
   * Configure les secrets GitHub Actions (pour CI/CD Vercel)
   */
  async setSecret({ owner, repo, secretName, secretValue }) {
    // Récupérer la clé publique du repo pour chiffrer
    const { data: pubKey } = await this.octokit.actions.getRepoPublicKey({ owner, repo });

    // Chiffrement libsodium (requis par GitHub)
    const sodium = require('tweetsodium');
    const key   = Buffer.from(pubKey.key, 'base64');
    const value = Buffer.from(secretValue);
    const encrypted = sodium.seal(value, key);
    const encryptedB64 = Buffer.from(encrypted).toString('base64');

    await this.octokit.actions.createOrUpdateRepoSecret({
      owner, repo,
      secret_name    : secretName,
      encrypted_value: encryptedB64,
      key_id         : pubKey.key_id,
    });
    logger.info(`[GitHub] ✓ Secret "${secretName}" configuré`);
  }

  /** Informations du user authentifié */
  async getUser() {
    const { data } = await this.octokit.users.getAuthenticated();
    return { login: data.login, name: data.name, email: data.email, avatar: data.avatar_url };
  }
}

module.exports = { GitHubInfra };
