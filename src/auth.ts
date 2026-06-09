import { timingSafeEqual } from 'crypto';

export type RegisterTokenValidation =
  | { ok: true; status: 'disabled' | 'valid' }
  | { ok: false; status: 'missing' | 'invalid'; error_code: 'REGISTER_TOKEN_REQUIRED' | 'REGISTER_TOKEN_INVALID'; error: string };

export function extractRegisterToken(args: Record<string, unknown>): string | null {
  const value = args.register_token ?? args.registration_token;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function safeTokenEquals(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

export function validateRegisterToken(configuredToken: string, args: Record<string, unknown>): RegisterTokenValidation {
  const expected = String(configuredToken || '').trim();
  if (!expected) return { ok: true, status: 'disabled' };

  const provided = extractRegisterToken(args);
  if (!provided) {
    return {
      ok: false,
      status: 'missing',
      error_code: 'REGISTER_TOKEN_REQUIRED',
      error: 'register_token is required when MCP_HUB_REGISTER_TOKEN is configured',
    };
  }

  if (!safeTokenEquals(expected, provided)) {
    return {
      ok: false,
      status: 'invalid',
      error_code: 'REGISTER_TOKEN_INVALID',
      error: 'register_token is invalid',
    };
  }

  return { ok: true, status: 'valid' };
}
