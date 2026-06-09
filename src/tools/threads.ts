import { getDb, sendMessage, heartbeat, logActivity } from '../db.js';
import type { Message } from '../types.js';
import { sha256Hex, withIdempotency } from '../utils.js';

type ThreadMode = 'compact' | 'tiny' | 'nano';
type ThreadOrder = 'latest' | 'oldest';

const DEFAULT_THREAD_LIMIT = 50;
const MAX_THREAD_LIMIT = 200;
const MAX_THREAD_TITLE_CHARS = 160;
const MAX_THREAD_CONTENT_CHARS = Number(process.env.MCP_HUB_MAX_MESSAGE_CONTENT_CHARS || 1024);

function normalizeMode(mode?: string): ThreadMode {
  if (mode === 'nano') return 'nano';
  if (mode === 'tiny') return 'tiny';
  return 'compact';
}

function normalizeThreadId(threadId?: string): string {
  return String(threadId || '').trim().slice(0, 120);
}

function normalizeOrder(order?: string): ThreadOrder {
  return order === 'oldest' ? 'oldest' : 'latest';
}

function makeThreadId(seed: string): string {
  return `thread-${sha256Hex(seed).slice(0, 16)}`;
}

function threadMetadata(args: {
  thread_id: string;
  title?: string;
  role?: string;
  parent_message_id?: number;
  extra?: Record<string, unknown>;
}) {
  return JSON.stringify({
    ...(args.extra || {}),
    thread_id: args.thread_id,
    thread_title: args.title ? String(args.title).slice(0, MAX_THREAD_TITLE_CHARS) : undefined,
    thread_role: args.role,
    parent_message_id: args.parent_message_id,
  });
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function formatThreadMessages(messages: Message[], mode: ThreadMode) {
  return messages.map((message) => {
    const metadata = parseMetadata(message.metadata);
    if (mode === 'nano') {
      return [
        message.id,
        message.from_agent,
        message.to_agent || '*',
        message.created_at,
        message.content.length,
        sha256Hex(message.content).slice(0, 12),
      ];
    }
    const base = {
      id: message.id,
      from_agent: message.from_agent,
      to_agent: message.to_agent,
      created_at: message.created_at,
      content_chars: message.content.length,
      content_digest: sha256Hex(message.content).slice(0, 16),
      role: metadata.thread_role || null,
      parent_message_id: metadata.parent_message_id || null,
    };
    if (mode === 'tiny') return base;
    return {
      ...base,
      content_preview: message.content.slice(0, 220),
      metadata,
    };
  });
}

export function handleStartThread(args: {
  from_agent: string;
  to_agent?: string;
  title: string;
  content: string;
  thread_id?: string;
  idempotency_key?: string;
}) {
  heartbeat(args.from_agent);
  return withIdempotency(args.from_agent, 'start_thread', args.idempotency_key, () => {
    const title = String(args.title || '').trim().slice(0, MAX_THREAD_TITLE_CHARS);
    const content = String(args.content || '').trim();
    if (!title) return { success: false, error_code: 'THREAD_TITLE_REQUIRED', error: 'title is required' };
    if (!content) return { success: false, error_code: 'THREAD_CONTENT_REQUIRED', error: 'content is required' };
    if (content.length > MAX_THREAD_CONTENT_CHARS) {
      return { success: false, error_code: 'CONTENT_TOO_LONG', error: `content too long (${content.length})`, max_chars: MAX_THREAD_CONTENT_CHARS };
    }
    const threadId = normalizeThreadId(args.thread_id) || makeThreadId(`${args.from_agent}:${title}:${Date.now()}`);
    const message = sendMessage(
      args.from_agent,
      args.to_agent || null,
      content,
      threadMetadata({ thread_id: threadId, title, role: 'start' }),
      threadId,
      'thread:start',
    );
    logActivity(args.from_agent, 'start_thread', `thread_id=${threadId} message_id=${message.id} to=${args.to_agent || '*'}`);
    return {
      success: true,
      thread: { thread_id: threadId, title, root_message_id: message.id },
      message,
    };
  });
}

export function handleReplyThread(args: {
  from_agent: string;
  thread_id: string;
  content: string;
  to_agent?: string;
  parent_message_id?: number;
  role?: string;
  idempotency_key?: string;
}) {
  heartbeat(args.from_agent);
  return withIdempotency(args.from_agent, 'reply_thread', args.idempotency_key, () => {
    const threadId = normalizeThreadId(args.thread_id);
    const content = String(args.content || '').trim();
    if (!threadId) return { success: false, error_code: 'THREAD_ID_REQUIRED', error: 'thread_id is required' };
    if (!content) return { success: false, error_code: 'THREAD_CONTENT_REQUIRED', error: 'content is required' };
    if (content.length > MAX_THREAD_CONTENT_CHARS) {
      return { success: false, error_code: 'CONTENT_TOO_LONG', error: `content too long (${content.length})`, max_chars: MAX_THREAD_CONTENT_CHARS };
    }
    const role = String(args.role || 'reply').trim().slice(0, 48) || 'reply';
    const message = sendMessage(
      args.from_agent,
      args.to_agent || null,
      content,
      threadMetadata({ thread_id: threadId, role, parent_message_id: args.parent_message_id }),
      threadId,
      `thread:${role}`,
    );
    logActivity(args.from_agent, 'reply_thread', `thread_id=${threadId} message_id=${message.id} role=${role} to=${args.to_agent || '*'}`);
    return { success: true, thread_id: threadId, message };
  });
}

export function handleReadThread(args: {
  agent_id: string;
  thread_id: string;
  limit?: number;
  response_mode?: ThreadMode;
  after_message_id?: number;
  before_message_id?: number;
  order?: ThreadOrder;
}) {
  heartbeat(args.agent_id);
  const threadId = normalizeThreadId(args.thread_id);
  if (!threadId) return { success: false, error_code: 'THREAD_ID_REQUIRED', error: 'thread_id is required' };
  const mode = normalizeMode(args.response_mode);
  const order = normalizeOrder(args.order);
  const limit = Math.max(1, Math.min(MAX_THREAD_LIMIT, Math.floor(Number(args.limit ?? DEFAULT_THREAD_LIMIT))));
  const afterMessageId = Math.max(0, Math.floor(Number(args.after_message_id || 0)));
  const beforeMessageId = Math.max(0, Math.floor(Number(args.before_message_id || 0)));
  const where: string[] = [
    'm.trace_id = ?',
    '(m.to_agent = ? OR m.to_agent IS NULL OR m.from_agent = ?)',
  ];
  const params: Array<string | number> = [args.agent_id, threadId, args.agent_id, args.agent_id];
  if (afterMessageId > 0) {
    where.push('m.id > ?');
    params.push(afterMessageId);
  }
  if (beforeMessageId > 0) {
    where.push('m.id < ?');
    params.push(beforeMessageId);
  }
  const orderSql = afterMessageId > 0 || order === 'oldest'
    ? 'm.created_at ASC, m.id ASC'
    : 'm.created_at DESC, m.id DESC';
  const rows = getDb().prepare(`
    SELECT
      m.*,
      CASE WHEN mr.message_id IS NULL THEN 0 ELSE 1 END AS read
    FROM messages m
    LEFT JOIN message_reads mr
      ON mr.message_id = m.id AND mr.agent_id = ?
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderSql}
    LIMIT ?
  `).all(...params, limit + 1) as Message[];
  const hasMore = rows.length > limit;
  let messages = rows.slice(0, limit);
  if (afterMessageId === 0 && order !== 'oldest') messages = messages.reverse();
  const nextCursor = messages.length > 0 ? Math.max(...messages.map((message) => message.id)) : afterMessageId;
  const previousCursor = messages.length > 0 ? Math.min(...messages.map((message) => message.id)) : beforeMessageId;
  logActivity(args.agent_id, 'read_thread', `thread_id=${threadId} messages=${messages.length} mode=${mode} order=${order}`, { emit_stream_event: false });
  if (mode === 'nano') return { t: threadId, c: messages.length, m: formatThreadMessages(messages, mode), u: nextCursor, p: previousCursor, h: hasMore ? 1 : 0 };
  return {
    success: true,
    thread_id: threadId,
    count: messages.length,
    messages: formatThreadMessages(messages, mode),
    next_cursor: nextCursor,
    previous_cursor: previousCursor,
    has_more: hasMore,
    order,
  };
}

export const threadTools = {
  start_thread: {
    description: 'Start a trace-backed discussion thread using messages metadata. Useful for multi-agent topic discussions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from_agent: { type: 'string', description: 'Your agent ID' },
        to_agent: { type: 'string', description: 'Optional target agent; omit for broadcast thread' },
        title: { type: 'string', description: 'Thread title' },
        content: { type: 'string', description: 'Initial message content' },
        thread_id: { type: 'string', description: 'Optional stable thread id; generated if omitted' },
        idempotency_key: { type: 'string', description: 'Optional idempotency key' },
        auth_token: { type: 'string', description: 'Optional auth token from register_agent' },
      },
      required: ['from_agent', 'title', 'content'],
    },
    handler: handleStartThread,
  },
  reply_thread: {
    description: 'Reply to a discussion thread. Stores thread_id in trace_id and message metadata for search/trace compatibility.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from_agent: { type: 'string', description: 'Your agent ID' },
        thread_id: { type: 'string', description: 'Thread id returned by start_thread' },
        content: { type: 'string', description: 'Reply content' },
        to_agent: { type: 'string', description: 'Optional target agent; omit for broadcast reply' },
        parent_message_id: { type: 'number', description: 'Optional parent message id' },
        role: { type: 'string', description: 'Optional role label, e.g. hypothesis/review/decision' },
        idempotency_key: { type: 'string', description: 'Optional idempotency key' },
        auth_token: { type: 'string', description: 'Optional auth token from register_agent' },
      },
      required: ['from_agent', 'thread_id', 'content'],
    },
    handler: handleReplyThread,
  },
  read_thread: {
    description: 'Read visible messages in a discussion thread without marking them read. Supports compact/tiny/nano output.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        thread_id: { type: 'string', description: 'Thread id' },
        limit: { type: 'number', description: `Max messages (default ${DEFAULT_THREAD_LIMIT}, max ${MAX_THREAD_LIMIT})` },
        response_mode: { type: 'string', enum: ['compact', 'tiny', 'nano'], description: 'Response verbosity' },
        after_message_id: { type: 'number', description: 'Only return messages with id greater than this cursor' },
        before_message_id: { type: 'number', description: 'Only return messages with id lower than this cursor' },
        order: { type: 'string', enum: ['latest', 'oldest'], description: 'Default latest returns the newest tail in chronological output order' },
        auth_token: { type: 'string', description: 'Optional auth token from register_agent' },
      },
      required: ['agent_id', 'thread_id'],
    },
    handler: handleReadThread,
  },
};
