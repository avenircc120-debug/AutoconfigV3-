/**
 * ═══════════════════════════════════════════════════════════════════
 *  services/stack-detector.js
 *  ┌─────────────────────────────────────────────────────────────┐
 *  │  identifyStack(owner, repo, githubToken)                    │
 *  │  Analyse la racine d'un dépôt GitHub et détecte :           │
 *  │  JavaScript/Node · Python · PHP · Go · Docker               │
 *  │  + extrait les variables du .env.example pour injection      │
 *  └─────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════
 */

const { Octokit } = require('@octokit/rest');
const logger      = require('../utils/logger');

// ── Signatures de détection ─────────────────────────────────────
const STACK_SIGNATURES = [
  {
    id         : 'nodejs',
    name       : 'JavaScript / Node.js',
    icon       : '🟨',
    color      : '#f7df1e',
    markers    : ['package.json'],
    devMarkers : ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.nvmrc', '.node-version'],
    frameworks : {
      'next.config.js'        : 'Next.js',
      'next.config.mjs'       : 'Next.js',
      'next.config.ts'        : 'Next.js',
      'nuxt.config.js'        : 'Nuxt.js',
      'nuxt.config.ts'        : 'Nuxt.js',
      'remix.config.js'       : 'Remix',
      'svelte.config.js'      : 'SvelteKit',
      'vite.config.js'        : 'Vite',
      'vite.config.ts'        : 'Vite',
      'angular.json'          : 'Angular',
      'gatsby-config.js'      : 'Gatsby',
      'astro.config.mjs'      : 'Astro',
    },
    vercelRuntime  : null,  // auto-détecté par Vercel
    buildCommand   : 'npm run build',
    installCommand : 'npm install',
    devCommand     : 'npm run dev',
    envTemplate    : ['NODE_ENV=production', 'PORT=3000'],
  },
  {
    id         : 'python',
    name       : 'Python',
    icon       : '🐍',
    color      : '#3572a5',
    markers    : ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'],
    devMarkers : ['.python-version', 'poetry.lock', 'Pipfile.lock'],
    frameworks : {
      'manage.py'             : 'Django',
      'wsgi.py'               : 'Django/WSGI',
      'asgi.py'               : 'Django/ASGI',
      'app.py'                : 'Flask/FastAPI',
      'main.py'               : 'FastAPI',
      'fastapi'               : 'FastAPI',   // dans requirements.txt
    },
    vercelRuntime  : '@vercel/python',
    buildCommand   : null,
    installCommand : 'pip install -r requirements.txt',
    devCommand     : 'python main.py',
    envTemplate    : ['PYTHON_ENV=production', 'DEBUG=False'],
  },
  {
    id         : 'php',
    name       : 'PHP',
    icon       : '🐘',
    color      : '#4f5b93',
    markers    : ['composer.json', 'composer.lock'],
    devMarkers : ['artisan', '.php-version'],
    frameworks : {
      'artisan'               : 'Laravel',
      'wp-config.php'         : 'WordPress',
      'wp-config-sample.php'  : 'WordPress',
      'index.php'             : 'PHP Native',
      'symfony.lock'          : 'Symfony',
    },
    vercelRuntime  : '@vercel/php',
    buildCommand   : null,
    installCommand : 'composer install',
    devCommand     : 'php -S localhost:8000',
    envTemplate    : ['APP_ENV=production', 'APP_DEBUG=false'],
  },
  {
    id         : 'go',
    name       : 'Go',
    icon       : '🐹',
    color      : '#00acd7',
    markers    : ['go.mod', 'go.sum'],
    devMarkers : ['.go-version'],
    frameworks : {
      'main.go'               : 'Go Native',
      'gin'                   : 'Gin',       // dans go.mod
      'fiber'                 : 'Fiber',
      'echo'                  : 'Echo',
    },
    vercelRuntime  : '@vercel/go',
    buildCommand   : 'go build -o app .',
    installCommand : 'go mod download',
    devCommand     : 'go run main.go',
    envTemplate    : ['GO_ENV=production', 'PORT=8080'],
  },
  {
    id         : 'docker',
    name       : 'Docker',
    icon       : '🐳',
    color      : '#2496ed',
    markers    : ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'],
    devMarkers : ['.dockerignore'],
    frameworks : {
      'docker-compose.yml'    : 'Docker Compose',
      'docker-compose.yaml'   : 'Docker Compose',
      'Dockerfile'            : 'Docker Native',
    },
    vercelRuntime  : null,
    buildCommand   : 'docker build -t app .',
    installCommand : null,
    devCommand     : 'docker-compose up',
    envTemplate    : ['DOCKER_ENV=production'],
  },
  {
    id         : 'ruby',
    name       : 'Ruby',
    icon       : '💎',
    color      : '#cc342d',
    markers    : ['Gemfile', 'Gemfile.lock'],
    devMarkers : ['.ruby-version'],
    frameworks : {
      'config/application.rb' : 'Rails',
      'config.ru'             : 'Rack/Sinatra',
      'Rakefile'              : 'Rails/Rake',
    },
    vercelRuntime  : '@vercel/ruby',
    buildCommand   : 'bundle exec rake assets:precompile',
    installCommand : 'bundle install',
    devCommand     : 'bundle exec rails server',
    envTemplate    : ['RAILS_ENV=production'],
  },
  {
    id         : 'rust',
    name       : 'Rust',
    icon       : '🦀',
    color      : '#dea584',
    markers    : ['Cargo.toml', 'Cargo.lock'],
    devMarkers : ['.rustfmt.toml'],
    frameworks : {
      'Cargo.toml'            : 'Rust Native',
    },
    vercelRuntime  : '@vercel/rust',
    buildCommand   : 'cargo build --release',
    installCommand : null,
    devCommand     : 'cargo run',
    envTemplate    : ['RUST_LOG=info'],
  },
];

