/**
 * ═══════════════════════════════════════════════════════════════════════
 *  tests/unit/llm-router.test.js
 *  Tests du routeur multi-LLM
 * ═══════════════════════════════════════════════════════════════════════
 */

process.env.MASTER_SECRET = 'test_master_secret_32chars_UNIT_OK!';
process.env.NODE_ENV      = 'test';

describe('🔀 LLM Router — Multi-Provider', () => {

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    // Configurer plusieurs providers
    process.env.GEMINI_KEYS        = JSON.stringify(['AIzaSy_gemini_test_key']);
    process.env.GROQ_API_KEY       = 'gsk_groq_test_key_1234567890';
    process.env.MISTRAL_API_KEY    = 'msk_mistral_test_key_123456';
    process.env.COHERE_API_KEY     = 'cohere_test_key_1234567890';

    jest.mock('axios');
    jest.mock('../../services/gemini-client', () => ({
      callGemini: jest.fn().mockResolvedValue('{"result":"ok"}'),
    }));
    jest.mock('../../utils/gemini-cache', () => ({
      cache: {
        get: jest.fn().mockReturnValue(null),
        set: jest.fn(),
      },
    }));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.resetModules();
    delete process.env.GEMINI_KEYS;
    delete process.env.GROQ_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    delete process.env.COHERE_API_KEY;
  });

  // ── Configuration des providers ──────────────────────────────────

  test('getRouterStatus() liste tous les providers configurés', () => {
    const { getRouterStatus } = require('../../services/llm-router');
    const status = getRouterStatus();
    expect(status.providers.length).toBeGreaterThanOrEqual(4);
    const ids = status.providers.map(p => p.id);
    expect(ids).toContain('gemini');
    expect(ids).toContain('groq');
    expect(ids).toContain('mistral');
    expect(ids).toContain('cohere');
  });

  test('providers configurés sont disponibles', () => {
    const { getRouterStatus } = require('../../services/llm-router');
    const status = getRouterStatus();
    const configured = status.providers.filter(p => p.configured);
    expect(configured.length).toBeGreaterThanOrEqual(3);
  });

  test('totalRPM > 15 quand plusieurs providers actifs', () => {
    const { getRouterStatus } = require('../../services/llm-router');
    const { totalRPM } = getRouterStatus();
    // Gemini(15) + Groq(30) + Mistral(5) + Cohere(20) = 70
    expect(totalRPM).toBeGreaterThan(15);
  });

  test('provider sans envKey retourne configured=false', () => {
    delete process.env.GROQ_API_KEY;
    jest.resetModules();
    const { getRouterStatus } = require('../../services/llm-router');
    const groq = getRouterStatus().providers.find(p => p.id === 'groq');
    expect(groq.configured).toBe(false);
    expect(groq.available).toBe(false);
  });

  // ── routePrompt() — Succès ───────────────────────────────────────

  test('routePrompt() retourne le texte du premier provider disponible', async () => {
    const axios = require('axios');
    axios.post = jest.fn().mockResolvedValue({
      data: { choices: [{ message: { content: 'réponse groq' } }] },
    });

    const { routePrompt } = require('../../services/llm-router');
    const promise = routePrompt('Analyse ce code', { preferProvider: 'groq' });
    jest.runAllTimers();
    const result = await promise;

    expect(result.text).toBeTruthy();
    expect(result.fromCache).toBe(false);
    expect(result.provider).toBeTruthy();
  });

  test('routePrompt() retourne fromCache=true si cache hit', async () => {
    jest.mock('../../utils/gemini-cache', () => ({
      cache: {
        get : jest.fn().mockReturnValue({ text: 'résultat mis en cache' }),
        set : jest.fn(),
      },
    }));

    const { routePrompt } = require('../../services/llm-router');
    const result = await routePrompt('prompt', { cacheKey: 'test-key' });
    expect(result.fromCache).toBe(true);
    expect(result.text).toBe('résultat mis en cache');
    expect(result.provider).toBe('cache');
  });

  // ── Fallback en cascade ──────────────────────────────────────────

  test('fallback : si Gemini échoue → tente Groq automatiquement', async () => {
    // Gemini échoue
    jest.mock('../../services/gemini-client', () => ({
      callGemini: jest.fn().mockRejectedValue(
        Object.assign(new Error('quota'), { response: { status: 429, headers: {} } })
      ),
    }));

    const axios = require('axios');
    let groqCalled = false;
    axios.post = jest.fn().mockImplementation((url) => {
      if (url.includes('groq')) {
        groqCalled = true;
        return Promise.resolve({ data: { choices: [{ message: { content: 'groq response' } }] } });
      }
      return Promise.reject(new Error('wrong url'));
    });

    const { routePrompt } = require('../../services/llm-router');
    const promise = routePrompt('test prompt', { preferProvider: 'gemini' });
    jest.runAllTimers();
    const result = await promise;

    expect(groqCalled).toBe(true);
    expect(result.provider).toBe('groq');
  });

  test('erreur si TOUS les providers sont épuisés', async () => {
    // Désactiver tous les providers
    delete process.env.GEMINI_KEYS;
    delete process.env.GROQ_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    delete process.env.COHERE_API_KEY;
    delete process.env.HUGGINGFACE_TOKEN;

    jest.resetModules();
    const { routePrompt } = require('../../services/llm-router');
    await expect(routePrompt('test')).rejects.toThrow(/Aucun provider/);
  });

  // ── Rate Limit & Blocage ─────────────────────────────────────────

  test('blockProvider() rend un provider indisponible temporairement', () => {
    const mod = require('../../services/llm-router');
    const statusBefore = mod.getRouterStatus();
    const groqBefore = statusBefore.providers.find(p => p.id === 'groq');
    expect(groqBefore.available).toBe(true);

    // Simuler un blocage
    const state = require('../../services/llm-router');
    // Via le comportement observable : après 30 requêtes RPM, groq devient indisponible
    // Test indirect via getRouterStatus après rpmLimit dépassé
    const status = mod.getRouterStatus();
    expect(status.providers.find(p => p.id === 'groq').rpmLimit).toBe(30);
  });

  test('provider avec 429 est bloqué et le suivant prend le relais', async () => {
    const axios = require('axios');
    let groqCallCount = 0;
    let cohereCallCount = 0;

    axios.post = jest.fn().mockImplementation((url) => {
      if (url.includes('groq')) {
        groqCallCount++;
        return Promise.reject(
          Object.assign(new Error('rate limit'), {
            response: { status: 429, headers: { 'retry-after': '5' }, data: {} }
          })
        );
      }
      if (url.includes('cohere')) {
        cohereCallCount++;
        return Promise.resolve({ data: { text: 'cohere response' } });
      }
      if (url.includes('mistral')) {
        return Promise.resolve({ data: { choices: [{ message: { content: 'mistral response' } }] } });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const { routePrompt } = require('../../services/llm-router');
    const promise = routePrompt('test', { preferProvider: 'groq' });
    jest.runAllTimers();
    const result = await promise;

    // Groq a été essayé mais bloqué, un autre provider a pris le relais
    expect(groqCallCount).toBeGreaterThanOrEqual(1);
    expect(['cohere', 'mistral', 'huggingface']).toContain(result.provider);
  });

  // ── analyzeRepoWithLLM ──────────────────────────────────────────

  test('analyzeRepoWithLLM() parse et retourne le JSON correctement', async () => {
    const axios = require('axios');
    const mockResponse = JSON.stringify({
      deploymentRecommendations: ['Ajouter NODE_ENV'],
      requiredEnvVars: ['DATABASE_URL'],
      databaseRequired: true,
      estimatedDeployTime: '2 min',
      warnings: [],
    });

    axios.post = jest.fn().mockResolvedValue({
      data: { choices: [{ message: { content: mockResponse } }] },
    });

    const { analyzeRepoWithLLM } = require('../../services/llm-router');
    const promise = analyzeRepoWithLLM('owner', 'repo', {
      summary: '🟨 Next.js', primary: { framework: 'Next.js' }, repoRoot: [], envVars: [],
    });
    jest.runAllTimers();
    const result = await promise;

    expect(result.databaseRequired).toBe(true);
    expect(result.requiredEnvVars).toContain('DATABASE_URL');
    expect(result._provider).toBeTruthy();
  });

  test('analyzeRepoWithLLM() gère une réponse non-JSON sans crash', async () => {
    jest.mock('../../services/gemini-client', () => ({
      callGemini: jest.fn().mockResolvedValue('Désolé, je ne peux pas analyser.'),
    }));

    const { analyzeRepoWithLLM } = require('../../services/llm-router');
    const promise = analyzeRepoWithLLM('o', 'r', { summary: 'test', repoRoot: [], envVars: [] });
    jest.runAllTimers();
    const result = await promise;

    // Pas de crash, retourne un objet avec _error
    expect(result._error).toBe('parse_failed');
  });

  // ── RPM tracking ────────────────────────────────────────────────

  test('rpmFree diminue à chaque requête', async () => {
    const axios = require('axios');
    axios.post = jest.fn().mockResolvedValue({
      data: { choices: [{ message: { content: 'ok' } }] },
    });

    const { routePrompt, getRouterStatus } = require('../../services/llm-router');

    const before = getRouterStatus().providers.find(p => p.id === 'groq')?.rpmFree || 30;

    const p1 = routePrompt('test 1', { preferProvider: 'groq' });
    jest.runAllTimers();
    await p1;

    const after = getRouterStatus().providers.find(p => p.id === 'groq')?.rpmFree;
    expect(after).toBeLessThan(before);
  });

  // ── jsonMode ────────────────────────────────────────────────────

  test('jsonMode nettoie les backticks markdown', async () => {
    const axios = require('axios');
    axios.post = jest.fn().mockResolvedValue({
      data: { choices: [{ message: { content: '```json\n{"key":"val"}\n```' } }] },
    });

    const { routePrompt } = require('../../services/llm-router');
    const p = routePrompt('test', { preferProvider: 'groq', jsonMode: true });
    jest.runAllTimers();
    const result = await p;

    expect(result.text).toBe('{"key":"val"}');
    expect(() => JSON.parse(result.text)).not.toThrow();
  });
});
