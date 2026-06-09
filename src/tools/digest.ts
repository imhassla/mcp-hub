import {
  getActivityLog,
  getContext,
  getMinStreamEventId,
  getStreamEventWatermark,
  heartbeat,
  listArtifacts,
  listSloAlerts,
  listStreamEventsAfter,
  listTasks,
  logActivity,
} from '../db.js';
import { sha256Hex } from '../utils.js';
import { handleGetMemoryDigest } from './memory.js';
import { handleReadSignalFeed } from './signals.js';

const DIGEST_SECTIONS = ['signals', 'events', 'tasks', 'context', 'activity', 'artifacts', 'slo', 'memory'] as const;
const EVENT_STREAMS = ['messages', 'tasks', 'context', 'activity', 'artifacts', 'consensus'] as const;

type DigestSection = (typeof DIGEST_SECTIONS)[number];
type EventStream = (typeof EVENT_STREAMS)[number];
type DigestMode = 'compact' | 'tiny' | 'nano';

function normalizeMode(mode?: string): DigestMode {
  if (mode === 'nano') return 'nano';
  if (mode === 'tiny') return 'tiny';
  return 'compact';
}

function normalizeSections(input?: unknown): DigestSection[] {
  if (!Array.isArray(input) || input.length === 0) return ['signals', 'events', 'tasks', 'context', 'activity', 'artifacts', 'slo', 'memory'];
  const sections = [...new Set(input
    .map((value) => String(value || '').toLowerCase().trim())
    .filter((value): value is DigestSection => DIGEST_SECTIONS.includes(value as DigestSection)))];
  return sections.length > 0 ? sections : ['signals', 'events'];
}

function normalizeStreams(input?: unknown): EventStream[] {
  if (!Array.isArray(input) || input.length === 0) return [...EVENT_STREAMS];
  const streams = [...new Set(input
    .map((value) => String(value || '').toLowerCase().trim())
    .filter((value): value is EventStream => EVENT_STREAMS.includes(value as EventStream)))];
  return streams.length > 0 ? streams : [...EVENT_STREAMS];
}

function parseEventCursor(cursor?: string | null): number | null {
  if (!cursor) return null;
  const raw = String(cursor).trim();
  if (!raw) return null;
  const prefixed = raw.toLowerCase().startsWith('e:');
  const value = prefixed ? raw.slice(2) : raw;
  if (!value) return null;
  if (!/^[0-9a-z]+$/i.test(value)) return null;
  const id = prefixed ? parseInt(value, 36) : (/^[0-9]+$/.test(value) ? Number(value) : parseInt(value, 36));
  if (!Number.isFinite(id) || id < 0) return null;
  return Math.floor(id);
}

function formatEventCursor(id: number): string {
  return `e:${Math.max(0, Math.floor(id)).toString(36)}`;
}

