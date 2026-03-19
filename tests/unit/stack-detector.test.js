/**
 * ═══════════════════════════════════════════════════════════════
 *  tests/unit/stack-detector.test.js
 *  Tests unitaires — identifyStack() + parseEnvExample()
 * ═══════════════════════════════════════════════════════════════
 */

process.env.MASTER_SECRET = 'test_master_secret_32chars_UNIT_OK!';

const { StackDetector, parseEnvExample, STACK_SIGNATURES } = require('../../services/stack-detector');

// ── parseEnvExample ──────────────────────────────────────────────
describe('📄 parseEnvExample()', () => {

  test('parse un .env.example simple', () => {
    const content = `
DATABASE_URL=postgres://localhost/db
SECRET_KEY=changeme
PORT=3000
    `.trim();
    const vars = parseEnvExample(content);
    const keys = vars.filter(v => !v.isComment).map(v => v.key);
    expect(keys).toContain('DATABASE_URL');
    expect(keys).toContain('SECRET_KEY');
    expect(keys).toContain('PORT');
  });

  test('ignore les commentaires (#)', () => {
    const content = `# Section principale\nKEY=value\n# Autre commentaire`;
    const vars = parseEnvExample(content);
    const nonComment = vars.filter(v => !v.isComment);
    expect(nonComment).toHaveLength(1);
    expect(nonComment[0].key).toBe('KEY');
  });

  test('ignore les lignes vides', () => {
    const content = `\n\nKEY=value\n\n`;
    const vars = parseEnvExample(content);
    expect(vars.filter(v => !v.isComment)).toHaveLength(1);
  });

  test('hasValue=false pour les valeurs vides ou CHANGE_ME', () => {
    const content = `EMPTY_KEY=\nCHANGE_KEY=CHANGE_ME`;
    const vars = parseEnvExample(content);
    vars.filter(v => !v.isComment).forEach(v => expect(v.hasValue).toBe(false));
  });

  test('hasValue=true pour une vraie valeur', () => {
    const content = `REAL_KEY=https://real-value.com`;
    const vars = parseEnvExample(content);
    expect(vars[0].hasValue).toBe(true);
  });

  test('gère les valeurs contenant "="', () => {
    const content = `URL=https://example.com?foo=bar&baz=qux`;
    const vars = parseEnvExample(content);
    expect(vars[0].value).toBe('https://example.com?foo=bar&baz=qux');
  });

  test('retourne tableau vide pour contenu vide', () => {
    expect(parseEnvExample('')).toEqual([]);
    expect(parseEnvExample('\n\n\n')).toEqual([]);
  });
});

// ── STACK_SIGNATURES ─────────────────────────────────────────────
describe('📦 STACK_SIGNATURES — structure', () => {

  const expectedIds = ['nodejs', 'python', 'php', 'go', 'docker', 'ruby', 'rust'];

  test('contient les 7 stacks requis', () => {
    const ids = STACK_SIGNATURES.map(s => s.id);
    expectedIds.forEach(id => expect(ids).toContain(id));
  });

  test('chaque stack a les champs obligatoires', () => {
    STACK_SIGNATURES.forEach(s => {
      expect(s.id).toBeTruthy();
      expect(s.name).toBeTruthy();
      expect(s.icon).toBeTruthy();
      expect(Array.isArray(s.markers)).toBe(true);
      expect(s.markers.length).toBeGreaterThan(0);
    });
  });

  test('Node.js reconnaît package.json', () => {
    const node = STACK_SIGNATURES.find(s => s.id === 'nodejs');
    expect(node.markers).toContain('package.json');
  });

  test('Python reconnaît requirements.txt et pyproject.toml', () => {
    const py = STACK_SIGNATURES.find(s => s.id === 'python');
    expect(py.markers).toContain('requirements.txt');
    expect(py.markers).toContain('pyproject.toml');
  });

  test('PHP reconnaît composer.json', () => {
    const php = STACK_SIGNATURES.find(s => s.id === 'php');
    expect(php.markers).toContain('composer.json');
  });

  test('Go reconnaît go.mod', () => {
    const go = STACK_SIGNATURES.find(s => s.id === 'go');
    expect(go.markers).toContain('go.mod');
  });

  test('Docker reconnaît Dockerfile', () => {
    const docker = STACK_SIGNATURES.find(s => s.id === 'docker');
    expect(docker.markers).toContain('Dockerfile');
  });
});

