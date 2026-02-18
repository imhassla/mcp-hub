import { createHash } from 'crypto';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'zlib';
import { getIdempotencyRecord, logActivity, saveIdempotencyRecord } from './db.js';

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

export function withIdempotency<T>(agentId: string, toolName: string, idempotencyKey: string | undefined, builder: () => T): T {
  if (!idempotencyKey) return builder();
  const record = getIdempotencyRecord(agentId, toolName, idempotencyKey);
  if (record) {
    try {
      logActivity(agentId, 'idempotency_hit', `Tool=${toolName} key=${idempotencyKey}`);
      return JSON.parse(record.response_json) as T;
    } catch {
      logActivity(agentId, 'idempotency_corrupt', `Tool=${toolName}: cached response JSON could not be parsed`);
    }
  }
  const response = builder();
  saveIdempotencyRecord(agentId, toolName, idempotencyKey, response);
  return response;
}
