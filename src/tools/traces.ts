import { getDb, heartbeat, logActivity } from '../db.js';
import { sha256Hex } from '../utils.js';

type TraceMode = 'compact' | 'tiny' | 'nano';

const MAX_TRACE_LIMIT = 100;
const DEFAULT_TRACE_LIMIT = 50;

interface TimelineItem {
  source: 'messages' | 'tasks' | 'context' | 'artifacts' | 'activity';
  id: string;
  ref: string;
  ts: number;
  title: string;
  summary: string;
  agent_id: string | null;
  target_agent_id: string | null;
  namespace: string | null;
  span_id: string | null;
}

function normalizeMode(mode?: string): TraceMode {
  if (mode === 'nano') return 'nano';
  if (mode === 'tiny') return 'tiny';
  return 'compact';
}

function preview(value: string | null | undefined, max = 220): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}...`;
}

function timelineDigest(item: TimelineItem): string {
  return sha256Hex(JSON.stringify([item.source, item.id, item.ts, item.title, item.summary])).slice(0, 12);
}

function loadTimelineItems(agentId: string, traceId: string, perSourceLimit: number): TimelineItem[] {
  const d = getDb();
  const messages = d.prepare(`
    SELECT
      'messages' AS source,
      CAST(id AS TEXT) AS id,
      'message:' || id AS ref,
      created_at AS ts,
      from_agent || ' -> ' || COALESCE(to_agent, '*') AS title,
      content || ' ' || COALESCE(metadata, '') AS summary,
      from_agent AS agent_id,
      to_agent AS target_agent_id,
      NULL AS namespace,
      span_id
    FROM messages
    WHERE trace_id = ?
      AND (to_agent = ? OR to_agent IS NULL OR from_agent = ?)
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(traceId, agentId, agentId, perSourceLimit) as TimelineItem[];

  const tasks = d.prepare(`
    SELECT
      'tasks' AS source,
      CAST(id AS TEXT) AS id,
      'task:' || id AS ref,
      updated_at AS ts,
      title || ' [' || status || '/' || priority || ']' AS title,
      description AS summary,
      created_by AS agent_id,
      assigned_to AS target_agent_id,
      namespace,
      span_id
    FROM tasks
    WHERE trace_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `).all(traceId, perSourceLimit) as TimelineItem[];

  const context = d.prepare(`
    SELECT
      'context' AS source,
      CAST(id AS TEXT) AS id,
      'context:' || id AS ref,
      updated_at AS ts,
      agent_id || ':' || key AS title,
      value AS summary,
      agent_id,
      NULL AS target_agent_id,
      namespace,
      span_id
    FROM context
    WHERE trace_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `).all(traceId, perSourceLimit) as TimelineItem[];

  const artifacts = d.prepare(`
    SELECT
      'artifacts' AS source,
      a.id AS id,
      'artifact:' || a.id AS ref,
      MAX(COALESCE(ta.created_at, a.updated_at)) AS ts,
      a.name AS title,
      a.summary AS summary,
      a.created_by AS agent_id,
      NULL AS target_agent_id,
      a.namespace AS namespace,
      NULL AS span_id
    FROM artifacts a
    JOIN task_artifacts ta ON ta.artifact_id = a.id
    JOIN tasks t ON t.id = ta.task_id
    LEFT JOIN artifact_shares s ON s.artifact_id = a.id AND s.to_agent = ?
    WHERE t.trace_id = ?
      AND (a.created_by = ? OR s.to_agent IS NOT NULL OR t.assigned_to = ? OR t.created_by = ?)
    GROUP BY a.id
    ORDER BY ts DESC, a.id DESC
    LIMIT ?
  `).all(agentId, traceId, agentId, agentId, agentId, perSourceLimit) as TimelineItem[];

  const activity = d.prepare(`
    SELECT
      'activity' AS source,
      CAST(id AS TEXT) AS id,
      'activity:' || id AS ref,
      created_at AS ts,
      action AS title,
      details AS summary,
      agent_id,
      NULL AS target_agent_id,
      NULL AS namespace,
      NULL AS span_id
    FROM activity_log
    WHERE agent_id = ?
      AND details LIKE ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(agentId, `%${traceId}%`, perSourceLimit) as TimelineItem[];

  return [...messages, ...tasks, ...context, ...artifacts, ...activity]
    .sort((a, b) => (a.ts - b.ts) || a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}

function formatTimeline(items: TimelineItem[], mode: TraceMode) {
  if (mode === 'nano') {
    return items.map((item) => [item.source[0], item.id, item.ts, item.agent_id || undefined, item.target_agent_id || undefined, item.span_id || undefined]);
  }
  if (mode === 'tiny') {
    return items.map((item) => ({
      source: item.source,
      id: item.id,
      ref: item.ref,
      ts: item.ts,
      digest: timelineDigest(item),
      span_id: item.span_id,
    }));
  }
  return items.map((item) => ({
    source: item.source,
    id: item.id,
    ref: item.ref,
    ts: item.ts,
    title: item.title,
    summary_preview: preview(item.summary),
    agent_id: item.agent_id,
    target_agent_id: item.target_agent_id,
    namespace: item.namespace,
    span_id: item.span_id,
  }));
}

export function handleGetTraceTimeline(args: {
  agent_id: string;
  trace_id: string;
  limit?: number;
  response_mode?: TraceMode;
}) {
  heartbeat(args.agent_id);
  const traceId = String(args.trace_id || '').trim();
  if (!traceId) return { success: false, error_code: 'TRACE_ID_REQUIRED', error: 'trace_id is required' };
  const mode = normalizeMode(args.response_mode);
  const limit = Math.max(1, Math.min(MAX_TRACE_LIMIT, Math.floor(Number(args.limit ?? DEFAULT_TRACE_LIMIT))));
  const items = loadTimelineItems(args.agent_id, traceId, limit).slice(0, limit);
  const counts = items.reduce((acc, item) => {
    acc[item.source] = (acc[item.source] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  logActivity(args.agent_id, 'get_trace_timeline', `trace_id=${traceId} count=${items.length} mode=${mode}`, { emit_stream_event: false });
  if (mode === 'nano') return { t: traceId, c: items.length, s: counts, i: formatTimeline(items, mode) };
  return {
    success: true,
    trace_id: traceId,
    count: items.length,
    counts,
    timeline: formatTimeline(items, mode),
  };
}

export const traceTools = {
  get_trace_timeline: {
    description: 'Get a low-token ordered timeline for a trace_id across visible messages, tasks, context, task artifacts, and own activity rows.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        trace_id: { type: 'string', description: 'Trace identifier to inspect' },
        limit: { type: 'number', description: `Max timeline items (default ${DEFAULT_TRACE_LIMIT}, max ${MAX_TRACE_LIMIT})` },
        response_mode: { type: 'string', enum: ['compact', 'tiny', 'nano'], description: 'Response verbosity' },
        auth_token: { type: 'string', description: 'Optional auth token from register_agent' },
      },
      required: ['agent_id', 'trace_id'],
    },
    handler: handleGetTraceTimeline,
  },
};
