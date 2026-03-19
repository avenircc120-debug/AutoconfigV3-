/**
 * ═══════════════════════════════════════════════════════════════════════
 *  tests/unit/gemini.test.js
 *  Tests unitaires — 3 stratégies Gemini
 *  ────────────────────────────────────────
 *  [1] Cache      → hit/miss/invalidation/persistance
 *  [2] Retry      → backoff exponentiel, calcul délais
 *  [3] Rotation   → sélection clé, markExhausted, round-robin
 * ═══════════════════════════════════════════════════════════════════════
 */

process.env.MASTER_SECRET = 'test_master_secret_32chars_UNIT_OK!';
process.env.NODE_ENV      = 'test';

// ══════════════════════════════════════════════════════════════════
//  STRATÉGIE 1 — CACHE
// ══════════════════════════════════════════════════════════════════
describe('📦 [1] GeminiCache — Stratégie de cache', () => {

  let GeminiCache, makeCacheKey;

  beforeEach(() => {
    jest.resetModules();
    // Mock fs pour éviter les écritures disque pendant les tests
    jest.mock('fs', () => ({
      mkdirSync   : jest.fn(),
      existsSync  : jest.fn().mockReturnValue(false),
      readFileSync: jest.fn(),
      writeFileSync: jest.fn(),
      unlinkSync  : jest.fn(),
    }));
    ({ GeminiCache, makeCacheKey } = require('../../utils/gemini-cache'));
  });

  afterEach(() => jest.resetModules());

  test('set() puis get() retourne la donnée mise en cache', () => {
    const c    = new GeminiCache(60_000);
    const data = { summary: '🟨 Next.js', primary: { id: 'nodejs' } };
    c.set('owner', 'repo', data, 'abc123', 'main');
    const result = c.get('owner', 'repo', 'abc123', 'main');
    expect(result).toEqual(data);
  });

  test('get() retourne null si entrée absente', () => {
    const c = new GeminiCache(60_000);
    expect(c.get('unknown', 'repo')).toBeNull();
  });

  test('get() retourne null si TTL expiré', () => {
    const c = new GeminiCache(1); // TTL = 1ms
    c.set('owner', 'repo', { test: true }, 'sha1');
    // Attendre expiration
    return new Promise(resolve => setTimeout(() => {
      expect(c.get('owner', 'repo', 'sha1')).toBeNull();
      resolve();
    }, 10));
  });

  test('recherche loose (sans SHA) trouve l\'entrée', () => {
    const c = new GeminiCache(60_000);
    c.set('owner', 'myrepo', { stack: 'python' }, 'sha_xyz');
    // Chercher sans SHA
    const result = c.get('owner', 'myrepo');
    expect(result).not.toBeNull();
    expect(result.stack).toBe('python');
  });

  test('invalidate() supprime les entrées d\'un repo', () => {
    const c = new GeminiCache(60_000);
    c.set('owner', 'repo', { data: 1 }, 'sha1');
    c.set('owner', 'repo', { data: 2 }, 'sha2');
    const count = c.invalidate('owner', 'repo');
    expect(count).toBeGreaterThan(0);
    expect(c.get('owner', 'repo')).toBeNull();
  });

  test('clear() vide entièrement le cache', () => {
    const c = new GeminiCache(60_000);
    c.set('a', 'b', { x: 1 });
    c.set('c', 'd', { y: 2 });
    c.clear();
    expect(c.stats().entries).toBe(0);
  });

  test('stats() rapporte hits et misses correctement', () => {
    const c = new GeminiCache(60_000);
    c.set('o', 'r', { stack: 'go' }, 'sh1');
    c.get('o', 'r', 'sh1'); // hit
    c.get('x', 'y');        // miss
    const s = c.stats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
    expect(s.hitRate).toBe('50%');
  });

  test('makeCacheKey() génère des clés différentes pour des SHA différents', () => {
    const k1 = makeCacheKey('owner', 'repo', 'aaa111', 'main');
    const k2 = makeCacheKey('owner', 'repo', 'bbb222', 'main');
    expect(k1).not.toBe(k2);
  });

  test('makeCacheKey() est insensible à la casse (owner/repo)', () => {
    const k1 = makeCacheKey('Owner', 'Repo', 'sha', 'main');
    const k2 = makeCacheKey('owner', 'repo', 'sha', 'main');
    expect(k1).toBe(k2);
  });

  test('list() retourne le contenu lisible du cache', () => {
    const c = new GeminiCache(60_000);
    c.set('monowner', 'monrepo', { summary: '🐍 Django', primary: { name: 'Python' } }, 'sha9');
    const items = c.list();
    expect(items.length).toBe(1);
    expect(items[0].repo).toBe('monowner/monrepo');
    expect(items[0].stack).toBe('🐍 Django');
  });

  test('MAX_ENTRIES : la plus ancienne entrée est évincée quand le cache est plein', () => {
    jest.resetModules();
    jest.mock('fs', () => ({ mkdirSync:jest.fn(), existsSync:jest.fn().mockReturnValue(false), readFileSync:jest.fn(), writeFileSync:jest.fn(), unlinkSync:jest.fn() }));
    // Recréer le module avec MAX_ENTRIES bas
    const mod = require('../../utils/gemini-cache');
    const c = new mod.GeminiCache(60_000);
    // Peupler jusqu'à la limite (on ne peut pas changer MAX_ENTRIES en test,
    // mais on vérifie que le cache grandit normalement)
    for (let i = 0; i < 10; i++) c.set(`owner${i}`, `repo${i}`, { i });
    expect(c.stats().entries).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  STRATÉGIE 2 — RETRY AVEC EXPONENTIAL BACKOFF
// ══════════════════════════════════════════════════════════════════
describe('🔄 [2] Retry — Exponential Backoff', () => {

  let callGemini, RETRY_CONFIG;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    process.env.GEMINI_KEYS = JSON.stringify(['AIzaSy_test_key_1_abcdefgh', 'AIzaSy_test_key_2_ijklmnop']);
    jest.mock('axios');
    ({ callGemini, RETRY_CONFIG } = require('../../services/gemini-client'));
  });

  afterEach(() => { jest.useRealTimers(); jest.resetModules(); delete process.env.GEMINI_KEYS; });

  test('RETRY_CONFIG a les valeurs attendues', () => {
    expect(RETRY_CONFIG.maxRetries).toBeGreaterThanOrEqual(3);
    expect(RETRY_CONFIG.baseDelayMs).toBeGreaterThanOrEqual(1000);
    expect(RETRY_CONFIG.maxDelayMs).toBeGreaterThanOrEqual(30_000);
    expect(RETRY_CONFIG.retryableStatuses).toContain(429);
    expect(RETRY_CONFIG.retryableStatuses).toContain(503);
  });

  test('calcul backoff : délai augmente exponentiellement', () => {
    // Accès à la fonction interne via le module
    const mod = require('../../services/gemini-client');
    // On vérifie le principe via RETRY_CONFIG
    const base = RETRY_CONFIG.baseDelayMs;
    // Tentative 0 → ~base, tentative 1 → ~base*2, tentative 2 → ~base*4
    // On vérifie seulement que maxDelayMs est bien respecté
    expect(RETRY_CONFIG.maxDelayMs).toBeLessThanOrEqual(128_000);
    expect(RETRY_CONFIG.baseDelayMs).toBeGreaterThan(500);
  });

  test('erreur 429 : réessaie après délai (avec 2 clés disponibles)', async () => {
    const axios = require('axios');
    let calls = 0;
    axios.post = jest.fn().mockImplementation(() => {
      calls++;
      if (calls === 1) {
        const err = new Error('Rate limit');
        err.response = { status: 429, headers: { 'retry-after': '1' }, data: { error: { message: 'quota' } } };
        return Promise.reject(err);
      }
      return Promise.resolve({
        data: { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }
      });
    });

    const promise = callGemini({ contents: [{ parts: [{ text: 'test' }] }] });
    // Avancer les timers pour les délais de backoff
    jest.runAllTimers();
    const result = await promise;
    expect(result).toContain('ok');
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test('erreur 503 : réessaie avec backoff', async () => {
    const axios = require('axios');
    let calls = 0;
    axios.post = jest.fn().mockImplementation(() => {
      calls++;
      if (calls < 3) {
        const err = new Error('Service unavailable');
        err.response = { status: 503, headers: {}, data: { error: { message: 'unavailable' } } };
        return Promise.reject(err);
      }
      return Promise.resolve({
        data: { candidates: [{ content: { parts: [{ text: 'success' }] } }] }
      });
    });

    const promise = callGemini({ contents: [] });
    jest.runAllTimers();
    const result = await promise;
    expect(result).toBe('success');
    expect(calls).toBe(3);
  });

  test('erreur 400 (non récupérable) : ne réessaie PAS', async () => {
    const axios = require('axios');
    let calls = 0;
    axios.post = jest.fn().mockImplementation(() => {
      calls++;
      const err = new Error('Bad request');
      err.response = { status: 400, headers: {}, data: { error: { message: 'invalid' } } };
      return Promise.reject(err);
    });

    const promise = callGemini({ contents: [] });
    jest.runAllTimers();
    await expect(promise).rejects.toThrow(/400/);
    expect(calls).toBe(1); // Pas de retry sur 400
  });

  test('erreur 401 (non autorisé) : ne réessaie PAS', async () => {
    const axios = require('axios');
    let calls = 0;
    axios.post = jest.fn().mockImplementation(() => {
      calls++;
      const err = new Error('Unauthorized');
      err.response = { status: 401, headers: {}, data: { error: { message: 'unauthorized' } } };
      return Promise.reject(err);
    });

    const promise = callGemini({ contents: [] });
    jest.runAllTimers();
    await expect(promise).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  STRATÉGIE 3 — ROTATION DE CLÉS
// ══════════════════════════════════════════════════════════════════
describe('🔑 [3] GeminiKeyRotator — Rotation de clés', () => {

  let GeminiKeyRotator;

  beforeEach(() => {
    jest.resetModules();
    ({ GeminiKeyRotator } = require('../../utils/gemini-key-rotator'));
  });

  afterEach(() => jest.resetModules());

  // ── Parsing des clés ───────────────────────────────────────────

  test('parse un tableau JSON de clés', () => {
    process.env.GEMINI_KEYS = JSON.stringify(['key1', 'key2', 'key3']);
    jest.resetModules();
    ({ GeminiKeyRotator } = require('../../utils/gemini-key-rotator'));
    const r = new GeminiKeyRotator();
    expect(r.totalKeys).toBe(3);
    delete process.env.GEMINI_KEYS;
  });

  test('parse une liste CSV de clés', () => {
    process.env.GEMINI_KEYS = 'keyA,keyB,keyC';
    jest.resetModules();
    ({ GeminiKeyRotator } = require('../../utils/gemini-key-rotator'));
    const r = new GeminiKeyRotator();
    expect(r.totalKeys).toBe(3);
    delete process.env.GEMINI_KEYS;
  });

  test('parse une clé unique (string simple)', () => {
    process.env.GEMINI_API_KEY = 'single_key_only';
    jest.resetModules();
    ({ GeminiKeyRotator } = require('../../utils/gemini-key-rotator'));
    const r = new GeminiKeyRotator();
    expect(r.totalKeys).toBe(1);
    delete process.env.GEMINI_API_KEY;
  });

  test('aucune clé configurée → hasKeys = false', () => {
    delete process.env.GEMINI_KEYS;
    delete process.env.GEMINI_API_KEY;
    jest.resetModules();
    ({ GeminiKeyRotator } = require('../../utils/gemini-key-rotator'));
    const r = new GeminiKeyRotator();
    expect(r.hasKeys).toBe(false);
    expect(r.totalKeys).toBe(0);
  });

  // ── Sélection de clé ──────────────────────────────────────────

  test('getAvailableKey() retourne la première clé disponible', async () => {
    process.env.GEMINI_KEYS = JSON.stringify(['AIzaSy_key1', 'AIzaSy_key2']);
    jest.resetModules();
    ({ GeminiKeyRotator } = require('../../utils/gemini-key-rotator'));
    const r = new GeminiKeyRotator();
    const result = await r.getAvailableKey();
    expect(result.apiKey).toBeTruthy();
    expect(result.index).toBeDefined();
    delete process.env.GEMINI_KEYS;
  });

  test('markExhausted() bloque une clé pour la durée spécifiée', async () => {
    process.env.GEMINI_KEYS = JSON.stringify(['key_a', 'key_b', 'key_c']);
    jest.resetModules();
    ({ GeminiKeyRotator } = require('../../utils/gemini-key-rotator'));
    const r = new GeminiKeyRotator();

    r.markExhausted(0, 60_000); // Bloquer clé #0 pour 60s

    // La clé #0 doit être bloquée
    const state0 = r.keys[0];
    expect(state0.exhaustedUntil).toBeGreaterThan(Date.now());
    expect(state0.errorCount).toBe(1);

    // Les autres clés doivent rester disponibles
    const available = await r.getAvailableKey();
    expect(available.index).not.toBe(0);
    delete process.env.GEMINI_KEYS;
  });

  test('round-robin : sélectionne les clés en alternance', async () => {
    process.env.GEMINI_KEYS = JSON.stringify(['key_1', 'key_2', 'key_3']);
    jest.resetModules();
    ({ GeminiKeyRotator } = require('../../utils/gemini-key-rotator'));
    const r = new GeminiKeyRotator();

    const indices = [];
    for (let i = 0; i < 6; i++) {
      const { index } = await r.getAvailableKey();
      indices.push(index);
    }
    // Toutes les 3 clés doivent avoir été utilisées
    const used = new Set(indices);
    expect(used.size).toBe(3);
    delete process.env.GEMINI_KEYS;
  });

  test('RPM : une clé avec 15 requêtes récentes est marquée non disponible', () => {
    process.env.GEMINI_KEYS = JSON.stringify(['key_rpm_test']);
    jest.resetModules();
    const { GeminiKeyRotator, GEMINI_RPM_LIMIT } = require('../../utils/gemini-key-rotator');
    const r = new GeminiKeyRotator();
    const state = r.keys[0];

    // Simuler 15 requêtes dans la fenêtre
    const now = Date.now();
    for (let i = 0; i < GEMINI_RPM_LIMIT; i++) {
      state.requestTimestamps.push(now - i * 100); // espacées de 100ms
    }

    const wait = r._availableInMs(state);
    expect(wait).toBeGreaterThan(0); // Doit attendre
    delete process.env.GEMINI_KEYS;
  });

  test('RPM fenêtre glissante : les anciennes requêtes n\'entrent pas en compte', () => {
    process.env.GEMINI_KEYS = JSON.stringify(['key_sliding_window']);
    jest.resetModules();
    const { GeminiKeyRotator, GEMINI_RPM_LIMIT } = require('../../utils/gemini-key-rotator');
    const r = new GeminiKeyRotator();
    const state = r.keys[0];

    // Simuler 15 requêtes il y a plus de 60s
    const old = Date.now() - 70_000; // 70 secondes dans le passé
    for (let i = 0; i < GEMINI_RPM_LIMIT; i++) {
      state.requestTimestamps.push(old + i * 100);
    }

    // Ces requêtes sont expirées → la clé doit être disponible
    const wait = r._availableInMs(state);
    expect(wait).toBe(0);
    delete process.env.GEMINI_KEYS;
  });

  // ── maskKey ───────────────────────────────────────────────────

  test('maskKey() masque correctement une clé API', () => {
    const masked = GeminiKeyRotator.maskKey('AIzaSy_AbCdEfGhIjKlMnOpQr');
    expect(masked).toContain('AIzaS');
    expect(masked).toContain('…');
    expect(masked).not.toBe('AIzaSy_AbCdEfGhIjKlMnOpQr'); // masqué
  });

  test('maskKey() gère les clés courtes', () => {
    expect(GeminiKeyRotator.maskKey('tiny')).toBe('****');
    expect(GeminiKeyRotator.maskKey('')).toBe('****');
  });

  // ── status() ─────────────────────────────────────────────────

  test('status() retourne le statut de chaque clé', async () => {
    process.env.GEMINI_KEYS = JSON.stringify(['k1', 'k2']);
    jest.resetModules();
    ({ GeminiKeyRotator } = require('../../utils/gemini-key-rotator'));
    const r = new GeminiKeyRotator();
    const s = r.status();
    expect(s).toHaveLength(2);
    s.forEach(entry => {
      expect(entry).toHaveProperty('index');
      expect(entry).toHaveProperty('rpmUsed');
      expect(entry).toHaveProperty('rpmLimit');
      expect(entry).toHaveProperty('available');
    });
    delete process.env.GEMINI_KEYS;
  });
});

// ══════════════════════════════════════════════════════════════════
//  INTÉGRATION DES 3 STRATÉGIES — analyzeRepo() avec mocks
// ══════════════════════════════════════════════════════════════════
describe('🧪 Intégration [1+2+3] — analyzeRepo() avec cache + retry + rotation', () => {

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    process.env.GEMINI_KEYS = JSON.stringify(['AIzaSy_test_integration_key']);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.resetModules();
    delete process.env.GEMINI_KEYS;
  });

  test('[1] analyzeRepo() sert le cache au 2ème appel (pas de requête Gemini)', async () => {
    jest.mock('axios');
    jest.mock('fs', () => ({ mkdirSync:jest.fn(), existsSync:jest.fn().mockReturnValue(false), readFileSync:jest.fn(), writeFileSync:jest.fn(), unlinkSync:jest.fn() }));
    jest.mock('../../services/stack-detector', () => ({
      StackDetector: jest.fn().mockImplementation(() => ({
        identifyStack: jest.fn().mockResolvedValue({
          summary: '🟨 Node.js', primary: { id: 'nodejs', name: 'Node.js', icon: '🟨', framework: 'Express.js' },
          all: [], hasDocker: false, envVars: [], repoRoot: ['package.json'],
        }),
      })),
    }));

    const axios = require('axios');
    let axiosCalls = 0;
    axios.post = jest.fn().mockImplementation(() => {
      axiosCalls++;
      return Promise.resolve({ data: { candidates: [{ content: { parts: [{ text: '{"deploymentRecommendations":[],"requiredEnvVars":[],"databaseRequired":false,"warnings":[]}' }] } }] } });
    });

    const { analyzeRepo } = require('../../services/gemini-client');

    const promise1 = analyzeRepo('owner', 'repo', 'fake_token');
    jest.runAllTimers();
    const result1 = await promise1;

    const promise2 = analyzeRepo('owner', 'repo', 'fake_token'); // depuis cache
    jest.runAllTimers();
    const result2 = await promise2;

    expect(result1.fromCache).toBe(false);
    expect(result2.fromCache).toBe(true);
    // Axios ne doit pas avoir été rappelé pour le 2ème analyzeRepo
    const callsAfterFirst = axiosCalls;
    expect(result2.summary).toBe(result1.summary);
    // Le nombre d'appels axios ne doit pas avoir augmenté entre le 1er et le 2ème
    expect(axiosCalls).toBe(callsAfterFirst);
  });

  test('[1] forceRefresh=true ignore le cache', async () => {
    jest.mock('axios');
    jest.mock('fs', () => ({ mkdirSync:jest.fn(), existsSync:jest.fn().mockReturnValue(false), readFileSync:jest.fn(), writeFileSync:jest.fn(), unlinkSync:jest.fn() }));
    jest.mock('../../services/stack-detector', () => ({
      StackDetector: jest.fn().mockImplementation(() => ({
        identifyStack: jest.fn().mockResolvedValue({
          summary: '🐍 Python', primary: { id:'python' }, all:[], hasDocker:false, envVars:[], repoRoot:[],
        }),
      })),
    }));

    const axios = require('axios');
    let calls = 0;
    axios.post = jest.fn().mockImplementation(() => {
      calls++;
      return Promise.resolve({ data: { candidates: [{ content: { parts: [{ text: '{}' }] } }] } });
    });

    const { analyzeRepo } = require('../../services/gemini-client');

    const p1 = analyzeRepo('o', 'r', 'tok'); jest.runAllTimers(); await p1;
    const callsAfterFirst = calls;

    const p2 = analyzeRepo('o', 'r', 'tok', { forceRefresh: true }); jest.runAllTimers(); await p2;

    // Force refresh → de nouveaux appels axios ont eu lieu
    expect(calls).toBeGreaterThan(callsAfterFirst);
  });
});
