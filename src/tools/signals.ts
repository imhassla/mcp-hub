import { getDb, heartbeat, logActivity } from '../db.js';
import { sha256Hex } from '../utils.js';

const SIGNAL_SOURCES = ['messages', 'tasks', 'artifacts', 'slo'] as const;
type SignalSource = (typeof SIGNAL_SOURCES)[number];
type SignalMode = 'compact' | 'tiny' | 'nano';

function normalizeSources(input?: unknown): SignalSource[] {
  if (!Array.isArray(input) || input.length === 0) return [...SIGNAL_SOURCES];
  const normalized = [...new Set(input
    .map((value) => String(value || '').toLowerCase().trim())
    .filter((value): value is SignalSource => SIGNAL_SOURCES.includes(value as SignalSource)))];
  return normalized.length > 0 ? normalized : [...SIGNAL_SOURCES];
}

function normalizeMode(mode?: string): SignalMode {
  if (mode === 'nano') return 'nano';
  if (mode === 'tiny') return 'tiny';
  return 'compact';
}

function preview(value: string, max = 160): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}...`;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readMessageSignals(agentId: string, limit: number, includeSelf: boolean) {
  return getDb().prepare(`
    SELECT
      m.id,
      m.from_agent,
      m.to_agent,
      m.content,
      m.metadata,
      m.created_at,
      m.trace_id,
      m.span_id
    FROM messages m
    LEFT JOIN message_reads mr
      ON mr.message_id = m.id AND mr.agent_id = ?
    LEFT JOIN feed_acks fa
      ON fa.agent_id = ? AND fa.source = 'messages' AND fa.entity_id = CAST(m.id AS TEXT)
    WHERE (m.to_agent = ? OR m.to_agent IS NULL)
      AND (? = 1 OR m.from_agent != ?)
      AND mr.message_id IS NULL
      AND fa.entity_id IS NULL
    ORDER BY CASE WHEN m.to_agent = ? THEN 0 ELSE 1 END, m.created_at DESC, m.id DESC
    LIMIT ?
  `).all(agentId, agentId, agentId, includeSelf ? 1 : 0, agentId, agentId, limit) as Array<Record<string, unknown>>;
}

function readTaskSignals(agentId: string, limit: number) {
  return getDb().prepare(`
    SELECT *
    FROM tasks t
    WHERE (
        t.assigned_to = ?
        OR (t.assigned_to IS NULL AND t.priority IN ('critical', 'high') AND t.status = 'pending')
      )
      AND t.status IN ('pending', 'in_progress', 'blocked')
      AND NOT EXISTS (
        SELECT 1 FROM feed_acks fa
        WHERE fa.agent_id = ? AND fa.source = 'tasks' AND fa.entity_id = CAST(t.id AS TEXT)
      )
    ORDER BY
      CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      t.updated_at DESC,
      t.id DESC
    LIMIT ?
  `).all(agentId, agentId, limit) as Array<Record<string, unknown>>;
}

function readArtifactSignals(agentId: string, limit: number) {
  return getDb().prepare(`
    SELECT a.*
    FROM artifacts a
    WHERE a.storage_path IS NOT NULL
      AND (
        a.created_by = ?
        OR EXISTS (
          SELECT 1 FROM artifact_shares s
          WHERE s.artifact_id = a.id AND s.to_agent IN (?, '*')
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM feed_acks fa
        WHERE fa.agent_id = ? AND fa.source = 'artifacts' AND fa.entity_id = a.id
      )
    ORDER BY a.updated_at DESC, a.id DESC
    LIMIT ?
  `).all(agentId, agentId, agentId, limit) as Array<Record<string, unknown>>;
}

function readSloSignals(agentId: string, limit: number) {
  return getDb().prepare(`
    SELECT *
    FROM slo_alerts s
    WHERE s.resolved_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM feed_acks fa
        WHERE fa.agent_id = ? AND fa.source = 'slo' AND fa.entity_id = CAST(s.id AS TEXT)
      )
    ORDER BY
      CASE s.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      s.updated_at DESC,
      s.id DESC
    LIMIT ?
  `).all(agentId, limit) as Array<Record<string, unknown>>;
}

function formatSignal(source: SignalSource, row: Record<string, unknown>, mode: SignalMode) {
  const id = String(row.id);
  const ts = Number(row.updated_at || row.created_at || 0);
  if (mode === 'nano') return [source, id, ts];
  if (mode === 'tiny') {
    const metadata = source === 'messages' ? parseMetadata(row.metadata) : {};
    return {
      source,
      id,
      updated_at: ts,
      digest: sha256Hex(JSON.stringify(row)).slice(0, 12),
      ...(source === 'messages' && row.trace_id ? { trace_id: row.trace_id, thread_id: metadata.thread_id || row.trace_id } : {}),
      ...(source === 'messages' && metadata.thread_role ? { thread_role: metadata.thread_role } : {}),
    };
  }
  if (source === 'messages') {
    const content = String(row.content || '');
    const metadata = parseMetadata(row.metadata);
    return {
      source,
      id,
      from_agent: row.from_agent,
      to_agent: row.to_agent,
      trace_id: row.trace_id,
      thread_id: metadata.thread_id || row.trace_id || null,
      thread_role: metadata.thread_role || null,
      created_at: row.created_at,
      content_preview: preview(content),
      content_digest: sha256Hex(content).slice(0, 16),
    };
  }
  if (source === 'tasks') {
    return {
      source,
      id,
      title: row.title,
      status: row.status,
      priority: row.priority,
      assigned_to: row.assigned_to,
      namespace: row.namespace,
      updated_at: row.updated_at,
    };
  }
  if (source === 'artifacts') {
    return {
      source,
      id,
      name: row.name,
      namespace: row.namespace,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      updated_at: row.updated_at,
      summary_preview: preview(String(row.summary || '')),
    };
  }
  return {
    source,
    id,
    code: row.code,
    severity: row.severity,
    message: row.message,
    updated_at: row.updated_at,
  };
}

export function handleReadSignalFeed(args: {
  agent_id: string;
  sources?: SignalSource[];
  limit?: number;
  response_mode?: SignalMode;
  include_self?: boolean;
}) {
  heartbeat(args.agent_id);
  const sources = normalizeSources(args.sources);
  const mode = normalizeMode(args.response_mode);
  const limit = Math.max(1, Math.min(200, Math.floor(Number(args.limit ?? 50))));
  const perSourceLimit = Math.max(1, Math.min(200, limit));
  const includeSelf = args.include_self === true;
  const rows: Array<{ source: SignalSource; row: Record<string, unknown> }> = [];
  if (sources.includes('messages')) rows.push(...readMessageSignals(args.agent_id, perSourceLimit, includeSelf).map((row) => ({ source: 'messages' as const, row })));
  if (sources.includes('tasks')) rows.push(...readTaskSignals(args.agent_id, perSourceLimit).map((row) => ({ source: 'tasks' as const, row })));
  if (sources.includes('artifacts')) rows.push(...readArtifactSignals(args.agent_id, perSourceLimit).map((row) => ({ source: 'artifacts' as const, row })));
  if (sources.includes('slo')) rows.push(...readSloSignals(args.agent_id, perSourceLimit).map((row) => ({ source: 'slo' as const, row })));
  const items = rows
    .sort((a, b) => Number(b.row.updated_at || b.row.created_at || 0) - Number(a.row.updated_at || a.row.created_at || 0))
    .slice(0, limit)
    .map(({ source, row }) => formatSignal(source, row, mode));
  logActivity(args.agent_id, 'read_signal_feed', `sources=${sources.join(',')} items=${items.length} mode=${mode} include_self=${includeSelf ? 1 : 0}`, { emit_stream_event: false });
  if (mode === 'nano') return { i: items, c: items.length };
  return { success: true, items, count: items.length, sources };
}

export function handleAckFeedItems(args: {
  agent_id: string;
  refs?: Partial<Record<SignalSource, Array<string | number>>>;
  mark_messages_read?: boolean;
}) {
  heartbeat(args.agent_id);
  const refs = args.refs || {};
  const now = Date.now();
  const d = getDb();
  let acked = 0;
  const tx = d.transaction(() => {
    const ack = d.prepare('INSERT OR IGNORE INTO feed_acks (agent_id, source, entity_id, acked_at) VALUES (?, ?, ?, ?)');
    const markRead = d.prepare('INSERT OR IGNORE INTO message_reads (message_id, agent_id, read_at) VALUES (?, ?, ?)');
    for (const source of SIGNAL_SOURCES) {
      const ids = Array.isArray(refs[source]) ? refs[source] || [] : [];
      for (const rawId of ids) {
        const entityId = String(rawId);
        const result = ack.run(args.agent_id, source, entityId, now);
        acked += result.changes;
        if (source === 'messages' && args.mark_messages_read === true) {
          const messageId = Number(entityId);
          if (Number.isInteger(messageId) && messageId > 0) markRead.run(messageId, args.agent_id, now);
        }
      }
    }
  });
  tx();
  logActivity(args.agent_id, 'ack_feed_items', `acked=${acked} mark_messages_read=${args.mark_messages_read === true ? 1 : 0}`, { emit_stream_event: false });
  return { success: true, acked };
}

export const signalTools = {
  read_signal_feed: {
    description: 'Read high-signal feed items without marking messages read. Includes unread messages, assigned/high-priority tasks, ready artifacts, and open SLO alerts.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        sources: { type: 'array', items: { type: 'string', enum: [...SIGNAL_SOURCES] }, description: 'Optional feed sources; defaults to all' },
        limit: { type: 'number', description: 'Max items to return (default 50, max 200)' },
        response_mode: { type: 'string', enum: ['compact', 'tiny', 'nano'], description: 'Response verbosity' },
        include_self: { type: 'boolean', description: 'If true, include your own broadcast messages. Default false reduces self-noise.' },
        auth_token: { type: 'string', description: 'Optional auth token from register_agent' },
      },
      required: ['agent_id'],
    },
    handler: handleReadSignalFeed,
  },
  ack_feed_items: {
    description: 'Acknowledge selected signal feed refs. Optionally mark message refs read.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        refs: { type: 'object', description: 'Refs grouped by source: messages/tasks/artifacts/slo' },
        mark_messages_read: { type: 'boolean', description: 'If true, message refs are also marked read' },
        auth_token: { type: 'string', description: 'Optional auth token from register_agent' },
      },
      required: ['agent_id'],
    },
    handler: handleAckFeedItems,
  },
};
