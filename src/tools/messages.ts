import {
  sendMessage,
  readMessages,
  heartbeat,
  logActivity,
  putProtocolBlob,
  getProtocolBlob,
} from '../db.js';
import type { Message } from '../types.js';
import {
  collapseWhitespace,
  normalizeJsonString,
  sha256Hex,
  estimateTokens,
  makeBlobRefEnvelope,
  parseBlobRefEnvelope,
  encodeLosslessBlobPayloadAuto,
  decodeLosslessBlobPayload,
  withIdempotency,
} from '../utils.js';

const MAX_MESSAGE_CONTENT_CHARS = Number(process.env.MCP_HUB_MAX_MESSAGE_CONTENT_CHARS || 1024);
const MAX_MESSAGE_METADATA_CHARS = Number(process.env.MCP_HUB_MAX_MESSAGE_METADATA_CHARS || 1024);
const MAX_PROTOCOL_BLOB_CHARS = Number(process.env.MCP_HUB_MAX_PROTOCOL_BLOB_CHARS || 32 * 1024);
const DEFAULT_READ_LIMIT = 50;
const MAX_READ_LIMIT = 200;
const DISALLOW_FULL_IN_POLLING = process.env.MCP_HUB_DISALLOW_FULL_IN_POLLING !== '0';

interface MessageBlobRef {
  hash: string;
  declared_chars: number;
  resolved: boolean;
  codec?: 'raw' | 'brotli-base64';
  integrity_ok?: boolean;
}

interface MessageCursor {
  ts: number;
  id: number;
}

interface ResolvedMessage extends Message {
  blob_ref?: MessageBlobRef;
  resolved_content?: string | null;
}

function maybeCompressContent(content: string, mode: 'none' | 'whitespace' | 'auto'): { content: string; compressed: boolean } {
  if (mode === 'none') return { content, compressed: false };
  const collapsed = collapseWhitespace(content);
  if (mode === 'whitespace') return { content: collapsed, compressed: collapsed !== content };
  if (collapsed.length <= Math.floor(content.length * 0.95)) {
    return { content: collapsed, compressed: true };
  }
  return { content, compressed: false };
}

function compressBlobPayload(value: string, mode: 'none' | 'json' | 'whitespace' | 'auto' | 'lossless_auto'): {
  stored: string;
  applied: boolean;
  lossless: boolean;
  codec: 'raw' | 'json' | 'whitespace' | 'brotli-base64';
  gain_pct: number;
} {
  if (mode === 'none') {
    return { stored: value, applied: false, lossless: true, codec: 'raw', gain_pct: 0 };
  }
  if (mode === 'json') {
    const normalized = normalizeJsonString(value);
    const gainPct = value.length === 0 ? 0 : Math.round((((value.length - normalized.length) / value.length) * 100) * 100) / 100;
    return { stored: normalized, applied: normalized !== value, lossless: false, codec: 'json', gain_pct: gainPct };
  }
  if (mode === 'whitespace') {
    const collapsed = collapseWhitespace(value);
    const gainPct = value.length === 0 ? 0 : Math.round((((value.length - collapsed.length) / value.length) * 100) * 100) / 100;
    return { stored: collapsed, applied: collapsed !== value, lossless: false, codec: 'whitespace', gain_pct: gainPct };
  }
  if (mode === 'lossless_auto') {
    const encoded = encodeLosslessBlobPayloadAuto(value);
    return {
      stored: encoded.stored_value,
      applied: encoded.applied,
      lossless: true,
      codec: encoded.codec === 'brotli-base64' ? 'brotli-base64' : 'raw',
      gain_pct: encoded.gain_pct,
    };
  }
  const normalized = normalizeJsonString(value);
  const collapsed = collapseWhitespace(value);
  const best = [value, normalized, collapsed].reduce((candidate, current) => current.length < candidate.length ? current : candidate, value);
  const gainPct = value.length === 0 ? 0 : Math.round((((value.length - best.length) / value.length) * 100) * 100) / 100;
  const codec: 'raw' | 'json' | 'whitespace' = best === normalized ? 'json' : (best === collapsed ? 'whitespace' : 'raw');
  return {
    stored: best,
    applied: best !== value,
    lossless: false,
    codec,
    gain_pct: gainPct,
  };
}