function preview(value: unknown, max = 120): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}...`;
}

function tinyDigest(row: unknown, size = 12): string {
  return sha256Hex(JSON.stringify(row)).slice(0, size);
}

function summarizeTasks(agentId: string, namespace: string | undefined, limit: number, mode: DigestMode) {
  const rows = listTasks({ assigned_to: agentId, namespace, limit });
  const counts = rows.reduce((acc, task) => {
    acc.total += 1;
    acc.by_status[task.status] = (acc.by_status[task.status] || 0) + 1;
    acc.by_priority[task.priority] = (acc.by_priority[task.priority] || 0) + 1;
    return acc;
  }, { total: 0, by_status: {} as Record<string, number>, by_priority: {} as Record<string, number> });
  if (mode === 'nano') return { c: counts, i: rows.map((task) => [task.id, task.status, task.priority, task.updated_at]) };
  if (mode === 'tiny') return { counts, items: rows.map((task) => ({ id: task.id, digest: tinyDigest(task), updated_at: task.updated_at })) };
  return {
    counts,
    items: rows.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      namespace: task.namespace,
      updated_at: task.updated_at,
    })),
  };
}

function summarizeContext(agentId: string, contextAgentId: string | undefined, namespace: string | undefined, limit: number, mode: DigestMode) {
  const rows = getContext({ agent_id: contextAgentId || agentId, namespace, limit });
  if (mode === 'nano') return rows.map((row) => [row.id, row.agent_id, row.key, row.updated_at]);
  if (mode === 'tiny') return rows.map((row) => ({ id: row.id, key: row.key, digest: tinyDigest(row.value), updated_at: row.updated_at }));
  return rows.map((row) => ({
    id: row.id,
    agent_id: row.agent_id,
    key: row.key,
    namespace: row.namespace,
    value_preview: preview(row.value),
    value_digest: sha256Hex(row.value).slice(0, 16),
    updated_at: row.updated_at,
  }));
}

function summarizeActivity(agentId: string, limit: number, mode: DigestMode) {
  const rows = getActivityLog({ agent_id: agentId, limit });
  if (mode === 'nano') return rows.map((row) => [row.id, row.action, row.created_at]);
  if (mode === 'tiny') return rows.map((row) => ({ id: row.id, action: row.action, digest: tinyDigest(row), created_at: row.created_at }));
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    details_preview: preview(row.details),
    created_at: row.created_at,
  }));
}

function summarizeArtifacts(agentId: string, namespace: string | undefined, limit: number, mode: DigestMode) {
  const rows = listArtifacts({ requesting_agent: agentId, namespace, limit })
    .filter((row) => Boolean(row.storage_path));
  if (mode === 'nano') return rows.map((row) => [row.id, row.name, row.size_bytes, row.updated_at]);
  if (mode === 'tiny') return rows.map((row) => ({ id: row.id, digest: tinyDigest(row), updated_at: row.updated_at }));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    namespace: row.namespace,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    summary_preview: preview(row.summary),
    updated_at: row.updated_at,
  }));
}

function summarizeSlo(limit: number, mode: DigestMode) {
  const rows = listSloAlerts({ open_only: true, limit });
  if (mode === 'nano') return rows.map((row) => [row.id, row.code, row.severity, row.updated_at]);
  if (mode === 'tiny') return rows.map((row) => ({ id: row.id, code: row.code, severity: row.severity, digest: tinyDigest(row), updated_at: row.updated_at }));
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    severity: row.severity,
    message: row.message,
    updated_at: row.updated_at,
  }));
}

function summarizeEvents(agentId: string, cursor: string | undefined, streams: EventStream[], limit: number, mode: DigestMode) {
  const parsed = parseEventCursor(cursor);
  const afterId = parsed ?? getStreamEventWatermark({ agent_id: agentId, streams });
  const events = listStreamEventsAfter({ agent_id: agentId, after_id: afterId, streams, limit });
  const nextId = events.length > 0 ? events[events.length - 1].id : afterId;
  const nextCursor = formatEventCursor(nextId);
  const minEventId = getMinStreamEventId({ agent_id: agentId, streams });
  const cursorStale = afterId > 0 && minEventId > 0 && afterId < minEventId;
  if (mode === 'nano') {
    return {
      c: nextCursor,
      x: cursorStale ? 1 : undefined,
      m: cursorStale ? minEventId : undefined,
      i: events.map((event) => [event.id, event.stream, event.op, event.entity_id]),
    };
  }
  if (mode === 'tiny') {
    return {
      cursor: nextCursor,
      cursor_stale: cursorStale || undefined,
      resync_required: cursorStale || undefined,
      resync_hint: cursorStale ? 'read_snapshot' : undefined,
      min_event_id: cursorStale ? minEventId : undefined,
      events: events.map((event) => ({
        id: event.id,
        stream: event.stream,
        op: event.op,
        entity_id: event.entity_id,
      })),
    };
  }
  return {
    cursor: nextCursor,
    cursor_stale: cursorStale || undefined,
    resync_required: cursorStale || undefined,
    resync_hint: cursorStale ? 'read_snapshot' : undefined,
    min_event_id: cursorStale ? minEventId : undefined,
    events: events.map((event) => ({
      id: event.id,
      stream: event.stream,
      op: event.op,
      entity_id: event.entity_id,
      agent_id: event.agent_id,
      target_agent_id: event.target_agent_id,
      namespace: event.namespace,
      created_at: event.created_at,
    })),
  };
}

export function handleGetHubDigest(args: {
  agent_id: string;
  sections?: DigestSection[];
  streams?: EventStream[];
  cursor?: string;
  namespace?: string;
  memory_namespace?: string;
  context_agent_id?: string;
  limit_per_source?: number;
  response_mode?: DigestMode;
}) {
  heartbeat(args.agent_id);
  const mode = normalizeMode(args.response_mode);
  const sections = normalizeSections(args.sections);
  const streams = normalizeStreams(args.streams);
  const limit = Math.max(1, Math.min(50, Math.floor(Number(args.limit_per_source ?? 5))));
  const result: Record<string, unknown> = {};
  if (sections.includes('events') && typeof args.cursor === 'string' && args.cursor.trim().length > 0 && parseEventCursor(args.cursor) === null) {
    return {
      success: false,
      error_code: 'CURSOR_INVALID',
      error: 'Invalid cursor. Expected event cursor "e:<id>".',
    };
  }

  if (sections.includes('signals')) {
    const signalFeed = handleReadSignalFeed({
      agent_id: args.agent_id,
      limit,
      response_mode: mode === 'nano' ? 'nano' : mode,
    }) as Record<string, any>;
    result.signals = mode === 'nano'
      ? { c: signalFeed.c || 0, i: signalFeed.i || [] }
      : { count: signalFeed.count || 0, items: signalFeed.items || [] };
  }
  if (sections.includes('events')) result.events = summarizeEvents(args.agent_id, args.cursor, streams, limit, mode);
  if (sections.includes('tasks')) result.tasks = summarizeTasks(args.agent_id, args.namespace, limit, mode);
  if (sections.includes('context')) result.context = summarizeContext(args.agent_id, args.context_agent_id, args.namespace, limit, mode);
  if (sections.includes('activity')) result.activity = summarizeActivity(args.agent_id, limit, mode);
  if (sections.includes('artifacts')) result.artifacts = summarizeArtifacts(args.agent_id, args.namespace, limit, mode);
  if (sections.includes('slo')) result.slo = summarizeSlo(limit, mode);
  if (sections.includes('memory')) {
    const memoryDigest = handleGetMemoryDigest({
      agent_id: args.agent_id,
      namespace: args.memory_namespace || args.namespace,
      limit,
      response_mode: mode,
    }) as Record<string, any>;
    result.memory = mode === 'nano'
      ? { c: memoryDigest.c || 0, m: memoryDigest.m || [] }
      : { count: memoryDigest.count || 0, namespace: memoryDigest.namespace || null, memories: memoryDigest.memories || [] };
  }

  logActivity(args.agent_id, 'get_hub_digest', `sections=${sections.join(',')} limit=${limit} mode=${mode}`, { emit_stream_event: false });
  if (mode === 'nano') return { s: sections, d: result };
  return { success: true, sections, digest: result };
}

export const digestTools = {
  get_hub_digest: {
    description: 'Get a bounded cross-source hub summary for low-token agent loops: signals, event deltas, assigned tasks, context, memory, activity, artifacts, and SLOs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        sections: { type: 'array', items: { type: 'string', enum: [...DIGEST_SECTIONS] }, description: 'Optional digest sections; defaults to all' },
        streams: { type: 'array', items: { type: 'string', enum: [...EVENT_STREAMS] }, description: 'Event streams used by the events section' },
        cursor: { type: 'string', description: 'Event cursor for the events section ("e:<id>"). Omit to start at current edge.' },
        namespace: { type: 'string', description: 'Optional namespace for tasks/context/artifacts sections' },
        memory_namespace: { type: 'string', description: 'Optional namespace for shared memory section; defaults to namespace/default memory behavior' },
        context_agent_id: { type: 'string', description: 'Optional context owner; defaults to agent_id' },
        limit_per_source: { type: 'number', description: 'Bound each section (default 5, max 50)' },
        response_mode: { type: 'string', enum: ['compact', 'tiny', 'nano'], description: 'Response verbosity' },
        auth_token: { type: 'string', description: 'Optional auth token from register_agent' },
      },
      required: ['agent_id'],
    },
    handler: handleGetHubDigest,
  },
};
