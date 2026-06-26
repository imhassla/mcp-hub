import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeDb, initDb } from '../src/db.js';
import {
  createApiKey,
  listApiKeys,
  parseExpiration,
  revokeApiKey,
  validateApiKeyToken,
} from '../src/apiKeys.js';

const SECRET = 'test-secret-with-enough-entropy';

beforeEach(() => {
  initDb(':memory:');
});

afterEach(() => {
  closeDb();
});

describe('api keys', () => {
  it('creates and validates an HS256 JWT API key', () => {
    const created = createApiKey('primary', SECRET);
    const validation = validateApiKeyToken(created.token, SECRET);

    expect(created.record.name).toBe('primary');
    expect(validation.valid).toBe(true);
    if (!validation.valid) return;
    expect(validation.record.token_id).toBe(created.record.token_id);
    expect(validation.claims.kid).toBe('primary');
    expect(validation.claims.jti).toBe(created.record.token_id);
  });

  it('rejects malformed, wrongly signed, expired, and revoked keys', () => {
    const expired = createApiKey('expired', SECRET, { expiresAt: Date.now() - 1000 });
    expect(validateApiKeyToken('not-a-jwt', SECRET)).toMatchObject({ valid: false, reason: 'malformed' });
    expect(validateApiKeyToken(expired.token, 'wrong-secret')).toMatchObject({ valid: false, reason: 'bad_signature' });
    expect(validateApiKeyToken(expired.token, SECRET)).toMatchObject({ valid: false, reason: 'expired' });

    const active = createApiKey('revocable', SECRET);
    expect(revokeApiKey('revocable')).toBe(1);
    expect(validateApiKeyToken(active.token, SECRET)).toMatchObject({ valid: false, reason: 'revoked' });
  });

  it('keeps active names unique and allows reuse after revoke', () => {
    const first = createApiKey('codex-01', SECRET);
    expect(() => createApiKey('codex-01', SECRET)).toThrow(/active API key already exists/);

    expect(revokeApiKey('codex-01')).toBe(1);
    const second = createApiKey('codex-01', SECRET);

    expect(second.record.id).not.toBe(first.record.id);
    expect(second.record.token_id).not.toBe(first.record.token_id);
    expect(listApiKeys()).toHaveLength(1);
    expect(listApiKeys({ includeAll: true })).toHaveLength(2);
  });

  it('validates names and parses --exp durations', () => {
    expect(() => createApiKey('Primary', SECRET)).toThrow(/API key name must match/);
    expect(() => parseExpiration('30days')).toThrow(/--exp must use/);
    expect(parseExpiration('1s')).toBeGreaterThan(Date.now());
  });
});