function parseMessageCursor(cursor?: string): MessageCursor | null {
  if (!cursor || typeof cursor !== 'string') return null;
  const [tsRaw, idRaw] = cursor.split(':');
  const ts = Number(tsRaw);
  const id = Number(idRaw);
  if (!Number.isFinite(ts) || !Number.isFinite(id) || ts <= 0 || id <= 0) return null;
  return { ts: Math.floor(ts), id: Math.floor(id) };
}

function formatMessageCursor(message: Message): string {
  return `${message.created_at}:${message.id}`;
}

export function handleSendMessage(args: {
  from_agent: string;
  to_agent?: string;
  content: string;
  metadata?: string;
  trace_id?: string;
  span_id?: string;
  compression_mode?: 'none' | 'whitespace' | 'auto';
  idempotency_key?: string;
}) {
  heartbeat(args.from_agent);
  return withIdempotency(args.from_agent, 'send_message', args.idempotency_key, () => {
    const compressionMode = args.compression_mode || 'auto';
    const compressed = maybeCompressContent(args.content, compressionMode);
    const metadata = normalizeJsonString(args.metadata || '{}');

    if (compressed.content.length > MAX_MESSAGE_CONTENT_CHARS) {
      const error = `Message content too long (${compressed.content.length} chars). Max is ${MAX_MESSAGE_CONTENT_CHARS}.`;
      logActivity(args.from_agent, 'send_message_rejected', error);
      return { success: false, error_code: 'CONTENT_TOO_LONG', error, max_chars: MAX_MESSAGE_CONTENT_CHARS };
    }
    if (metadata.length > MAX_MESSAGE_METADATA_CHARS) {
      const error = `Message metadata too long (${metadata.length} chars). Max is ${MAX_MESSAGE_METADATA_CHARS}.`;
      logActivity(args.from_agent, 'send_message_rejected', error);
      return { success: false, error_code: 'METADATA_TOO_LONG', error, max_chars: MAX_MESSAGE_METADATA_CHARS };
    }

    const message = sendMessage(
      args.from_agent,
      args.to_agent || null,
      compressed.content,
      metadata,
      args.trace_id,
      args.span_id,
    );
    const target = args.to_agent || 'broadcast';
    const savedChars = args.content.length - compressed.content.length;
    logActivity(args.from_agent, 'send_message', `Message to ${target}: ${compressed.content.slice(0, 100)} (compressed=${compressed.compressed} saved_chars=${savedChars})`);
    return {
      success: true,
      message,
      compression: {
        mode: compressionMode,
        applied: compressed.compressed,
        original_chars: args.content.length,
        stored_chars: compressed.content.length,
      },
    };
  });
}

