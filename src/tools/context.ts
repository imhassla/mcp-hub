import { createHash } from 'crypto';
import {
  shareContext,
  getContext,
  heartbeat,
  logActivity,
  putProtocolBlob,
  getProtocolBlob,
} from '../db.js';
import type { Context } from '../types.js';
import {
  withIdempotency,
  normalizeJsonString,
  collapseWhitespace,
  sha256Hex,
  estimateTokens,
  makeBlobRefEnvelope,
  parseBlobRefEnvelope,
  encodeLosslessBlobPayloadAuto,
  decodeLosslessBlobPayload,
} from '../utils.js';

const MAX_CONTEXT_VALUE_CHARS = Number(process.env.MCP_HUB_MAX_CONTEXT_VALUE_CHARS || 2048);
const MAX_PROTOCOL_BLOB_CHARS = Number(process.env.MCP_HUB_MAX_PROTOCOL_BLOB_CHARS || 32 * 1024);
const DEFAULT_CONTEXT_LIMIT = 100;
const MAX_CONTEXT_LIMIT = 500;
const DISALLOW_FULL_IN_POLLING = process.env.MCP_HUB_DISALLOW_FULL_IN_POLLING !== '0';

interface ContextBlobRef {
  hash: string;
  declared_chars: number;
  resolved: boolean;
  codec?: 'raw' | 'brotli-base64';
  integrity_ok?: boolean;
}

interface ResolvedContext extends Context {
  blob_ref?: ContextBlobRef;
  resolved_value?: string | null;
}

function maybeCompressValue(value: string, mode: 'none' | 'json' | 'whitespace' | 'auto'): { value: string; compressed: boolean } {
  if (mode === 'none') return { value, compressed: false };
  if (mode === 'json') {
    const normalized = normalizeJsonString(value);
    return { value: normalized, compressed: normalized !== value };
  }
  if (mode === 'whitespace') {
    const collapsed = collapseWhitespace(value);
    return { value: collapsed, compressed: collapsed !== value };
  }
  const jsonNormalized = normalizeJsonString(value);
  const whitespaceCollapsed = collapseWhitespace(value);
  const best = [value, jsonNormalized, whitespaceCollapsed].reduce((current, candidate) => candidate.length < current.length ? candidate : current, value);
  const compressed = best.length <= Math.floor(value.length * 0.95);
  return { value: compressed ? best : value, compressed };
}

function estimateEntropy(input: string): number {
  if (!input) return 0;
  const counts = new Map<string, number>();
  for (const char of input) {
    counts.set(char, (counts.get(char) || 0) + 1);
  }
  const length = input.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / length;
    entropy -= p * Math.log2(p);
  }
  return Math.round(entropy * 1000) / 1000;
}

function valueDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function handleShareContext(args: {
  agent_id: string;
  key: string;
  value: string;
  namespace?: string;
  trace_id?: string;
  span_id?: string;
  compression_mode?: 'none' | 'json' | 'whitespace' | 'auto';
  idempotency_key?: string;
}) {
  heartbeat(args.agent_id);
  return withIdempotency(args.agent_id, 'share_context', args.idempotency_key, () => {
    const compressionMode = args.compression_mode || 'auto';
    const compressed = maybeCompressValue(args.value, compressionMode);
    if (compressed.value.length > MAX_CONTEXT_VALUE_CHARS) {
      const error = `Context value too long (${compressed.value.length} chars). Max is ${MAX_CONTEXT_VALUE_CHARS}.`;
      logActivity(args.agent_id, 'share_context_rejected', error);
      return { success: false, error_code: 'VALUE_TOO_LONG', error, max_chars: MAX_CONTEXT_VALUE_CHARS };
    }
    const contextNamespace = (args.namespace || 'default').trim() || 'default';
    const ctx = shareContext(args.agent_id, args.key, compressed.value, args.trace_id, args.span_id, contextNamespace);
    const savedChars = args.value.length - compressed.value.length;
    logActivity(
      args.agent_id,
      'share_context',
      `Shared context key="${args.key}" ns=${contextNamespace} compressed=${compressed.compressed} saved_chars=${savedChars}`
    );
    return {
      success: true,
      context: ctx,
      compression: {
        mode: compressionMode,
        applied: compressed.compressed,
        original_chars: args.value.length,
        stored_chars: compressed.value.length,
      },
    };
  });
}