// ── Parser .env.example ─────────────────────────────────────────

/**
 * Extrait les clés et valeurs d'un fichier .env.example
 * @param {string} content
 * @returns {Array<{ key, value, hasValue, isComment }>}
 */
function parseEnvExample(content) {
  const lines  = content.split('\n');
  const vars   = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      vars.push({ key: line, value: '', hasValue: false, isComment: true });
      continue;
    }
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key   = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    vars.push({ key, value, hasValue: value.length > 0 && !value.includes('CHANGE_ME'), isComment: false });
  }
  return vars;
}

// ── Détecteur principal ─────────────────────────────────────────

class StackDetector {
  constructor(githubToken) {
    this.octokit = new Octokit({
      auth      : githubToken,
      // [3] User-Agent obligatoire pour l'API GitHub
      userAgent : 'AutoConfig-Ultimate/3.1 (https://github.com/autoconfig)',
    });
  }

  /**
   * Lister le contenu de la racine du dépôt
   */
  async #getRootFiles(owner, repo, ref = 'main') {
    try {
      const { data } = await this.octokit.repos.getContent({ owner, repo, path: '', ref });
      return data.map(f => f.name.toLowerCase());
    } catch {
      // Essayer 'master' si 'main' échoue
      try {
        const { data } = await this.octokit.repos.getContent({ owner, repo, path: '', ref: 'master' });
        return data.map(f => f.name.toLowerCase());
      } catch { return []; }
    }
  }

  /**
   * Lire un fichier texte du repo
   */
  async #readFile(owner, repo, path) {
    try {
      const { data } = await this.octokit.repos.getContent({ owner, repo, path });
      if (data.type !== 'file') return null;
      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch { return null; }
  }

  /**
   * Détecter le framework à partir du contenu de package.json
   */
  #detectNodeFramework(packageJson) {
    if (!packageJson) return null;
    try {
      const pkg  = JSON.parse(packageJson);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['next'])    return 'Next.js';
      if (deps['nuxt'])    return 'Nuxt.js';
      if (deps['@remix-run/node']) return 'Remix';
      if (deps['@sveltejs/kit'])   return 'SvelteKit';
      if (deps['astro'])   return 'Astro';
      if (deps['vite'])    return 'Vite';
      if (deps['gatsby'])  return 'Gatsby';
      if (deps['angular']) return 'Angular';
      if (deps['express']) return 'Express.js';
      if (deps['fastify']) return 'Fastify';
      if (deps['hono'])    return 'Hono';
      return pkg.name ? `Node.js (${pkg.name})` : 'Node.js';
    } catch { return 'Node.js'; }
  }

  /**
   * ╔═══════════════════════════════════════════════════════╗
   * ║  identifyStack(owner, repo)  — Fonction principale   ║
   * ╚═══════════════════════════════════════════════════════╝
   *
   * @returns {StackResult}
   */
  async identifyStack(owner, repo) {
    logger.info(`[Detector] 🔍 Analyse de ${owner}/${repo}…`);
    const rootFiles = await this.#getRootFiles(owner, repo);
    logger.debug(`[Detector] Fichiers racine: ${rootFiles.slice(0, 12).join(', ')}`);

    const detected  = [];
    let primaryStack = null;

    for (const sig of STACK_SIGNATURES) {
      const markers    = sig.markers.map(m => m.toLowerCase());
      const devMarkers = sig.devMarkers.map(m => m.toLowerCase());

      const matchCount = markers.filter(m => rootFiles.includes(m)).length;
      const devCount   = devMarkers.filter(m => rootFiles.includes(m)).length;

      if (matchCount > 0) {
        // Détecter le framework spécifique
        let framework   = null;
        let confidence  = matchCount * 30 + devCount * 10;

        // Détection avancée selon le type
        if (sig.id === 'nodejs') {
          const pkgJson = await this.#readFile(owner, repo, 'package.json');
          framework = this.#detectNodeFramework(pkgJson);
          confidence += 20;
        } else if (sig.id === 'python') {
          const req = await this.#readFile(owner, repo, 'requirements.txt');
          if (req) {
            if (req.includes('django'))  framework = 'Django';
            else if (req.includes('fastapi')) framework = 'FastAPI';
            else if (req.includes('flask'))   framework = 'Flask';
            else if (req.includes('tornado')) framework = 'Tornado';
          }
          if (!framework) {
            if (rootFiles.includes('manage.py'))  framework = 'Django';
            else if (rootFiles.includes('app.py')) framework = 'Flask/FastAPI';
            else if (rootFiles.includes('main.py'))framework = 'FastAPI';
          }
        } else if (sig.id === 'php') {
          if (rootFiles.includes('artisan')) framework = 'Laravel';
          else if (rootFiles.includes('wp-config.php') || rootFiles.includes('wp-config-sample.php')) framework = 'WordPress';
          else if (rootFiles.includes('symfony.lock')) framework = 'Symfony';
        } else if (sig.id === 'go') {
          const goMod = await this.#readFile(owner, repo, 'go.mod');
          if (goMod) {
            if (goMod.includes('gin-gonic/gin'))   framework = 'Gin';
            else if (goMod.includes('gofiber'))    framework = 'Fiber';
            else if (goMod.includes('labstack/echo')) framework = 'Echo';
            else framework = 'Go Native';
          }
        } else if (sig.id === 'docker') {
          if (rootFiles.includes('docker-compose.yml') || rootFiles.includes('docker-compose.yaml')) {
            framework = 'Docker Compose';
          } else {
            framework = 'Docker Native';
          }
        }

        detected.push({ ...sig, framework, confidence, markersFound: markers.filter(m => rootFiles.includes(m)) });
      }
    }

    // Trier par confiance décroissante
    detected.sort((a, b) => b.confidence - a.confidence);

    // Le stack primaire est celui avec la plus haute confiance
    // (Docker est secondaire si un autre langage est aussi présent)
    primaryStack = detected.find(d => d.id !== 'docker') || detected[0] || null;
    const hasDocker = detected.some(d => d.id === 'docker');

    // Lire le .env.example
    let envVars = [];
    const envContent = await this.#readFile(owner, repo, '.env.example')
      || await this.#readFile(owner, repo, '.env.sample')
      || await this.#readFile(owner, repo, '.env.template');

    if (envContent) {
      envVars = parseEnvExample(envContent);
      logger.info(`[Detector] .env.example trouvé — ${envVars.filter(v => !v.isComment).length} variables`);
    }

    // Lire package.json pour les scripts si Node.js
    let buildConfig = {
      buildCommand   : primaryStack?.buildCommand   || null,
      installCommand : primaryStack?.installCommand || null,
      devCommand     : primaryStack?.devCommand     || null,
    };
    if (primaryStack?.id === 'nodejs') {
      const pkgJson = await this.#readFile(owner, repo, 'package.json');
      if (pkgJson) {
        try {
          const pkg = JSON.parse(pkgJson);
          if (pkg.scripts?.build)   buildConfig.buildCommand   = 'npm run build';
          if (pkg.scripts?.start)   buildConfig.devCommand     = 'npm start';
          if (pkg.scripts?.install) buildConfig.installCommand = 'npm install';
        } catch {}
      }
    }

    const result = {
      primary     : primaryStack,
      all         : detected,
      hasDocker,
      envVars,
      buildConfig,
      repoRoot    : rootFiles,
      detectedAt  : new Date().toISOString(),
      summary     : primaryStack
        ? `${primaryStack.icon} ${primaryStack.framework || primaryStack.name}${hasDocker ? ' + 🐳 Docker' : ''}`
        : '❓ Stack inconnu',
    };

    logger.info(`[Detector] ✓ Résultat: ${result.summary} (${detected.length} stack(s) trouvé(s))`);
    return result;
  }
}

module.exports = { StackDetector, parseEnvExample, STACK_SIGNATURES };
