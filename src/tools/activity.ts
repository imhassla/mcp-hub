import {
  getActivityLog,
  heartbeat,
  logActivity,
  runMaintenance,
  getKpiWindows,
  getUpdateWatermark,
  getMinStreamEventId,
  getStreamEventWatermark,
  listStreamEventsAfter,
  evaluateSloAlerts,
  listSloAlerts,
  getAuthCoverageSnapshot,
} from '../db.js';
import { handleReadMessages } from './messages.js';
import { handleListTasks } from './tasks.js';
import { handleGetContext } from './context.js';
import type { StreamEventName } from '../types.js';

const DEFAULT_WINDOWS_SEC = [60, 300, 1800];
const MAX_WINDOWS = 6;
const MAX_WAIT_MS = Number.isFinite(Number(process.env.MCP_HUB_WAIT_MAX_MS))
  ? Math.max(1_000, Math.min(300_000, Math.floor(Number(process.env.MCP_HUB_WAIT_MAX_MS))))
  : 25_000;
const DEFAULT_WAIT_MS = Number.isFinite(Number(process.env.MCP_HUB_WAIT_DEFAULT_MS))
  ? Math.max(100, Math.min(MAX_WAIT_MS, Math.floor(Number(process.env.MCP_HUB_WAIT_DEFAULT_MS))))
  : 10_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const WAIT_RETRY_FACTOR = Number.isFinite(Number(process.env.MCP_HUB_WAIT_RETRY_FACTOR))
  ? Math.max(1.0, Math.min(3.0, Number(process.env.MCP_HUB_WAIT_RETRY_FACTOR)))
  : 1.5;
const WAIT_RETRY_CAP_MS = Number.isFinite(Number(process.env.MCP_HUB_WAIT_RETRY_CAP_MS))
  ? Math.max(100, Math.min(120_000, Math.floor(Number(process.env.MCP_HUB_WAIT_RETRY_CAP_MS))))
  : 10_000;
const WAIT_RETRY_JITTER_PCT = Number.isFinite(Number(process.env.MCP_HUB_WAIT_RETRY_JITTER_PCT))
  ? Math.max(0, Math.min(0.8, Number(process.env.MCP_HUB_WAIT_RETRY_JITTER_PCT)))
  : 0.2;
const WAIT_RESPONSE_MODES = ['nano', 'micro', 'tiny', 'compact', 'full'] as const;
type WaitResponseMode = (typeof WAIT_RESPONSE_MODES)[number];
const WAIT_TIMEOUT_RESPONSE_MODES = ['default', 'minimal'] as const;
type WaitTimeoutResponseMode = (typeof WAIT_TIMEOUT_RESPONSE_MODES)[number];
const WAIT_STREAMS = ['messages', 'tasks', 'context', 'activity', 'artifacts', 'consensus'] as const;
type WaitStream = (typeof WAIT_STREAMS)[number];
const EVENT_DELTA_STREAMS = ['messages', 'tasks', 'context', 'activity', 'artifacts', 'consensus'] as const;
type EventDeltaStream = (typeof EVENT_DELTA_STREAMS)[number];
const SNAPSHOT_STREAMS = ['messages', 'tasks', 'context', 'activity', 'artifacts', 'consensus'] as const satisfies readonly StreamEventName[];
const TIMESTAMP_WATERMARK_STREAMS = ['messages', 'tasks', 'context', 'activity'] as const;
const DEFAULT_WAIT_RESPONSE_MODE: WaitResponseMode = (() => {
  const configured = String(process.env.MCP_HUB_WAIT_DEFAULT_RESPONSE_MODE || '').toLowerCase().trim();
  if (configured === 'nano') return 'nano';
  if (configured === 'micro') return 'micro';
  if (configured === 'tiny') return 'tiny';
  if (configured === 'full') return 'full';
  return 'compact';
})();
const DEFAULT_WAIT_TIMEOUT_RESPONSE_MODE: WaitTimeoutResponseMode = (() => {
  const configured = String(process.env.MCP_HUB_WAIT_DEFAULT_TIMEOUT_RESPONSE || '').toLowerCase().trim();
  return configured === 'minimal' ? 'minimal' : 'default';
})();
const WAIT_LOG_HITS = String(process.env.MCP_HUB_WAIT_LOG_HITS || '').toLowerCase() === 'true';
const WAIT_LOG_TIMEOUTS = String(process.env.MCP_HUB_WAIT_LOG_TIMEOUTS || '').toLowerCase() === 'true';
const waitTimeoutStreak = new Map<string, number>();
const MAX_SNAPSHOT_LIMIT = 500;
const DEFAULT_SNAPSHOT_LIMIT = 100;