export function handleSendBlobMessage(args: {
  from_agent: string;
  to_agent?: string;
  payload: string;
  metadata?: string;
  trace_id?: string;
  span_id?: string;
  compression_mode?: 'none' | 'json' | 'whitespace' | 'auto' | 'lossless_auto';
  hash_truncate?: number;
  idempotency_key?: string;
}) {
  heartbeat(args.from_agent);
  return withIdempotency(args.from_agent, 'send_blob_message', args.idempotency_key, () => {
    const compressionMode = args.compression_mode || 'lossless_auto';
    const compressed = compressBlobPayload(args.payload, compressionMode);
    const storedPayload = compressed.stored;
    if (storedPayload.length > MAX_PROTOCOL_BLOB_CHARS) {
      const error = `Blob payload too long (${storedPayload.length} chars). Max is ${MAX_PROTOCOL_BLOB_CHARS}.`;
      logActivity(args.from_agent, 'send_blob_message_rejected', error);
      return { success: false, error_code: 'BLOB_TOO_LONG', error, max_chars: MAX_PROTOCOL_BLOB_CHARS };
    }

    const fullHash = sha256Hex(storedPayload);
    const shortLen = Number.isFinite(args.hash_truncate) ? Math.max(8, Math.min(64, Math.floor(Number(args.hash_truncate)))) : 16;
    const { created } = putProtocolBlob(fullHash, storedPayload);
    const envelope = makeBlobRefEnvelope(fullHash, storedPayload.length);

    if (envelope.length > MAX_MESSAGE_CONTENT_CHARS) {
      const error = `Blob envelope too long (${envelope.length} chars). Max is ${MAX_MESSAGE_CONTENT_CHARS}.`;
      logActivity(args.from_agent, 'send_blob_message_rejected', error);
      return { success: false, error_code: 'CONTENT_TOO_LONG', error, max_chars: MAX_MESSAGE_CONTENT_CHARS };
    }

    const metadata = normalizeJsonString(args.metadata || '{}');
    if (metadata.length > MAX_MESSAGE_METADATA_CHARS) {
      const error = `Message metadata too long (${metadata.length} chars). Max is ${MAX_MESSAGE_METADATA_CHARS}.`;
      logActivity(args.from_agent, 'send_blob_message_rejected', error);
      return { success: false, error_code: 'METADATA_TOO_LONG', error, max_chars: MAX_MESSAGE_METADATA_CHARS };
    }

    const message = sendMessage(
      args.from_agent,
      args.to_agent || null,
      envelope,
      metadata,
      args.trace_id,
      args.span_id,
    );
    const target = args.to_agent || 'broadcast';
    logActivity(
      args.from_agent,
      'send_blob_message',
      `Message to ${target}: blob=${fullHash.slice(0, 12)} created=${created} payload_chars=${storedPayload.length} envelope_chars=${envelope.length} codec=${compressed.codec} lossless=${compressed.lossless}`
    );

    return {
      success: true,
      message,
      blob_ref: {
        hash: fullHash,
        short_hash: fullHash.slice(0, shortLen),
        created,
        payload_chars: storedPayload.length,
      },
      transport: {
        original_chars: args.payload.length,
        message_chars: envelope.length,
        saved_chars: Math.max(0, args.payload.length - envelope.length),
        original_tokens_est: estimateTokens(args.payload.length),
        message_tokens_est: estimateTokens(envelope.length),
      },
      compression: {
        mode: compressionMode,
        applied: compressed.applied,
        codec: compressed.codec,
        lossless: compressed.lossless,
        gain_pct: compressed.gain_pct,
        original_chars: args.payload.length,
        stored_chars: storedPayload.length,
      },
    };
  });
}

