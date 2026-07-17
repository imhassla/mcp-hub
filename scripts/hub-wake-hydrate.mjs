#!/usr/bin/env node
// hub-wake-hydrate.mjs - low-token wake->hydrate loop for bridge/external agents.
//
// Composition over coupling (R4 decision): the canonical SSE client
// (hub-events-client.mjs) stays a pure ~0-token wake transport; this helper spawns
// it in nano mode and, on each wake, selectively HYDRATES only the changed entities
// via read_event_deltas -> fetch_hub_refs, emitting compact hydrated JSONL.
//
// Why not bolt --hydrate onto the client: that would couple a clean SSE reader to the
// full MCP client surface (tools/call, auth, idempotency, session-recovery). Hydration
// instead composes the SSE reader with the shared session-recovery MCP client.
//
// Guards: debounce (coalesce bursts), dedup entities, bounded fan-out with NO silent
// loss (cap per round via read_event_deltas limit; if has_more, drain without skipping),
// stream filter (only subscribed streams).
//
// Usage:
//   export HUB_AUTH_TOKEN=...
//   node scripts/hub-wake-hydrate.mjs --agent-id ID \
//     --streams messages,tasks --hydrate-mode tiny --cap 25 [--once] [--timeout-ms N]

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpClient } from './lib/mcp-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const envToken = process.env.HUB_AUTH_TOKEN || process.env.AUTH_TOKEN || process.env.MCP_HUB_AUTH_TOKEN || '';
  const o = {
    endpoint: process.env.HUB_ENDPOINT || 'http://127.0.0.1:3000/mcp',
    agentId: process.env.AGENT_ID || '',
    token: envToken,
    tokenFile: process.env.HUB_AUTH_TOKEN_FILE || process.env.AUTH_TOKEN_FILE || '',
    tokenFromArgv: false,
    streams: 'messages,tasks',
    hydrateMode: 'tiny',          // tiny|compact|nano|full for fetch_hub_refs
    cursor: '',
    cursorFile: '',
    cap: 25,                       // max entities hydrated per drain round
    debounceMs: 150,
    previewChars: 0,
    once: false,
    timeoutMs: 0,
    clientPath: path.join(__dirname, 'hub-events-client.mjs'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--endpoint') o.endpoint = next();
    else if (a === '--agent-id') o.agentId = next();
    else if (a === '--token' || a === '--auth-token') { o.token = next(); o.tokenFromArgv = true; }
    else if (a === '--token-file') o.tokenFile = next();
    else if (a === '--streams') o.streams = next();
    else if (a === '--hydrate-mode') o.hydrateMode = next();
    else if (a === '--cursor') o.cursor = next();
    else if (a === '--cursor-file') o.cursorFile = next();
    else if (a === '--cap') o.cap = Number(next());
    else if (a === '--debounce-ms') o.debounceMs = Number(next());
    else if (a === '--preview-chars') o.previewChars = Number(next());
    else if (a === '--once') o.once = true;
    else if (a === '--timeout-ms') o.timeoutMs = Number(next());
    else if (a === '--client-path') o.clientPath = next();
    else if (a === '--help' || a === '-h') { printHelp(o); process.exit(0); }
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (!o.agentId) throw new Error('--agent-id is required');
  if (!['nano', 'tiny', 'compact', 'full'].includes(o.hydrateMode)) {
    throw new Error('--hydrate-mode must be nano|tiny|compact|full');
  }
  if (!Number.isFinite(o.cap) || o.cap < 1) {
    throw new Error('--cap must be a positive number');
  }
  if (!Number.isFinite(o.debounceMs) || o.debounceMs < 0) {
    throw new Error('--debounce-ms must be a non-negative number');
  }
  if (!Number.isFinite(o.previewChars) || o.previewChars < 0) {
    throw new Error('--preview-chars must be a non-negative number');
  }
  return o;
}

function printHelp(o) {
  console.log(`Usage: hub-wake-hydrate.mjs --agent-id ID [options]

Wakes on SSE /events (nano) and hydrates only the changed entities (low token).
Output: JSON Lines {t:"hydrated",cursor,counts,items} and {t:"wake"|"error"}.

Auth:
  Set HUB_AUTH_TOKEN or AUTH_TOKEN in the environment (preferred).
  MCP_HUB_AUTH_TOKEN is also accepted for compatibility.
  --token-file PATH    Read token from a local file (trimmed)
  --token TOKEN        Legacy compatibility only; warning: visible in ps/process listings
  --auth-token TOKEN   Legacy alias with the same ps/process-listing exposure

  --endpoint URL       MCP endpoint (default ${o.endpoint})
  --streams CSV        Streams to watch/hydrate (default messages,tasks)
  --hydrate-mode MODE  fetch_hub_refs response_mode: nano|tiny|compact|full (default tiny)
  --cursor CURSOR      Resume from a fully hydrated cursor, e.g. e:1ab
  --cursor-file PATH   Load/save fully hydrated cursor for safe resume
  --cap N              Max entities hydrated per drain round (default 25, drains rest next round)
  --debounce-ms MS     Coalesce bursts before hydrating (default 150)
  --preview-chars N    Message/content preview length when hydrate-mode supports it
  --once               Exit after the first hydrate batch
  --timeout-ms MS      Exit after MS of wall time`);
}

async function resolveAuthToken(opts) {
  if (!opts.token && opts.tokenFile) {
    opts.token = (await fs.readFile(opts.tokenFile, 'utf8')).trim();
  }
  if (opts.tokenFromArgv) {
    process.stderr.write('[security] --token/--auth-token exposes the auth token in ps/process listings; prefer HUB_AUTH_TOKEN, AUTH_TOKEN, or --token-file.\n');
  }
  if (!opts.token) {
    throw new Error('auth token is required via HUB_AUTH_TOKEN, AUTH_TOKEN, or --token-file (legacy --token/--auth-token is ps-visible)');
  }
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

const STREAM_TO_REF = {
  activity: 'activity',
  artifacts: 'artifacts',
  consensus: 'consensus',
  context: 'context',
  messages: 'messages',
  tasks: 'tasks',
};

function addEntityRef(refs, stream, entityId) {
  const key = STREAM_TO_REF[stream];
  if (!key || entityId === null || entityId === undefined || entityId === '') return;
  const value = key === 'artifacts' ? String(entityId) : Number(entityId);
  if (key !== 'artifacts' && !Number.isFinite(value)) return;
  (refs[key] ||= new Set()).add(value);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await resolveAuthToken(opts);
  const streams = opts.streams.split(',').map((s) => s.trim()).filter(Boolean);
  const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const mcp = await createMcpClient(opts.endpoint, {
    clientName: 'hub-wake-hydrate',
    clientVersion: '1.0.0',
    protocolVersion: '2025-06-18',
  });

  let hydratedCursor = opts.cursor || await readCursorFile(opts.cursorFile); // fully hydrated through
  let pending = false;         // a wake arrived; hydrate scheduled/needed
  let draining = false;        // hydrate loop in flight
  let stopped = false;
  let debounceTimer = null;
  let child = null;
  let cleanupStarted = false;

  const shutdown = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    stopped = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    try { child?.kill('SIGTERM'); } catch { /* noop */ }
    await mcp.close();
  };

  // Drain all deltas since hydratedCursor, bounded per round, NO silent loss.
  const drain = async () => {
    if (draining || stopped) return;
    draining = true;
    try {
      // loop until caught up (has_more false), capped per round
      // eslint-disable-next-line no-constant-condition
      while (!stopped) {
        const deltas = await mcp.call('read_event_deltas', {
          requesting_agent: opts.agentId,
          cursor: hydratedCursor || undefined,
          streams,
          limit: Math.max(1, opts.cap),
          include_payload: false,
          response_mode: 'compact',
          auth_token: opts.token,
        });
        if (deltas?.success !== true) { emit({ t: 'error', stage: 'read_event_deltas', error: deltas?.error_code || deltas?.error || 'failed' }); break; }
        const events = Array.isArray(deltas.events) ? deltas.events : [];
        if (events.length === 0) {
          if (deltas.cursor) {
            hydratedCursor = deltas.cursor;
            await writeCursorFile(opts.cursorFile, hydratedCursor);
          }
          break;
        }

        // group changed entity ids by stream (dedup)
        const refs = {};
        for (const ev of events) {
          addEntityRef(refs, ev.stream, ev.entity_id);
        }
        const refsArr = Object.fromEntries(Object.entries(refs).map(([k, set]) => [k, [...set]]));
        let hydrated = null;
        if (Object.keys(refsArr).length > 0) {
          hydrated = await mcp.call('fetch_hub_refs', {
            agent_id: opts.agentId,
            refs: refsArr,
            response_mode: opts.hydrateMode,
            ...(opts.previewChars > 0 ? { preview_chars: opts.previewChars } : {}),
            auth_token: opts.token,
          });
        }
        emit({
          t: 'hydrated',
          cursor: deltas.cursor,
          changed_streams: [...new Set(events.map((e) => e.stream))],
          counts: hydrated?.counts || {},
          items: hydrated?.items || {},
          missing: hydrated?.missing || undefined,
          denied: hydrated?.denied || undefined,
          has_more: Boolean(deltas.has_more),
        });
        if (deltas.cursor) {
          hydratedCursor = deltas.cursor;
          await writeCursorFile(opts.cursorFile, hydratedCursor);
        }
        if (opts.once) { await shutdown(); break; }
        if (!deltas.has_more) break;   // caught up
        // else loop: next capped round drains the rest (no skip, no silent loss)
      }
    } catch (err) {
      emit({ t: 'error', stage: 'drain', error: String(err?.message || err) });
    } finally {
      draining = false;
      if (pending && !stopped) { pending = false; scheduleDrain(); }
    }
  };

  const scheduleDrain = () => {
    if (stopped) return;
    if (draining) { pending = true; return; }
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => { debounceTimer = null; drain(); }, Math.max(0, opts.debounceMs));
    debounceTimer.unref?.();
  };

  // ---- spawn canonical SSE client as the wake transport (nano, ~0 token) ----
  // T79-F4: pass the auth token via the child's ENV (the client reads AUTH_TOKEN), never on argv,
  // so the secret is not visible in `ps`/proc for the spawned process.
  const childArgs = [
    opts.clientPath,
    '--endpoint', opts.endpoint,
    '--agent-id', opts.agentId,
    '--streams', opts.streams,
    '--response-mode', 'nano',
  ];
  if (hydratedCursor) childArgs.push('--cursor', hydratedCursor);
  child = spawn(process.execPath, childArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AUTH_TOKEN: opts.token },
  });

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.event === 'hello') { if (!hydratedCursor && o.cursor) hydratedCursor = o.cursor; emit({ t: 'wake', kind: 'hello', cursor: o.cursor }); }
      else if (o.event === 'update') { emit({ t: 'wake', kind: 'update', cursor: o.cursor, streams: o.data?.s || o.data?.streams }); scheduleDrain(); }
    }
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim();
    if (text) emit({ t: 'warn', stage: 'sse-client', message: text });
  });

  child.on('exit', () => { if (!stopped) shutdown(); });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  if (opts.timeoutMs > 0) setTimeout(shutdown, opts.timeoutMs).unref?.();

  // resolve when stopped
  await new Promise((resolve) => {
    const iv = setInterval(() => { if (stopped) { clearInterval(iv); resolve(); } }, 50);
    iv.unref?.();
  });
}

main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
