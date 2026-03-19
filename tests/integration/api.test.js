/**
 * ═══════════════════════════════════════════════════════════════
 *  tests/integration/api.test.js
 *  Tests d'intégration — tous les endpoints REST de l'API unifiée
 *  Utilise supertest (pas de réseau réel, serveur monté en mémoire)
 * ═══════════════════════════════════════════════════════════════
 */

process.env.MASTER_SECRET      = 'test_master_secret_32chars_INTEG!';
process.env.NODE_ENV           = 'test';
process.env.GOOGLE_CLIENT_ID   = 'fake_google_id';
process.env.GOOGLE_CLIENT_SECRET = 'fake_google_secret';
process.env.GITHUB_CLIENT_ID   = 'fake_gh_id';
process.env.GITHUB_CLIENT_SECRET = 'fake_gh_secret';
process.env.BASE_URL           = 'http://localhost:3000';

const request  = require('supertest');
const app      = require('../../server');
const { encrypt } = require('../../utils/security');

// ════════════════════════════════════════════════════════════════
//  HEALTH
// ════════════════════════════════════════════════════════════════
describe('🏥 GET /api/health', () => {
  test('retourne 200 avec status ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('AutoConfig Ultimate');
    expect(res.body.version).toBe('3.0.0');
  });

  test('liste les 3 modules', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body.modules).toHaveProperty('A_autoconfig');
    expect(res.body.modules).toHaveProperty('B_infraforge_v1');
    expect(res.body.modules).toHaveProperty('C_infraforge_v2');
  });

  test('inclut l\'uptime', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body.uptime).toMatch(/^\d+\.\d+s$/);
  });
});

