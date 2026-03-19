/**
 * ═══════════════════════════════════════════════════════════════
 *  tests/unit/security.test.js
 *  Tests unitaires — Fortress AES-256-GCM + Validation Zod
 * ═══════════════════════════════════════════════════════════════
 */

process.env.MASTER_SECRET = 'test_master_secret_32chars_UNIT_OK!';

const { encrypt, decrypt, verifyWebhook, validate, schemas } = require('../../utils/security');

// ── AES-256-GCM ─────────────────────────────────────────────────
describe('🔒 Fortress — AES-256-GCM', () => {

  test('encrypt() produit un payload non-vide au format iv:tag:cipher', () => {
    const payload = encrypt('GITHUB-TEST-montoken_secret');
    expect(payload).toBeTruthy();
    const parts = payload.split(':');
    expect(parts).toHaveLength(3);
    parts.forEach(p => expect(p.length).toBeGreaterThan(0));
  });

  test('decrypt(encrypt(x)) === x (round-trip fidèle)', () => {
    const original = 'GITHUB-TEST-SuperSecretToken123456789';
    const enc = encrypt(original);
    const dec = decrypt(enc);
    expect(dec).toBe(original);
  });

  test('deux encrypt() du même texte donnent des payloads différents (IV aléatoire)', () => {
    const t = 'meme_token';
    const e1 = encrypt(t);
    const e2 = encrypt(t);
    expect(e1).not.toBe(e2);          // IV différent à chaque fois
    expect(decrypt(e1)).toBe(t);       // les deux déchiffrent correctement
    expect(decrypt(e2)).toBe(t);
  });

  test('decrypt() avec payload corrompu lance une erreur', () => {
    expect(() => decrypt('INVALIDE')).toThrow();
    expect(() => decrypt('aaa:bbb:ccc')).toThrow();
  });

  test('chiffrer une chaîne vide fonctionne', () => {
    const enc = encrypt('');
    expect(decrypt(enc)).toBe('');
  });

  test('chiffrer une longue chaîne (>1kb) fonctionne', () => {
    const long = 'x'.repeat(2048);
    const enc  = encrypt(long);
    expect(decrypt(enc)).toBe(long);
  });

  test('MASTER_SECRET manquant lance une erreur', () => {
    const orig = process.env.MASTER_SECRET;
    delete process.env.MASTER_SECRET;
    // Réinitialiser le cache de la clé
    jest.resetModules();
    const { encrypt: enc2 } = require('../../utils/security');
    expect(() => enc2('test')).toThrow(/MASTER_SECRET/);
    process.env.MASTER_SECRET = orig;
    jest.resetModules();
  });
});

// ── HMAC Webhook ─────────────────────────────────────────────────
describe('🔏 Webhook HMAC-SHA256', () => {

  const secret  = 'webhook_secret_test';
  const body    = '{"event":"payment","amount":5000}';
  const crypto  = require('crypto');
  const sig     = crypto.createHmac('sha256', secret).update(body).digest('hex');

  test('verifyWebhook() valide une signature correcte', () => {
    expect(verifyWebhook(body, sig, secret)).toBe(true);
  });

  test('verifyWebhook() rejette une signature incorrecte', () => {
    expect(verifyWebhook(body, 'fakesig'.padEnd(64, '0'), secret)).toBe(false);
  });

  test('verifyWebhook() accepte le préfixe sha256=', () => {
    expect(verifyWebhook(body, `sha256=${sig}`, secret)).toBe(true);
  });

  test('verifyWebhook() rejette un body altéré', () => {
    const alteredBody = '{"event":"payment","amount":9999}';
    expect(verifyWebhook(alteredBody, sig, secret)).toBe(false);
  });
});

// ── Validation Zod ───────────────────────────────────────────────
describe('✅ Validation Zod — Schémas', () => {

  describe('githubTokenSchema', () => {
    test('accepte format GH-TOKEN', () => {
      const r = validate(schemas.githubTokenSchema, 'GITHUB-TEST-abcdefghijklmnopqrstuvwxyz12345');
      expect(r.success).toBe(true);
    });
    test('accepte format GH-SERVER', () => {
      const r = validate(schemas.githubTokenSchema, 'GITSRV-TEST-abcdefghijklmnopqrstuvwxyz12345');
      expect(r.success).toBe(true);
    });
    test('accepte format GH-PAT', () => {
      const r = validate(schemas.githubTokenSchema, 'GITPAT-TEST-abc123456789012345678901');
      expect(r.success).toBe(true);
    });
    test('rejette un token trop court', () => {
      const r = validate(schemas.githubTokenSchema, 'GITHUB-TEST-tiny');
      expect(r.success).toBe(false);
    });
    test('rejette un token sans préfixe GitHub', () => {
      const r = validate(schemas.githubTokenSchema, 'TEST-KEY-LIVE-verylongtokenthatshouldnotwork');
      expect(r.success).toBe(false);
      expect(r.errors.join(' ')).toMatch(/format/i);
    });
    test('rejette une chaîne vide', () => {
      expect(validate(schemas.githubTokenSchema, '').success).toBe(false);
    });
  });

  describe('urlSchema', () => {
    test('accepte une URL HTTPS valide', () => {
      expect(validate(schemas.urlSchema, 'https://api.github.com').success).toBe(true);
    });
    test('rejette HTTP (non sécurisé)', () => {
      expect(validate(schemas.urlSchema, 'http://api.github.com').success).toBe(false);
    });
    test('rejette une URL malformée', () => {
      expect(validate(schemas.urlSchema, 'pas-une-url').success).toBe(false);
    });
  });

  describe('deployConfigSchema', () => {
    const base = {
      owner       : 'mon-owner',
      repo        : 'mon-repo',
      branch      : 'main',
      githubToken : 'GITHUB-TEST-abcdefghijklmnopqrstuvwxyz12345',
    };

    test('valide une config correcte', () => {
      expect(validate(schemas.deployConfigSchema, base).success).toBe(true);
    });

    test('owner avec caractères invalides est rejeté', () => {
      expect(validate(schemas.deployConfigSchema, { ...base, owner: 'bad owner!' }).success).toBe(false);
    });

    test('branch par défaut = main si absente', () => {
      const { branch: _, ...noBranch } = base;
      const r = validate(schemas.deployConfigSchema, noBranch);
      expect(r.success).toBe(true);
      expect(r.data?.branch).toBe('main');
    });

    test('token invalide rejette la config', () => {
      expect(validate(schemas.deployConfigSchema, { ...base, githubToken: 'invalid' }).success).toBe(false);
    });
  });
});
