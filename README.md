<div align="center">

# ⚡ AutoConfig Ultimate

### Déploiement automatique universel — Node.js · Python · PHP · Go · Docker

[![Version](https://img.shields.io/badge/version-3.0.0-6366f1?style=flat-square)](.)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-339933?style=flat-square)](.)
[![Tests](https://img.shields.io/badge/tests-74%20assertions-10b981?style=flat-square)](.)
[![Licence](https://img.shields.io/badge/licence-MIT-f59e0b?style=flat-square)](.)

**Saisis ton Gmail. L'application détecte ton stack, crée ta base de données, lie ton repo GitHub et déploie sur Vercel — sans aucune intervention manuelle.**

</div>

---

## 🎯 Ce que fait AutoConfig Ultimate

AutoConfig Ultimate automatise **l'intégralité du cycle de déploiement** d'une application web, quel que soit le langage utilisé. En une seule action :

1. **Détecte automatiquement** le langage et le framework de ton projet GitHub
2. **Crée et configure** une base de données Supabase (PostgreSQL) sans intervention
3. **Lie ton dépôt GitHub** au projet Vercel
4. **Déploie en production** avec toutes les variables d'environnement injectées automatiquement
5. **Génère le fichier `.env`** complet, poussé directement sur ton repo

---

## 🌍 Langages et frameworks supportés

La fonction `identifyStack()` détecte et configure automatiquement **7 stacks** :

| Stack | Fichiers détectés | Frameworks reconnus |
|---|---|---|
| 🟨 **JavaScript / Node.js** | `package.json` | Next.js · Nuxt · Remix · SvelteKit · Astro · Vite · Express · Fastify |
| 🐍 **Python** | `requirements.txt` · `pyproject.toml` | Django · FastAPI · Flask · Tornado |
| 🐘 **PHP** | `composer.json` | Laravel · WordPress · Symfony |
| 🐹 **Go** | `go.mod` | Gin · Fiber · Echo · Go natif |
| 🐳 **Docker** | `Dockerfile` · `docker-compose.yml` | Docker natif · Compose |
| 💎 **Ruby** | `Gemfile` | Rails · Sinatra · Rack |
| 🦀 **Rust** | `Cargo.toml` | Rust natif |

> `identifyStack()` analyse la racine de ton repo via l'API GitHub Contents (**zéro clonage local**), lit le contenu de `package.json`, `requirements.txt` ou `go.mod` pour identifier le framework exact, et extrait automatiquement les variables de ton `.env.example`.

---

## 🏗 Architecture — 3 modules fusionnés

```
AutoConfig Ultimate v3.0
│
├── [A] AutoConfig Core
│   ├── Gateway Universel      axios + retry automatique (3 tentatives)
│   ├── Zero-Clone GitHub      Lecture/écriture sans git clone
│   ├── Fortress AES-256-GCM   Chiffrement bancaire des tokens
│   ├── Validation Zod         Vérification stricte avant chaque appel
│   └── SSE Progress           Progression temps réel 0% → 100%
│
├── [B] InfraForge v1
│   ├── OAuth Google           Récupération de l'email utilisateur
│   ├── OAuth GitHub           Token avec scopes repo + workflow
│   ├── Supabase Provisioner   Création projet + poll ACTIVE_HEALTHY
│   ├── Vercel Provisioner     Création + liaison GitHub + déploiement
│   └── setupFullStack()       Orchestration v1
│
└── [C] InfraForge v2 — Intelligence Universelle
    ├── identifyStack()        Détection omni-langage (7 stacks)
    ├── parseEnvExample()      Extraction des variables .env.example
    ├── Auto-Provisioner       Injection dynamique des secrets
    └── orchestrateFullStack() Séquence complète Gmail → Live
```

---

## ⚡ Démarrage rapide

### Prérequis
- **Node.js ≥ 18**
- Comptes : GitHub · Supabase · Vercel

### Installation

```bash
# 1. Cloner ou décompresser le projet
cd autoconfig-ultimate

# 2. Installer les dépendances
npm install

# 3. Configurer les variables
cp config/.env.example .env
nano .env   # Remplir au minimum MASTER_SECRET + les tokens
```

**Générer ton MASTER_SECRET :**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Lancement

```bash
npm run dev    # Développement (nodemon)
npm start      # Production
```

Accès sur **http://localhost:3000**

---

## 🔄 Séquence orchestrateFullStack()

```
Gmail saisi
     │
     ▼
identifyStack()          → Détection langage · Extraction .env.example
     │
     ▼
SupabaseProvisioner()    → Création DB · Poll COMING_UP → HEALTHY
     │                      Récupération auto URL + ANON_KEY + SERVICE_ROLE_KEY
     ▼
GitHub confirmation      → Repo vérifié · Branche par défaut détectée
     │
     ▼
VercelProvisioner()      → Création projet · Liaison GitHub · Framework auto
     │
     ▼
injectEnvVars()          → vars .env.example + clés Supabase → Vercel ENV
     │                      .env.generated poussé sur GitHub (Zero-Clone)
     ▼
🚀  PROJET LIVE EN PRODUCTION
```

---

## 📡 API Endpoints

### [A] AutoConfig Core
```
POST  /api/auth/encrypt-token      Chiffre un token GitHub (AES-256)
POST  /api/github/read             Lit un fichier distant
POST  /api/github/write            Écrit/met à jour un fichier
POST  /api/github/update-env       Met à jour un .env distant
POST  /api/deploy/start            Pipeline de déploiement simple
GET   /api/deploy/events/:jobId    Flux SSE progression
```

### [B] InfraForge v1
```
GET   /api/oauth/google            Flux OAuth Google
GET   /api/oauth/github            Flux OAuth GitHub
POST  /api/session/create          Créer une session
POST  /api/setup/start             setupFullStack()
GET   /api/setup/events/:jobId     SSE multi-services
```

### [C] InfraForge v2
```
POST  /api/detect                  Détecter le stack d'un repo
POST  /api/orchestrate/start       orchestrateFullStack()
GET   /api/orchestrate/events/:jobId  SSE par phases
GET   /api/orchestrate/result/:jobId  Résultat + .env généré
```

---

## 🧪 Tests

```bash
npm test              # 74 assertions (unitaires + intégration)
npm run test:unit     # 50 tests unitaires
npm run test:int      # 24 tests d'intégration
npm run test:cov      # Rapport de couverture
```

| Fichier | Tests | Ce qui est testé |
|---|---|---|
| `tests/unit/security.test.js` | 18 | AES-256-GCM round-trip · HMAC · Zod schemas |
| `tests/unit/stack-detector.test.js` | 18 | `identifyStack()` (7 stacks) · `parseEnvExample()` |
| `tests/unit/gateway.test.js` | 14 | `createClient()` · `request()` · retry auto |
| `tests/integration/api.test.js` | 24 | Tous les endpoints REST |

---

## 🔒 Sécurité

| Mécanisme | Implémentation | Protection |
|---|---|---|
| **AES-256-GCM** | IV aléatoire à chaque chiffrement | Tokens illisibles même en cas d'accès DB |
| **Zod** | Validation format `ghp_` / `ghs_` | Rejection des tokens malformés |
| **HMAC-SHA256** | `crypto.timingSafeEqual` | Résistance aux attaques par timing |
| **OAuth anti-CSRF** | States `crypto.randomBytes` + TTL 10min | Protection contre le vol de session |
| **Zero-Clone** | API GitHub Contents uniquement | Aucun fichier téléchargé localement |
| **Gzip niveau 6** | `compression` Express | Chargement rapide en 3G/4G |

---

## 🚀 Déploiement

### Replit
1. Importer le repo GitHub dans Replit
2. Copier `config/replit.nix` → `replit.nix` (racine)
3. Copier `config/.replit` → `.replit` (racine)
4. Ajouter `MASTER_SECRET` dans les **Secrets**
5. **Run** — disponible sur le port 3000

### VPS (Ubuntu/Debian)
```bash
npm install --production
cp config/.env.example .env && nano .env
npm start
```

### PM2 (production)
```bash
npm install -g pm2
pm2 start server.js --name autoconfig
pm2 save && pm2 startup
```

---

## 📁 Structure

```
autoconfig-ultimate/
├── core/gateway.js                 Connecteur Universel
├── services/
│   ├── github.js                   Zero-Clone
│   ├── github-infra.js             Création repos
│   ├── supabase-infra.js           Provisioning DB
│   ├── vercel-infra.js             Déploiement
│   ├── oauth.js                    OAuth Google+GitHub
│   ├── orchestrator.js             setupFullStack() v1
│   ├── stack-detector.js           identifyStack() 7 stacks
│   ├── auto-provisioner.js         Injection dynamique
│   └── master-orchestrator.js      orchestrateFullStack()
├── routes/api.js                   25 endpoints unifiés
├── utils/{logger,security,sse}.js
├── public/index.html               Interface mobile-first
├── tests/unit/                     50 tests unitaires
├── tests/integration/              24 tests intégration
├── config/{.env.example,.replit,replit.nix}
├── .gitignore
├── package.json
└── server.js
```

---

<div align="center">
<sub>⚡ AutoConfig Ultimate v3.0 — Gateway · ZeroClone · AES-256 · identifyStack() · MasterOrchestrator</sub>
</div>