export function handleReadMessages(args: {
  agent_id: string;
  from?: string;
  unread_only?: boolean;
  limit?: number;
  offset?: number;
  since_ts?: number;
  cursor?: string;
  response_mode?: 'full' | 'compact' | 'tiny' | 'nano';
  polling?: boolean;
  resolve_blob_refs?: boolean;
}) {
  heartbeat(args.agent_id);
  const limit = Math.max(1, Math.min(MAX_READ_LIMIT, Math.floor(args.limit ?? DEFAULT_READ_LIMIT)));
  const cursor = parseMessageCursor(args.cursor);
  const responseMode = args.response_mode || 'full';
  const sinceTs = Number.isFinite(args.since_ts) ? Math.floor(Number(args.since_ts)) : undefined;
  const useDeltaOrdering = cursor !== null || sinceTs !== undefined;
  const pollingCycle = args.polling === true || useDeltaOrdering;
  if (pollingCycle && responseMode === 'full' && DISALLOW_FULL_IN_POLLING) {
    return {
      success: false,
      error_code: 'FULL_MODE_FORBIDDEN_IN_POLLING',
      error: 'response_mode=full is forbidden in polling cycles; use nano, tiny, or compact',
      allowed_response_modes: ['nano', 'tiny', 'compact'],
    };
  }
  const queryLimit = useDeltaOrdering ? Math.min(MAX_READ_LIMIT + 1, limit + 1) : limit;
  const offset = Math.max(0, Math.floor(args.offset ?? 0));
  const messages = readMessages(args.agent_id, {
    from: args.from,
    unread_only: args.unread_only,
    limit: queryLimit,
    offset,
    since_ts: sinceTs,
    cursor: cursor || undefined,
  });
  const hasMore = useDeltaOrdering ? messages.length > limit : false;
  const slicedMessages = hasMore ? messages.slice(0, limit) : messages;
  const nextCursor = slicedMessages.length > 0 ? formatMessageCursor(slicedMessages[slicedMessages.length - 1]) : args.cursor || null;
  const resolvedMessages: ResolvedMessage[] = args.resolve_blob_refs
    ? slicedMessages.map((message) => {
      const blobRef = parseBlobRefEnvelope(message.content);
      if (!blobRef) return { ...message };
      const blob = getProtocolBlob(blobRef.hash);
      const decoded = blob ? decodeLosslessBlobPayload(blob.value) : null;
      return {
        ...message,
        blob_ref: {
          hash: blobRef.hash,
          declared_chars: blobRef.declared_chars,
          resolved: Boolean(blob),
          codec: decoded?.codec,
          integrity_ok: decoded ? decoded.integrity_ok : undefined,
        },
        resolved_content: decoded ? decoded.value : null,
      };
    })
    : slicedMessages;

  logActivity(
    args.agent_id,
    'read_messages',
    `Read ${slicedMessages.length} messages (limit=${limit}, offset=${offset}, since_ts=${sinceTs ?? '-'}, cursor=${args.cursor || '-'}, resolve_blob_refs=${Boolean(args.resolve_blob_refs)})`
  );
  if (responseMode === 'nano') {
    const nano = resolvedMessages.map((message) => {
      const resolvedValue = typeof message.resolved_content === 'string' ? message.resolved_content : null;
      const content = resolvedValue ?? message.content;
      const item: Record<string, unknown> = {
        i: message.id,
        f: message.from_agent,
        t: message.to_agent,
        u: message.created_at,
        r: message.read ? 1 : 0,
        c: content.length,
        d: sha256Hex(content).slice(0, 12),
      };
      if (message.trace_id) item.x = message.trace_id.slice(0, 12);
      if (message.span_id) item.y = message.span_id.slice(0, 12);
      if (message.blob_ref?.hash) {
        item.b = message.blob_ref.hash.slice(0, 16);
        item.z = message.blob_ref.resolved ? 1 : 0;
      }
      return item;
    });
    return {
      m: nano,
      h: hasMore ? 1 : 0,
      n: nextCursor,
    };
  }
  if (responseMode === 'compact' || responseMode === 'tiny') {
    const compactLike = resolvedMessages.map((message) => {
      const resolvedValue = typeof message.resolved_content === 'string' ? message.resolved_content : null;
      const contentForPreview = resolvedValue ?? message.content;
      const base = {
        id: message.id,
        from_agent: message.from_agent,
        to_agent: message.to_agent,
        created_at: message.created_at,
        read: message.read,
        trace_id: message.trace_id,
        span_id: message.span_id,
        content_chars: contentForPreview.length,
        content_digest: sha256Hex(contentForPreview).slice(0, 16),
        blob_ref_hash: message.blob_ref?.hash,
        blob_resolved: message.blob_ref?.resolved,
      };
      if (responseMode === 'tiny') {
        return base;
      }
      return {
        ...base,
        content_preview: contentForPreview.slice(0, 180),
      };
    });
    return {
      messages: compactLike,
      has_more: hasMore,
      next_cursor: nextCursor,
    };
  }
  return {
    messages: resolvedMessages,
    has_more: hasMore,
    next_cursor: nextCursor,
  };
}

