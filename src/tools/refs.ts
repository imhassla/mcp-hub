import { getDb, heartbeat, logActivity } from '../db.js';
import { sha256Hex } from '../utils.js';
import type { ActivityLogEntry, Artifact, ConsensusDecision, Context, Message, Task } from '../types.js';

type FetchRefsResponseMode = 'compact' | 'tiny' | 'nano' | 'full';

interface HubRefs {
  messages?: number[];
  tasks?: number[];
  context?: number[];
  activity?: number[];
  artifacts?: string[];
  consensus?: number[];
}

const MAX_IDS_PER_SOURCE = 100;
const DEFAULT_PREVIEW_CHARS = 220;
const MAX_PREVIEW_CHARS = 1000;

function normalizeResponseMode(mode?: string): FetchRefsResponseMode {
  if (mode === 'full') return 'full';
  if (mode === 'nano') return 'nano';
  if (mode === 'tiny') return 'tiny';
  return 'compact';
}

function normalizeNumberIds(ids?: unknown[]): number[] {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)
    .map((id) => Math.floor(id)))]
    .slice(0, MAX_IDS_PER_SOURCE);
}

function normalizeStringIds(ids?: unknown[]): string[] {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids
    .map((id) => String(id || '').trim())
    .filter((id) => id.length > 0))]
    .slice(0, MAX_IDS_PER_SOURCE);
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