function parseWindowsSec(windowsSec?: number[]): number[] {
  if (!Array.isArray(windowsSec) || windowsSec.length === 0) {
    return DEFAULT_WINDOWS_SEC;
  }
  const unique = [...new Set(
    windowsSec
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => Math.floor(value))
  )];
  return unique.slice(0, MAX_WINDOWS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeAdaptiveWaitRetryMs(agentId: string, baseMs: number): number {
  const misses = (waitTimeoutStreak.get(agentId) ?? 0) + 1;
  waitTimeoutStreak.set(agentId, misses);
  const exponent = Math.max(0, Math.min(6, misses - 1));
  const nominal = Math.min(WAIT_RETRY_CAP_MS, Math.round(baseMs * Math.pow(WAIT_RETRY_FACTOR, exponent)));
  const low = Math.max(baseMs, Math.round(nominal * (1 - WAIT_RETRY_JITTER_PCT)));
  const high = Math.max(low, Math.min(WAIT_RETRY_CAP_MS, Math.round(nominal * (1 + WAIT_RETRY_JITTER_PCT))));
  return low + Math.round(Math.random() * (high - low));
}

function resetAdaptiveWaitRetry(agentId: string) {
  waitTimeoutStreak.delete(agentId);
}

function normalizeWaitResponseMode(mode?: string): WaitResponseMode {
  if (mode === 'nano') return 'nano';
  if (mode === 'micro') return 'micro';
  if (mode === 'tiny') return 'tiny';
  return mode === 'full' ? 'full' : 'compact';
}

function normalizeWaitTimeoutResponseMode(mode?: string): WaitTimeoutResponseMode {
  return mode === 'minimal' ? 'minimal' : 'default';
}

function normalizeSnapshotResponseMode(mode?: string): 'nano' | 'tiny' | 'compact' | 'full' {
  if (mode === 'nano') return 'nano';
  if (mode === 'tiny') return 'tiny';
  if (mode === 'full') return 'full';
  return 'compact';
}

function normalizeWaitStreams(input?: unknown): { ok: true; streams: WaitStream[] } | { ok: false; invalid: string[] } {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: true, streams: [...WAIT_STREAMS] };
  }
  const normalized = [...new Set(input
    .map((value) => String(value || '').toLowerCase().trim())
    .filter((value) => value.length > 0))];
  const invalid = normalized.filter((value) => !WAIT_STREAMS.includes(value as WaitStream));
  if (invalid.length > 0) {
    return { ok: false, invalid };
  }
  return { ok: true, streams: normalized as WaitStream[] };
}

function normalizeEventDeltaStreams(input?: unknown): { ok: true; streams: EventDeltaStream[] } | { ok: false; invalid: string[] } {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: true, streams: [...EVENT_DELTA_STREAMS] };
  }
  const normalized = [...new Set(input
    .map((value) => String(value || '').toLowerCase().trim())
    .filter((value) => value.length > 0))];
  const invalid = normalized.filter((value) => !EVENT_DELTA_STREAMS.includes(value as EventDeltaStream));
  if (invalid.length > 0) {
    return { ok: false, invalid };
  }
  return { ok: true, streams: normalized as EventDeltaStream[] };
}

function changedStreamMap(streams: string[]) {
  return {
    messages: streams.includes('messages'),
    tasks: streams.includes('tasks'),
    context: streams.includes('context'),
    activity: streams.includes('activity'),
    artifacts: streams.includes('artifacts'),
    consensus: streams.includes('consensus'),
  };
}

function timestampWatermarkStreams(streams: readonly string[]) {
  return streams.filter((stream): stream is 'messages' | 'tasks' | 'context' | 'activity' => (
    (TIMESTAMP_WATERMARK_STREAMS as readonly string[]).includes(stream)
  ));
}

function encodeEventCursor(eventId: number): string {
  return `e:${Math.max(0, Math.floor(Number(eventId) || 0)).toString(36)}`;
}

function getCursorStaleness(agentId: string, afterId: number, streams: StreamEventName[]) {
  const minEventId = getMinStreamEventId({ agent_id: agentId, streams });
  if (afterId <= 0 || minEventId <= 0 || afterId >= minEventId) {
    return { stale: false, min_event_id: minEventId };
  }
  return {
    stale: true,
    min_event_id: minEventId,
    resync_required: true,
    resync_hint: 'read_snapshot',
  };
}

function parseEventCursor(cursor?: string): number | null {
  if (typeof cursor !== 'string' || cursor.trim().length === 0) return null;
  const value = cursor.trim();
  const match = /^e:([0-9a-z]+)$/i.exec(value);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 36);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

export function handleGetActivityLog(args: {
  agent_id?: string;
  limit?: number;
  offset?: number;
  requesting_agent?: string;
  response_mode?: 'full' | 'compact' | 'summary';
}) {
  if (args.requesting_agent) heartbeat(args.requesting_agent);
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.floor(Number(args.limit))) : 50;
  const offset = Number.isFinite(args.offset) ? Math.max(0, Math.floor(Number(args.offset))) : 0;
  const log = getActivityLog({ agent_id: args.agent_id, limit, offset });
  if (args.response_mode === 'summary') {
    const perAction = new Map<string, number>();
    for (const entry of log) {
      perAction.set(entry.action, (perAction.get(entry.action) || 0) + 1);
    }
    const topActions = [...perAction.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([action, count]) => ({ action, count }));
    return {
      success: true,
      log: [],
      entries: [],
      summary: {
        count: log.length,
        unique_agents: new Set(log.map((entry) => entry.agent_id)).size,
        top_actions: topActions,
      },
    };
  }
  if (args.response_mode === 'compact') {
    return {
      success: true,
      log: [],
      entries: log.map((entry) => ({
        id: entry.id,
        agent_id: entry.agent_id,
        action: entry.action,
        created_at: entry.created_at,
        details_preview: entry.details.slice(0, 120),
        details_chars: entry.details.length,
      })),
    };
  }
  return { log, entries: log };
}

