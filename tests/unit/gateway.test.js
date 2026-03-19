/**
 * ═══════════════════════════════════════════════════════════════
 *  tests/unit/gateway.test.js
 *  Tests unitaires — Connecteur Universel (core/gateway.js)
 * ═══════════════════════════════════════════════════════════════
 */

process.env.MASTER_SECRET = 'test_master_secret_32chars_UNIT_OK!';

const { createClient, request } = require('../../core/gateway');
const axios = require('axios');

// Mock axios pour éviter les vraies requêtes réseau
jest.mock('axios', () => {
  const mockInstance = {
    request      : jest.fn(),
    interceptors : {
      request  : { use: jest.fn() },
      response : { use: jest.fn() },
    },
  };
  return {
    create : jest.fn(() => mockInstance),
    _instance: mockInstance,
  };
});

describe('⚡ Gateway — createClient()', () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('crée une instance axios avec la bonne baseURL', () => {
    createClient({ baseURL: 'https://api.github.com', token: 'ghp_test' });
    expect(axios.create).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://api.github.com' })
    );
  });

  test('injecte le header Authorization avec Bearer par défaut', () => {
    createClient({ baseURL: 'https://api.example.com', token: 'my_token' });
    const callArg = axios.create.mock.calls[0][0];
    expect(callArg.headers.Authorization).toBe('Bearer my_token');
  });

  test('supporte un authScheme personnalisé (token, Basic…)', () => {
    createClient({ baseURL: 'https://api.example.com', token: 'abc', authScheme: 'token' });
    const callArg = axios.create.mock.calls[0][0];
    expect(callArg.headers.Authorization).toBe('token abc');
  });

  test('injecte les headers personnalisés', () => {
    createClient({
      baseURL : 'https://api.example.com',
      token   : 'tok',
      headers : { 'X-Custom': 'hello', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    const callArg = axios.create.mock.calls[0][0];
    expect(callArg.headers['X-Custom']).toBe('hello');
    expect(callArg.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  test('lance une erreur si baseURL est absent', () => {
    expect(() => createClient({ token: 'tok' })).toThrow(/baseURL/);
  });

  test('applique le timeout personnalisé', () => {
    createClient({ baseURL: 'https://api.example.com', timeout: 5000 });
    const callArg = axios.create.mock.calls[0][0];
    expect(callArg.timeout).toBe(5000);
  });

  test('installe les intercepteurs request et response', () => {
    const client = createClient({ baseURL: 'https://api.example.com' });
    expect(client.interceptors.request.use).toHaveBeenCalled();
    expect(client.interceptors.response.use).toHaveBeenCalled();
  });
});

describe('⚡ Gateway — request()', () => {

  let client;

  beforeEach(() => {
    jest.clearAllMocks();
    client = createClient({ baseURL: 'https://api.test.com', token: 'tok' });
    client.request = jest.fn();
  });

  test('effectue une requête GET par défaut', async () => {
    client.request.mockResolvedValue({ data: { id: 1 } });
    const result = await request(client, { endpoint: '/users' });
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', url: '/users' })
    );
    expect(result).toEqual({ id: 1 });
  });

  test('effectue une requête POST avec body', async () => {
    client.request.mockResolvedValue({ data: { created: true } });
    await request(client, { method: 'POST', endpoint: '/repos', body: { name: 'test' } });
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', data: { name: 'test' } })
    );
  });

  test('passe les query params', async () => {
    client.request.mockResolvedValue({ data: [] });
    await request(client, { endpoint: '/items', params: { page: 2, per_page: 10 } });
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({ params: { page: 2, per_page: 10 } })
    );
  });

  test('réessaie automatiquement sur erreur 500 (retry)', async () => {
    const serverError = { response: { status: 500, data: { message: 'Internal Server Error' } } };
    client.request
      .mockRejectedValueOnce(serverError)
      .mockRejectedValueOnce(serverError)
      .mockResolvedValue({ data: { ok: true } });

    const result = await request(client, { endpoint: '/flaky', retries: 2 });
    expect(client.request).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ ok: true });
  });

  test('ne réessaie PAS sur erreur 404 (erreur client)', async () => {
    const notFound = { response: { status: 404, data: { message: 'Not Found' } } };
    client.request.mockRejectedValue(notFound);
    await expect(request(client, { endpoint: '/missing', retries: 3 })).rejects.toEqual(notFound);
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  test('ne réessaie PAS sur erreur 401 (non autorisé)', async () => {
    const unauthorized = { response: { status: 401, data: {} } };
    client.request.mockRejectedValue(unauthorized);
    await expect(request(client, { endpoint: '/private' })).rejects.toEqual(unauthorized);
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  test('lève une erreur si toutes les tentatives échouent', async () => {
    const err = { response: { status: 503, data: {} } };
    client.request.mockRejectedValue(err);
    await expect(request(client, { endpoint: '/down', retries: 2 })).rejects.toEqual(err);
    expect(client.request).toHaveBeenCalledTimes(3);
  });
});
