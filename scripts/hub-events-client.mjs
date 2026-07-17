#!/usr/bin/env node
import fs from 'node:fs/promises';

const DEFAULT_ENDPOINT = process.env.EVENTS_ENDPOINT
  || process.env.HUB_EVENTS_URL
  || process.env.MCP_ENDPOINT
  || process.env.ENDPOINT
  || 'http://127.0.0.1:3000/mcp';

function parseArgs(argv) {
  const envToken = process.env.HUB_AUTH_TOKEN || process.env.AUTH_TOKEN || process.env.MCP_HUB_AUTH_TOKEN || '';
  const out = {
    endpoint: DEFAULT_ENDPOINT,
    agentId: process.env.AGENT_ID || process.env.BRIDGE_AGENT_ID || '',
    authToken: envToken,
    authTokenFile: process.env.HUB_AUTH_TOKEN_FILE || process.env.AUTH_TOKEN_FILE || '',
    authTokenFromArgv: false,
    streams: process.env.HUB_EVENTS_STREAMS || 'messages,tasks',
    responseMode: process.env.HUB_EVENTS_RESPONSE_MODE || 'nano',
    cursor: process.env.HUB_EVENTS_CURSOR || '',
    cursorFile: process.env.HUB_EVENTS_CURSOR_FILE || '',
    once: false,
    includeHeartbeats: false,
    timeoutMs: Number(process.env.HUB_EVENTS_TIMEOUT_MS || 0),
    maxUpdates: Number(process.env.HUB_EVENTS_MAX_UPDATES || 0),
    pollMs: Number(process.env.HUB_EVENTS_POLL_MS || 0),
    reconnect: process.env.HUB_EVENTS_NO_RECONNECT ? false : true,
    maxReconnects: Number(process.env.HUB_EVENTS_MAX_RECONNECTS || 0),
    reconnectMinMs: Number(process.env.HUB_EVENTS_RECONNECT_MIN_MS || 500),
    reconnectMaxMs: Number(process.env.HUB_EVENTS_RECONNECT_MAX_MS || 15000),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    if (arg === '--endpoint') out.endpoint = next();
    else if (arg === '--events-url') out.endpoint = next();
    else if (arg === '--agent-id') out.agentId = next();
    else if (arg === '--auth-token') { out.authToken = next(); out.authTokenFromArgv = true; }
    else if (arg === '--token-file') out.authTokenFile = next();
    else if (arg === '--streams') out.streams = next();
    else if (arg === '--response-mode') out.responseMode = next();
    else if (arg === '--cursor') out.cursor = next();
    else if (arg === '--cursor-file') out.cursorFile = next();
    else if (arg === '--poll-ms') out.pollMs = Number(next());
    else if (arg === '--timeout-ms') out.timeoutMs = Number(next());
    else if (arg === '--max-updates') out.maxUpdates = Number(next());
    else if (arg === '--once') out.once = true;
    else if (arg === '--include-heartbeats') out.includeHeartbeats = true;
    else if (arg === '--no-reconnect') out.reconnect = false;
    else if (arg === '--max-reconnects') out.maxReconnects = Number(next());
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: hub-events-client.mjs --agent-id ID [options]

Auth:
  Set HUB_AUTH_TOKEN or AUTH_TOKEN in the environment (preferred).
  MCP_HUB_AUTH_TOKEN is also accepted for compatibility.
  --token-file PATH    Read token from a local file (trimmed)
  --auth-token TOKEN   Legacy compatibility only; warning: visible in ps/process listings

Options:
  --endpoint URL       MCP endpoint or /events URL (default ${DEFAULT_ENDPOINT})
  --events-url URL     Alias for --endpoint
  --agent-id ID        Agent id to subscribe as
  --streams CSV        Event streams (default messages,tasks)
  --response-mode MODE nano|compact (default nano)
  --cursor CURSOR      Resume cursor, e.g. e:1ab
  --cursor-file PATH   Load/save latest cursor for resume
  --poll-ms MS         Server fallback poll interval hint
  --once              Exit after first update event
  --max-updates N      Exit after N update events
  --timeout-ms MS      Abort after timeout
  --include-heartbeats Print heartbeat events too
  --no-reconnect       Exit on stream drop instead of auto-reconnecting (legacy single-shot)
  --max-reconnects N   Stop after N reconnect attempts (0 = unlimited, default)

Output: JSON Lines {event,id,cursor,data,received_at}`);
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }
  return out;
}

function toEventsUrl(endpoint) {
  const url = new URL(endpoint);
  if (url.pathname.endsWith('/mcp')) {
    url.pathname = `${url.pathname.slice(0, -4)}/events`;
  } else if (!url.pathname.endsWith('/events')) {
    url.pathname = url.pathname.replace(/\/$/, '');
    url.pathname = `${url.pathname}/events`;
  }
  return url;
}

function cursorFromPayload(payload, eventId) {
  if (payload && typeof payload === 'object') {
    if (typeof payload.cursor === 'string') return payload.cursor;
    if (typeof payload.u === 'string') return payload.u;
  }
  if (eventId !== null && eventId !== undefined && eventId !== '') return `e:${Number(eventId).toString(36)}`;
  return '';
}

function lastEventIdFromCursor(cursor) {
  const match = String(cursor || '').trim().match(/^e:([0-9a-z]+)$/i);
  if (!match) return '';
  const id = Number.parseInt(match[1], 36);
  return Number.isFinite(id) && id >= 0 ? String(id) : '';
}

async function readCursorFile(filePath) {
  if (!filePath) return '';
  try {
    return (await fs.readFile(filePath, 'utf8')).trim();
  } catch {
    return '';
  }
}

async function writeCursorFile(filePath, cursor) {
  if (!filePath || !cursor) return;
  await fs.writeFile(filePath, `${cursor}\n`);
}

async function resolveAuthToken(opts) {
  if (!opts.authToken && opts.authTokenFile) {
    opts.authToken = (await fs.readFile(opts.authTokenFile, 'utf8')).trim();
  }
  if (opts.authTokenFromArgv) {
    process.stderr.write('[security] --auth-token exposes the auth token in ps/process listings; prefer HUB_AUTH_TOKEN, AUTH_TOKEN, or --token-file.\n');
  }
  if (!opts.authToken) {
    throw new Error('auth token is required via HUB_AUTH_TOKEN, AUTH_TOKEN, or --token-file (legacy --auth-token is ps-visible)');
  }
}

function parseSseFrame(frame) {
  let event = 'message';
  let id = null;
  const data = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon >= 0 ? rawLine.slice(0, colon) : rawLine;
    const value = colon >= 0 ? rawLine.slice(colon + 1).replace(/^ /, '') : '';
    if (field === 'event') event = value || event;
    else if (field === 'id') id = value;
    else if (field === 'data') data.push(value);
  }
  const text = data.join('\n');
  let payload = text;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  return { event, id, data: payload };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.agentId) throw new Error('--agent-id is required');
  await resolveAuthToken(opts);
  if (!['nano', 'compact'].includes(opts.responseMode)) throw new Error('--response-mode must be nano|compact');

  const storedCursor = await readCursorFile(opts.cursorFile);
  let latestCursor = opts.cursor || storedCursor || '';
  const eventsBase = toEventsUrl(opts.endpoint);

  let updateCount = 0;
  let terminal = false;            // once/max-updates/timeout/signal reached -> do not reconnect
  let currentController = null;
  const abortCurrent = () => { try { currentController?.abort(); } catch { /* noop */ } };
  const stop = () => { terminal = true; abortCurrent(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const timeout = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? setTimeout(() => { terminal = true; abortCurrent(); }, opts.timeoutMs)
    : null;
  timeout?.unref();

  // One connection attempt. Returns 'terminal' (stop) or 'dropped' (reconnect).
  const streamOnce = async () => {
    const url = new URL(eventsBase);
    url.searchParams.set('agent_id', opts.agentId);
    url.searchParams.set('streams', opts.streams);
    url.searchParams.set('response_mode', opts.responseMode);
    if (latestCursor) url.searchParams.set('cursor', latestCursor); // resume without gaps
    if (Number.isFinite(opts.pollMs) && opts.pollMs > 0) url.searchParams.set('poll_ms', String(Math.floor(opts.pollMs)));

    currentController = new AbortController();
    const lastEventId = lastEventIdFromCursor(latestCursor);
    const res = await fetch(url, {
      signal: currentController.signal,
      headers: {
        accept: 'text/event-stream',
        authorization: `Bearer ${opts.authToken}`,
        ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`events HTTP ${res.status}: ${body}`);
      if (res.status !== 429 && res.status < 500) { terminal = true; } // 4xx (auth/bad-req) = fatal
      throw err;
    }
    if (!res.body) throw new Error('events response body is empty');

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const rawFrame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseSseFrame(rawFrame);
        const nextCursor = cursorFromPayload(frame.data, frame.id);
        if (nextCursor) { latestCursor = nextCursor; await writeCursorFile(opts.cursorFile, nextCursor); }
        if (frame.event === 'update') updateCount += 1;
        if (frame.event !== 'heartbeat' || opts.includeHeartbeats) {
          process.stdout.write(`${JSON.stringify({
            event: frame.event,
            id: frame.id,
            cursor: nextCursor || null,
            data: frame.data,
            received_at: Date.now(),
          })}\n`);
        }
        if (frame.event === 'update' && (opts.once || (opts.maxUpdates > 0 && updateCount >= opts.maxUpdates))) {
          terminal = true;
          abortCurrent();
          return 'terminal';
        }
      }
    }
    return 'dropped'; // server closed the stream (drain/heartbeat/restart) without a terminal condition
  };

  let reconnects = 0;
  try {
    while (true) {
      try {
        const reason = await streamOnce();
        if (reason === 'terminal' || terminal) break;
      } catch (error) {
        if (terminal) break;                 // timeout/signal/fatal status
        if (!opts.reconnect) throw error;    // legacy single-shot
        process.stderr.write(`[reconnect] ${String(error?.message || error)}\n`);
      }
      if (terminal || !opts.reconnect) break;
      if (opts.maxReconnects > 0 && reconnects >= opts.maxReconnects) break;
      reconnects += 1;
      const backoff = Math.min(opts.reconnectMaxMs, opts.reconnectMinMs * 2 ** Math.min(reconnects, 6));
      await new Promise((r) => { const t = setTimeout(r, backoff); t.unref?.(); });
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