export function handleGetKpiSnapshot(args: {
  requesting_agent?: string;
  windows_sec?: number[];
  include_auth?: boolean;
  include_slo?: boolean;
  include_top_actions?: boolean;
  include_namespace?: boolean;
  include_execution?: boolean;
  response_mode?: 'full' | 'tiny';
}) {
  if (args.requesting_agent) heartbeat(args.requesting_agent);
  const windowsSec = parseWindowsSec(args.windows_sec);
  const windowsMs = windowsSec.map((seconds) => seconds * 1000);
  const snapshot = getKpiWindows(windowsMs);
  const responseMode = args.response_mode === 'tiny' ? 'tiny' : 'full';

  if (responseMode === 'tiny') {
    return {
      success: true,
      generated_at: snapshot.at,
      windows_sec: windowsSec,
      queue: snapshot.queue,
      latest_window: snapshot.windows[0] || null,
      collective_accuracy: snapshot.collective_accuracy,
    };
  }

  const result: Record<string, unknown> = {
    success: true,
    generated_at: snapshot.at,
    windows_sec: windowsSec,
    queue: snapshot.queue,
    windows: snapshot.windows,
    collective_accuracy: snapshot.collective_accuracy,
  };

  if (args.include_top_actions !== false) {
    result.top_actions_5m = snapshot.top_actions_5m;
  }
  if (args.include_namespace !== false) {
    result.namespace_backlog = snapshot.namespace_backlog;
  }
  if (args.include_execution !== false) {
    result.execution_backlog = snapshot.execution_backlog;
  }
  if (args.include_auth) {
    result.auth_coverage_30m = getAuthCoverageSnapshot(30 * 60 * 1000, snapshot.at);
  }
  if (args.include_slo) {
    result.open_slo_alerts = listSloAlerts({ open_only: true, limit: 100 });
  }

  return result;
}

export function handleGetTransportSnapshot(args: {
  requesting_agent?: string;
  window_sec?: number;
  response_mode?: 'tiny' | 'full';
}) {
  if (args.requesting_agent) heartbeat(args.requesting_agent);
  const windowSec = Number.isFinite(args.window_sec)
    ? Math.max(30, Math.min(7 * 24 * 60 * 60, Math.floor(Number(args.window_sec))))
    : 300;
  const snapshot = getKpiWindows([windowSec * 1000]);
  const latest = snapshot.windows[0] || null;
  if (args.response_mode === 'full') {
    return {
      success: true,
      generated_at: snapshot.at,
      window_sec: windowSec,
      queue: snapshot.queue,
      transport: latest ? {
        wait_calls: latest.wait_calls,
        wait_hits: latest.wait_hits,
        wait_timeouts: latest.wait_timeouts,
        wait_hit_rate_pct: latest.wait_hit_rate_pct,
        wait_retry_after_avg_ms: latest.wait_retry_after_avg_ms,
        wait_retry_after_p95_ms: latest.wait_retry_after_p95_ms,
        polling_calls: latest.polling_calls,
      } : null,
      latest_window: latest,
    };
  }
  return {
    success: true,
    generated_at: snapshot.at,
    window_sec: windowSec,
    transport: latest ? {
      wait_calls: latest.wait_calls,
      wait_hits: latest.wait_hits,
      wait_timeouts: latest.wait_timeouts,
      wait_hit_rate_pct: latest.wait_hit_rate_pct,
      wait_retry_after_avg_ms: latest.wait_retry_after_avg_ms,
      wait_retry_after_p95_ms: latest.wait_retry_after_p95_ms,
      polling_calls: latest.polling_calls,
    } : null,
  };
}

function normalizeSnapshotLimit(value?: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SNAPSHOT_LIMIT;
  return Math.max(1, Math.min(MAX_SNAPSHOT_LIMIT, Math.floor(Number(value))));
}

function isToolErrorPayload(value: unknown): value is { success?: boolean; error_code?: string } {
  return Boolean(
    value
      && typeof value === 'object'
      && (
        (Object.prototype.hasOwnProperty.call(value, 'success') && (value as { success?: unknown }).success === false)
        || Object.prototype.hasOwnProperty.call(value, 'error_code')
      )
  );
}