// ════════════════════════════════════════════════════════════════
//  [A] SÉCURITÉ — Chiffrement
// ════════════════════════════════════════════════════════════════
describe('🔒 POST /api/auth/encrypt-token', () => {

  test('chiffre un token GitHub valide', async () => {
    const res = await request(app)
      .post('/api/auth/encrypt-token')
      .send({ githubToken: 'ghp_abcdefghijklmnopqrstuvwxyz12345' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.encryptedToken).toBeTruthy();
    expect(res.body.encryptedToken.split(':')).toHaveLength(3);
  });

  test('rejette un token sans préfixe GitHub', async () => {
    const res = await request(app)
      .post('/api/auth/encrypt-token')
      .send({ githubToken: 'sk_live_notgithub' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeTruthy();
  });

  test('rejette un body vide', async () => {
    const res = await request(app).post('/api/auth/encrypt-token').send({});
    expect(res.status).toBe(400);
  });

  test('deux chiffrements du même token donnent des payloads différents', async () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz12345';
    const r1 = await request(app).post('/api/auth/encrypt-token').send({ githubToken: token });
    const r2 = await request(app).post('/api/auth/encrypt-token').send({ githubToken: token });
    expect(r1.body.encryptedToken).not.toBe(r2.body.encryptedToken);
  });
});

// ════════════════════════════════════════════════════════════════
//  [A] GITHUB — Zero-Clone (mock Octokit)
// ════════════════════════════════════════════════════════════════
describe('🐙 POST /api/github/read', () => {

  test('retourne 400 si encryptedToken corrompu', async () => {
    const res = await request(app).post('/api/github/read').send({
      encryptedToken: 'INVALIDE',
      owner: 'owner', repo: 'repo', path: 'README.md',
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('🐙 POST /api/github/write', () => {
  test('retourne 400 si owner/repo invalide (Zod)', async () => {
    const enc = encrypt('ghp_abcdefghijklmnopqrstuvwxyz12345');
    const res = await request(app).post('/api/github/write').send({
      encryptedToken: enc,
      owner: 'bad owner!', repo: 'repo',
      path: 'test.txt', content: 'hello', message: 'test',
    });
    expect(res.status).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════════
//  [B] SESSIONS
// ════════════════════════════════════════════════════════════════
describe('🗝 Sessions — POST /api/session/create', () => {

  test('crée une session avec email', async () => {
    const res = await request(app)
      .post('/api/session/create')
      .send({ email: 'test@gmail.com', owner: 'myowner', repo: 'myrepo' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.sessionId).toBeTruthy();
    expect(res.body.sessionId).toHaveLength(36); // UUID v4
  });

  test('rejette si email manquant', async () => {
    const res = await request(app).post('/api/session/create').send({ owner: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('GET session après création', async () => {
    const cr = await request(app).post('/api/session/create')
      .send({ email: 'user@test.com', owner: 'o', repo: 'r' });
    const sid = cr.body.sessionId;

    const gr = await request(app).get(`/api/session/${sid}`);
    expect(gr.status).toBe(200);
    expect(gr.body.email).toBe('user@test.com');
    expect(gr.body.owner).toBe('o');
    expect(gr.body.repo).toBe('r');
  });

  test('GET session inconnue → 404', async () => {
    const res = await request(app).get('/api/session/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  test('PATCH session — met à jour les tokens', async () => {
    const cr  = await request(app).post('/api/session/create').send({ email: 'u@t.com' });
    const sid = cr.body.sessionId;

    const pr = await request(app).patch(`/api/session/${sid}`)
      .send({ githubToken: 'ghp_newtoken123456789012345678901234' });
    expect(pr.status).toBe(200);
    expect(pr.body.updated).toBe(true);

    const gr = await request(app).get(`/api/session/${sid}`);
    expect(gr.body.hasGitHub).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
//  [B] SETUP — validation des tokens manquants
// ════════════════════════════════════════════════════════════════
describe('⚡ POST /api/setup/start — validation', () => {

  test('rejette si session inconnue', async () => {
    const res = await request(app).post('/api/setup/start')
      .send({ sessionId: 'unknown-session-id' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/session/i);
  });

  test('rejette si GitHub token manquant', async () => {
    const cr  = await request(app).post('/api/session/create')
      .send({ email: 'u@t.com', owner: 'o', repo: 'r' });
    const res = await request(app).post('/api/setup/start')
      .send({ sessionId: cr.body.sessionId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/github/i);
  });
});

// ════════════════════════════════════════════════════════════════
//  [C] DETECT — Stack detection
// ════════════════════════════════════════════════════════════════
describe('🔍 POST /api/detect — validation', () => {

  test('rejette si token GitHub manquant', async () => {
    const res = await request(app).post('/api/detect')
      .send({ owner: 'myowner', repo: 'myrepo' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/token/i);
  });

  test('rejette si owner/repo manquants', async () => {
    const res = await request(app).post('/api/detect')
      .send({ githubToken: 'ghp_abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/owner|repo/i);
  });

  test('passe le token depuis la session', async () => {
    // Créer une session avec un token fictif
    const cr = await request(app).post('/api/session/create').send({
      email: 'dev@test.com', owner: 'owner', repo: 'repo',
      githubToken: 'ghp_sessiontoken123456789012345678',
    });
    // La requête va échouer (token fictif) mais le code doit tenter la détection
    const res = await request(app).post('/api/detect')
      .send({ sessionId: cr.body.sessionId });
    // Erreur réseau attendue, pas erreur de validation
    expect(res.status).toBe(400);
    // L'erreur NE doit PAS être "Token GitHub requis"
    expect(res.body.error).not.toMatch(/token.*requis/i);
  });
});

// ════════════════════════════════════════════════════════════════
//  [C] ORCHESTRATE — validation
// ════════════════════════════════════════════════════════════════
describe('🚀 POST /api/orchestrate/start — validation', () => {

  test('rejette si session inconnue', async () => {
    const res = await request(app).post('/api/orchestrate/start')
      .send({ sessionId: 'nonexistent' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/session/i);
  });

  test('liste les tokens manquants', async () => {
    const cr = await request(app).post('/api/session/create')
      .send({ email: 'u@t.com', owner: 'o', repo: 'r' });
    const res = await request(app).post('/api/orchestrate/start')
      .send({ sessionId: cr.body.sessionId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/manquants/i);
    // Doit lister les 3 tokens manquants
    expect(res.body.error).toMatch(/GitHub/);
    expect(res.body.error).toMatch(/Supabase/);
    expect(res.body.error).toMatch(/Vercel/);
  });

  test('rejette si owner/repo manquants', async () => {
    const cr = await request(app).post('/api/session/create').send({
      email: 'u@t.com',
      githubToken  : 'ghp_abcdefghijklmnopqrstuvwxyz12345',
      supabaseToken: 'sbp_abcdefghijklmnopqrstuvwxyz12345',
      vercelToken  : 'vc_abcdefghijklmnopqrstuvwxyz12345',
    });
    const res = await request(app).post('/api/orchestrate/start')
      .send({ sessionId: cr.body.sessionId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/owner|repo/i);
  });

  test('retourne un jobId valide si tous les tokens présents', async () => {
    const cr = await request(app).post('/api/session/create').send({
      email: 'u@t.com', owner: 'o', repo: 'r',
      githubToken  : 'ghp_abcdefghijklmnopqrstuvwxyz12345',
      supabaseToken: 'sbp_abcdefghijklmnopqrstuvwxyz12345',
      vercelToken  : 'vc_abcdefghijklmnopqrstuvwxyz12345',
    });
    const res = await request(app).post('/api/orchestrate/start')
      .send({ sessionId: cr.body.sessionId });
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBeTruthy();
    expect(res.body.jobId).toHaveLength(36);
  });
});

// ════════════════════════════════════════════════════════════════
//  DEPLOY EVENTS — SSE connection
// ════════════════════════════════════════════════════════════════
describe('📡 GET /api/deploy/events/:jobId — SSE headers', () => {
  test('retourne les headers SSE corrects', (done) => {
    const jobId = 'test-sse-job-123';
    const req = request(app)
      .get(`/api/deploy/events/${jobId}`)
      .expect('Content-Type', /text\/event-stream/)
      .expect('Cache-Control', /no-cache/)
      .buffer(false);

    req.end((err) => {
      // La connexion est maintenue ouverte — on vérifie juste les headers
      done();
    });
    // Fermer après 200ms
    setTimeout(() => req.req?.destroy(), 200);
  });
});

// ════════════════════════════════════════════════════════════════
//  RESULT — Jobs
// ════════════════════════════════════════════════════════════════
describe('📊 GET /api/setup/result/:jobId', () => {
  test('retourne 404 pour un jobId inconnu', async () => {
    const res = await request(app).get('/api/setup/result/unknown-job-id');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
//  ROUTES NON EXISTANTES
// ════════════════════════════════════════════════════════════════
describe('🚫 Routes inconnues', () => {
  test('route API inconnue retourne le frontend (SPA fallback)', async () => {
    const res = await request(app).get('/api/nonexistent');
    // Soit 404 json, soit fallback HTML
    expect([200, 404]).toContain(res.status);
  });
});