// ── StackDetector avec mock Octokit ─────────────────────────────
describe('🔍 StackDetector.identifyStack() — mocks', () => {

  function mockDetector(rootFiles, fileContents = {}) {
    const detector = new StackDetector('fake_token');
    // Mock des méthodes privées via les appels octokit
    detector.octokit = {
      repos: {
        getContent: jest.fn(({ path }) => {
          if (path === '') {
            // Racine du repo
            return Promise.resolve({
              data: rootFiles.map(name => ({ name, type: name.includes('.') || !name.includes('/') ? 'file' : 'dir' })),
            });
          }
          // Fichier spécifique
          const content = fileContents[path];
          if (!content) return Promise.reject({ status: 404 });
          return Promise.resolve({
            data: {
              type    : 'file',
              content : Buffer.from(content).toString('base64'),
              sha     : 'abc123',
              path,
            },
          });
        }),
      },
    };
    return detector;
  }

  test('détecte Node.js depuis package.json', async () => {
    const pkg = JSON.stringify({ name: 'my-app', dependencies: { express: '^4.0.0' } });
    const det = mockDetector(['package.json', 'index.js'], { 'package.json': pkg });
    const result = await det.identifyStack('owner', 'repo');
    expect(result.primary?.id).toBe('nodejs');
  });

  test('détecte Next.js depuis package.json avec dep next', async () => {
    const pkg = JSON.stringify({ name: 'my-next', dependencies: { next: '^14.0.0', react: '^18.0.0' } });
    const det = mockDetector(['package.json', 'next.config.js'], { 'package.json': pkg });
    const result = await det.identifyStack('owner', 'repo');
    expect(result.primary?.id).toBe('nodejs');
    expect(result.primary?.framework).toBe('Next.js');
  });

  test('détecte Python / Django', async () => {
    const req = 'django==4.2\npsycopg2==2.9\n';
    const det = mockDetector(['requirements.txt', 'manage.py', 'wsgi.py'],
      { 'requirements.txt': req });
    const result = await det.identifyStack('owner', 'repo');
    expect(result.primary?.id).toBe('python');
    expect(result.primary?.framework).toBe('Django');
  });

  test('détecte Python / FastAPI', async () => {
    const req = 'fastapi==0.104\nuvicorn==0.24\npydantic==2.0\n';
    const det = mockDetector(['requirements.txt', 'main.py'], { 'requirements.txt': req });
    const result = await det.identifyStack('owner', 'repo');
    expect(result.primary?.id).toBe('python');
    expect(result.primary?.framework).toBe('FastAPI');
  });

  test('détecte PHP / Laravel', async () => {
    const det = mockDetector(['composer.json', 'artisan', 'app', 'routes'], {});
    const result = await det.identifyStack('owner', 'repo');
    expect(result.primary?.id).toBe('php');
    expect(result.primary?.framework).toBe('Laravel');
  });

  test('détecte Go / Gin', async () => {
    const goMod = 'module myapp\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n';
    const det = mockDetector(['go.mod', 'go.sum', 'main.go'], { 'go.mod': goMod });
    const result = await det.identifyStack('owner', 'repo');
    expect(result.primary?.id).toBe('go');
    expect(result.primary?.framework).toBe('Gin');
  });

  test('détecte Docker Compose', async () => {
    const det = mockDetector(['docker-compose.yml', 'Dockerfile'], {});
    const result = await det.identifyStack('owner', 'repo');
    expect(result.hasDocker).toBe(true);
  });

  test('repo vide → primary null, all vide', async () => {
    const det = mockDetector([], {});
    const result = await det.identifyStack('owner', 'repo');
    expect(result.primary).toBeNull();
    expect(result.all).toHaveLength(0);
  });

  test('extrait les variables du .env.example', async () => {
    const pkg = JSON.stringify({ name: 'app' });
    const env = 'DATABASE_URL=postgres://localhost\nSECRET=changeme\nPORT=3000\n';
    const det = mockDetector(['package.json', '.env.example'], {
      'package.json': pkg,
      '.env.example': env,
    });
    const result = await det.identifyStack('owner', 'repo');
    expect(result.envVars.filter(v => !v.isComment).length).toBe(3);
    expect(result.envVars.map(v => v.key)).toContain('DATABASE_URL');
  });

  test('Node.js + Docker → primary=nodejs, hasDocker=true', async () => {
    const pkg = JSON.stringify({ name: 'dockerized-node' });
    const det = mockDetector(['package.json', 'Dockerfile'], { 'package.json': pkg });
    const result = await det.identifyStack('owner', 'repo');
    expect(result.primary?.id).toBe('nodejs');
    expect(result.hasDocker).toBe(true);
  });

  test('summary contient le nom du framework détecté', async () => {
    const pkg = JSON.stringify({ dependencies: { next: '^14' } });
    const det = mockDetector(['package.json'], { 'package.json': pkg });
    const result = await det.identifyStack('owner', 'repo');
    expect(result.summary).toContain('Next.js');
  });
});
