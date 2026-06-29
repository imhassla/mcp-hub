import { describe, expect, it } from 'vitest';
import { extractRegisterToken, validateRegisterToken } from '../src/auth.js';

describe('registration auth helpers', () => {
  it('disables register token validation when no secret is configured', () => {
    expect(validateRegisterToken('', {})).toEqual({ ok: true, status: 'disabled' });
  });

  it('rejects registration when a configured token is missing', () => {
    const result = validateRegisterToken('secret', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('missing');
    expect(result.error_code).toBe('REGISTER_TOKEN_REQUIRED');
  });

  it('rejects registration when token does not match', () => {
    const result = validateRegisterToken('secret', { register_token: 'wrong' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('invalid');
    expect(result.error_code).toBe('REGISTER_TOKEN_INVALID');
  });

  it('accepts the exact register token and trims caller input', () => {
    expect(validateRegisterToken('secret', { register_token: ' secret ' })).toEqual({ ok: true, status: 'valid' });
  });

  it('extracts the explicit registration token aliases only', () => {
    expect(extractRegisterToken({ registration_token: ' alias ' })).toBe('alias');
    expect(extractRegisterToken({ auth_token: 'not-registration' })).toBeNull();
  });
});
