#!/usr/bin/env node
// hub-claim.mjs - collision-free "claim-or-skip" gate for collaborative agents.
//
// Root cause it fixes: agents that declare ownership only in a thread still race and
// duplicate work (observed 3x in one session). claim_task is atomic at the hub, so
// routing work through a claim makes single-ownership BINDING: exactly one agent wins
// a task; the loser is told to skip.
//
// Composable CLI (exit codes make it shell-pipeable):
//   node scripts/hub-claim.mjs --task-id 69 --agent-id ID --token-file /secure/hub.token && do_work || echo skip
//     exit 0  -> claimed (you own it; JSON {claimed:true,claim_id,...} on stdout)
//     exit 3  -> CONFLICT, already owned by another agent (do NOT do the work)
//     exit 1  -> error
//   Release when done:
//   node scripts/hub-claim.mjs --release --task-id 69 --claim-id C --status done \
//     --agent-id ID --token-file /secure/hub.token [--confidence 0.9 --verification-passed \
//     --verified-by REVIEWER --evidence ref1,ref2]
//
// Poll mode (claim next available matching this agent's runtime/profile):
//   node scripts/hub-claim.mjs --poll --namespace NS --agent-id ID --token-file /secure/hub.token

import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createMcpClient } from './lib/mcp-client.mjs';