export function handleShareBlobContext(args: {
  agent_id: string;
  key: string;
  payload: string;
  namespace?: string;
  trace_id?: string;
  span_id?: string;
  compression_mode?: 'none' | 'json' | 'whitespace' | 'auto' | 'lossless_auto';
  hash_truncate?: number;
  idempotency_key?: string;
}) {
  heartbeat(args.agent_id);
  return withIdempotency(args.agent_id, 'share_blob_context', args.idempotency_key, () => {
    const compressionMode = args.compression_mode || 'lossless_auto';
    const compressed = compressionMode === 'lossless_auto'
      ? (() => {
        const lossless = encodeLosslessBlobPayloadAuto(args.payload);
        return {
          value: lossless.stored_value,
          compressed: lossless.applied,
          codec: lossless.codec,
          lossless: true,
          gain_pct: lossless.gain_pct,
        };
      })()
      : (() => {
        const c = maybeCompressValue(args.payload, compressionMode);
        const gainPct = args.payload.length === 0 ? 0 : Math.round((((args.payload.length - c.value.length) / args.payload.length) * 100) * 100) / 100;
        return {
          value: c.value,
          compressed: c.compressed,
          codec: c.compressed ? (compressionMode === 'json' ? 'json' : (compressionMode === 'whitespace' ? 'whitespace' : 'raw')) : 'raw',
          lossless: false,
          gain_pct: gainPct,
        };
      })();
    if (compressed.value.length > MAX_PROTOCOL_BLOB_CHARS) {
      const error = `Blob payload too long (${compressed.value.length} chars). Max is ${MAX_PROTOCOL_BLOB_CHARS}.`;
      logActivity(args.agent_id, 'share_blob_context_rejected', error);
      return { success: false, error_code: 'BLOB_TOO_LONG', error, max_chars: MAX_PROTOCOL_BLOB_CHARS };
    }

    const fullHash = sha256Hex(compressed.value);
    const shortLen = Number.isFinite(args.hash_truncate) ? Math.max(8, Math.min(64, Math.floor(Number(args.hash_truncate)))) : 16;
    const { created } = putProtocolBlob(fullHash, compressed.value);
    const refValue = makeBlobRefEnvelope(fullHash, compressed.value.length);

    if (refValue.length > MAX_CONTEXT_VALUE_CHARS) {
      const error = `Blob reference value too long (${refValue.length} chars). Max is ${MAX_CONTEXT_VALUE_CHARS}.`;
      logActivity(args.agent_id, 'share_blob_context_rejected', error);
      return { success: false, error_code: 'VALUE_TOO_LONG', error, max_chars: MAX_CONTEXT_VALUE_CHARS };
    }

    const contextNamespace = (args.namespace || 'default').trim() || 'default';
    const ctx = shareContext(args.agent_id, args.key, refValue, args.trace_id, args.span_id, contextNamespace);
    logActivity(
      args.agent_id,
      'share_blob_context',
      `Shared blob context key="${args.key}" ns=${contextNamespace} hash=${fullHash.slice(0, 12)} created=${created} payload_chars=${compressed.value.length} codec=${compressed.codec} lossless=${compressed.lossless}`
    );
    return {
      success: true,
      context: ctx,
      blob_ref: {
        hash: fullHash,
        short_hash: fullHash.slice(0, shortLen),
        created,
        payload_chars: compressed.value.length,
      },
      transport: {
        original_chars: args.payload.length,
        context_value_chars: refValue.length,
        saved_chars: Math.max(0, args.payload.length - refValue.length),
        original_tokens_est: estimateTokens(args.payload.length),
        context_tokens_est: estimateTokens(refValue.length),
      },
      compression: {
        mode: compressionMode,
        applied: compressed.compressed,
        codec: compressed.codec,
        lossless: compressed.lossless,
        gain_pct: compressed.gain_pct,
        original_chars: args.payload.length,
        stored_chars: compressed.value.length,
      },
    };
  });
}

