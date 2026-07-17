import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'zlib';
import { getDb, getIdempotencyRecord, logActivity, saveIdempotencyRecord } from './db.js';
import { runWithDeferredStreamNotifications } from './eventNotifier.js';

export interface BlobRefEnvelope {
  v: 'caep-1';
  k: 'blob';
  h: string;
  c: number;
}

interface LosslessBlobEnvelope {
  v: 'caep-blobz-1';
  alg: 'brotli-base64';
  raw_chars: number;
  raw_sha256: string;
  data: string;
}

export interface LosslessAutoResult {
  stored_value: string;
  applied: boolean;
  codec: 'raw' | 'brotli-base64';
  original_chars: number;
  stored_chars: number;
  gain_pct: number;
}

export interface LosslessDecodeResult {
  value: string;
  decoded: boolean;
  codec: 'raw' | 'brotli-base64';
  integrity_ok: boolean;
}

const LOSSLESS_AUTO_MIN_PAYLOAD_CHARS = Number.isFinite(Number(process.env.MCP_HUB_LOSSLESS_AUTO_MIN_PAYLOAD_CHARS))
  ? Math.max(0, Math.floor(Number(process.env.MCP_HUB_LOSSLESS_AUTO_MIN_PAYLOAD_CHARS)))
  : 1024;
const LOSSLESS_AUTO_MIN_GAIN_PCT = Number.isFinite(Number(process.env.MCP_HUB_LOSSLESS_AUTO_MIN_GAIN_PCT))
  ? Math.max(0, Math.min(100, Number(process.env.MCP_HUB_LOSSLESS_AUTO_MIN_GAIN_PCT)))
  : 3;
export const MAX_IDEMPOTENCY_KEY_CHARS = 256;
const IDEMPOTENCY_FINGERPRINT_EXCLUDED_KEYS = new Set([
  'idempotency_key',
  'auth_token',
  'register_token',
  'registration_token',
]);
const VOLATILE_IDEMPOTENCY_TOOLS = new Set([
  'create_artifact_upload',
  'create_artifact_download',
  'create_task_artifact_downloads',
]);
const VOLATILE_RESPONSE_ENCRYPTION_KEY = randomBytes(32);

