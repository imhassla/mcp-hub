import { getDb, heartbeat, logActivity } from '../db.js';
import { sha256Hex } from '../utils.js';

const SEARCH_SCOPES = ['messages', 'tasks', 'context', 'activity', 'artifacts', 'consensus'] as const;
type SearchScope = (typeof SEARCH_SCOPES)[number];
type SearchResponseMode = 'compact' | 'tiny' | 'nano';

interface RawSearchRow {
  source: SearchScope;
  id: string;
  ts: number;
  title: string | null;
  text: string;
  namespace: string | null;
  agent_id: string | null;
  target_agent_id: string | null;
  extra_json: string | null;
}

interface SearchResult extends RawSearchRow {
  score: number;
  digest: string;
  preview: string;
}

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const DEFAULT_PREVIEW_CHARS = 180;
const MAX_PREVIEW_CHARS = 500;

function normalizeScopes(scopes?: unknown): SearchScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) return [...SEARCH_SCOPES];
  const normalized = [...new Set(scopes
    .map((scope) => String(scope || '').toLowerCase().trim())
    .filter((scope): scope is SearchScope => SEARCH_SCOPES.includes(scope as SearchScope)))];
  return normalized.length > 0 ? normalized : [...SEARCH_SCOPES];
}

function normalizeResponseMode(mode?: string): SearchResponseMode {
  if (mode === 'nano') return 'nano';
  if (mode === 'tiny') return 'tiny';
  return 'compact';
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function tokenizeQuery(query: string): string[] {
  return [...new Set(query
    .toLowerCase()
    .split(/[\s,;:|]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2))]
    .slice(0, 8);
}

function buildMatchClause(columns: string[], tokens: string[], params: unknown[]): string {
  const groups = tokens.map((token) => {
    const like = `%${escapeLike(token)}%`;
    for (let i = 0; i < columns.length; i += 1) params.push(like);
    return `(${columns.map((column) => `LOWER(COALESCE(${column}, '')) LIKE ? ESCAPE '\\'`).join(' OR ')})`;
  });
  return groups.join(' AND ');
}

function previewText(text: string, tokens: string[], maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  const lower = normalized.toLowerCase();
  const firstHit = tokens
    .map((token) => lower.indexOf(token))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstHit - Math.floor(maxChars / 3));
  const end = Math.min(normalized.length, start + maxChars);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < normalized.length ? '...' : '';
  return `${prefix}${normalized.slice(start, end)}${suffix}`;
}