export function handleReadSnapshot(args: {
  requesting_agent?: string;
  agent_id?: string;
  cursor?: string;
  response_mode?: 'full' | 'compact' | 'tiny' | 'nano';
  message_limit?: number;
  message_from?: string;
  message_unread_only?: boolean;
  task_limit?: number;
  task_status?: string;
  task_assigned_to?: string;
  task_namespace?: string;
  task_execution_mode?: 'any' | 'repo' | 'isolated';
  task_ready_only?: boolean;
  include_dependencies?: boolean;
  context_limit?: number;
  context_agent_id?: string;
  context_key?: string;
  context_namespace?: string;
  resolve_blob_refs?: boolean;
}) {
  const watcherAgentId = args.agent_id || args.requesting_agent;
  if (args.requesting_agent) heartbeat(args.requesting_agent);
  if (!watcherAgentId) {
    return { success: false, error_code: 'AGENT_ID_REQUIRED', error: 'agent_id or requesting_agent is required' };
  }

  const parsedEventCursor = parseEventCursor(args.cursor);
  if (typeof args.cursor === 'string' && args.cursor.trim().length > 0 && parsedEventCursor === null) {
    return {
      success: false,
      error_code: 'CURSOR_INVALID',
      error: 'Invalid cursor. Expected event cursor "e:<id>".',
    };
  }

  const responseMode = normalizeSnapshotResponseMode(args.response_mode);
  if (responseMode === 'full') {
    return {
      success: false,
      error_code: 'FULL_MODE_FORBIDDEN_IN_POLLING',
      error: 'response_mode=full is forbidden in polling snapshots; use nano, tiny, or compact',
      allowed_response_modes: ['nano', 'tiny', 'compact'],
    };
  }

  const messageLimit = normalizeSnapshotLimit(args.message_limit);
  const taskLimit = normalizeSnapshotLimit(args.task_limit);
  const contextLimit = normalizeSnapshotLimit(args.context_limit);
  const eventChanges = parsedEventCursor !== null
    ? listStreamEventsAfter({
      agent_id: watcherAgentId,
      after_id: parsedEventCursor,
      streams: [...SNAPSHOT_STREAMS],
      limit: 1000,
    })
    : [];
  const eventStreams = new Set(eventChanges.map((event) => event.stream));
  const shouldReadAll = parsedEventCursor === null;
  const shouldReadMessages = shouldReadAll || eventStreams.has('messages');
  const shouldReadTasks = shouldReadAll || eventStreams.has('tasks');
  const shouldReadContext = shouldReadAll || eventStreams.has('context');

  const messages = shouldReadMessages ? handleReadMessages({
    agent_id: watcherAgentId,
    from: args.message_from,
    unread_only: args.message_unread_only,
    limit: messageLimit,
    response_mode: responseMode,
    polling: true,
    resolve_blob_refs: args.resolve_blob_refs,
    mark_read: false,
  }) as Record<string, unknown> : (
    responseMode === 'nano'
      ? { m: [], h: 0, n: null }
      : { messages: [], has_more: false, next_cursor: null }
  );
  if (isToolErrorPayload(messages)) {
    return {
      success: false,
      error_code: messages.error_code || 'READ_MESSAGES_FAILED',
      error: 'read_snapshot failed in read_messages stage',
      stage: 'messages',
      cause: messages,
    };
  }

  const tasks = shouldReadTasks ? handleListTasks({
    agent_id: args.requesting_agent || watcherAgentId,
    status: args.task_status,
    assigned_to: args.task_assigned_to,
    namespace: args.task_namespace,
    execution_mode: args.task_execution_mode,
    ready_only: args.task_ready_only,
    include_dependencies: args.include_dependencies,
    limit: taskLimit,
    response_mode: responseMode,
    polling: true,
  }) as Record<string, unknown> : (
    responseMode === 'nano'
      ? { t: [], h: 0, n: null }
      : { tasks: [], has_more: false, next_cursor: null }
  );
  if (isToolErrorPayload(tasks)) {
    return {
      success: false,
      error_code: tasks.error_code || 'LIST_TASKS_FAILED',
      error: 'read_snapshot failed in list_tasks stage',
      stage: 'tasks',
      cause: tasks,
    };
  }

  const context = shouldReadContext ? handleGetContext({
    requesting_agent: args.requesting_agent || watcherAgentId,
    agent_id: args.context_agent_id,
    key: args.context_key,
    namespace: args.context_namespace,
    limit: contextLimit,
    response_mode: responseMode,
    polling: true,
    resolve_blob_refs: args.resolve_blob_refs,
  }) as Record<string, unknown> : (
    responseMode === 'nano'
      ? { c: [], h: 0, n: null }
      : { contexts: [], has_more: false, next_cursor: null }
  );
  if (isToolErrorPayload(context)) {
    return {
      success: false,
      error_code: context.error_code || 'GET_CONTEXT_FAILED',
      error: 'read_snapshot failed in get_context stage',
      stage: 'context',
      cause: context,
    };
  }

  const eventWatermark = getStreamEventWatermark({
    agent_id: watcherAgentId,
    streams: [...SNAPSHOT_STREAMS],
  });
  const lastReturnedEventId = eventChanges.length > 0
    ? eventChanges[eventChanges.length - 1].id
    : eventWatermark;
  const eventsHasMore = lastReturnedEventId < eventWatermark;
  const changed = changedStreamMap([...eventStreams]);
  const messagesCount = Array.isArray((messages as { m?: unknown[] }).m)
    ? (messages as { m: unknown[] }).m.length
    : Array.isArray((messages as { messages?: unknown[] }).messages)
      ? (messages as { messages: unknown[] }).messages.length
      : 0;
  const tasksCount = Array.isArray((tasks as { t?: unknown[] }).t)
    ? (tasks as { t: unknown[] }).t.length
    : Array.isArray((tasks as { tasks?: unknown[] }).tasks)
      ? (tasks as { tasks: unknown[] }).tasks.length
      : 0;
  const contextCount = Array.isArray((context as { c?: unknown[] }).c)
    ? (context as { c: unknown[] }).c.length
    : Array.isArray((context as { contexts?: unknown[] }).contexts)
      ? (context as { contexts: unknown[] }).contexts.length
      : 0;

  logActivity(
    args.requesting_agent || watcherAgentId,
    'read_snapshot',
    `messages=${messagesCount} tasks=${tasksCount} context=${contextCount} mode=${responseMode} cursor_in=${args.cursor || '-'} cursor_out=${encodeEventCursor(lastReturnedEventId)} watermark=${eventWatermark} events_has_more=${eventsHasMore ? 1 : 0}`,
    { emit_stream_event: false }
  );
  const cursor = encodeEventCursor(lastReturnedEventId);

  if (responseMode === 'nano') {
    return {
      s: {
        m: (messages as { m?: unknown[] }).m || [],
        t: (tasks as { t?: unknown[] }).t || [],
        c: (context as { c?: unknown[] }).c || [],
      },
      h: {
        m: Number((messages as { h?: unknown }).h || 0),
        t: Number((tasks as { h?: unknown }).h || 0),
      },
      ch: {
        m: changed.messages ? 1 : 0,
        t: changed.tasks ? 1 : 0,
        c: changed.context ? 1 : 0,
        a: changed.activity ? 1 : 0,
        r: changed.artifacts ? 1 : 0,
        q: changed.consensus ? 1 : 0,
      },
      n: {
        m: (messages as { n?: string | null }).n ?? null,
        t: (tasks as { n?: string | null }).n ?? null,
      },
      u: cursor,
      ei: lastReturnedEventId,
      ew: eventWatermark,
      eh: eventsHasMore ? 1 : 0,
    };
  }

  return {
    success: true,
    response_mode: responseMode,
    changed,
    cursor,
    event_id: lastReturnedEventId,
    event_watermark: eventWatermark,
    events_has_more: eventsHasMore,
    events: eventChanges.map((event) => ({
      id: event.id,
      stream: event.stream,
      op: event.op,
      entity_id: event.entity_id,
      created_at: event.created_at,
    })),
    snapshot: {
      messages,
      tasks,
      context,
    },
    counts: {
      messages: messagesCount,
      tasks: tasksCount,
      context: contextCount,
    },
  };
}

