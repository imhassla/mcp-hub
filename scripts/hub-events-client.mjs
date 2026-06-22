#!/usr/bin/env node
import fs from 'node:fs/promises';

const DEFAULT_ENDPOINT = process.env.EVENTS_ENDPOINT
  || process.env.HUB_EVENTS_URL
  || process.env.MCP_ENDPOINT
  || process.env.ENDPOINT
  || 'http://127.0.0.1:3000/mcp';

function parseArgs(argv) {
  const out = {
    endpoint: DEFAULT_ENDPOINT,
    agentId: process.env.AGENT_ID || process.env.BRIDGE_AGENT_ID || '',
    authToken: process.env.AUTH_TOKEN || process.env.MCP_HUB_AUTH_TOKEN || '',
    streams: process.env.HUB_EVENTS_STREAMS || 'messages,tasks',
    responseMode: process.env.HUB_EVENTS_RESPONSE_MODE || 'nano',
    cursor: process.env.HUB_EVENTS_CURSOR || '',
    cursorFile: process.env.HUB_EVENTS_CURSOR_FILE || '',
    once: false,
    includeHeartbeats: false,
    timeoutMs: Number(process.env.HUB_EVENTS_TIMEOUT_MS || 0),
    maxUpdates: Number(process.env.HUB_EVENTS_MAX_UPDATES || 0),
    pollMs: Number(process.env.HUB_EVENTS_POLL_MS || 0),
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
    else if (arg === '--auth-token') out.authToken = next();
    else if (arg === '--streams') out.streams = next();
    else if (arg === '--response-mode') out.responseMode = next();
    else if (arg === '--cursor') out.cursor = next();
    else if (arg === '--cursor-file') out.cursorFile = next();
    else if (arg === '--poll-ms') out.pollMs = Number(next());
    else if (arg === '--timeout-ms') out.timeoutMs = Number(next());
    else if (arg === '--max-updates') out.maxUpdates = Number(next());
    else if (arg === '--once') out.once = true;
    else if (arg === '--include-heartbeats') out.includeHeartbeats = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: hub-events-client.mjs --agent-id ID --auth-token TOKEN [options]

Options:
  --endpoint URL       MCP endpoint or /events URL (default ${DEFAULT_ENDPOINT})
  --events-url URL     Alias for --endpoint
  --agent-id ID        Agent id to subscribe as
  --auth-token TOKEN   register_agent auth token, sent as Authorization: Bearer
  --streams CSV        Event streams (default messages,tasks)
  --response-mode MODE nano|compact (default nano)
  --cursor CURSOR      Resume cursor, e.g. e:1ab
  --cursor-file PATH   Load/save latest cursor for resume
  --poll-ms MS         Server fallback poll interval hint
  --once              Exit after first update event
  --max-updates N      Exit after N update events
  --timeout-ms MS      Abort after timeout
  --include-heartbeats Print heartbeat events too

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
  if (!opts.authToken) throw new Error('--auth-token is required');
  if (!['nano', 'compact'].includes(opts.responseMode)) throw new Error('--response-mode must be nano|compact');

  const storedCursor = await readCursorFile(opts.cursorFile);
  const cursor = opts.cursor || storedCursor;
  const eventsUrl = toEventsUrl(opts.endpoint);
  eventsUrl.searchParams.set('agent_id', opts.agentId);
  eventsUrl.searchParams.set('streams', opts.streams);
  eventsUrl.searchParams.set('response_mode', opts.responseMode);
  if (cursor) eventsUrl.searchParams.set('cursor', cursor);
  if (Number.isFinite(opts.pollMs) && opts.pollMs > 0) eventsUrl.searchParams.set('poll_ms', String(Math.floor(opts.pollMs)));

  const controller = new AbortController();
  const timeout = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? setTimeout(() => controller.abort(new Error(`timeout ${opts.timeoutMs}ms`)), opts.timeoutMs)
    : null;
  timeout?.unref();

  let updateCount = 0;
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const res = await fetch(eventsUrl, {
    signal: controller.signal,
    headers: {
      accept: 'text/event-stream',
      authorization: `Bearer ${opts.authToken}`,
    },
  });
  if (!res.ok) {
    throw new Error(`events HTTP ${res.status}: ${await res.text()}`);
  }
  if (!res.body) throw new Error('events response body is empty');

  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const rawFrame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseSseFrame(rawFrame);
        const nextCursor = cursorFromPayload(frame.data, frame.id);
        if (nextCursor) await writeCursorFile(opts.cursorFile, nextCursor);
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
          controller.abort();
          return;
        }
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
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