interface EncryptedIdempotencyResponse {
  v: 'idempotency-aes-gcm-1';
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeJsonString(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value;
  }
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const row = value as Record<string, unknown>;
    const entries = Object.keys(row)
      .filter((key) => row[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`);
    return `{${entries.join(',')}}`;
  }
  return 'null';
}

export function idempotencyRequestHash(request: unknown): string {
  let semanticRequest = request;
  if (request && typeof request === 'object' && !Array.isArray(request)) {
    semanticRequest = Object.fromEntries(
      Object.entries(request as Record<string, unknown>)
        .filter(([key]) => !IDEMPOTENCY_FINGERPRINT_EXCLUDED_KEYS.has(key)),
    );
  }
  return `v1:${sha256Hex(canonicalJson(semanticRequest))}`;
}

function idempotencyResponseAad(agentId: string, toolName: string, idempotencyKey: string, requestHash: string): Buffer {
  return Buffer.from(canonicalJson([agentId, toolName, idempotencyKey, requestHash]), 'utf8');
}

function encryptVolatileIdempotencyResponse(
  response: unknown,
  agentId: string,
  toolName: string,
  idempotencyKey: string,
  requestHash: string,
): EncryptedIdempotencyResponse {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', VOLATILE_RESPONSE_ENCRYPTION_KEY, iv);
  cipher.setAAD(idempotencyResponseAad(agentId, toolName, idempotencyKey, requestHash));
  const plaintext = Buffer.from(JSON.stringify(response), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: 'idempotency-aes-gcm-1',
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptVolatileIdempotencyResponse<T>(
  stored: unknown,
  agentId: string,
  toolName: string,
  idempotencyKey: string,
  requestHash: string,
): T | null {
  if (!stored || typeof stored !== 'object') return null;
  const envelope = stored as Partial<EncryptedIdempotencyResponse>;
  if (envelope.v !== 'idempotency-aes-gcm-1'
    || envelope.alg !== 'aes-256-gcm'
    || typeof envelope.iv !== 'string'
    || typeof envelope.tag !== 'string'
    || typeof envelope.data !== 'string') {
    return null;
  }
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      VOLATILE_RESPONSE_ENCRYPTION_KEY,
      Buffer.from(envelope.iv, 'base64'),
    );
    decipher.setAAD(idempotencyResponseAad(agentId, toolName, idempotencyKey, requestHash));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext) as T;
  } catch {
    return null;
  }
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export function makeBlobRefEnvelope(hash: string, payloadChars: number): string {
  return JSON.stringify({ v: 'caep-1', k: 'blob', h: hash, c: payloadChars } satisfies BlobRefEnvelope);
}

export function parseBlobRefEnvelope(content: string): { hash: string; declared_chars: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const row = parsed as Record<string, unknown>;
  if (row.v !== 'caep-1' || row.k !== 'blob' || typeof row.h !== 'string') return null;
  const declaredChars = Number.isFinite(row.c) ? Math.max(0, Math.floor(Number(row.c))) : 0;
  return { hash: row.h, declared_chars: declaredChars };
}

export function encodeLosslessBlobPayloadAuto(
  value: string,
  options: { min_payload_chars?: number; min_gain_pct?: number } = {}
): LosslessAutoResult {
  const originalChars = value.length;
  const minPayloadChars = Number.isFinite(options.min_payload_chars)
    ? Math.max(0, Math.floor(Number(options.min_payload_chars)))
    : LOSSLESS_AUTO_MIN_PAYLOAD_CHARS;
  const minGainPct = Number.isFinite(options.min_gain_pct)
    ? Math.max(0, Math.min(100, Number(options.min_gain_pct)))
    : LOSSLESS_AUTO_MIN_GAIN_PCT;
  if (originalChars < minPayloadChars) {
    return {
      stored_value: value,
      applied: false,
      codec: 'raw',
      original_chars: originalChars,
      stored_chars: originalChars,
      gain_pct: 0,
    };
  }

  try {
    const raw = Buffer.from(value, 'utf8');
    const compressed = brotliCompressSync(raw, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
        [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
      },
    });
    const envelope: LosslessBlobEnvelope = {
      v: 'caep-blobz-1',
      alg: 'brotli-base64',
      raw_chars: originalChars,
      raw_sha256: sha256Hex(value),
      data: compressed.toString('base64'),
    };
    const storedValue = JSON.stringify(envelope);
    const gainRaw = originalChars === 0 ? 0 : ((originalChars - storedValue.length) / originalChars) * 100;
    const gainPct = Math.round(gainRaw * 100) / 100;
    if (storedValue.length < originalChars && gainPct >= minGainPct) {
      return {
        stored_value: storedValue,
        applied: true,
        codec: 'brotli-base64',
        original_chars: originalChars,
        stored_chars: storedValue.length,
        gain_pct: gainPct,
      };
    }
    return {
      stored_value: value,
      applied: false,
      codec: 'raw',
      original_chars: originalChars,
      stored_chars: originalChars,
      gain_pct: gainPct,
    };
  } catch {
    return {
      stored_value: value,
      applied: false,
      codec: 'raw',
      original_chars: originalChars,
      stored_chars: originalChars,
      gain_pct: 0,
    };
  }
}

export function decodeLosslessBlobPayload(value: string): LosslessDecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { value, decoded: false, codec: 'raw', integrity_ok: true };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { value, decoded: false, codec: 'raw', integrity_ok: true };
  }
  const row = parsed as Record<string, unknown>;
  if (row.v !== 'caep-blobz-1' || row.alg !== 'brotli-base64' || typeof row.data !== 'string') {
    return { value, decoded: false, codec: 'raw', integrity_ok: true };
  }
  try {
    const compressed = Buffer.from(row.data, 'base64');
    const raw = brotliDecompressSync(compressed).toString('utf8');
    const declaredChars = Number.isFinite(row.raw_chars) ? Math.max(0, Math.floor(Number(row.raw_chars))) : raw.length;
    const expectedHash = typeof row.raw_sha256 === 'string' ? row.raw_sha256 : '';
    const hashMatches = expectedHash.length > 0 ? sha256Hex(raw) === expectedHash : true;
    if (!hashMatches || raw.length !== declaredChars) {
      return { value, decoded: false, codec: 'raw', integrity_ok: false };
    }
    return { value: raw, decoded: true, codec: 'brotli-base64', integrity_ok: true };
  } catch {
    return { value, decoded: false, codec: 'raw', integrity_ok: false };
  }
}

export function withIdempotency<T>(
  agentId: string,
  toolName: string,
  idempotencyKey: string | undefined,
  request: unknown,
  builder: () => T,
): T {
  if (idempotencyKey === undefined || idempotencyKey.length === 0) return builder();
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARS) {
    return {
      success: false,
      error_code: 'IDEMPOTENCY_KEY_INVALID',
      error: `idempotency_key must be at most ${MAX_IDEMPOTENCY_KEY_CHARS} characters`,
      max_chars: MAX_IDEMPOTENCY_KEY_CHARS,
    } as T;
  }

  const requestHash = idempotencyRequestHash(request);
  const hasVolatileResponse = VOLATILE_IDEMPOTENCY_TOOLS.has(toolName);
  type Outcome =
    | { kind: 'executed'; response: T }
    | { kind: 'replayed'; response: T }
    | { kind: 'legacy' }
    | { kind: 'conflict' }
    | { kind: 'corrupt' }
    | { kind: 'volatile-expired' };

  const outcome = runWithDeferredStreamNotifications(() => {
    const transaction = getDb().transaction((): Outcome => {
      const record = getIdempotencyRecord(agentId, toolName, idempotencyKey);
      if (record) {
        if (record.request_hash === null) {
          return { kind: hasVolatileResponse ? 'volatile-expired' : 'legacy' };
        }
        if (record.request_hash !== requestHash) return { kind: 'conflict' };
        try {
          const storedResponse = JSON.parse(record.response_json) as unknown;
          if (hasVolatileResponse) {
            const response = decryptVolatileIdempotencyResponse<T>(
              storedResponse,
              agentId,
              toolName,
              idempotencyKey,
              requestHash,
            );
            return response === null
              ? { kind: 'volatile-expired' }
              : { kind: 'replayed', response };
          }
          return { kind: 'replayed', response: storedResponse as T };
        } catch {
          return { kind: hasVolatileResponse ? 'volatile-expired' : 'corrupt' };
        }
      }

      const response = builder();
      const storedResponse = hasVolatileResponse
        ? encryptVolatileIdempotencyResponse(response, agentId, toolName, idempotencyKey, requestHash)
        : response;
      if (!saveIdempotencyRecord(agentId, toolName, idempotencyKey, storedResponse, requestHash)) {
        throw new Error('IDEMPOTENCY_RECORD_INSERT_FAILED');
      }
      return { kind: 'executed', response };
    });
    return transaction.immediate();
  });

  if (outcome.kind === 'replayed') {
    logActivity(agentId, 'idempotency_hit', `Tool=${toolName} key=${idempotencyKey}`);
    return outcome.response;
  }
  if (outcome.kind === 'executed') return outcome.response;
  if (outcome.kind === 'legacy') {
    logActivity(agentId, 'idempotency_legacy_record', `Tool=${toolName} key=${idempotencyKey}`);
    return {
      success: false,
      error_code: 'IDEMPOTENCY_LEGACY_RECORD',
      error: 'This idempotency_key predates payload fingerprints and cannot be safely replayed; use a new key',
    } as T;
  }
  if (outcome.kind === 'conflict') {
    logActivity(agentId, 'idempotency_conflict', `Tool=${toolName} key=${idempotencyKey}`);
    return {
      success: false,
      error_code: 'IDEMPOTENCY_KEY_CONFLICT',
      error: 'This idempotency_key was already used with different arguments',
    } as T;
  }
  if (outcome.kind === 'volatile-expired') {
    logActivity(agentId, 'idempotency_volatile_response_expired', `Tool=${toolName} key=${idempotencyKey}`);
    return {
      success: false,
      error_code: 'IDEMPOTENCY_VOLATILE_RESPONSE_EXPIRED',
      error: 'The cached response contained a process-local ticket that is no longer available; use a new idempotency_key',
    } as T;
  }

  logActivity(agentId, 'idempotency_corrupt', `Tool=${toolName}: cached response JSON could not be parsed`);
  return {
    success: false,
    error_code: 'IDEMPOTENCY_RECORD_CORRUPT',
    error: 'The cached idempotency response is corrupt and cannot be safely replayed',
  } as T;
}
