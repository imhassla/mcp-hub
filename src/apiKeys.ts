import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { getDb } from './db.js';

export type ApiKeyRecord = {
  id: string;
  name: string;
  token_id: string;
  token_hash: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
};

export type ApiKeyValidation =
  | { valid: true; record: ApiKeyRecord; claims: Record<string, unknown> }
  | { valid: false; reason: string; kid?: string; jti?: string };

const API_KEY_NAME_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const JWT_AUDIENCE = 'mcp-hub-api';
const JWT_ISSUER = 'mcp-hub';

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function base64UrlJson(value: Record<string, unknown>): string {
  return base64UrlEncode(JSON.stringify(value));
}

function base64UrlDecode(value: string): Buffer | null {
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    return null;
  }
}

function parseJsonPart(part: string): Record<string, unknown> | null {
  const decoded = base64UrlDecode(part);
  if (!decoded) return null;
  try {
    const value = JSON.parse(decoded.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function hmacSignature(signingInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signingInput).digest('base64url');
}

function safeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function validateApiKeyName(name: string): string {
  const normalized = String(name || '').trim();
  if (!API_KEY_NAME_RE.test(normalized)) {
    throw new Error('API key name must match [a-z][a-z0-9._-]{0,63}');
  }
  return normalized;
}

export function parseExpiration(value?: string): number | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;
  const match = raw.match(/^([1-9][0-9]*)([smhdw])$/);
  if (!match) {
    throw new Error('--exp must use a duration like 30d, 12h, 90m, or 3600s');
  }
  const count = Number(match[1]);
  const unit = match[2];
  const secondsByUnit: Record<string, number> = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
    w: 7 * 24 * 60 * 60,
  };
  return Date.now() + count * secondsByUnit[unit] * 1000;
}

export function createApiKey(name: string, secret: string, options: { expiresAt?: number | null } = {}): {
  record: ApiKeyRecord;
  token: string;
} {
  if (!secret) throw new Error('MCP_HUB_API_JWT_SECRET is required');
  const normalizedName = validateApiKeyName(name);
  const now = Date.now();
  const id = randomUUID();
  const tokenId = randomUUID();
  const expiresAt = Number.isFinite(options.expiresAt) ? Math.floor(options.expiresAt as number) : null;
  const header = {
    alg: 'HS256',
    typ: 'JWT',
    kid: normalizedName,
  };
  const claims: Record<string, unknown> = {
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    kid: normalizedName,
    jti: tokenId,
    iat: Math.floor(now / 1000),
  };
  if (expiresAt) claims.exp = Math.floor(expiresAt / 1000);
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const token = `${signingInput}.${hmacSignature(signingInput, secret)}`;
  const tokenHash = hashApiToken(token);
  const db = getDb();
  const record = db.transaction(() => {
    const active = db
      .prepare('SELECT id FROM api_keys WHERE name = ? AND revoked_at IS NULL LIMIT 1')
      .get(normalizedName);
    if (active) {
      throw new Error(`active API key already exists for name "${normalizedName}"; revoke it before creating another`);
    }
    db.prepare(`
      INSERT INTO api_keys (id, name, token_id, token_hash, created_at, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(id, normalizedName, tokenId, tokenHash, now, expiresAt);
    return db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKeyRecord;
  })();
  return { record, token };
}

export function listApiKeys(options: { includeAll?: boolean } = {}): ApiKeyRecord[] {
  const where = options.includeAll ? '' : 'WHERE revoked_at IS NULL';
  return getDb()
    .prepare(`SELECT * FROM api_keys ${where} ORDER BY created_at DESC`)
    .all() as ApiKeyRecord[];
}

export function revokeApiKey(name: string, now = Date.now()): number {
  const normalizedName = validateApiKeyName(name);
  const result = getDb()
    .prepare('UPDATE api_keys SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL')
    .run(now, normalizedName);
  return result.changes;
}

export function validateApiKeyToken(token: string, secret: string, now = Date.now()): ApiKeyValidation {
  if (!secret) return { valid: false, reason: 'missing_secret' };
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };
  const [headerPart, claimsPart, signaturePart] = parts;
  const header = parseJsonPart(headerPart);
  const claims = parseJsonPart(claimsPart);
  if (!header || !claims) return { valid: false, reason: 'malformed' };
  const kid = typeof claims.kid === 'string' ? claims.kid : (typeof header.kid === 'string' ? header.kid : undefined);
  const jti = typeof claims.jti === 'string' ? claims.jti : undefined;
  if (header.alg !== 'HS256') return { valid: false, reason: 'unsupported_alg', kid, jti };
  if (header.typ && header.typ !== 'JWT') return { valid: false, reason: 'unsupported_typ', kid, jti };
  const signingInput = `${headerPart}.${claimsPart}`;
  const expectedSignature = hmacSignature(signingInput, secret);
  if (!safeEqualString(signaturePart, expectedSignature)) {
    return { valid: false, reason: 'bad_signature', kid, jti };
  }
  if (claims.aud !== JWT_AUDIENCE) return { valid: false, reason: 'bad_audience', kid, jti };
  if (claims.iss && claims.iss !== JWT_ISSUER) return { valid: false, reason: 'bad_issuer', kid, jti };
  if (!kid || !jti) return { valid: false, reason: 'missing_claims', kid, jti };
  const exp = Number(claims.exp);
  if (Number.isFinite(exp) && exp > 0 && now >= exp * 1000) {
    return { valid: false, reason: 'expired', kid, jti };
  }
  const tokenHash = hashApiToken(token);
  const record = getDb()
    .prepare('SELECT * FROM api_keys WHERE token_id = ? AND token_hash = ?')
    .get(jti, tokenHash) as ApiKeyRecord | undefined;
  if (!record) return { valid: false, reason: 'not_found', kid, jti };
  if (record.revoked_at !== null && record.revoked_at !== undefined) {
    return { valid: false, reason: 'revoked', kid, jti };
  }
  if (record.expires_at && now >= record.expires_at) {
    return { valid: false, reason: 'expired', kid, jti };
  }
  if (record.name !== kid) return { valid: false, reason: 'kid_mismatch', kid, jti };
  return { valid: true, record, claims };
}
