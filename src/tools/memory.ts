import { getDb, heartbeat, logActivity, shareContext } from '../db.js';
import { sha256Hex, withIdempotency } from '../utils.js';

type MemoryMode = 'compact' | 'tiny' | 'nano';

const DEFAULT_MEMORY_NAMESPACE = 'memory';
const MEMORY_KEY_PREFIX = 'memory:';
const DEFAULT_MEMORY_LIMIT = 20;
const MAX_MEMORY_LIMIT = 100;
const MAX_MEMORY_TEXT_CHARS = Number(process.env.MCP_HUB_MAX_MEMORY_TEXT_CHARS || 2048);
const MAX_MEMORY_KEY_CHARS = 120;
const MAX_MEMORY_TAGS = 12;

interface MemoryRow {
  id: number;
  agent_id: string;
  key: string;
  value: string;
  namespace: string;
  updated_at: number;
}

interface MemoryPayload {
  text: string;
  tags: string[];
  importance: number;
  updated_by: string;
  updated_at: number;
}

function normalizeMode(mode?: string): MemoryMode {
  if (mode === 'nano') return 'nano';
  if (mode === 'tiny') return 'tiny';
  return 'compact';
}

function normalizeNamespace(namespace?: string): string {
  return (namespace || DEFAULT_MEMORY_NAMESPACE).trim() || DEFAULT_MEMORY_NAMESPACE;
}

function normalizeKey(key?: string): string {
  const cleaned = String(key || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:@/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_MEMORY_KEY_CHARS);
  return cleaned || `note-${Date.now().toString(36)}`;
}

function normalizeOptionalKeyPrefix(keyPrefix?: string): string | null {
  const cleaned = String(keyPrefix || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:@/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_MEMORY_KEY_CHARS);
  return cleaned || null;
}

function contextKey(memoryKey: string): string {
  return `${MEMORY_KEY_PREFIX}${memoryKey}`;
}

function normalizeTags(tags?: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags
    .map((tag) => String(tag || '').trim().toLowerCase())
    .filter((tag) => tag.length > 0)
    .map((tag) => tag.replace(/[^a-z0-9._:/-]+/g, '-').slice(0, 48))
    .filter((tag) => tag.length > 0))]
    .slice(0, MAX_MEMORY_TAGS);
}

function clampImportance(value?: number): number {
  const num = Number.isFinite(value) ? Number(value) : 0.5;
  return Math.round(Math.max(0, Math.min(1, num)) * 100) / 100;
}