export async function handleWaitForUpdates(args: {
  requesting_agent?: string;
  agent_id?: string;
  streams?: WaitStream[];
  cursor?: string;
  wait_ms?: number;
  poll_interval_ms?: number;
  adaptive_retry?: boolean;
  response_mode?: WaitResponseMode;
  timeout_response?: WaitTimeoutResponseMode;
}) {
  const watcherAgentId = args.agent_id || args.requesting_agent;
  if (args.requesting_agent) heartbeat(args.requesting_agent);
  if (!watcherAgentId) {
    return { success: false, error_code: 'AGENT_ID_REQUIRED', error: 'agent_id or requesting_agent is required' };
  }

  const streamSelection = normalizeWaitStreams(args.streams);
  if (!streamSelection.ok) {
    return {
      success: false,
      error_code: 'STREAMS_INVALID',
      error: `Invalid streams: ${streamSelection.invalid.join(', ')}. Allowed: ${WAIT_STREAMS.join(', ')}`,
    };
  }
  const watchedStreams = streamSelection.streams;

  const responseMode = normalizeWaitResponseMode(args.response_mode || DEFAULT_WAIT_RESPONSE_MODE);
  const timeoutResponseMode = normalizeWaitTimeoutResponseMode(args.timeout_response || DEFAULT_WAIT_TIMEOUT_RESPONSE_MODE);
  const parsedEventCursor = parseEventCursor(args.cursor);
  if (typeof args.cursor === 'string' && args.cursor.trim().length > 0 && parsedEventCursor === null) {
    return {
      success: false,
      error_code: 'CURSOR_INVALID',
      error: 'Invalid cursor. Expected event cursor "e:<id>".',
    };
  }
  const waitMs = Math.max(100, Math.min(MAX_WAIT_MS, Math.floor(Number(args.wait_ms ?? DEFAULT_WAIT_MS))));
  const pollIntervalMs = Math.max(100, Math.min(2_000, Math.floor(Number(args.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS))));
  const startedAt = Date.now();
  const deadline = startedAt + waitMs;
  const afterId = parsedEventCursor ?? getStreamEventWatermark({
    agent_id: watcherAgentId,
    streams: watchedStreams,
  });
  const cursorState = getCursorStaleness(watcherAgentId, afterId, watchedStreams);
  if (cursorState.stale) {
    const watermarkEventId = getStreamEventWatermark({
      agent_id: watcherAgentId,
      streams: watchedStreams,
    });
    const cursor = encodeEventCursor(watermarkEventId);
    const adaptiveRetry = args.adaptive_retry !== false;
    const retryAfterMs = adaptiveRetry
      ? computeAdaptiveWaitRetryMs(watcherAgentId, pollIntervalMs)
      : pollIntervalMs;
    logActivity(
      watcherAgentId,
      'wait_for_updates_cursor_stale',
      `cursor_in=${args.cursor || '-'} min_event_id=${cursorState.min_event_id} event_cursor=${watermarkEventId}`,
      { emit_stream_event: false }
    );
    if (responseMode === 'nano') {
      return { c: 0, u: cursor, r: retryAfterMs, i: watermarkEventId, x: 1, m: cursorState.min_event_id };
    }
    return {
      success: true,
      changed: false,
      cursor,
      retry_after_ms: retryAfterMs,
      event_id: watermarkEventId,
      cursor_stale: true,
      resync_required: true,
      resync_hint: cursorState.resync_hint,
      min_event_id: cursorState.min_event_id,
    };
  }

  while (Date.now() <= deadline) {
    const events = listStreamEventsAfter({
      agent_id: watcherAgentId,
      after_id: afterId,
      streams: watchedStreams,
      limit: 100,
    });
    if (events.length > 0) {
      resetAdaptiveWaitRetry(watcherAgentId);
      const nextEventId = events[events.length - 1].id;
      const cursor = encodeEventCursor(nextEventId);
      const changedStreams = [...new Set(events.map((event) => event.stream))];
      const changed = changedStreamMap(changedStreams);
      if (WAIT_LOG_HITS) {
        logActivity(watcherAgentId, 'wait_for_updates_hit', `event_cursor=${afterId} changed=${JSON.stringify(changed)}`, { emit_stream_event: false });
      }
      if (responseMode === 'nano') {
        return { c: 1, s: changedStreams, u: cursor, i: nextEventId };
      }
      if (responseMode === 'micro') {
        return { changed: true, streams: changedStreams, cursor, event_id: nextEventId };
      }
      if (responseMode === 'tiny') {
        return {
          success: true,
          changed: true,
          streams: changedStreams,
          cursor,
          event_id: nextEventId,
        };
      }
      if (responseMode === 'compact') {
        return {
          success: true,
          changed: true,
          elapsed_ms: Date.now() - startedAt,
          streams: changedStreams,
          cursor,
          event_id: nextEventId,
          events: events.map((event) => ({
            id: event.id,
            stream: event.stream,
            op: event.op,
            entity_id: event.entity_id,
            created_at: event.created_at,
          })),
        };
      }
      return {
        success: true,
        changed: true,
        elapsed_ms: Date.now() - startedAt,
        cursor,
        event_id: nextEventId,
        changed_streams: changed,
        watermark: getUpdateWatermark(watcherAgentId, { streams: timestampWatermarkStreams(watchedStreams) }),
        events,
      };
    }
    await sleep(pollIntervalMs);
  }

  const watermarkEventId = Math.max(afterId, getStreamEventWatermark({
    agent_id: watcherAgentId,
    streams: watchedStreams,
  }));
  const cursor = encodeEventCursor(watermarkEventId);
  const adaptiveRetry = args.adaptive_retry !== false;
  const retryAfterMs = adaptiveRetry
    ? computeAdaptiveWaitRetryMs(watcherAgentId, pollIntervalMs)
    : pollIntervalMs;
  if (WAIT_LOG_TIMEOUTS) {
    logActivity(
      watcherAgentId,
      'wait_for_updates_timeout',
      `wait_ms=${waitMs} retry_after_ms=${retryAfterMs} mode=${responseMode} adaptive=${adaptiveRetry ? 1 : 0} streams=${watchedStreams.join(',')} event_cursor=${watermarkEventId}`,
      { emit_stream_event: false }
    );
  }
  if (timeoutResponseMode === 'minimal') {
    return responseMode === 'nano' ? { c: 0 } : { changed: false };
  }
  if (responseMode === 'nano') {
    return {
      c: 0,
      u: cursor,
      r: retryAfterMs,
      i: watermarkEventId,
    };
  }
  if (responseMode === 'micro') {
    return {
      changed: false,
      cursor,
      retry_after_ms: retryAfterMs,
      event_id: watermarkEventId,
    };
  }
  if (responseMode === 'tiny') {
    return {
      success: true,
      changed: false,
      cursor,
      retry_after_ms: retryAfterMs,
      event_id: watermarkEventId,
    };
  }
  if (responseMode === 'compact') {
    return {
      success: true,
      changed: false,
      elapsed_ms: Date.now() - startedAt,
      cursor,
      retry_after_ms: retryAfterMs,
      event_id: watermarkEventId,
    };
  }
  return {
    success: true,
    changed: false,
    elapsed_ms: Date.now() - startedAt,
    cursor,
    event_id: watermarkEventId,
    changed_streams: changedStreamMap([]),
    watermark: getUpdateWatermark(watcherAgentId, { streams: timestampWatermarkStreams(watchedStreams) }),
  };
}