export function handleGetContext(args: {
  agent_id?: string;
  key?: string;
  namespace?: string;
  requesting_agent?: string;
  limit?: number;
  offset?: number;
  updated_after?: number;
  response_mode?: 'full' | 'compact' | 'tiny' | 'nano' | 'summary';
  polling?: boolean;
  resolve_blob_refs?: boolean;
}) {
  if (args.requesting_agent) heartbeat(args.requesting_agent);
  const responseMode = args.response_mode || 'full';
  if (args.polling === true && responseMode === 'full' && DISALLOW_FULL_IN_POLLING) {
    return {
      success: false,
      error_code: 'FULL_MODE_FORBIDDEN_IN_POLLING',
      error: 'response_mode=full is forbidden in polling cycles; use nano, tiny, compact, or summary',
      allowed_response_modes: ['nano', 'tiny', 'compact', 'summary'],
    };
  }
  const limit = Math.max(1, Math.min(MAX_CONTEXT_LIMIT, Math.floor(args.limit ?? DEFAULT_CONTEXT_LIMIT)));
  const offset = Math.max(0, Math.floor(args.offset ?? 0));
  const updatedAfter = Number.isFinite(args.updated_after) ? Math.floor(Number(args.updated_after)) : undefined;
  const contexts = getContext({
    agent_id: args.agent_id,
    key: args.key,
    namespace: args.namespace,
    limit,
    offset,
    updated_after: updatedAfter,
  });
  logActivity(
    args.requesting_agent || 'system',
    'get_context',
    `Queried context (agent=${args.agent_id || '*'}, key=${args.key || '*'}, ns=${args.namespace || '*'}, limit=${limit}, offset=${offset}, updated_after=${updatedAfter ?? '-'}) : ${contexts.length} results`
  );

  const resolvedContexts: ResolvedContext[] = args.resolve_blob_refs
    ? contexts.map((ctx) => {
      const blobRef = parseBlobRefEnvelope(ctx.value);
      if (!blobRef) return { ...ctx };
      const blob = getProtocolBlob(blobRef.hash);
      const decoded = blob ? decodeLosslessBlobPayload(blob.value) : null;
      return {
        ...ctx,
        blob_ref: {
          hash: blobRef.hash,
          declared_chars: blobRef.declared_chars,
          resolved: Boolean(blob),
          codec: decoded?.codec,
          integrity_ok: decoded ? decoded.integrity_ok : undefined,
        },
        resolved_value: decoded ? decoded.value : null,
      };
    })
    : contexts;

  if (responseMode === 'nano') {
    const nano = resolvedContexts.map((ctx) => {
      const resolvedValue = typeof ctx.resolved_value === 'string' ? ctx.resolved_value : null;
      const value = resolvedValue ?? ctx.value;
      const item: Record<string, unknown> = {
        i: ctx.id,
        a: ctx.agent_id,
        k: ctx.key,
        n: ctx.namespace,
        u: ctx.updated_at,
        c: value.length,
        d: valueDigest(value).slice(0, 12),
      };
      if (ctx.trace_id) item.x = ctx.trace_id.slice(0, 12);
      if (ctx.span_id) item.y = ctx.span_id.slice(0, 12);
      if (ctx.blob_ref?.hash) {
        item.b = ctx.blob_ref.hash.slice(0, 16);
        item.r = ctx.blob_ref.resolved ? 1 : 0;
      }
      return item;
    });
    return {
      c: nano,
    };
  }

  if (responseMode === 'compact' || responseMode === 'tiny') {
    const compactLike = resolvedContexts.map((ctx) => {
      const resolvedValue = typeof ctx.resolved_value === 'string' ? ctx.resolved_value : null;
      const value = resolvedValue ?? ctx.value;
      const base = {
        id: ctx.id,
        agent_id: ctx.agent_id,
        key: ctx.key,
        namespace: ctx.namespace,
        updated_at: ctx.updated_at,
        trace_id: ctx.trace_id,
        span_id: ctx.span_id,
        value_chars: value.length,
        value_digest: valueDigest(value),
        blob_ref_hash: ctx.blob_ref?.hash,
        blob_resolved: ctx.blob_ref?.resolved,
      };
      if (responseMode === 'tiny') {
        return base;
      }
      return {
        ...base,
        value_preview: value.slice(0, 180),
      };
    });
    return {
      contexts: compactLike,
    };
  }

  if (responseMode === 'summary') {
    const values = resolvedContexts.map((item) => {
      return typeof item.resolved_value === 'string' ? item.resolved_value : item.value;
    });
    const totalChars = values.reduce((sum, value) => sum + value.length, 0);
    const avgEntropy = values.length === 0
      ? 0
      : Math.round((values.reduce((sum, value) => sum + estimateEntropy(value), 0) / values.length) * 1000) / 1000;
    const blobRefsTotal = resolvedContexts.reduce((sum, item) => sum + (item.blob_ref ? 1 : 0), 0);
    const blobRefsResolved = resolvedContexts.reduce((sum, item) => sum + (item.blob_ref?.resolved ? 1 : 0), 0);
    const topKeys = resolvedContexts.slice(0, 20).map((ctx) => {
      const resolvedValue = typeof ctx.resolved_value === 'string' ? ctx.resolved_value : null;
      const value = resolvedValue ?? ctx.value;
      return {
        agent_id: ctx.agent_id,
        key: ctx.key,
        namespace: ctx.namespace,
        value_chars: value.length,
        entropy: estimateEntropy(value),
        value_digest: valueDigest(value),
      };
    });
    return {
      summary: {
        count: resolvedContexts.length,
        total_chars: totalChars,
        avg_entropy: avgEntropy,
        blob_refs_total: blobRefsTotal,
        blob_refs_resolved: blobRefsResolved,
      },
      contexts: topKeys,
    };
  }

  return { contexts: resolvedContexts };
}