function preview(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function markMessagesRead(agentId: string, ids: number[]) {
  if (ids.length === 0) return;
  const d = getDb();
  const now = Date.now();
  const tx = d.transaction((messageIds: number[]) => {
    const insert = d.prepare('INSERT OR IGNORE INTO message_reads (message_id, agent_id, read_at) VALUES (?, ?, ?)');
    for (const messageId of messageIds) insert.run(messageId, agentId, now);
  });
  tx(ids);
}

function fetchMessages(agentId: string, ids: number[], markRead: boolean): { rows: Message[]; denied: number[]; missing: number[] } {
  if (ids.length === 0) return { rows: [], denied: [], missing: [] };
  const d = getDb();
  const rows = d.prepare(`
    SELECT
      m.*,
      CASE WHEN mr.message_id IS NULL THEN 0 ELSE 1 END AS read
    FROM messages m
    LEFT JOIN message_reads mr
      ON mr.message_id = m.id AND mr.agent_id = ?
    WHERE m.id IN (${placeholders(ids.length)})
    ORDER BY m.created_at DESC, m.id DESC
  `).all(agentId, ...ids) as Message[];
  const found = new Set(rows.map((row) => row.id));
  const visible = rows.filter((row) => row.to_agent === agentId || row.to_agent === null || row.from_agent === agentId);
  const visibleIds = new Set(visible.map((row) => row.id));
  if (markRead) markMessagesRead(agentId, visible.filter((row) => row.read === 0).map((row) => row.id));
  return {
    rows: visible,
    denied: rows.filter((row) => !visibleIds.has(row.id)).map((row) => row.id),
    missing: ids.filter((id) => !found.has(id)),
  };
}

function fetchTasks(ids: number[]): { rows: Task[]; missing: number[] } {
  if (ids.length === 0) return { rows: [], missing: [] };
  const rows = getDb().prepare(`
    SELECT * FROM tasks
    WHERE id IN (${placeholders(ids.length)})
    ORDER BY updated_at DESC, id DESC
  `).all(...ids) as Task[];
  const found = new Set(rows.map((row) => row.id));
  return { rows, missing: ids.filter((id) => !found.has(id)) };
}

function fetchContext(ids: number[]): { rows: Context[]; missing: number[] } {
  if (ids.length === 0) return { rows: [], missing: [] };
  const rows = getDb().prepare(`
    SELECT * FROM context
    WHERE id IN (${placeholders(ids.length)})
    ORDER BY updated_at DESC, id DESC
  `).all(...ids) as Context[];
  const found = new Set(rows.map((row) => row.id));
  return { rows, missing: ids.filter((id) => !found.has(id)) };
}

function fetchActivity(ids: number[]): { rows: ActivityLogEntry[]; missing: number[] } {
  if (ids.length === 0) return { rows: [], missing: [] };
  const rows = getDb().prepare(`
    SELECT * FROM activity_log
    WHERE id IN (${placeholders(ids.length)})
    ORDER BY created_at DESC, id DESC
  `).all(...ids) as ActivityLogEntry[];
  const found = new Set(rows.map((row) => row.id));
  return { rows, missing: ids.filter((id) => !found.has(id)) };
}

function fetchArtifacts(agentId: string, ids: string[]): { rows: Artifact[]; denied: string[]; missing: string[] } {
  if (ids.length === 0) return { rows: [], denied: [], missing: [] };
  const rows = getDb().prepare(`
    SELECT * FROM artifacts
    WHERE id IN (${placeholders(ids.length)})
    ORDER BY updated_at DESC, id DESC
  `).all(...ids) as Artifact[];
  const found = new Set(rows.map((row) => row.id));
  const visible = rows.filter((row) => {
    if (row.created_by === agentId) return true;
    const share = getDb().prepare(`
      SELECT 1 FROM artifact_shares
      WHERE artifact_id = ? AND to_agent IN (?, '*')
      LIMIT 1
    `).get(row.id, agentId);
    return Boolean(share);
  });
  const visibleIds = new Set(visible.map((row) => row.id));
  return {
    rows: visible,
    denied: rows.filter((row) => !visibleIds.has(row.id)).map((row) => row.id),
    missing: ids.filter((id) => !found.has(id)),
  };
}

function fetchConsensus(ids: number[]): { rows: ConsensusDecision[]; missing: number[] } {
  if (ids.length === 0) return { rows: [], missing: [] };
  const rows = getDb().prepare(`
    SELECT * FROM consensus_decisions
    WHERE id IN (${placeholders(ids.length)})
    ORDER BY created_at DESC, id DESC
  `).all(...ids) as ConsensusDecision[];
  const found = new Set(rows.map((row) => row.id));
  return { rows, missing: ids.filter((id) => !found.has(id)) };
}

function formatMessages(rows: Message[], mode: FetchRefsResponseMode, previewChars: number) {
  if (mode === 'nano') return rows.map((row) => [row.id, row.from_agent, row.to_agent, row.created_at, row.read, sha256Hex(row.content).slice(0, 12)]);
  if (mode === 'tiny') return rows.map((row) => ({
    id: row.id,
    from_agent: row.from_agent,
    to_agent: row.to_agent,
    created_at: row.created_at,
    read: row.read,
    content_chars: row.content.length,
    content_digest: sha256Hex(row.content).slice(0, 16),
  }));
  if (mode === 'compact') return rows.map((row) => ({
    id: row.id,
    from_agent: row.from_agent,
    to_agent: row.to_agent,
    created_at: row.created_at,
    read: row.read,
    trace_id: row.trace_id,
    span_id: row.span_id,
    content_preview: preview(row.content, previewChars),
    content_chars: row.content.length,
    content_digest: sha256Hex(row.content).slice(0, 16),
  }));
  return rows;
}

function formatTasks(rows: Task[], mode: FetchRefsResponseMode, previewChars: number) {
  if (mode === 'nano') return rows.map((row) => [row.id, row.status, row.assigned_to, row.priority, row.namespace, row.updated_at]);
  if (mode === 'tiny') return rows.map((row) => ({
    id: row.id,
    status: row.status,
    assigned_to: row.assigned_to,
    priority: row.priority,
    namespace: row.namespace,
    updated_at: row.updated_at,
    title_chars: row.title.length,
  }));
  if (mode === 'compact') return rows.map((row) => ({
    ...row,
    title_preview: preview(row.title, Math.min(previewChars, 120)),
    description_preview: preview(row.description, previewChars),
    description_chars: row.description.length,
  }));
  return rows;
}

function formatContext(rows: Context[], mode: FetchRefsResponseMode, previewChars: number) {
  if (mode === 'nano') return rows.map((row) => [row.id, row.agent_id, row.key, row.namespace, row.updated_at, sha256Hex(row.value).slice(0, 12)]);
  if (mode === 'tiny') return rows.map((row) => ({
    id: row.id,
    agent_id: row.agent_id,
    key: row.key,
    namespace: row.namespace,
    updated_at: row.updated_at,
    value_chars: row.value.length,
    value_digest: sha256Hex(row.value).slice(0, 16),
  }));
  if (mode === 'compact') return rows.map((row) => ({
    ...row,
    value_preview: preview(row.value, previewChars),
    value_chars: row.value.length,
    value_digest: sha256Hex(row.value).slice(0, 16),
    value: undefined,
  }));
  return rows;
}

function formatActivity(rows: ActivityLogEntry[], mode: FetchRefsResponseMode, previewChars: number) {
  if (mode === 'nano') return rows.map((row) => [row.id, row.agent_id, row.action, row.created_at]);
  if (mode === 'tiny') return rows.map((row) => ({
    id: row.id,
    agent_id: row.agent_id,
    action: row.action,
    created_at: row.created_at,
    details_chars: row.details.length,
  }));
  if (mode === 'compact') return rows.map((row) => ({
    ...row,
    details_preview: preview(row.details, previewChars),
    details_chars: row.details.length,
    details: undefined,
  }));
  return rows;
}

function formatArtifacts(rows: Artifact[], mode: FetchRefsResponseMode, previewChars: number) {
  if (mode === 'nano') return rows.map((row) => [row.id, row.name, row.namespace, row.size_bytes, row.updated_at]);
  if (mode === 'tiny') return rows.map((row) => ({
    id: row.id,
    name: row.name,
    namespace: row.namespace,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    ready: row.storage_path ? 1 : 0,
    updated_at: row.updated_at,
  }));
  if (mode === 'compact') return rows.map((row) => ({
    ...row,
    summary_preview: preview(row.summary, previewChars),
    summary_chars: row.summary.length,
    ready: Boolean(row.storage_path),
    storage_path: undefined,
  }));
  return rows;
}

function formatConsensus(rows: ConsensusDecision[], mode: FetchRefsResponseMode, previewChars: number) {
  if (mode === 'nano') return rows.map((row) => [row.id, row.proposal_id, row.outcome, row.created_at]);
  if (mode === 'tiny') return rows.map((row) => ({
    id: row.id,
    proposal_id: row.proposal_id,
    outcome: row.outcome,
    requesting_agent: row.requesting_agent,
    created_at: row.created_at,
  }));
  if (mode === 'compact') return rows.map((row) => ({
    id: row.id,
    proposal_id: row.proposal_id,
    requesting_agent: row.requesting_agent,
    outcome: row.outcome,
    created_at: row.created_at,
    stats_preview: preview(row.stats_json, previewChars),
    reasons_preview: preview(row.reasons_json, previewChars),
  }));
  return rows;
}

export function handleFetchHubRefs(args: {
  agent_id: string;
  refs?: HubRefs;
  response_mode?: FetchRefsResponseMode;
  preview_chars?: number;
  mark_messages_read?: boolean;
}) {
  heartbeat(args.agent_id);
  const refs = args.refs || {};
  const messageIds = normalizeNumberIds(refs.messages);
  const taskIds = normalizeNumberIds(refs.tasks);
  const contextIds = normalizeNumberIds(refs.context);
  const activityIds = normalizeNumberIds(refs.activity);
  const artifactIds = normalizeStringIds(refs.artifacts);
  const consensusIds = normalizeNumberIds(refs.consensus);
  const mode = normalizeResponseMode(args.response_mode);
  const previewChars = Math.max(40, Math.min(MAX_PREVIEW_CHARS, Math.floor(args.preview_chars ?? DEFAULT_PREVIEW_CHARS)));

  const messages = fetchMessages(args.agent_id, messageIds, args.mark_messages_read === true);
  const tasks = fetchTasks(taskIds);
  const context = fetchContext(contextIds);
  const activity = fetchActivity(activityIds);
  const artifacts = fetchArtifacts(args.agent_id, artifactIds);
  const consensus = fetchConsensus(consensusIds);

  const counts = {
    messages: messages.rows.length,
    tasks: tasks.rows.length,
    context: context.rows.length,
    activity: activity.rows.length,
    artifacts: artifacts.rows.length,
    consensus: consensus.rows.length,
  };
  const missing = {
    messages: messages.missing,
    tasks: tasks.missing,
    context: context.missing,
    activity: activity.missing,
    artifacts: artifacts.missing,
    consensus: consensus.missing,
  };
  const denied = {
    messages: messages.denied,
    artifacts: artifacts.denied,
  };

  logActivity(args.agent_id, 'fetch_hub_refs', `counts=${JSON.stringify(counts)} mode=${mode} mark_messages_read=${args.mark_messages_read === true ? 1 : 0}`, { emit_stream_event: false });

  if (mode === 'nano') {
    return {
      c: counts,
      m: formatMessages(messages.rows, mode, previewChars),
      t: formatTasks(tasks.rows, mode, previewChars),
      x: formatContext(context.rows, mode, previewChars),
      a: formatActivity(activity.rows, mode, previewChars),
      f: formatArtifacts(artifacts.rows, mode, previewChars),
      v: formatConsensus(consensus.rows, mode, previewChars),
    };
  }

  return {
    success: true,
    response_mode: mode,
    counts,
    items: {
      messages: formatMessages(messages.rows, mode, previewChars),
      tasks: formatTasks(tasks.rows, mode, previewChars),
      context: formatContext(context.rows, mode, previewChars),
      activity: formatActivity(activity.rows, mode, previewChars),
      artifacts: formatArtifacts(artifacts.rows, mode, previewChars),
      consensus: formatConsensus(consensus.rows, mode, previewChars),
    },
    missing,
    denied,
  };
}

export const refTools = {
  fetch_hub_refs: {
    description: 'Selectively hydrate hub refs from search_hub/read_event_deltas without broad list reads. Message/artifact visibility is enforced; messages are not marked read unless mark_messages_read=true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID; used for message/artifact visibility and heartbeat' },
        refs: {
          type: 'object',
          description: 'Refs to hydrate, grouped by source',
          properties: {
            messages: { type: 'array', items: { type: 'number' }, description: 'Message IDs' },
            tasks: { type: 'array', items: { type: 'number' }, description: 'Task IDs' },
            context: { type: 'array', items: { type: 'number' }, description: 'Context row IDs' },
            activity: { type: 'array', items: { type: 'number' }, description: 'Activity log IDs' },
            artifacts: { type: 'array', items: { type: 'string' }, description: 'Artifact IDs' },
            consensus: { type: 'array', items: { type: 'number' }, description: 'Consensus decision IDs' },
          },
        },
        response_mode: { type: 'string', enum: ['compact', 'tiny', 'nano', 'full'], description: 'compact previews by default; full returns full stored rows for visible refs' },
        preview_chars: { type: 'number', description: `Preview chars for compact rows (default ${DEFAULT_PREVIEW_CHARS}, max ${MAX_PREVIEW_CHARS})` },
        mark_messages_read: { type: 'boolean', description: 'If true, mark fetched visible messages as read. Default false.' },
        auth_token: { type: 'string', description: 'Optional auth token from register_agent' },
      },
      required: ['agent_id'],
    },
    handler: handleFetchHubRefs,
  },
};