function scoreRow(row: RawSearchRow, tokens: string[]): number {
  const haystack = `${row.title || ''}\n${row.text || ''}`.toLowerCase();
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function runSearchQuery(query: string, params: unknown[]): RawSearchRow[] {
  return getDb().prepare(query).all(...params) as RawSearchRow[];
}

function searchMessages(args: {
  agentId: string;
  tokens: string[];
  limit: number;
  from?: string;
  sinceTs?: number;
}): RawSearchRow[] {
  const params: unknown[] = [args.agentId, args.agentId, args.agentId];
  let query = `
    SELECT
      'messages' AS source,
      CAST(m.id AS TEXT) AS id,
      m.created_at AS ts,
      m.from_agent || ' -> ' || COALESCE(m.to_agent, '*') AS title,
      m.content || ' ' || COALESCE(m.metadata, '') AS text,
      NULL AS namespace,
      m.from_agent AS agent_id,
      m.to_agent AS target_agent_id,
      json_object('read', CASE WHEN mr.message_id IS NULL THEN 0 ELSE 1 END, 'trace_id', m.trace_id, 'span_id', m.span_id) AS extra_json
    FROM messages m
    LEFT JOIN message_reads mr
      ON mr.message_id = m.id AND mr.agent_id = ?
    WHERE (m.to_agent = ? OR m.to_agent IS NULL OR m.from_agent = ?)
  `;
  if (args.from) {
    query += ' AND m.from_agent = ?';
    params.push(args.from);
  }
  if (Number.isFinite(args.sinceTs)) {
    query += ' AND m.created_at >= ?';
    params.push(Math.floor(args.sinceTs as number));
  }
  query += ` AND ${buildMatchClause(['m.content', 'm.metadata', 'm.from_agent', 'm.to_agent'], args.tokens, params)}`;
  query += ' ORDER BY m.created_at DESC, m.id DESC LIMIT ?';
  params.push(args.limit);
  return runSearchQuery(query, params);
}

function searchTasks(args: {
  tokens: string[];
  limit: number;
  namespace?: string;
  status?: string;
  assignedTo?: string;
  sinceTs?: number;
}): RawSearchRow[] {
  const params: unknown[] = [];
  let query = `
    SELECT
      'tasks' AS source,
      CAST(id AS TEXT) AS id,
      updated_at AS ts,
      title AS title,
      title || ' ' || description || ' ' || status || ' ' || priority || ' ' || COALESCE(assigned_to, '') AS text,
      namespace AS namespace,
      created_by AS agent_id,
      assigned_to AS target_agent_id,
      json_object('status', status, 'priority', priority, 'execution_mode', execution_mode, 'trace_id', trace_id, 'span_id', span_id) AS extra_json
    FROM tasks
    WHERE 1=1
  `;
  if (args.namespace) {
    query += ' AND namespace = ?';
    params.push(args.namespace);
  }
  if (args.status) {
    query += ' AND status = ?';
    params.push(args.status);
  }
  if (args.assignedTo) {
    query += ' AND assigned_to = ?';
    params.push(args.assignedTo);
  }
  if (Number.isFinite(args.sinceTs)) {
    query += ' AND updated_at >= ?';
    params.push(Math.floor(args.sinceTs as number));
  }
  query += ` AND ${buildMatchClause(['title', 'description', 'status', 'priority', 'assigned_to', 'created_by'], args.tokens, params)}`;
  query += ' ORDER BY updated_at DESC, id DESC LIMIT ?';
  params.push(args.limit);
  return runSearchQuery(query, params);
}

function searchContext(args: {
  tokens: string[];
  limit: number;
  namespace?: string;
  owner?: string;
  key?: string;
  sinceTs?: number;
}): RawSearchRow[] {
  const params: unknown[] = [];
  let query = `
    SELECT
      'context' AS source,
      CAST(id AS TEXT) AS id,
      updated_at AS ts,
      agent_id || ':' || key AS title,
      key || ' ' || value AS text,
      namespace AS namespace,
      agent_id AS agent_id,
      NULL AS target_agent_id,
      json_object('key', key, 'trace_id', trace_id, 'span_id', span_id) AS extra_json
    FROM context
    WHERE 1=1
  `;
  if (args.namespace) {
    query += ' AND namespace = ?';
    params.push(args.namespace);
  }
  if (args.owner) {
    query += ' AND agent_id = ?';
    params.push(args.owner);
  }
  if (args.key) {
    query += ' AND key = ?';
    params.push(args.key);
  }
  if (Number.isFinite(args.sinceTs)) {
    query += ' AND updated_at >= ?';
    params.push(Math.floor(args.sinceTs as number));
  }
  query += ` AND ${buildMatchClause(['key', 'value', 'agent_id'], args.tokens, params)}`;
  query += ' ORDER BY updated_at DESC, id DESC LIMIT ?';
  params.push(args.limit);
  return runSearchQuery(query, params);
}

function searchActivity(args: { tokens: string[]; limit: number; agentId?: string; sinceTs?: number }): RawSearchRow[] {
  const params: unknown[] = [];
  let query = `
    SELECT
      'activity' AS source,
      CAST(id AS TEXT) AS id,
      created_at AS ts,
      agent_id || ':' || action AS title,
      action || ' ' || details AS text,
      NULL AS namespace,
      agent_id AS agent_id,
      NULL AS target_agent_id,
      json_object('action', action) AS extra_json
    FROM activity_log
    WHERE 1=1
  `;
  if (args.agentId) {
    query += ' AND agent_id = ?';
    params.push(args.agentId);
  }
  if (Number.isFinite(args.sinceTs)) {
    query += ' AND created_at >= ?';
    params.push(Math.floor(args.sinceTs as number));
  }
  query += ` AND ${buildMatchClause(['action', 'details', 'agent_id'], args.tokens, params)}`;
  query += ' ORDER BY created_at DESC, id DESC LIMIT ?';
  params.push(args.limit);
  return runSearchQuery(query, params);
}

function searchArtifacts(args: { agentId: string; tokens: string[]; limit: number; namespace?: string; sinceTs?: number }): RawSearchRow[] {
  const params: unknown[] = [args.agentId, args.agentId];
  let query = `
    SELECT
      'artifacts' AS source,
      a.id AS id,
      a.updated_at AS ts,
      a.name AS title,
      a.name || ' ' || COALESCE(a.summary, '') || ' ' || a.mime_type AS text,
      a.namespace AS namespace,
      a.created_by AS agent_id,
      NULL AS target_agent_id,
      json_object('mime_type', a.mime_type, 'size_bytes', a.size_bytes, 'ready', CASE WHEN a.storage_path IS NULL THEN 0 ELSE 1 END, 'sha256', a.sha256) AS extra_json
    FROM artifacts a
    WHERE (
      a.created_by = ?
      OR EXISTS (
        SELECT 1
        FROM artifact_shares s
        WHERE s.artifact_id = a.id AND s.to_agent IN (?, '*')
      )
    )
  `;
  if (args.namespace) {
    query += ' AND a.namespace = ?';
    params.push(args.namespace);
  }
  if (Number.isFinite(args.sinceTs)) {
    query += ' AND a.updated_at >= ?';
    params.push(Math.floor(args.sinceTs as number));
  }
  query += ` AND ${buildMatchClause(['a.name', 'a.summary', 'a.mime_type', 'a.created_by'], args.tokens, params)}`;
  query += ' ORDER BY a.updated_at DESC, a.id DESC LIMIT ?';
  params.push(args.limit);
  return runSearchQuery(query, params);
}

function searchConsensus(args: { tokens: string[]; limit: number; sinceTs?: number }): RawSearchRow[] {
  const params: unknown[] = [];
  let query = `
    SELECT
      'consensus' AS source,
      CAST(id AS TEXT) AS id,
      created_at AS ts,
      proposal_id || ':' || outcome AS title,
      proposal_id || ' ' || outcome || ' ' || stats_json || ' ' || reasons_json AS text,
      NULL AS namespace,
      requesting_agent AS agent_id,
      NULL AS target_agent_id,
      json_object('proposal_id', proposal_id, 'outcome', outcome) AS extra_json
    FROM consensus_decisions
    WHERE 1=1
  `;
  if (Number.isFinite(args.sinceTs)) {
    query += ' AND created_at >= ?';
    params.push(Math.floor(args.sinceTs as number));
  }
  query += ` AND ${buildMatchClause(['proposal_id', 'outcome', 'stats_json', 'reasons_json', 'requesting_agent'], args.tokens, params)}`;
  query += ' ORDER BY created_at DESC, id DESC LIMIT ?';
  params.push(args.limit);
  return runSearchQuery(query, params);
}

function formatResults(results: SearchResult[], mode: SearchResponseMode) {
  if (mode === 'nano') {
    return results.map((result) => ({
      s: result.source,
      i: result.id,
      u: result.ts,
      r: result.score,
      d: result.digest.slice(0, 12),
      p: result.preview,
    }));
  }
  if (mode === 'tiny') {
    return results.map((result) => ({
      source: result.source,
      id: result.id,
      updated_at: result.ts,
      score: result.score,
      digest: result.digest.slice(0, 16),
      title: result.title,
      namespace: result.namespace,
    }));
  }
  return results.map((result) => ({
    source: result.source,
    id: result.id,
    updated_at: result.ts,
    score: result.score,
    title: result.title,
    preview: result.preview,
    digest: result.digest.slice(0, 16),
    namespace: result.namespace,
    agent_id: result.agent_id,
    target_agent_id: result.target_agent_id,
    extra: result.extra_json ? JSON.parse(result.extra_json) : null,
  }));
}

export function handleSearchHub(args: {
  agent_id: string;
  q: string;
  scopes?: SearchScope[];
  namespace?: string;
  from_agent?: string;
  context_agent_id?: string;
  context_key?: string;
  task_status?: string;
  task_assigned_to?: string;
  activity_agent_id?: string;
  since_ts?: number;
  limit?: number;
  preview_chars?: number;
  response_mode?: SearchResponseMode;
}) {
  heartbeat(args.agent_id);
  const query = String(args.q || '').trim();
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) {
    return {
      success: false,
      error_code: 'QUERY_TOO_SHORT',
      error: 'q must contain at least one token with 2+ characters',
    };
  }

  const scopes = normalizeScopes(args.scopes);
  const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(args.limit ?? DEFAULT_SEARCH_LIMIT)));
  const perScopeLimit = Math.min(MAX_SEARCH_LIMIT, Math.max(limit, Math.ceil(limit * 1.5)));
  const previewChars = Math.max(40, Math.min(MAX_PREVIEW_CHARS, Math.floor(args.preview_chars ?? DEFAULT_PREVIEW_CHARS)));
  const responseMode = normalizeResponseMode(args.response_mode);
  const sinceTs = Number.isFinite(Number(args.since_ts)) && Number(args.since_ts) > 0
    ? Math.floor(Number(args.since_ts))
    : undefined;
  const rows: RawSearchRow[] = [];

  if (scopes.includes('messages')) {
    rows.push(...searchMessages({ agentId: args.agent_id, tokens, limit: perScopeLimit, from: args.from_agent, sinceTs }));
  }
  if (scopes.includes('tasks')) {
    rows.push(...searchTasks({
      tokens,
      limit: perScopeLimit,
      namespace: args.namespace,
      status: args.task_status,
      assignedTo: args.task_assigned_to,
      sinceTs,
    }));
  }
  if (scopes.includes('context')) {
    rows.push(...searchContext({
      tokens,
      limit: perScopeLimit,
      namespace: args.namespace,
      owner: args.context_agent_id,
      key: args.context_key,
      sinceTs,
    }));
  }
  if (scopes.includes('activity')) {
    rows.push(...searchActivity({ tokens, limit: perScopeLimit, agentId: args.activity_agent_id, sinceTs }));
  }
  if (scopes.includes('artifacts')) {
    rows.push(...searchArtifacts({ agentId: args.agent_id, tokens, limit: perScopeLimit, namespace: args.namespace, sinceTs }));
  }
  if (scopes.includes('consensus')) {
    rows.push(...searchConsensus({ tokens, limit: perScopeLimit, sinceTs }));
  }

  const results = rows
    .map((row) => ({
      ...row,
      score: scoreRow(row, tokens),
      digest: sha256Hex(`${row.source}:${row.id}:${row.text}`),
      preview: previewText(row.text, tokens, previewChars),
    }))
    .sort((a, b) => (b.score - a.score) || (b.ts - a.ts) || a.source.localeCompare(b.source))
    .slice(0, limit);

  logActivity(args.agent_id, 'search_hub', `q_tokens=${tokens.length} scopes=${scopes.join(',')} results=${results.length} mode=${responseMode}`);

  if (responseMode === 'nano') {
    return {
      r: formatResults(results, responseMode),
      c: results.length,
      q: sha256Hex(query).slice(0, 12),
    };
  }
  return {
    success: true,
    query_digest: sha256Hex(query).slice(0, 16),
    scopes,
    since_ts: sinceTs,
    count: results.length,
    results: formatResults(results, responseMode),
  };
}