export const contextTools = {
  share_context: {
    description: `Share a key-value context entry. Uses upsert — same agent_id+key will update the value. Supports optional compression and idempotency keys. Limit: value<=${MAX_CONTEXT_VALUE_CHARS} chars.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        key: { type: 'string', description: 'Context key' },
        value: { type: 'string', description: 'Context value (can be JSON string)' },
        namespace: { type: 'string', description: 'Optional context namespace/tag (default "default")' },
        trace_id: { type: 'string', description: 'Optional trace identifier for cross-tool diagnostics' },
        span_id: { type: 'string', description: 'Optional span identifier for this context update' },
        compression_mode: { type: 'string', enum: ['none', 'json', 'whitespace', 'auto'], description: 'Optional token-saving compression mode (default auto)' },
        idempotency_key: { type: 'string', description: 'Optional idempotency key for safe retries' },
      },
      required: ['agent_id', 'key', 'value'],
    },
    handler: handleShareContext,
  },
  share_blob_context: {
    description: `Store payload as protocol blob and share only hash-reference value in context key. Useful for large cross-agent context payloads. Blob limit: payload<=${MAX_PROTOCOL_BLOB_CHARS} chars. Default compression_mode=lossless_auto for strict reversible compression.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        key: { type: 'string', description: 'Context key to update' },
        payload: { type: 'string', description: 'Payload text or JSON string to store and reference' },
        namespace: { type: 'string', description: 'Optional context namespace/tag (default "default")' },
        trace_id: { type: 'string', description: 'Optional trace identifier for cross-tool diagnostics' },
        span_id: { type: 'string', description: 'Optional span identifier for this context update' },
        compression_mode: { type: 'string', enum: ['none', 'json', 'whitespace', 'auto', 'lossless_auto'], description: 'Compression mode before hashing/storage (lossless_auto is strict and reversible)' },
        hash_truncate: { type: 'number', description: 'Optional short hash length in response (8..64)' },
        idempotency_key: { type: 'string', description: 'Optional idempotency key for safe retries' },
      },
      required: ['agent_id', 'key', 'payload'],
    },
    handler: handleShareBlobContext,
  },
  get_context: {
    description: `Get shared context entries. Filter by agent and/or key. Defaults to limit=${DEFAULT_CONTEXT_LIMIT}, max limit=${MAX_CONTEXT_LIMIT}. Use compact/tiny/nano/summary modes to reduce token output.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        requesting_agent: { type: 'string', description: 'Your agent ID (for heartbeat)' },
        agent_id: { type: 'string', description: 'Filter by agent ID' },
        key: { type: 'string', description: 'Filter by key' },
        namespace: { type: 'string', description: 'Filter by context namespace/tag' },
        limit: { type: 'number', description: `Max rows to return (default ${DEFAULT_CONTEXT_LIMIT}, max ${MAX_CONTEXT_LIMIT})` },
        offset: { type: 'number', description: 'Row offset for pagination (default 0)' },
        updated_after: { type: 'number', description: 'Delta mode: return context rows with updated_at > updated_after (ms epoch)' },
        response_mode: { type: 'string', enum: ['full', 'compact', 'tiny', 'nano', 'summary'], description: 'compact shows previews, tiny shows digests/sizes, nano uses short keys, summary returns aggregates' },
        polling: { type: 'boolean', description: 'Mark this call as polling-cycle read; full mode is forbidden when polling=true' },
        resolve_blob_refs: { type: 'boolean', description: 'Resolve CAEP blob-ref values from protocol blob store' },
      },
    },
    handler: handleGetContext,
  },
};