export function handleReadEventDeltas(args: {
  requesting_agent?: string;
  agent_id?: string;
  cursor?: string;
  streams?: EventDeltaStream[];
  limit?: number;
  include_payload?: boolean;
  response_mode?: 'compact' | 'tiny' | 'nano';
}) {
  const watcherAgentId = args.agent_id || args.requesting_agent;
  if (args.requesting_agent) heartbeat(args.requesting_agent);
  if (!watcherAgentId) {
    return { success: false, error_code: 'AGENT_ID_REQUIRED', error: 'agent_id or requesting_agent is required' };
  }

  const parsedEventCursor = parseEventCursor(args.cursor);
  if (typeof args.cursor === 'string' && args.cursor.trim().length > 0 && parsedEventCursor === null) {
    return {
      success: false,
      error_code: 'CURSOR_INVALID',
      error: 'Invalid cursor. Expected event cursor "e:<id>".',
    };
  }

  const streamSelection = normalizeEventDeltaStreams(args.streams);
  if (!streamSelection.ok) {
    return {
      success: false,
      error_code: 'STREAMS_INVALID',
      error: `Invalid streams: ${streamSelection.invalid.join(', ')}. Allowed: ${EVENT_DELTA_STREAMS.join(', ')}`,
    };
  }
  const streams = streamSelection.streams;
  const limit = Math.max(1, Math.min(1000, Math.floor(Number(args.limit ?? 100))));
  const afterId = parsedEventCursor ?? getStreamEventWatermark({
    agent_id: watcherAgentId,
    streams: streams as StreamEventName[],
  });
  const cursorState = getCursorStaleness(watcherAgentId, afterId, streams as StreamEventName[]);
  const events = listStreamEventsAfter({
    agent_id: watcherAgentId,
    after_id: afterId,
    streams: streams as StreamEventName[],
    limit,
  });
  const watermark = Math.max(afterId, events.length > 0 ? events[events.length - 1].id : getStreamEventWatermark({
    agent_id: watcherAgentId,
    streams: streams as StreamEventName[],
  }));
  const cursor = encodeEventCursor(watermark);
  const changedStreams = [...new Set(events.map((event) => event.stream))];
  const includePayload = args.include_payload === true;
  const mode = args.response_mode === 'nano' ? 'nano' : (args.response_mode === 'tiny' ? 'tiny' : 'compact');

  logActivity(
    args.requesting_agent || watcherAgentId,
    'read_event_deltas',
    `events=${events.length} streams=${streams.join(',')} cursor_in=${args.cursor || '-'} cursor_out=${cursor} mode=${mode}`,
    { emit_stream_event: false }
  );

  if (mode === 'nano') {
    return {
      c: events.length,
      u: cursor,
      i: watermark,
      s: changedStreams,
      x: cursorState.stale ? 1 : undefined,
      m: cursorState.stale ? cursorState.min_event_id : undefined,
      e: events.map((event) => [
        event.id,
        event.stream,
        event.op,
        event.entity_id,
      ]),
    };
  }

  const formattedEvents = events.map((event) => {
    const base = {
      event_id: event.id,
      stream: event.stream,
      op: event.op,
      entity_id: event.entity_id,
      created_at: event.created_at,
    };
    if (mode === 'tiny') return base;
    return {
      ...base,
      agent_id: event.agent_id,
      target_agent_id: event.target_agent_id,
      namespace: event.namespace,
      payload: includePayload ? JSON.parse(event.payload_json || '{}') : undefined,
      payload_chars: event.payload_json.length,
    };
  });

  return {
    success: true,
    changed: events.length > 0,
    streams: changedStreams,
    cursor,
    event_id: watermark,
    cursor_stale: cursorState.stale || undefined,
    resync_required: cursorState.stale || undefined,
    resync_hint: cursorState.stale ? cursorState.resync_hint : undefined,
    min_event_id: cursorState.stale ? cursorState.min_event_id : undefined,
    events: formattedEvents,
    has_more: events.length >= limit,
  };
}

