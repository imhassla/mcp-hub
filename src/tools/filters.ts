import { getDb, heartbeat, logActivity } from '../db.js';
import { handleReadEventDeltas } from './activity.js';
import { handleSearchHub } from './search.js';

type SavedFilterMode = 'compact' | 'tiny' | 'nano';

interface SavedFilterRow {
  id: number;
  owner_agent_id: string;
  name: string;
  namespace: string | null;
  filter_json: string;
  cursor: string | null;
  created_at: number;
  updated_at: number;
}

function normalizeName(name?: string): string {
  return String(name || '').trim().slice(0, 120);
}

function normalizeMode(mode?: string): SavedFilterMode {
  if (mode === 'nano') return 'nano';
  if (mode === 'tiny') return 'tiny';
  return 'compact';
}

function parseFilterJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function getSavedFilter(agentId: string, args: { filter_id?: number; name?: string }): SavedFilterRow | null {
  const d = getDb();
  if (Number.isInteger(args.filter_id) && Number(args.filter_id) > 0) {
    const row = d.prepare('SELECT * FROM saved_filters WHERE id = ? AND owner_agent_id = ?')
      .get(Math.floor(Number(args.filter_id)), agentId) as SavedFilterRow | undefined;
    return row || null;
  }
  const name = normalizeName(args.name);
  if (!name) return null;
  const row = d.prepare('SELECT * FROM saved_filters WHERE owner_agent_id = ? AND name = ?')
    .get(agentId, name) as SavedFilterRow | undefined;
  return row || null;
}

function summarizeRow(row: SavedFilterRow, mode: SavedFilterMode) {
  const filter = parseFilterJson(row.filter_json);
  if (mode === 'nano') {
    return {
      i: row.id,
      n: row.name,
      k: filter.kind || (filter.q ? 'search' : 'event_deltas'),
      u: row.updated_at,
      c: row.cursor,
    };
  }
  if (mode === 'tiny') {
    return {
      id: row.id,
      name: row.name,
      namespace: row.namespace,
      kind: filter.kind || (filter.q ? 'search' : 'event_deltas'),
      cursor: row.cursor,
      updated_at: row.updated_at,
    };
  }
  return {
    id: row.id,
    owner_agent_id: row.owner_agent_id,
    name: row.name,
    namespace: row.namespace,
    filter,
    cursor: row.cursor,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function validateFilter(filter: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
    return { ok: false, error: 'filter must be an object' };
  }
  const value = filter as Record<string, unknown>;
  const kind = String(value.kind || '').trim();
  if (kind && kind !== 'search' && kind !== 'event_deltas') {
    return { ok: false, error: 'filter.kind must be "search" or "event_deltas"' };
  }
  if ((kind === 'search' || value.q !== undefined) && typeof value.q !== 'string') {
    return { ok: false, error: 'search filters require string q' };
  }
  return { ok: true, value };
}

export function handleSaveFilter(args: {
  agent_id: string;
  name: string;
  filter: Record<string, unknown>;
  namespace?: string;
  cursor?: string;
}) {
  heartbeat(args.agent_id);
  const name = normalizeName(args.name);
  if (!name) return { success: false, error_code: 'FILTER_NAME_REQUIRED', error: 'name is required' };
  const validated = validateFilter(args.filter);
  if (!validated.ok) return { success: false, error_code: 'FILTER_INVALID', error: validated.error };
  const now = Date.now();
  const namespace = args.namespace?.trim() || null;
  const filterJson = JSON.stringify(validated.value);
  const d = getDb();
  d.prepare(`
    INSERT INTO saved_filters (owner_agent_id, name, namespace, filter_json, cursor, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_agent_id, name) DO UPDATE SET
      namespace = excluded.namespace,
      filter_json = excluded.filter_json,
      cursor = excluded.cursor,
      updated_at = excluded.updated_at
  `).run(args.agent_id, name, namespace, filterJson, args.cursor || null, now, now);
  const row = d.prepare('SELECT * FROM saved_filters WHERE owner_agent_id = ? AND name = ?')
    .get(args.agent_id, name) as SavedFilterRow;
  logActivity(args.agent_id, 'save_filter', `filter_id=${row.id} name=${name}`, { emit_stream_event: false });
  return { success: true, filter: summarizeRow(row, 'compact') };
}

export function handleListFilters(args: {
  agent_id: string;
  namespace?: string;
  limit?: number;
  offset?: number;
  response_mode?: SavedFilterMode;
}) {
  heartbeat(args.agent_id);
  const limit = Math.max(1, Math.min(200, Math.floor(Number(args.limit ?? 100))));
  const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)));
  const mode = normalizeMode(args.response_mode);
  const params: unknown[] = [args.agent_id];
  let query = 'SELECT * FROM saved_filters WHERE owner_agent_id = ?';
  if (args.namespace) {
    query += ' AND namespace = ?';
    params.push(args.namespace);
  }
  query += ' ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  const rows = getDb().prepare(query).all(...params) as SavedFilterRow[];
  if (mode === 'nano') return { f: rows.map((row) => summarizeRow(row, mode)), c: rows.length };
  return { success: true, filters: rows.map((row) => summarizeRow(row, mode)), count: rows.length };
}