function tokenizeQuery(query?: string): string[] {
  return [...new Set(String(query || '')
    .toLowerCase()
    .split(/[\s,;:|]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2))]
    .slice(0, 8);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function parsePayload(row: MemoryRow): MemoryPayload {
  try {
    const parsed = JSON.parse(row.value) as Partial<MemoryPayload>;
    return {
      text: String(parsed.text || ''),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map((tag) => String(tag)) : [],
      importance: clampImportance(parsed.importance),
      updated_by: String(parsed.updated_by || row.agent_id),
      updated_at: Number.isFinite(parsed.updated_at) ? Math.floor(Number(parsed.updated_at)) : row.updated_at,
    };
  } catch {
    return {
      text: row.value,
      tags: [],
      importance: 0.5,
      updated_by: row.agent_id,
      updated_at: row.updated_at,
    };
  }
}

function preview(value: string, max = 220): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}...`;
}

function formatMemory(rows: MemoryRow[], mode: MemoryMode) {
  return rows.map((row) => {
    const payload = parsePayload(row);
    const memoryKey = row.key.startsWith(MEMORY_KEY_PREFIX) ? row.key.slice(MEMORY_KEY_PREFIX.length) : row.key;
    if (mode === 'nano') {
      return [row.id, row.agent_id, memoryKey, row.namespace, payload.importance, row.updated_at, sha256Hex(payload.text).slice(0, 12)];
    }
    const base = {
      id: row.id,
      agent_id: row.agent_id,
      key: memoryKey,
      namespace: row.namespace,
      tags: payload.tags,
      importance: payload.importance,
      updated_at: row.updated_at,
      text_chars: payload.text.length,
      text_digest: sha256Hex(payload.text).slice(0, 16),
    };
    if (mode === 'tiny') return base;
    return { ...base, text_preview: preview(payload.text) };
  });
}

export function handleWriteMemory(args: {
  agent_id: string;
  key: string;
  text: string;
  namespace?: string;
  tags?: string[];
  importance?: number;
  idempotency_key?: string;
}) {
  heartbeat(args.agent_id);
  return withIdempotency(args.agent_id, 'write_memory', args.idempotency_key, () => {
    const text = String(args.text || '').trim();
    if (!text) return { success: false, error_code: 'MEMORY_TEXT_REQUIRED', error: 'text is required' };
    if (text.length > MAX_MEMORY_TEXT_CHARS) {
      return {
        success: false,
        error_code: 'MEMORY_TEXT_TOO_LONG',
        error: `Memory text too long (${text.length} chars). Max is ${MAX_MEMORY_TEXT_CHARS}.`,
        max_chars: MAX_MEMORY_TEXT_CHARS,
      };
    }
    const now = Date.now();
    const key = normalizeKey(args.key);
    const namespace = normalizeNamespace(args.namespace);
    const payload: MemoryPayload = {
      text,
      tags: normalizeTags(args.tags),
      importance: clampImportance(args.importance),
      updated_by: args.agent_id,
      updated_at: now,
    };
    const ctx = shareContext(args.agent_id, contextKey(key), JSON.stringify(payload), undefined, undefined, namespace);
    logActivity(args.agent_id, 'write_memory', `memory_id=${ctx.id} key=${key} ns=${namespace} tags=${payload.tags.join(',')}`, { emit_stream_event: false });
    return {
      success: true,
      memory: {
        id: ctx.id,
        agent_id: ctx.agent_id,
        key,
        namespace,
        tags: payload.tags,
        importance: payload.importance,
        updated_at: ctx.updated_at,
        text_chars: text.length,
        text_digest: sha256Hex(text).slice(0, 16),
      },
    };
  });
}

export function handleSearchMemory(args: {
  agent_id: string;
  q?: string;
  namespace?: string;
  tags?: string[];
  limit?: number;
  response_mode?: MemoryMode;
}) {
  heartbeat(args.agent_id);
  const mode = normalizeMode(args.response_mode);
  const namespace = args.namespace?.trim();
  const tags = normalizeTags(args.tags);
  const tokens = tokenizeQuery(args.q);
  const limit = Math.max(1, Math.min(MAX_MEMORY_LIMIT, Math.floor(Number(args.limit ?? DEFAULT_MEMORY_LIMIT))));
  const params: unknown[] = [];
  let query = `
    SELECT *
    FROM context
    WHERE key LIKE 'memory:%'
  `;
  if (namespace) {
    query += ' AND namespace = ?';
    params.push(namespace);
  }
  for (const token of tokens) {
    const like = `%${escapeLike(token)}%`;
    query += ` AND (
      LOWER(key) LIKE ? ESCAPE '\\'
      OR LOWER(value) LIKE ? ESCAPE '\\'
      OR LOWER(agent_id) LIKE ? ESCAPE '\\'
    )`;
    params.push(like, like, like);
  }
  for (const tag of tags) {
    query += ` AND LOWER(value) LIKE ? ESCAPE '\\'`;
    params.push(`%"${escapeLike(tag)}"%`);
  }
  query += ' ORDER BY updated_at DESC, id DESC LIMIT ?';
  params.push(limit);
  const rows = getDb().prepare(query).all(...params) as MemoryRow[];
  logActivity(args.agent_id, 'search_memory', `q_tokens=${tokens.length} tags=${tags.join(',')} ns=${namespace || '*'} results=${rows.length} mode=${mode}`, { emit_stream_event: false });
  if (mode === 'nano') return { m: formatMemory(rows, mode), c: rows.length };
  return {
    success: true,
    count: rows.length,
    namespace: namespace || null,
    query_digest: args.q ? sha256Hex(args.q).slice(0, 16) : null,
    memories: formatMemory(rows, mode),
  };
}

export function handleGetMemoryDigest(args: {
  agent_id: string;
  namespace?: string;
  tags?: string[];
  key_prefix?: string;
  updated_by?: string;
  limit?: number;
  response_mode?: MemoryMode;
}) {
  heartbeat(args.agent_id);
  const mode = normalizeMode(args.response_mode);
  const namespace = args.namespace?.trim();
  const tags = normalizeTags(args.tags);
  const keyPrefix = normalizeOptionalKeyPrefix(args.key_prefix);
  const updatedBy = String(args.updated_by || '').trim();
  const limit = Math.max(1, Math.min(MAX_MEMORY_LIMIT, Math.floor(Number(args.limit ?? 10))));
  const params: unknown[] = [];
  let query = `
    SELECT *
    FROM context
    WHERE key LIKE 'memory:%'
  `;
  if (namespace) {
    query += ' AND namespace = ?';
    params.push(namespace);
  }
  if (keyPrefix) {
    query += ` AND LOWER(key) LIKE ? ESCAPE '\\'`;
    params.push(`${MEMORY_KEY_PREFIX}${escapeLike(keyPrefix)}%`);
  }
  if (updatedBy) {
    query += ' AND LOWER(agent_id) = ?';
    params.push(updatedBy.toLowerCase());
  }
  for (const tag of tags) {
    query += ` AND LOWER(value) LIKE ? ESCAPE '\\'`;
    params.push(`%"${escapeLike(tag)}"%`);
  }
  query += ' ORDER BY updated_at DESC, id DESC LIMIT ?';
  params.push(limit * 5);
  const rows = (getDb().prepare(query).all(...params) as MemoryRow[])
    .sort((a, b) => {
      const pa = parsePayload(a);
      const pb = parsePayload(b);
      return (pb.importance - pa.importance) || (b.updated_at - a.updated_at) || (b.id - a.id);
    })
    .slice(0, limit);
  logActivity(args.agent_id, 'get_memory_digest', `ns=${namespace || '*'} tags=${tags.join(',')} key_prefix=${keyPrefix || '*'} updated_by=${updatedBy || '*'} count=${rows.length} mode=${mode}`, { emit_stream_event: false });
  if (mode === 'nano') return { m: formatMemory(rows, mode), c: rows.length };
  return {
    success: true,
    count: rows.length,
    namespace: namespace || null,
    filters: {
      tags,
      key_prefix: keyPrefix,
      updated_by: updatedBy || null,
    },
    memories: formatMemory(rows, mode),
  };
}

export const memoryTools = {
  write_memory: {
    description: 'Write durable shared memory on top of hub context. Useful for cross-agent facts, decisions, preferences, and reusable project notes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        key: { type: 'string', description: 'Stable memory key; normalized under memory:<key>' },
        text: { type: 'string', description: `Memory text (max ${MAX_MEMORY_TEXT_CHARS} chars)` },
        namespace: { type: 'string', description: `Memory namespace (default ${DEFAULT_MEMORY_NAMESPACE})` },
        tags: { type: 'array', items: { type: 'string' }, description: `Optional tags (max ${MAX_MEMORY_TAGS})` },
        importance: { type: 'number', description: 'Importance 0..1 for digest ordering (default 0.5)' },
        idempotency_key: { type: 'string', description: 'Optional idempotency key for safe retries' },
        auth_token: { type: 'string', description: 'Optional auth token from register_agent' },
      },
      required: ['agent_id', 'key', 'text'],
    },
    handler: handleWriteMemory,
  },
  search_memory: {
    description: 'Search durable shared memory with low-token compact/tiny/nano output. Uses context-backed memory rows and tag filters.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        q: { type: 'string', description: 'Optional text query' },
        namespace: { type: 'string', description: 'Optional namespace filter' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filters' },
        limit: { type: 'number', description: `Max memories (default ${DEFAULT_MEMORY_LIMIT}, max ${MAX_MEMORY_LIMIT})` },
        response_mode: { type: 'string', enum: ['compact', 'tiny', 'nano'], description: 'Response verbosity' },
        auth_token: { type: 'string', description: 'Optional auth token from register_agent' },
      },
      required: ['agent_id'],
    },
    handler: handleSearchMemory,
  },
  get_memory_digest: {
    description: 'Get highest-importance recent memory for agent startup/context refresh loops.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        namespace: { type: 'string', description: 'Optional namespace filter' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filters' },
        key_prefix: { type: 'string', description: 'Optional memory key prefix filter' },
        updated_by: { type: 'string', description: 'Optional source agent filter' },
        limit: { type: 'number', description: `Max memories (default 10, max ${MAX_MEMORY_LIMIT})` },
        response_mode: { type: 'string', enum: ['compact', 'tiny', 'nano'], description: 'Response verbosity' },
        auth_token: { type: 'string', description: 'Optional auth token from register_agent' },
      },
      required: ['agent_id'],
    },
    handler: handleGetMemoryDigest,
  },
};
