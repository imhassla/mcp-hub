#!/usr/bin/env node
// hub-findings.mjs - publish large structured findings without 1024-char thread truncation.
//
// Pain it fixes: reviewers repeatedly truncate findings to fit reply_thread's 1024-char
// limit (observed ~10x in one session). Instead, store the FULL findings JSON as a
// deduplicated protocol blob and post only a compact pointer (summary + blob hash) to
// the thread. Readers resolve the hash to the full payload on demand.
//
// Publish:
//   node scripts/hub-findings.mjs publish --thread-id T --agent-id ID --token TOK \
//     --findings-file f.json [--role findings-blob] [--summary "..."]
//   (findings JSON may also be piped on stdin)
//
// Fetch:
//   node scripts/hub-findings.mjs fetch --hash HASH --agent-id ID --token TOK
//
// Uses the shared session-recovery client (scripts/lib/mcp-client.mjs).

import fs from 'node:fs/promises';
import { createMcpClient } from './lib/mcp-client.mjs';

const THREAD_LIMIT = 1024;

function parseArgs(argv) {
  const o = {
    mode: argv[0] && !argv[0].startsWith('-') ? argv.shift() : '',
    endpoint: process.env.HUB_ENDPOINT || 'http://127.0.0.1:3000/mcp',
    agentId: process.env.AGENT_ID || '',
    token: process.env.HUB_AUTH_TOKEN || process.env.AUTH_TOKEN || '',
    threadId: '',
    role: 'findings-blob',
    findingsFile: '',
    summary: '',
    hash: '',
    responseMode: 'full',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--endpoint') o.endpoint = next();
    else if (a === '--agent-id') o.agentId = next();
    else if (a === '--token' || a === '--auth-token') o.token = next();
    else if (a === '--thread-id') o.threadId = next();
    else if (a === '--role') o.role = next();
    else if (a === '--findings-file') o.findingsFile = next();
    else if (a === '--summary') o.summary = next();
    else if (a === '--hash') o.hash = next();
    else if (a === '--response-mode') o.responseMode = next();
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (!['publish', 'fetch'].includes(o.mode)) throw new Error('mode must be "publish" or "fetch"');
  if (!o.agentId) throw new Error('--agent-id is required');
  if (!o.token) throw new Error('--token is required (or HUB_AUTH_TOKEN)');
  if (o.mode === 'publish' && !o.threadId) throw new Error('publish requires --thread-id');
  if (o.mode === 'fetch' && !o.hash) throw new Error('fetch requires --hash');
  return o;
}

function printHelp() {
  console.log(`Usage:
  hub-findings.mjs publish --thread-id T --agent-id ID --token TOK --findings-file f.json [--role R] [--summary S]
  hub-findings.mjs fetch --hash HASH --agent-id ID --token TOK

Stores full findings JSON as a protocol blob and posts a compact thread pointer,
so large structured findings are never truncated by the 1024-char thread limit.`);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

// Build a compact (<1024) thread pointer from arbitrary findings.
function summarize(findings, blobHash, explicitSummary) {
  const arr = Array.isArray(findings) ? findings
    : Array.isArray(findings?.findings) ? findings.findings
      : Array.isArray(findings?.f) ? findings.f : [];
  const sev = {};
  for (const f of arr) {
    const s = String(f.severity || f.sev || f.s || 'unknown').toLowerCase();
    sev[s] = (sev[s] || 0) + 1;
  }
  const pointer = {
    role: 'findings-blob',
    blob: blobHash,
    count: arr.length || undefined,
    severities: Object.keys(sev).length ? sev : undefined,
    summary: explicitSummary || findings?.summary || findings?.area || undefined,
    fetch: `hub-findings fetch --hash ${blobHash}`,
  };
  // ensure pointer fits; trim summary if needed
  let text = JSON.stringify(pointer);
  if (text.length > THREAD_LIMIT && pointer.summary) {
    pointer.summary = `${pointer.summary.slice(0, 200)}...`;
    text = JSON.stringify(pointer);
  }
  if (text.length > THREAD_LIMIT) { delete pointer.summary; text = JSON.stringify(pointer); }
  return { pointer, text };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mcp = await createMcpClient(opts.endpoint, { clientName: 'hub-findings', protocolVersion: '2025-06-18' });
  const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  try {
    if (opts.mode === 'publish') {
      const raw = opts.findingsFile ? await fs.readFile(opts.findingsFile, 'utf8') : await readStdin();
      if (!raw.trim()) throw new Error('no findings payload (use --findings-file or stdin)');
      let findings;
      try { findings = JSON.parse(raw); } catch { findings = { raw }; }
      const payload = JSON.stringify(findings);
      if (payload.length > 32768) throw new Error(`findings payload ${payload.length} exceeds blob limit 32768`);

      const stored = await mcp.call('store_protocol_blob', {
        agent_id: opts.agentId,
        payload,
        compression_mode: 'auto',
        auth_token: opts.token,
      });
      const blobHash = stored?.hash || stored?.blob?.hash || stored?.ref;
      if (!blobHash) throw new Error(`store_protocol_blob returned no hash: ${JSON.stringify(stored).slice(0, 200)}`);

      const { pointer, text } = summarize(findings, blobHash, opts.summary);
      const reply = await mcp.call('reply_thread', {
        from_agent: opts.agentId,
        thread_id: opts.threadId,
        content: text,
        role: opts.role,
        auth_token: opts.token,
        idempotency_key: `${opts.agentId}:findings:${blobHash}`,
      });
      out({ action: 'publish', success: reply?.success === true, blob: blobHash, pointer_chars: text.length, payload_chars: payload.length, message_id: reply?.message?.id, pointer });
      process.exit(reply?.success === true ? 0 : 1);
    } else {
      const res = await mcp.call('get_protocol_blob', { agent_id: opts.agentId, hash: opts.hash, response_mode: opts.responseMode, auth_token: opts.token });
      // get_protocol_blob returns { success, blob: { hash, value } } where value is the original payload string.
      const payload = res?.blob?.value ?? res?.blob?.payload ?? res?.payload ?? res?.value;
      if (payload === undefined) throw new Error(`get_protocol_blob returned no value: ${JSON.stringify(res).slice(0, 200)}`);
      process.stdout.write(`${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n`);
      process.exit(0);
    }
  } catch (err) {
    out({ action: opts.mode, success: false, error: String(err?.message || err) });
    process.exit(1);
  } finally {
    await mcp.close();
  }
}

main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