export function handleDeleteFilter(args: { agent_id: string; filter_id?: number; name?: string }) {
  heartbeat(args.agent_id);
  const row = getSavedFilter(args.agent_id, args);
  if (!row) return { success: false, error_code: 'FILTER_NOT_FOUND', error: 'Saved filter not found' };
  getDb().prepare('DELETE FROM saved_filters WHERE id = ? AND owner_agent_id = ?').run(row.id, args.agent_id);
  logActivity(args.agent_id, 'delete_filter', `filter_id=${row.id} name=${row.name}`, { emit_stream_event: false });
  return { success: true, deleted: { id: row.id, name: row.name } };
}

export function handleReadFilterFeed(args: {
  agent_id: string;
  filter_id?: number;
  name?: string;
  cursor?: string;
  advance_cursor?: boolean;
  response_mode?: SavedFilterMode;
  limit?: number;
}) {
  heartbeat(args.agent_id);
  const row = getSavedFilter(args.agent_id, args);
  if (!row) return { success: false, error_code: 'FILTER_NOT_FOUND', error: 'Saved filter not found' };
  const filter = parseFilterJson(row.filter_json);
  const mode = normalizeMode(args.response_mode || String(filter.response_mode || 'compact'));
  const limit = Math.max(1, Math.min(1000, Math.floor(Number(args.limit ?? filter.limit ?? 100))));
  let result: Record<string, unknown>;

  if (filter.kind === 'search' || typeof filter.q === 'string') {
    result = handleSearchHub({
      ...(filter as any),
      agent_id: args.agent_id,
      response_mode: mode,
      limit,
    }) as Record<string, unknown>;
  } else {
    result = handleReadEventDeltas({
      agent_id: args.agent_id,
      cursor: args.cursor || row.cursor || String(filter.cursor || ''),
      streams: Array.isArray(filter.streams) ? filter.streams as any : undefined,
      response_mode: mode,
      limit,
      include_payload: filter.include_payload === true,
    }) as Record<string, unknown>;
  }

  const nextCursor = typeof result.cursor === 'string'
    ? result.cursor
    : (typeof result.u === 'string' ? result.u : null);
  if (args.advance_cursor === true && nextCursor) {
    getDb().prepare('UPDATE saved_filters SET cursor = ?, updated_at = ? WHERE id = ? AND owner_agent_id = ?')
      .run(nextCursor, Date.now(), row.id, args.agent_id);
  }
  logActivity(args.agent_id, 'read_filter_feed', `filter_id=${row.id} mode=${mode} advance=${args.advance_cursor === true ? 1 : 0}`, { emit_stream_event: false });
  if (mode === 'nano') {
    return { f: row.id, n: row.name, r: result, u: nextCursor };
  }
  return { success: true, filter: summarizeRow(row, 'tiny'), result, cursor: nextCursor };
}

export const filterTools = {
  save_filter: {
    description: 'Save or replace a reusable hub search/event-delta filter owned by an agent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        name: { type: 'string', description: 'Unique filter name for this agent' },
        filter: { type: 'object', description: 'Filter JSON. Use {kind:"search", q, scopes...} or {kind:"event_deltas", streams...}' },
        namespace: { type: 'string', description: 'Optional namespace/tag for grouping saved filters' },
        cursor: { type: 'string', description: 'Optional initial event cursor for event_deltas filters' },
        auth_token: { type: 'string', description: 'Optional auth token from register_agent' },
      },
      required: ['agent_id', 'name', 'filter'],
    },
    handler: handleSaveFilter,
  },
  list_filters: {
    description: 'List saved filters owned by an agent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        namespace: { type: 'string', description: 'Optional namespace/tag filter' },
        limit: { type: 'number', description: 'Max rows to return (default 100)' },
        offset: { type: 'number', description: 'Row offset (default 0)' },
        response_mode: { type: 'string', enum: ['compact', 'tiny', 'nano'], description: 'Response verbosity' },
        auth_token: { type: 'string', description: 'Optional auth token from register_agent' },
      },
      required: ['agent_id'],
    },
    handler: handleListFilters,
  },
  read_filter_feed: {
    description: 'Read a saved filter feed. Search filters run search_hub; event_deltas filters read stream refs and can advance cursor.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        filter_id: { type: 'number', description: 'Saved filter ID' },
        name: { type: 'string', description: 'Saved filter name if filter_id is omitted' },
        cursor: { type: 'string', description: 'Optional cursor override for event_deltas filters' },
        advance_cursor: { type: 'boolean', description: 'If true, persist returned cursor on the saved filter' },
        response_mode: { type: 'string', enum: ['compact', 'tiny', 'nano'], description: 'Response verbosity override' },
        limit: { type: 'number', description: 'Max feed items/events' },
        auth_token: { type: 'string', description: 'Optional auth token from register_agent' },
      },
      required: ['agent_id'],
    },
    handler: handleReadFilterFeed,
  },
  delete_filter: {
    description: 'Delete a saved filter owned by an agent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        filter_id: { type: 'number', description: 'Saved filter ID' },
        name: { type: 'string', description: 'Saved filter name if filter_id is omitted' },
        auth_token: { type: 'string', description: 'Optional auth token from register_agent' },
      },
      required: ['agent_id'],
    },
    handler: handleDeleteFilter,
  },
};