function parseArgs(argv) {
  const o = {
    endpoint: process.env.HUB_ENDPOINT || 'http://127.0.0.1:3000/mcp',
    agentId: process.env.AGENT_ID || '',
    token: process.env.HUB_AUTH_TOKEN || process.env.AUTH_TOKEN || '',
    tokenFile: process.env.HUB_AUTH_TOKEN_FILE || process.env.AUTH_TOKEN_FILE || '',
    tokenFromArgv: false,
    operationId: process.env.HUB_OPERATION_ID || randomUUID(),
    taskId: 0,
    leaseSeconds: 1800,
    namespace: '',
    release: false,
    poll: false,
    claimId: '',
    status: 'done',
    confidence: undefined,
    verificationPassed: false,
    verifiedBy: '',
    preserveAssignment: false,
    evidence: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--endpoint') o.endpoint = next();
    else if (a === '--agent-id') o.agentId = next();
    else if (a === '--token' || a === '--auth-token') { o.token = next(); o.tokenFromArgv = true; }
    else if (a === '--token-file') o.tokenFile = next();
    else if (a === '--operation-id') o.operationId = next();
    else if (a === '--task-id') o.taskId = Number(next());
    else if (a === '--lease-seconds') o.leaseSeconds = Number(next());
    else if (a === '--namespace') o.namespace = next();
    else if (a === '--release') o.release = true;
    else if (a === '--poll') o.poll = true;
    else if (a === '--claim-id') o.claimId = next();
    else if (a === '--status') o.status = next();
    else if (a === '--next-status') o.status = next();
    else if (a === '--confidence') o.confidence = Number(next());
    else if (a === '--verification-passed') o.verificationPassed = true;
    else if (a === '--verified-by') o.verifiedBy = next();
    else if (a === '--preserve-assignment') o.preserveAssignment = true;
    else if (a === '--evidence') o.evidence = next();
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (!o.agentId) throw new Error('--agent-id is required');
  if (!o.poll && !o.taskId) throw new Error('--task-id is required (or use --poll)');
  if (!['pending', 'done', 'blocked'].includes(o.status)) throw new Error('--status must be pending|done|blocked');
  if (o.release && o.status === 'done' && (!Number.isFinite(o.confidence) || !o.verificationPassed)) {
    throw new Error('--release --status done requires --confidence and --verification-passed');
  }
  if (o.release && !o.claimId) throw new Error('--release requires --claim-id');
  return o;
}

function printHelp() {
  console.log(`Usage: hub-claim.mjs --task-id N --agent-id ID [options]
Atomic claim-or-skip gate. Exit 0=claimed, 3=conflict(skip), 1=error.

Auth: set HUB_AUTH_TOKEN/AUTH_TOKEN (preferred), or use --token-file PATH.
Legacy --token/--auth-token is accepted but visible in ps/process listings.

  --task-id N          Task to claim (or release)
  --poll               Claim next available task (poll_and_claim) instead of a fixed id
  --namespace NS       Namespace for poll/claim
  --lease-seconds N    Claim lease (default 1800)
  --operation-id ID    Stable retry id for one logical operation (default random UUID)
  --release            Release a held claim (with --claim-id --status)
  --claim-id C         Claim id to release
  --status S           Release status: pending|done|blocked (default done)
  --confidence F       Release confidence (done-gate)
  --verification-passed
  --verified-by ID     Independent reviewer that already added task evidence
  --preserve-assignment
                       Keep claimant assignment when releasing pending/blocked
  --evidence a,b,c     Release evidence refs (done-gate)`);
}

async function resolveAuthToken(opts) {
  if (!opts.token && opts.tokenFile) opts.token = (await fs.readFile(opts.tokenFile, 'utf8')).trim();
  if (opts.tokenFromArgv) {
    process.stderr.write('[security] --token/--auth-token exposes the auth token in ps/process listings; prefer HUB_AUTH_TOKEN, AUTH_TOKEN, or --token-file.\n');
  }
  if (!opts.token) throw new Error('auth token is required via HUB_AUTH_TOKEN, AUTH_TOKEN, or --token-file');
}

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
// CONFLICT = another agent already holds/owns it. Distinguish from generic failure.
function isConflict(result) {
  const code = String(result?.error_code || '').toUpperCase();
  const err = String(result?.error || '').toLowerCase();
  return code.includes('CONFLICT') || code.includes('ALREADY') || code.includes('CLAIMED')
    || err.includes('already claimed') || err.includes('held by') || err.includes('owned by');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await resolveAuthToken(opts);
  const mcp = await createMcpClient(opts.endpoint, {
    clientName: 'hub-claim',
    clientVersion: '1.0.0',
    protocolVersion: '2025-06-18',
  });
  let exitCode = 0;
  try {
    if (opts.release) {
      const res = await mcp.call('release_task_claim', {
        task_id: opts.taskId,
        agent_id: opts.agentId,
        auth_token: opts.token,
        claim_id: opts.claimId || undefined,
        next_status: opts.status,
        confidence: Number.isFinite(opts.confidence) ? opts.confidence : undefined,
        verification_passed: opts.verificationPassed || undefined,
        verified_by: opts.verifiedBy || undefined,
        preserve_assignment: opts.preserveAssignment || undefined,
        evidence_refs: opts.evidence ? opts.evidence.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        idempotency_key: `${opts.agentId}:release:${opts.taskId}:${opts.operationId}`,
      });
      out({ action: 'release', success: res?.success === true, status: opts.status, error: res?.success === true ? undefined : (res?.error_code || res?.error) });
      exitCode = res?.success === true ? 0 : 1;
    } else if (opts.poll) {
      const res = await mcp.call('poll_and_claim', {
        agent_id: opts.agentId,
        auth_token: opts.token,
        namespace: opts.namespace || undefined,
        lease_seconds: opts.leaseSeconds,
        idempotency_key: `${opts.agentId}:poll:${opts.namespace || 'default'}:${opts.operationId}`,
      });
      const task = res?.task || res?.claim?.task || null;
      if (res?.success === true && task) {
        out({ action: 'poll', claimed: true, task_id: task.id, claim_id: res?.claim?.claim_id, title: task.title });
        exitCode = 0;
      } else if (res?.success === true) {
        out({ action: 'poll', claimed: false, reason: 'no_available_task' });
        exitCode = 3;
      } else {
        out({ action: 'poll', claimed: false, error: res?.error_code || res?.error || 'poll_failed' });
        exitCode = 1;
      }
    } else {
      const res = await mcp.call('claim_task', {
        task_id: opts.taskId,
        agent_id: opts.agentId,
        auth_token: opts.token,
        lease_seconds: opts.leaseSeconds,
        namespace: opts.namespace || undefined,
        idempotency_key: `${opts.agentId}:claim:${opts.taskId}:${opts.operationId}`,
      });
      if (res?.success === true) {
        out({ action: 'claim', claimed: true, task_id: opts.taskId, claim_id: res?.claim?.claim_id, status: res?.task?.status });
        exitCode = 0;
      } else if (isConflict(res)) {
        out({ action: 'claim', claimed: false, conflict: true, task_id: opts.taskId, owner: res?.claim?.agent_id || res?.task?.assigned_to, reason: res?.error_code || res?.error || 'conflict' });
        exitCode = 3; // skip: someone else owns it
      } else {
        out({ action: 'claim', claimed: false, conflict: false, task_id: opts.taskId, error: res?.error_code || res?.error || 'claim_failed' });
        exitCode = 1;
      }
    }
  } catch (err) {
    out({ action: opts.release ? 'release' : (opts.poll ? 'poll' : 'claim'), claimed: false, error: String(err?.message || err) });
    exitCode = 1;
  } finally {
    await mcp.close();
  }
  process.exit(exitCode);
}

main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