export const messageTools = {
  send_message: {
    description: `Send a message to a specific agent or broadcast to all (omit to_agent for broadcast). Supports optional compression and idempotency keys. Limits: content<=${MAX_MESSAGE_CONTENT_CHARS} chars, metadata<=${MAX_MESSAGE_METADATA_CHARS} chars.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        from_agent: { type: 'string', description: 'Your agent ID' },
        to_agent: { type: 'string', description: 'Target agent ID (omit for broadcast)' },
        content: { type: 'string', description: 'Message content' },
        metadata: { type: 'string', description: 'JSON metadata string' },
        trace_id: { type: 'string', description: 'Optional trace identifier for cross-tool diagnostics' },
        span_id: { type: 'string', description: 'Optional span identifier for this message emission' },
        compression_mode: { type: 'string', enum: ['none', 'whitespace', 'auto'], description: 'Optional token-saving compression mode (default auto)' },
        idempotency_key: { type: 'string', description: 'Optional idempotency key for safe retries' },
      },
      required: ['from_agent', 'content'],
    },
    handler: handleSendMessage,
  },
  send_blob_message: {
    description: `Store payload as protocol blob and send only hash-reference envelope. Useful for large payload handoffs. Blob limit: payload<=${MAX_PROTOCOL_BLOB_CHARS} chars. Default compression_mode=lossless_auto for strict reversible compression.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        from_agent: { type: 'string', description: 'Your agent ID' },
        to_agent: { type: 'string', description: 'Target agent ID (omit for broadcast)' },
        payload: { type: 'string', description: 'Payload text or JSON string to store and reference' },
        metadata: { type: 'string', description: 'JSON metadata string' },
        trace_id: { type: 'string', description: 'Optional trace identifier for cross-tool diagnostics' },
        span_id: { type: 'string', description: 'Optional span identifier for this message emission' },
        compression_mode: { type: 'string', enum: ['none', 'json', 'whitespace', 'auto', 'lossless_auto'], description: 'Compression mode before hashing/storage (lossless_auto is strict and reversible)' },
        hash_truncate: { type: 'number', description: 'Optional short hash length in response (8..64)' },
        idempotency_key: { type: 'string', description: 'Optional idempotency key for safe retries' },
      },
      required: ['from_agent', 'payload'],
    },
    handler: handleSendBlobMessage,
  },
  read_messages: {
    description: `Read incoming messages. Messages are marked as read after retrieval. Defaults to limit=${DEFAULT_READ_LIMIT}, max limit=${MAX_READ_LIMIT}. Use response_mode=compact|tiny|nano to reduce token output.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        from: { type: 'string', description: 'Filter by sender agent ID' },
        unread_only: { type: 'boolean', description: 'Only return unread messages' },
        limit: { type: 'number', description: `Max number of messages to return (default ${DEFAULT_READ_LIMIT}, max ${MAX_READ_LIMIT})` },
        offset: { type: 'number', description: 'Row offset for pagination (default 0)' },
        since_ts: { type: 'number', description: 'Delta mode: return only messages with created_at > since_ts (ms epoch)' },
        cursor: { type: 'string', description: 'Delta cursor "<created_at>:<id>" returned by previous call' },
        response_mode: { type: 'string', enum: ['full', 'compact', 'tiny', 'nano'], description: 'compact returns previews; tiny returns digests/sizes; nano uses short keys for routing loops' },
        polling: { type: 'boolean', description: 'Mark this call as polling-cycle read; full mode is forbidden when polling=true' },
        resolve_blob_refs: { type: 'boolean', description: 'Resolve CAEP blob-ref envelopes into payloads from protocol blob store' },
      },
      required: ['agent_id'],
    },
    handler: handleReadMessages,
  },
};