export function handleEvaluateSloAlerts(args: { requesting_agent?: string }) {
  if (args.requesting_agent) heartbeat(args.requesting_agent);
  const evaluation = evaluateSloAlerts();
  if (args.requesting_agent) {
    logActivity(
      args.requesting_agent,
      'evaluate_slo_alerts',
      `triggered=${evaluation.triggered} resolved=${evaluation.resolved} open=${evaluation.open_alerts.length}`
    );
  }
  return { success: true, evaluation };
}

export function handleListSloAlerts(args: { requesting_agent?: string; open_only?: boolean; code?: string; limit?: number; offset?: number }) {
  if (args.requesting_agent) heartbeat(args.requesting_agent);
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.floor(Number(args.limit))) : 100;
  const offset = Number.isFinite(args.offset) ? Math.max(0, Math.floor(Number(args.offset))) : 0;
  const alerts = listSloAlerts({
    open_only: args.open_only,
    code: args.code,
    limit,
    offset,
  });
  return { success: true, alerts };
}

export function handleGetAuthCoverage(args: { requesting_agent?: string; window_sec?: number }) {
  if (args.requesting_agent) heartbeat(args.requesting_agent);
  const windowSec = Number.isFinite(args.window_sec) ? Math.max(60, Math.min(7 * 24 * 60 * 60, Math.floor(Number(args.window_sec)))) : 1800;
  const coverage = getAuthCoverageSnapshot(windowSec * 1000);
  return { success: true, coverage };
}

export function handleRunMaintenance(args: { requesting_agent?: string; dry_run?: boolean }) {
  if (args.requesting_agent) heartbeat(args.requesting_agent);
  if (args.dry_run) {
    return {
      success: true,
      maintenance: {
        dry_run: true,
        note: 'dry_run mode currently reports capability only; run without dry_run to execute cleanup.',
      },
    };
  }
  const summary = runMaintenance();
  if (args.requesting_agent) {
    logActivity(
      args.requesting_agent,
      'run_maintenance',
      `claims=${summary.claims_cleaned} eph_claims=${summary.ephemeral_claims_reaped} requeued=${summary.orphaned_assignments_requeued} offline=${summary.agents_marked_offline} agents_deleted=${summary.agents_deleted} messages=${summary.messages_cleaned} activity=${summary.activity_log_cleaned} stream_events=${summary.stream_events_cleaned} blobs=${summary.protocol_blobs_cleaned} artifacts=${summary.artifacts_cleaned} archived=${summary.tasks_archived} auth_events=${summary.auth_events_cleaned} slo_open=${summary.slo.open_alerts}`
    );
  }
  return { success: true, maintenance: summary };
}