export const searchTools = {
  search_hub: {
    description: 'Search hub coordination data. Message/artifact visibility is enforced; tasks, context, activity, and consensus follow the hub shared-state visibility model.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID; used for message/artifact visibility and heartbeat' },
        q: { type: 'string', description: 'Text query; tokens are matched case-insensitively' },
        scopes: { type: 'array', items: { type: 'string', enum: [...SEARCH_SCOPES] }, description: 'Optional sources to search; defaults to all' },
        namespace: { type: 'string', description: 'Optional namespace filter for tasks/context/artifacts' },
        from_agent: { type: 'string', description: 'Optional sender filter for message search' },
        context_agent_id: { type: 'string', description: 'Optional context owner filter' },
        context_key: { type: 'string', description: 'Optional exact context key filter' },
        task_status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'], description: 'Optional task status filter' },
        task_assigned_to: { type: 'string', description: 'Optional task assignee filter' },
        activity_agent_id: { type: 'string', description: 'Optional activity owner filter' },
        since_ts: { type: 'number', description: 'Optional lower timestamp bound. Messages/activity/consensus use created_at; tasks/context/artifacts use updated_at.' },
        limit: { type: 'number', description: `Max results to return (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT})` },
        preview_chars: { type: 'number', description: `Preview chars per compact/nano result (default ${DEFAULT_PREVIEW_CHARS}, max ${MAX_PREVIEW_CHARS})` },
        response_mode: { type: 'string', enum: ['compact', 'tiny', 'nano'], description: 'compact includes previews; tiny returns refs/digests; nano uses shortest keys' },
        auth_token: { type: 'string', description: 'Optional auth token from register_agent' },
      },
      required: ['agent_id', 'q'],
    },
    handler: handleSearchHub,
  },
};