export const activityTools = {
  get_activity_log: {
    description: 'View the activity log of all agents. Optionally filter by agent and use compact/summary modes for token-efficient diagnostics.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        requesting_agent: { type: 'string', description: 'Your agent ID (for heartbeat)' },
        agent_id: { type: 'string', description: 'Filter log by agent ID' },
        limit: { type: 'number', description: 'Max entries to return (default 50)' },
        offset: { type: 'number', description: 'Row offset for pagination (default 0)' },
        response_mode: { type: 'string', enum: ['full', 'compact', 'summary'], description: 'compact trims details fields; summary returns aggregate counts/top actions' },
      },
    },
    handler: handleGetActivityLog,
  },
  get_kpi_snapshot: {
    description: 'Get built-in KPI aggregates for selected windows (defaults: 1m/5m/30m).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        requesting_agent: { type: 'string', description: 'Your agent ID (for heartbeat)' },
        windows_sec: { type: 'array', items: { type: 'number' }, description: 'Window sizes in seconds (e.g. [60,300,1800])' },
        response_mode: { type: 'string', enum: ['full', 'tiny'], description: 'tiny returns queue + latest_window + collective_accuracy only' },
        include_auth: { type: 'boolean', description: 'Include auth coverage metrics (30m)' },
        include_slo: { type: 'boolean', description: 'Include currently open SLO alerts' },
        include_top_actions: { type: 'boolean', description: 'Include top actions in last 5 minutes (default true)' },
        include_namespace: { type: 'boolean', description: 'Include namespace backlog distribution (default true)' },
        include_execution: { type: 'boolean', description: 'Include execution_mode backlog distribution (default true)' },
      },
    },
    handler: handleGetKpiSnapshot,
  },
  get_transport_snapshot: {
    description: 'Get lightweight transport efficiency snapshot for wait/poll behavior over selected window.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        requesting_agent: { type: 'string', description: 'Your agent ID (for heartbeat)' },
        window_sec: { type: 'number', description: 'Aggregation window in seconds (default 300)' },
        response_mode: { type: 'string', enum: ['tiny', 'full'], description: 'tiny returns compact transport metrics only; full includes latest_window and queue' },
      },
    },
    handler: handleGetTransportSnapshot,
  },
  read_snapshot: {
    description: 'Read messages + tasks + context in one polling call with a single cursor. Recommended for orchestrator/reviewer loops.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        requesting_agent: { type: 'string', description: 'Your agent ID (for heartbeat)' },
        agent_id: { type: 'string', description: 'Target agent scope for inbox reads (defaults to requesting_agent)' },
        cursor: { type: 'string', description: 'Snapshot cursor from previous read_snapshot/wait_for_updates response' },
        response_mode: { type: 'string', enum: ['compact', 'tiny', 'nano'], description: 'Use nano for shortest machine-readable payload' },
        message_limit: { type: 'number', description: `Max messages (default ${DEFAULT_SNAPSHOT_LIMIT}, max ${MAX_SNAPSHOT_LIMIT})` },
        message_from: { type: 'string', description: 'Optional sender filter for messages' },
        message_unread_only: { type: 'boolean', description: 'If true, include only unread inbox messages' },
        task_limit: { type: 'number', description: `Max tasks (default ${DEFAULT_SNAPSHOT_LIMIT}, max ${MAX_SNAPSHOT_LIMIT})` },
        task_status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'], description: 'Optional task status filter' },
        task_assigned_to: { type: 'string', description: 'Optional assignee filter' },
        task_namespace: { type: 'string', description: 'Optional task namespace filter' },
        task_execution_mode: { type: 'string', enum: ['any', 'repo', 'isolated'], description: 'Optional task execution-mode filter' },
        task_ready_only: { type: 'boolean', description: 'If true, include only dependency-ready tasks' },
        include_dependencies: { type: 'boolean', description: 'If true, include depends_on IDs in task rows' },
        context_limit: { type: 'number', description: `Max context rows (default ${DEFAULT_SNAPSHOT_LIMIT}, max ${MAX_SNAPSHOT_LIMIT})` },
        context_agent_id: { type: 'string', description: 'Optional context owner filter' },
        context_key: { type: 'string', description: 'Optional context key filter' },
        context_namespace: { type: 'string', description: 'Optional context namespace filter' },
        resolve_blob_refs: { type: 'boolean', description: 'Resolve blob-ref envelopes in messages/context' },
      },
    },
    handler: handleReadSnapshot,
  },
  wait_for_updates: {
    description: 'Long-poll for message/task/context/activity updates to reduce busy polling loops (supports compact delta cursor).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        requesting_agent: { type: 'string', description: 'Your agent ID (for heartbeat)' },
        agent_id: { type: 'string', description: 'Target agent scope (defaults to requesting_agent)' },
        streams: { type: 'array', items: { type: 'string', enum: [...WAIT_STREAMS] }, description: 'Optional stream filter (default all): messages|tasks|context|activity' },
        cursor: { type: 'string', description: 'Event cursor from previous wait_for_updates/read_snapshot response ("e:<id>")' },
        wait_ms: { type: 'number', description: `Wait timeout in milliseconds (max ${MAX_WAIT_MS})` },
        poll_interval_ms: { type: 'number', description: 'Internal poll interval in milliseconds (default 500)' },
        adaptive_retry: { type: 'boolean', description: 'If true (default), timeout responses include adaptive retry_after_ms with backoff+jitter' },
        response_mode: { type: 'string', enum: [...WAIT_RESPONSE_MODES], description: 'nano is shortest machine mode (c/s/u keys); micro is compact cursor mode; tiny is compact; compact (default) includes elapsed+watermark; full includes full timeout payload' },
        timeout_response: { type: 'string', enum: [...WAIT_TIMEOUT_RESPONSE_MODES], description: 'Timeout payload mode: default preserves per-mode fields; minimal returns only changed flag ({changed:false} or {c:0} in nano mode)' },
      },
    },
    handler: handleWaitForUpdates,
  },
  read_event_deltas: {
    description: 'Read exact stream_events refs after an event cursor without hydrating full lists. Use before selective fetch/handoff flows.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        requesting_agent: { type: 'string', description: 'Your agent ID (for heartbeat)' },
        agent_id: { type: 'string', description: 'Target agent scope (defaults to requesting_agent)' },
        cursor: { type: 'string', description: 'Event cursor from wait_for_updates/read_snapshot/read_event_deltas ("e:<id>"). Omit to start at current edge; pass e:0 to replay retained events.' },
        streams: { type: 'array', items: { type: 'string', enum: [...EVENT_DELTA_STREAMS] }, description: 'Optional stream filter; defaults to messages,tasks,context,activity,artifacts,consensus' },
        limit: { type: 'number', description: 'Max events to return (default 100, max 1000)' },
        include_payload: { type: 'boolean', description: 'If true in compact mode, include event payload_json parsed as payload' },
        response_mode: { type: 'string', enum: ['compact', 'tiny', 'nano'], description: 'nano returns tuples; tiny returns event refs; compact can include payload metadata' },
      },
    },
    handler: handleReadEventDeltas,
  },
  evaluate_slo_alerts: {
    description: 'Evaluate SLO rules (pending-age, claim-churn, stale in-progress) and upsert alert state.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        requesting_agent: { type: 'string', description: 'Your agent ID (for heartbeat/logging)' },
      },
    },
    handler: handleEvaluateSloAlerts,
  },
  list_slo_alerts: {
    description: 'List SLO alerts (open by default optional), with pagination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        requesting_agent: { type: 'string', description: 'Your agent ID (for heartbeat)' },
        open_only: { type: 'boolean', description: 'Only open alerts' },
        code: { type: 'string', description: 'Filter by alert code' },
        limit: { type: 'number', description: 'Max rows to return (default 100)' },
        offset: { type: 'number', description: 'Row offset for pagination (default 0)' },
      },
    },
    handler: handleListSloAlerts,
  },
  get_auth_coverage: {
    description: 'Get auth rollout coverage for the given time window.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        requesting_agent: { type: 'string', description: 'Your agent ID (for heartbeat)' },
        window_sec: { type: 'number', description: 'Coverage window in seconds (default 1800)' },
      },
    },
    handler: handleGetAuthCoverage,
  },
  run_maintenance: {
    description: 'Run housekeeping cleanup (claims, offline agents, TTL cleanup, task archiving, auth-event retention, SLO retention).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        requesting_agent: { type: 'string', description: 'Your agent ID (for heartbeat/logging)' },
        dry_run: { type: 'boolean', description: 'If true, do not execute cleanup; return capability info only' },
      },
    },
    handler: handleRunMaintenance,
  },
};
