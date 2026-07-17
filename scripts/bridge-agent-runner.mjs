#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMcpClient as createMcpHttpClient } from './lib/mcp-client.mjs';
import {
  assessTaskCompletion,
  getOrCreateAgentToken,
  readAgentToken,
  resolveThreadPublicationPolicy,
  runIdempotencyKey,
  sanitizeBackendEnv,
  taskRequiresIndependentVerifier,
  writeAgentToken,
  writePrivateJson,
} from './lib/bridge-runtime.mjs';

process.umask(0o077);

const DEFAULT_ENDPOINT = process.env.ENDPOINT || process.env.MCP_ENDPOINT || 'http://127.0.0.1:3000/mcp';
const MAX_CONTEXT_CHARS = Number(process.env.BRIDGE_CONTEXT_MAX_CHARS || 1900);
const MAX_MESSAGE_CHARS = Number(process.env.BRIDGE_MESSAGE_MAX_CHARS || 900);
const MAX_PREFLIGHT_CHARS = Number(process.env.BRIDGE_PREFLIGHT_MAX_CHARS || 3000);
const RESULT_BLOB_MIN_CHARS = Number.isFinite(Number(process.env.BRIDGE_RESULT_BLOB_MIN_CHARS))
  ? Math.max(0, Math.floor(Number(process.env.BRIDGE_RESULT_BLOB_MIN_CHARS)))
  : 1800;
const RESULT_BLOB_MAX_CHARS = Number.isFinite(Number(process.env.BRIDGE_RESULT_BLOB_MAX_CHARS))
  ? Math.max(4096, Math.min(32768, Math.floor(Number(process.env.BRIDGE_RESULT_BLOB_MAX_CHARS))))
  : 30_000;
const BRIDGE_HTTP_RETRIES = Number.isFinite(Number(process.env.BRIDGE_HTTP_RETRIES))
  ? Math.max(0, Math.min(5, Math.floor(Number(process.env.BRIDGE_HTTP_RETRIES))))
  : 2;
const BRIDGE_HTTP_RETRY_DELAY_MS = Number.isFinite(Number(process.env.BRIDGE_HTTP_RETRY_DELAY_MS))
  ? Math.max(25, Math.min(5_000, Math.floor(Number(process.env.BRIDGE_HTTP_RETRY_DELAY_MS))))
  : 250;
const BRIDGE_HTTP_TIMEOUT_MS = Number.isFinite(Number(process.env.BRIDGE_HTTP_TIMEOUT_MS))
  ? Math.max(250, Math.min(120_000, Math.floor(Number(process.env.BRIDGE_HTTP_TIMEOUT_MS))))
  : 15_000;
const BRIDGE_STATUS_HEARTBEAT_MS = Number.isFinite(Number(process.env.BRIDGE_STATUS_HEARTBEAT_MS))
  ? Math.max(5_000, Math.min(10 * 60_000, Math.floor(Number(process.env.BRIDGE_STATUS_HEARTBEAT_MS))))
  : 60_000;

let rpcRetries = 0;

function parseArgs(argv) {
  const out = {
    endpoint: DEFAULT_ENDPOINT,
    backend: 'codex',
    agentId: '',
    agentName: '',
    role: process.env.BRIDGE_AGENT_ROLE || 'worker',
    lifecycle: process.env.BRIDGE_AGENT_LIFECYCLE || 'ephemeral',
    onboardingMode: process.env.BRIDGE_ONBOARDING_MODE || 'none',
    registerToken: process.env.BRIDGE_REGISTER_TOKEN || process.env.MCP_HUB_REGISTER_TOKEN || '',
    registerTokenFromArgv: false,
    agentAuthToken: process.env.BRIDGE_AGENT_AUTH_TOKEN || '',
    agentTokenFile: process.env.BRIDGE_AGENT_TOKEN_FILE || '',
    capabilities: process.env.BRIDGE_AGENT_CAPABILITIES || '',
    namespace: `BRIDGE-${Date.now()}`,
    key: '',
    taskId: 0,
    requireClaim: false,
    leaseSeconds: 600,
    prompt: '',
    promptFile: '',
    outDir: '/tmp/bridge-agent-runner',
    codexBin: process.env.CODEX_BIN || 'codex',
    codexSandbox: process.env.CODEX_SANDBOX || 'read-only',
    codexModel: process.env.CODEX_MODEL || '',
    claudeBin: process.env.CLAUDE_BIN || 'claude',
    claudeModel: process.env.CLAUDE_MODEL || '',
    memoryNamespace: process.env.BRIDGE_MEMORY_NAMESPACE || '',
    rememberKey: '',
    rememberTags: '',
    threadId: '',
    threadRole: 'bridge-result',
    threadTail: Number(process.env.BRIDGE_THREAD_TAIL || 12),
    runtimeMode: process.env.BRIDGE_RUNTIME_MODE || 'auto',
    timeoutMs: Number(process.env.BRIDGE_TIMEOUT_MS || 180000),
    messageMode: process.env.BRIDGE_MESSAGE_MODE || 'auto',
    failureStatus: process.env.BRIDGE_FAILURE_STATUS || 'blocked',
    expectJson: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    if (arg === '--endpoint') out.endpoint = next();
    else if (arg === '--backend') out.backend = next();
    else if (arg === '--agent-id') out.agentId = next();
    else if (arg === '--agent-name') out.agentName = next();
    else if (arg === '--role') out.role = next();
    else if (arg === '--lifecycle') out.lifecycle = next();
    else if (arg === '--onboarding-mode') out.onboardingMode = next();
    else if (arg === '--register-token') { out.registerToken = next(); out.registerTokenFromArgv = true; }
    else if (arg === '--agent-token-file') out.agentTokenFile = next();
    else if (arg === '--capabilities') out.capabilities = next();
    else if (arg === '--namespace') out.namespace = next();
    else if (arg === '--key') out.key = next();
    else if (arg === '--task-id') out.taskId = Number(next());
    else if (arg === '--require-claim') out.requireClaim = true;
    else if (arg === '--lease-seconds') out.leaseSeconds = Number(next());
    else if (arg === '--prompt') out.prompt = next();
    else if (arg === '--prompt-file') out.promptFile = next();
    else if (arg === '--out-dir') out.outDir = next();
    else if (arg === '--codex-bin') out.codexBin = next();
    else if (arg === '--codex-sandbox') out.codexSandbox = next();
    else if (arg === '--codex-model') out.codexModel = next();
    else if (arg === '--claude-bin') out.claudeBin = next();
    else if (arg === '--claude-model') out.claudeModel = next();
    else if (arg === '--memory-namespace') out.memoryNamespace = next();
    else if (arg === '--remember-key') out.rememberKey = next();
    else if (arg === '--remember-tags') out.rememberTags = next();
    else if (arg === '--thread-id') out.threadId = next();
    else if (arg === '--thread-role') out.threadRole = next();
    else if (arg === '--thread-tail') out.threadTail = Number(next());
    else if (arg === '--runtime-mode') out.runtimeMode = next();
    else if (arg === '--timeout-ms') out.timeoutMs = Number(next());
    else if (arg === '--message-mode') out.messageMode = next();
    else if (arg === '--failure-status') out.failureStatus = next();
    else if (arg === '--expect-json') out.expectJson = true;
    else if (arg === '--no-message') out.messageMode = 'never';
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bridge-agent-runner.mjs --backend claude|codex|custom --prompt "..." [options]

Options:
  --endpoint URL       MCP Streamable HTTP endpoint (default ${DEFAULT_ENDPOINT})
  --agent-id ID        Bridge agent id (default bridge-<backend>-<ts>)
  --agent-name NAME    Registered hub display name (default agent id)
  --role ROLE          Hub coordination role: orchestrator|reviewer|assistant|worker (default worker)
  --lifecycle MODE     Agent lifecycle: ephemeral|persistent (default ephemeral)
  --onboarding-mode M  register_agent onboarding: none|compact|full (default none)
  --register-token T   Legacy compatibility; prefer BRIDGE_REGISTER_TOKEN (argv is ps-visible)
  --agent-token-file P Read/write this agent's auth token (mode 0600); preferred for restart/fallback
  --capabilities CSV   Extra registered capabilities
  --namespace NAME     Context namespace
  --key KEY            Context key
  --task-id ID         Claim/release a hub task; backend must return JSON with verification_passed and confidence
  --require-claim      Refuse to run backend unless --task-id is provided and claimed
  --prompt TEXT        Prompt for the backend
  --prompt-file PATH   Prompt file
  --out-dir DIR        Write backend logs/report
  --codex-sandbox MODE Codex sandbox mode (default read-only)
  --claude-model NAME  Claude model override
  --memory-namespace NAME
                       Optional shared memory namespace for preflight digest
  --remember-key KEY   Store successful backend output as shared memory
  --remember-tags CSV  Tags for --remember-key memory
  --thread-id ID       Publish compact result as a discussion thread reply
  --thread-role ROLE   Thread reply role (default bridge-result)
  --thread-tail N      Include latest N visible thread messages in backend preflight (default 12)
  --runtime-mode MODE  Runtime profile override: auto|repo|isolated|unknown
  --timeout-ms MS      Backend timeout
  --message-mode MODE  Result broadcast mode: auto|always|never (default auto; auto skips duplicate broadcast for thread runs)
  --failure-status S   Task status after failed backend: blocked|pending (default blocked)

Custom backend env:
  BRIDGE_CUSTOM_COMMAND executable path
  BRIDGE_CUSTOM_ARGS_JSON optional JSON string array of arguments
  The composed prompt is provided on stdin (BRIDGE_PROMPT_MODE=stdin).`);
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }
  return out;
}

function validateBridgeOptions(opts) {
  if (!['ephemeral', 'persistent'].includes(opts.lifecycle)) {
    throw new Error('--lifecycle must be ephemeral|persistent');
  }
  if (!['none', 'compact', 'full'].includes(opts.onboardingMode)) {
    throw new Error('--onboarding-mode must be none|compact|full');
  }
  if (!['orchestrator', 'reviewer', 'assistant', 'worker'].includes(opts.role)) {
    throw new Error('--role must be orchestrator|reviewer|assistant|worker');
  }
  if (!['auto', 'always', 'never'].includes(opts.messageMode)) {
    throw new Error('--message-mode must be auto|always|never');
  }
  if (!['blocked', 'pending'].includes(opts.failureStatus)) {
    throw new Error('--failure-status must be blocked|pending');
  }
  if (opts.requireClaim && (!Number.isInteger(opts.taskId) || opts.taskId <= 0)) {
    throw new Error('--require-claim requires --task-id');
  }
  if (!Number.isFinite(opts.threadTail) || opts.threadTail < 0) {
    throw new Error('--thread-tail must be a non-negative number');
  }
  if (!Number.isFinite(opts.leaseSeconds) || opts.leaseSeconds <= 0) {
    throw new Error('--lease-seconds must be a positive number');
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }
  opts.threadTail = Math.min(50, Math.floor(opts.threadTail));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function truncate(value, max) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function extractPreviewField(preview, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(preview || '').match(new RegExp(`"${escapedKey}"\\s*:\\s*(?:"([^"]*)"|([^,}\\]]+))`));
  if (!match) return null;
  return String(match[1] ?? match[2] ?? '').trim().replace(/^null$/, '') || null;
}

function shouldSummarizeThreadMessageRole(role) {
  const normalized = String(role || '').toLowerCase();
  return normalized === 'canary' || normalized.includes('result');
}

function summarizeBridgeResultPreview(preview, role) {
  if (!shouldSummarizeThreadMessageRole(role)) return null;
  const text = String(preview || '');
  if (!text.includes('"schema":"bridge-result-v1"') && !text.includes('"schema": "bridge-result-v1"')) {
    return null;
  }
  const fields = [
    ['status', extractPreviewField(text, 'status')],
    ['backend', extractPreviewField(text, 'backend')],
    ['agent', extractPreviewField(text, 'agent_id')],
    ['role', extractPreviewField(text, 'role')],
    ['digest', extractPreviewField(text, 'output_digest')],
    ['error', extractPreviewField(text, 'error')],
  ].filter(([, value]) => value);
  return `bridge-result-v1 ${fields.map(([key, value]) => `${key}=${value}`).join(' ')}`;
}

function countBridgeResultPreviews(thread) {
  if (!thread || !Array.isArray(thread.messages)) return 0;
  return thread.messages.filter((message) => summarizeBridgeResultPreview(message.content_preview, message.role)).length;
}

function compactThreadPreflight(thread, previewChars = 180) {
  if (!thread || thread.success !== true || !Array.isArray(thread.messages)) return thread || null;
  return {
    success: true,
    thread_id: thread.thread_id,
    count: thread.count,
    next_cursor: thread.next_cursor,
    previous_cursor: thread.previous_cursor,
    has_more: thread.has_more,
    order: thread.order,
    messages: thread.messages.map((message) => ({
      id: message.id,
      from_agent: message.from_agent,
      to_agent: message.to_agent || null,
      role: message.role || null,
      created_at: message.created_at,
      content_digest: message.content_digest,
      content_preview: summarizeBridgeResultPreview(message.content_preview, message.role) || truncate(message.content_preview || '', previewChars),
    })),
  };
}

function compactTaskRoutingPreflight(taskRouting, agentId) {
  if (!taskRouting || taskRouting.success === false) return taskRouting || null;
  const suggestions = Array.isArray(taskRouting.suggestions) ? taskRouting.suggestions : [];
  const selfIndex = suggestions.findIndex((suggestion) => {
    if (Array.isArray(suggestion)) return suggestion[0] === agentId;
    return suggestion?.id === agentId || suggestion?.agent?.id === agentId;
  });
  const top = suggestions[0] || null;
  return {
    task: taskRouting.task || null,
    inferred: taskRouting.inferred || null,
    total: taskRouting.total ?? suggestions.length,
    self_rank: selfIndex >= 0 ? selfIndex + 1 : null,
    top_agent: Array.isArray(top) ? top[0] : (top?.id || top?.agent?.id || null),
    top_score: Array.isArray(top) ? top[1] : (top?.score ?? null),
  };
}

function compactHubDigestPreflight(hubDigest) {
  if (!hubDigest || hubDigest.success !== true) return hubDigest || null;
  const digest = hubDigest.digest || hubDigest.d || {};
  const signals = digest.signals || {};
  const events = digest.events || {};
  const memory = digest.memory || {};
  const signalItems = Array.isArray(signals.items) ? signals.items : [];
  const memoryItems = Array.isArray(memory.memories) ? memory.memories : [];
  return {
    success: true,
    sections: hubDigest.sections || hubDigest.s || Object.keys(digest),
    signals: {
      count: signals.count ?? signals.c ?? signalItems.length,
      refs: signalItems.slice(0, 5).map((item) => ({
        source: item.source,
        id: item.id,
        thread_id: item.thread_id || null,
        thread_role: item.thread_role || null,
        digest: item.content_digest || item.digest || null,
      })),
    },
    events: {
      cursor: events.cursor ?? events.c ?? null,
      count: Array.isArray(events.events) ? events.events.length : (events.count ?? events.c ?? null),
    },
    memory: {
      count: memory.count ?? memory.c ?? memoryItems.length,
      namespace: memory.namespace || null,
      memories: memoryItems.slice(0, 3).map((item) => ({
        key: item.key,
        tags: item.tags,
        digest: item.text_digest || item.digest || null,
        preview: truncate(item.text_preview || '', 120),
      })),
    },
  };
}

function selectNegotiatedReadMode(registration) {
  const negotiated = registration?.capability_negotiation?.negotiated
    || registration?.registration?.contract_profile
    || {};
  const mode = negotiated.preferred_read_mode;
  return ['nano', 'tiny', 'compact'].includes(mode) ? mode : 'tiny';
}

function modelFamily(modelId, fallback) {
  const normalized = String(modelId || fallback || 'unknown').toLowerCase();
  if (normalized.includes('claude')) return 'claude';
  if (normalized.includes('gpt') || normalized.includes('codex')) return 'openai';
  if (normalized.includes('qwen')) return 'qwen';
  if (normalized.includes('llama')) return 'llama';
  return fallback || 'unknown';
}

function buildModelProfile(opts) {
  const modelId = opts.backend === 'codex'
    ? (opts.codexModel || process.env.CODEX_MODEL || 'codex-default')
    : opts.backend === 'claude'
      ? (opts.claudeModel || process.env.CLAUDE_MODEL || 'claude-default')
      : (process.env.BRIDGE_MODEL_ID || 'custom-default');
  if (opts.backend === 'codex') {
    return {
      provider: 'codex',
      id: modelId,
      family: modelFamily(modelId, 'openai'),
      strengths: ['coding', 'code_review', 'debugging', 'repo_reasoning', 'tool_use'],
      task_types: ['coding', 'review', 'debugging', 'research', 'planning'],
      cost_tier: process.env.BRIDGE_MODEL_COST_TIER || 'unknown',
      latency_tier: process.env.BRIDGE_MODEL_LATENCY_TIER || 'unknown',
    };
  }
  if (opts.backend === 'claude') {
    return {
      provider: 'claude',
      id: modelId,
      family: modelFamily(modelId, 'claude'),
      strengths: ['analysis', 'code_review', 'planning', 'research', 'synthesis', 'writing'],
      task_types: ['research', 'review', 'planning', 'synthesis', 'architecture'],
      cost_tier: process.env.BRIDGE_MODEL_COST_TIER || 'unknown',
      latency_tier: process.env.BRIDGE_MODEL_LATENCY_TIER || 'unknown',
    };
  }
  return {
    provider: 'custom',
    id: modelId,
    family: modelFamily(modelId, 'custom'),
    strengths: parseCsv(process.env.BRIDGE_MODEL_STRENGTHS || 'custom,analysis,tool_use'),
    task_types: parseCsv(process.env.BRIDGE_MODEL_TASK_TYPES || 'custom,research'),
    cost_tier: process.env.BRIDGE_MODEL_COST_TIER || 'unknown',
    latency_tier: process.env.BRIDGE_MODEL_LATENCY_TIER || 'unknown',
  };
}

function serializePreflight(preflight) {
  const originalChars = JSON.stringify(preflight).length;
  const wirePreflight = {
    ...preflight,
    hub_digest: compactHubDigestPreflight(preflight?.hub_digest),
    thread: compactThreadPreflight(preflight?.thread, 180),
    task_routing: compactTaskRoutingPreflight(preflight?.task_routing, preflight?.agent_id),
  };
  const full = JSON.stringify(wirePreflight);
  if (full.length <= MAX_PREFLIGHT_CHARS) {
    return { text: full, truncated: false, original_chars: originalChars, wire_chars: full.length };
  }
  const digest = preflight?.hub_digest?.digest || preflight?.hub_digest?.d || {};
  const digestSections = preflight?.hub_digest?.sections || preflight?.hub_digest?.s || Object.keys(digest);
  let stub = {
    truncated: true,
    original_chars: originalChars,
    agent_id: preflight?.agent_id,
    namespace: preflight?.namespace,
    digest_sections: digestSections,
    signal_count: digest.signals?.count ?? digest.signals?.c ?? null,
    memory_count: digest.memory?.count ?? digest.memory?.c ?? null,
    event_cursor: digest.events?.cursor ?? digest.events?.c ?? null,
    thread: compactThreadPreflight(preflight?.thread, 180),
    task_routing: compactTaskRoutingPreflight(preflight?.task_routing, preflight?.agent_id),
  };
  let text = JSON.stringify(stub);
  if (text.length > MAX_PREFLIGHT_CHARS && stub.thread?.messages) {
    stub = {
      ...stub,
      thread: {
        ...stub.thread,
        messages: stub.thread.messages.slice(-Math.max(1, Math.min(3, stub.thread.messages.length))).map((message) => ({
          ...message,
          content_preview: truncate(message.content_preview, 120),
        })),
      },
    };
    text = JSON.stringify(stub);
  }
  if (text.length > MAX_PREFLIGHT_CHARS) {
    stub = {
      ...stub,
      thread: stub.thread ? {
        ...stub.thread,
        messages: stub.thread.messages.map((message) => ({
          id: message.id,
          from_agent: message.from_agent,
          role: message.role,
          content_digest: message.content_digest,
        })),
      } : null,
    };
    text = JSON.stringify(stub);
  }
  return { text, truncated: true, original_chars: originalChars, wire_chars: full.length };
}

function buildBackendPrompt(prompt, preflight, requireTaskCompletion = false) {
  const serialized = serializePreflight(preflight);
  const context = serialized.text;
  const notice = serialized.truncated
    ? `\nPreflight note: context was truncated from ${serialized.original_chars} chars; retained thread tail is prioritized when available.\n`
    : '\n';
  const completionContract = requireTaskCompletion
    ? `\nTask completion contract (required): return one JSON object containing verification_passed (boolean), confidence (number 0..1), verification.checks (non-empty array), and the result. Set verification_passed=true only after performing the listed checks.\n`
    : '';
  return `Hub preflight context (bounded JSON; use if relevant, do not repeat verbatim):\n${context}${notice}\nUser task:\n${prompt}${completionContract}`;
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function readPrompt(opts) {
  if (opts.promptFile) return fs.readFile(opts.promptFile, 'utf8');
  if (opts.prompt) return opts.prompt;
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new Error('Provide --prompt, --prompt-file, or stdin');
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findGitDir(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    if (await pathExists(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function countFiles(dir, limit = 10_000) {
  let count = 0;
  async function walk(current) {
    if (count >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= limit) return;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        count += 1;
      }
    }
  }
  await walk(dir);
  return count;
}

async function detectRuntimeProfile(opts) {
  const cwd = process.cwd();
  const gitRoot = await findGitDir(cwd);
  const fileCount = await countFiles(cwd);
  const emptyDir = fileCount === 0;
  let mode;
  if (opts.runtimeMode && opts.runtimeMode !== 'auto') {
    if (!['repo', 'isolated', 'unknown'].includes(opts.runtimeMode)) {
      throw new Error('--runtime-mode must be auto|repo|isolated|unknown');
    }
    mode = opts.runtimeMode;
  } else if (gitRoot) {
    mode = 'repo';
  } else if (emptyDir) {
    mode = 'isolated';
  } else {
    mode = 'unknown';
  }
  return {
    mode,
    cwd,
    has_git: Boolean(gitRoot),
    file_count: fileCount,
    empty_dir: emptyDir,
    source: 'client_auto',
    notes: `bridge backend=${opts.backend}${gitRoot ? ` git_root=${gitRoot}` : ''}`,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createMcpClient(endpoint) {
  return createMcpHttpClient(endpoint, {
    clientName: 'bridge-agent-runner',
    clientVersion: '1.0.0',
    protocolVersion: '2025-06-18',
    httpRetries: BRIDGE_HTTP_RETRIES,
    retryDelayMs: BRIDGE_HTTP_RETRY_DELAY_MS,
    timeoutMs: BRIDGE_HTTP_TIMEOUT_MS,
    onRetry: () => { rpcRetries += 1; },
  });
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      // T79-F2: run the backend in its own process group so a timeout/abort can signal the whole
      // tree. `codex exec` / `claude -p` fork helper subprocesses; signalling only the direct child
      // PID re-parents those grandchildren to init and leaks them.
      detached: true,
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let aborted = false;
    // Signal the entire process group (negative PID) so grandchildren die with the backend; fall
    // back to the direct child if the group is already gone or process groups are unsupported.
    const signalTree = (signal) => {
      try {
        if (typeof child.pid === 'number') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch { /* already exited */ }
      }
    };
    const terminate = (reason) => {
      if (child.killed) return;
      if (reason === 'timeout') timedOut = true;
      if (reason === 'abort') aborted = true;
      signalTree('SIGTERM');
      setTimeout(() => signalTree('SIGKILL'), 2000).unref();
    };
    const timer = setTimeout(() => {
      terminate('timeout');
    }, options.timeoutMs);
    const abortListener = () => terminate('abort');
    if (options.signal) {
      if (options.signal.aborted) {
        abortListener();
      } else {
        options.signal.addEventListener('abort', abortListener, { once: true });
      }
    }
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener?.('abort', abortListener);
    };
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(String(options.input ?? ''));
    }
    child.on('error', (error) => {
      cleanup();
      resolve({
        exitCode: 127,
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
        stdout: '',
        stderr: String(error?.stack || error),
      });
    });
    child.on('close', (code, signal) => {
      cleanup();
      resolve({
        exitCode: code,
        signal: signal || null,
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function buildBackendEnv(extra = {}) {
  return sanitizeBackendEnv(process.env, extra);
}

function parseCustomArgs() {
  const raw = process.env.BRIDGE_CUSTOM_ARGS_JSON;
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('BRIDGE_CUSTOM_ARGS_JSON must be a JSON string array');
  }
  return parsed;
}

async function runCodex(opts, prompt, signal) {
  const args = ['exec', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', opts.codexSandbox];
  if (opts.codexModel) args.push('--model', opts.codexModel);
  args.push('-');
  const result = await runProcess(opts.codexBin, args, {
    timeoutMs: opts.timeoutMs,
    env: buildBackendEnv(),
    input: prompt,
    signal,
  });
  return {
    backend: 'codex',
    ok: result.exitCode === 0 && !result.timedOut && !result.aborted,
    output: result.stdout.trim(),
    stderr: result.stderr.trim(),
    exit_code: result.exitCode,
    exit_signal: result.signal,
    timed_out: result.timedOut,
    aborted: result.aborted,
    duration_ms: result.durationMs,
  };
}

async function runClaude(opts, prompt, signal) {
  const args = ['-p', '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config'];
  if (opts.claudeModel) args.push('--model', opts.claudeModel);
  const result = await runProcess(opts.claudeBin, args, {
    timeoutMs: opts.timeoutMs,
    env: buildBackendEnv(),
    input: prompt,
    signal,
  });
  return {
    backend: 'claude',
    ok: result.exitCode === 0 && !result.timedOut && !result.aborted,
    output: result.stdout.trim(),
    stderr: result.stderr.trim(),
    exit_code: result.exitCode,
    exit_signal: result.signal,
    timed_out: result.timedOut,
    aborted: result.aborted,
    duration_ms: result.durationMs,
  };
}

async function runCustom(opts, prompt, signal) {
  const command = process.env.BRIDGE_CUSTOM_COMMAND;
  if (!command) {
    return {
      backend: 'custom',
      ok: false,
      output: '',
      error: 'BRIDGE_CUSTOM_COMMAND is required for backend=custom',
      duration_ms: 0,
    };
  }
  let customArgs;
  try {
    customArgs = parseCustomArgs();
  } catch (error) {
    return {
      backend: 'custom',
      ok: false,
      output: '',
      error: String(error?.message || error),
      duration_ms: 0,
    };
  }
  const result = await runProcess(command, customArgs, {
    timeoutMs: opts.timeoutMs,
    env: buildBackendEnv({ BRIDGE_PROMPT_MODE: 'stdin' }),
    input: prompt,
    signal,
  });
  return {
    backend: 'custom',
    ok: result.exitCode === 0 && !result.timedOut && !result.aborted,
    output: result.stdout.trim(),
    stderr: result.stderr.trim(),
    exit_code: result.exitCode,
    exit_signal: result.signal,
    timed_out: result.timedOut,
    aborted: result.aborted,
    duration_ms: result.durationMs,
  };
}

async function runBackend(opts, prompt, signal) {
  if (opts.backend === 'claude') return runClaude(opts, prompt, signal);
  if (opts.backend === 'codex') return runCodex(opts, prompt, signal);
  if (opts.backend === 'custom') return runCustom(opts, prompt, signal);
  throw new Error(`Unsupported backend: ${opts.backend}`);
}

function startClaimRenewal(mcp, opts, authToken, claim, abortController, runId) {
  const intervalMs = Math.max(10_000, Math.min(60_000, Math.floor(opts.leaseSeconds * 1000 / 3)));
  let stopped = false;
  let inFlight = null;
  let renewals = 0;
  let renewalAttempts = 0;
  let lastError = null;
  const renew = () => {
    if (stopped || inFlight) return;
    renewalAttempts += 1;
    inFlight = mcp.call('renew_task_claim', {
      task_id: opts.taskId,
      agent_id: opts.agentId,
      auth_token: authToken,
      claim_id: claim.claim?.claim_id,
      lease_seconds: opts.leaseSeconds,
      idempotency_key: runIdempotencyKey(runId, 'renew', opts.taskId, renewalAttempts),
    })
      .then((result) => {
        if (result.success === true) {
          renewals += 1;
          return;
        }
        lastError = JSON.stringify(result);
        abortController?.abort(new Error(`claim_renewal_failed: ${lastError}`));
      })
      .catch((error) => {
        lastError = String(error?.message || error);
        abortController?.abort(new Error(`claim_renewal_error: ${lastError}`));
      })
      .finally(() => {
        inFlight = null;
      });
  };
  const timer = setInterval(renew, intervalMs);
  timer.unref?.();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (inFlight) await inFlight.catch(() => {});
      return { renewals, last_error: lastError };
    },
  };
}

function compactResult(opts, prompt, backendResult) {
  const output = backendResult.output || '';
  const errors = [backendResult.error, backendResult.stderr].filter(Boolean).join('\n');
  const status = backendResult.status || (backendResult.ok ? 'pass' : (backendResult.timed_out ? 'timeout' : 'degraded'));
  return {
    schema: 'bridge-result-v1',
    status,
    run_id: backendResult.run_id,
    backend: opts.backend,
    agent_id: opts.agentId,
    role: opts.role,
    namespace: opts.namespace,
    started_at: backendResult.started_at,
    finished_at: backendResult.finished_at,
    error_digest: backendResult.error_digest,
    prompt_digest: sha256(prompt).slice(0, 16),
    output_digest: sha256(output).slice(0, 16),
    output_preview: truncate(output || errors, 1200),
    kpi: {
      status,
      duration_ms: backendResult.duration_ms_total ?? backendResult.duration_ms,
      rpc_retries: backendResult.rpc_retries ?? 0,
      phase_count: backendResult.phase_timings_ms ? Object.keys(backendResult.phase_timings_ms).length : 0,
      heartbeat_count: backendResult.heartbeat_count ?? 0,
      publish_attempts: backendResult.publish_attempts ?? 0,
      publish_failures: backendResult.publish_failures ?? 0,
      message_mode: opts.messageMode,
    },
    backend_result: {
      ok: backendResult.ok,
      duration_ms: backendResult.duration_ms,
      exit_code: backendResult.exit_code,
      exit_signal: backendResult.exit_signal,
      timed_out: backendResult.timed_out,
      aborted: backendResult.aborted,
      model: backendResult.model,
      error: backendResult.error,
      json_valid: backendResult.json_valid,
      completion_verified: backendResult.completion_verified,
      completion_confidence: backendResult.completion_confidence,
      phase_timings_ms: backendResult.phase_timings_ms,
      rpc_retries: backendResult.rpc_retries,
      negotiated_read_mode: backendResult.negotiated_read_mode,
      preflight_digest_mode: backendResult.preflight_digest_mode,
      preflight_thread_mode: backendResult.preflight_thread_mode,
      preflight_truncated: backendResult.preflight_truncated,
      preflight_original_chars: backendResult.preflight_original_chars,
      preflight_wire_chars: backendResult.preflight_wire_chars,
      preflight_sent_chars: backendResult.preflight_sent_chars,
      preflight_bridge_result_summaries: backendResult.preflight_bridge_result_summaries,
      context_error: backendResult.context_error,
      message_error: backendResult.message_error,
      memory_id: backendResult.memory_id,
      memory_key: backendResult.memory_key,
      memory_error: backendResult.memory_error,
      thread_message_id: backendResult.thread_message_id,
      thread_error: backendResult.thread_error,
      result_blob_hash: backendResult.result_blob_hash,
      result_blob_short_hash: backendResult.result_blob_short_hash,
      result_blob_chars: backendResult.result_blob_chars,
      result_blob_truncated: backendResult.result_blob_truncated,
      result_blob_original_chars: backendResult.result_blob_original_chars,
      result_blob_error: backendResult.result_blob_error,
      task_routing_self_rank: backendResult.task_routing_self_rank,
      task_routing_top_agent: backendResult.task_routing_top_agent,
      task_routing_error: backendResult.task_routing_error,
      release_error: backendResult.release_error,
      blocked_release: backendResult.blocked_release,
      failure_release: backendResult.failure_release,
      claim_renewals: backendResult.claim_renewals,
      claim_renewal_error: backendResult.claim_renewal_error,
    },
  };
}

function buildResultBlobPayload(fullReport, maxChars = RESULT_BLOB_MAX_CHARS) {
  const fullPayload = JSON.stringify({ schema: 'bridge-result-full-v1', ...fullReport });
  if (fullPayload.length <= maxChars) {
    return { payload: fullPayload, truncated: false, original_chars: fullPayload.length };
  }
  const output = String(fullReport.output || '');
  const stderr = String(fullReport.stderr || '');
  const rawError = String(fullReport.raw_error || '');
  const base = {
    schema: 'bridge-result-full-v1',
    ...fullReport,
    output: '',
    stderr: '',
    raw_error: rawError ? truncate(rawError, 1000) : rawError,
    result_blob_truncated: true,
    result_blob_original_chars: fullPayload.length,
  };
  const baseChars = JSON.stringify(base).length;
  const budget = Math.max(1000, maxChars - baseChars - 200);
  const outputBudget = Math.floor(budget * 0.8);
  const stderrBudget = budget - outputBudget;
  const payload = JSON.stringify({
    ...base,
    output: truncate(output, outputBudget),
    stderr: truncate(stderr, stderrBudget),
  });
  if (payload.length <= maxChars) {
    return { payload, truncated: true, original_chars: fullPayload.length };
  }
  return {
    payload: JSON.stringify({
      schema: 'bridge-result-full-v1',
      result_blob_truncated: true,
      result_blob_original_chars: fullPayload.length,
      output_digest: fullReport.output_digest,
      error_digest: fullReport.error_digest,
      backend_result: fullReport.backend_result,
    }),
    truncated: true,
    original_chars: fullPayload.length,
  };
}

function buildPublishPayload(opts, prompt, backendResult, maxChars = MAX_CONTEXT_CHARS) {
  const base = compactResult(opts, prompt, backendResult);
  const variants = [
    base,
    {
      ...base,
      output_preview: truncate(base.output_preview, backendResult.result_blob_hash ? 180 : 700),
      backend_result: {
        ...base.backend_result,
        phase_timings_ms: undefined,
      },
    },
    {
      schema: base.schema,
      status: base.status,
      run_id: base.run_id,
      backend: base.backend,
      agent_id: base.agent_id,
      role: base.role,
      namespace: base.namespace,
      started_at: base.started_at,
      finished_at: base.finished_at,
      prompt_digest: base.prompt_digest,
      output_digest: base.output_digest,
      output_preview: truncate(base.output_preview, backendResult.result_blob_hash ? 120 : 300),
      kpi: base.kpi,
      backend_result: {
        ok: backendResult.ok,
        duration_ms: backendResult.duration_ms,
        exit_code: backendResult.exit_code,
        timed_out: backendResult.timed_out,
        aborted: backendResult.aborted,
        error: backendResult.error,
        rpc_retries: backendResult.rpc_retries,
        result_blob_hash: backendResult.result_blob_hash,
        result_blob_short_hash: backendResult.result_blob_short_hash,
        result_blob_chars: backendResult.result_blob_chars,
        result_blob_truncated: backendResult.result_blob_truncated,
        result_blob_original_chars: backendResult.result_blob_original_chars,
      },
    },
  ];
  for (const variant of variants) {
    const payload = JSON.stringify(variant);
    if (payload.length <= maxChars) return payload;
  }
  const minimal = {
    schema: 'bridge-result-v1',
    status: base.status,
    run_id: base.run_id,
    backend: base.backend,
    agent_id: base.agent_id,
    output_digest: base.output_digest,
    result_blob_hash: backendResult.result_blob_hash,
    result_blob_short_hash: backendResult.result_blob_short_hash,
    error: backendResult.error,
  };
  return JSON.stringify(minimal);
}

function errorDigest(error) {
  const text = String(error?.stack || error?.message || error || '');
  return sha256(text).slice(0, 16);
}

function buildRunStatus(opts, prompt, state) {
  const now = Date.now();
  return {
    schema: 'bridge-run-status-v1',
    run_id: state.runId,
    status: state.status,
    phase: state.phase,
    backend: opts.backend,
    agent_id: opts.agentId,
    role: opts.role,
    namespace: opts.namespace,
    prompt_digest: sha256(prompt).slice(0, 16),
    started_at: state.startedAt,
    updated_at: now,
    duration_ms: now - state.startedAt,
    phase_timings_ms: state.phaseTimings,
    rpc_retries: rpcRetries,
    heartbeat_count: state.heartbeatCount,
    error_digest: state.errorDigest,
    error_class: state.errorClass,
    error_preview: state.errorPreview,
  };
}

async function publishRunStatus(mcp, opts, authToken, prompt, state) {
  if (!mcp || !authToken || state.allowSharedPublication === false) return false;
  state.publishAttempts += 1;
  const payload = JSON.stringify(buildRunStatus(opts, prompt, state));
  try {
    const result = await mcp.call('share_context', {
      agent_id: opts.agentId,
      auth_token: authToken,
      key: `${opts.key}:run`,
      namespace: opts.namespace,
      value: payload.length <= MAX_CONTEXT_CHARS ? payload : JSON.stringify({
        ...buildRunStatus(opts, prompt, state),
        error_preview: truncate(state.errorPreview || '', 300),
      }),
    });
    if (result?.success !== true) {
      state.publishFailures += 1;
      return false;
    }
    return true;
  } catch {
    state.publishFailures += 1;
    return false;
  }
}

function startRunHeartbeat(mcp, opts, authToken, prompt, state) {
  if (!authToken || BRIDGE_STATUS_HEARTBEAT_MS <= 0) return null;
  const timer = setInterval(() => {
    state.heartbeatCount += 1;
    publishRunStatus(mcp, opts, authToken, prompt, state).catch(() => undefined);
  }, BRIDGE_STATUS_HEARTBEAT_MS);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function measurePhase(timings, name, fn) {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    timings[name] = (timings[name] || 0) + (Date.now() - startedAt);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  validateBridgeOptions(opts);
  if (opts.registerTokenFromArgv) {
    process.stderr.write('[security] --register-token exposes the registration secret in ps/process listings; prefer BRIDGE_REGISTER_TOKEN.\n');
  }
  const prompt = await readPrompt(opts);
  opts.agentId ||= `bridge-${opts.backend}-${Date.now()}`;
  opts.agentName ||= opts.agentId;
  opts.key ||= `bridge-result-${opts.backend}`;
  await fs.mkdir(opts.outDir, { recursive: true, mode: 0o700 });
  await fs.chmod(opts.outDir, 0o700);
  const phaseTimings = {};
  const startedAt = Date.now();
  const runId = `${opts.agentId}:${randomUUID()}`;
  const runState = {
    runId,
    status: 'starting',
    phase: 'starting',
    startedAt,
    phaseTimings,
    heartbeatCount: 0,
    publishAttempts: 0,
    publishFailures: 0,
    errorDigest: null,
    errorClass: null,
    errorPreview: null,
    // A requested thread is privacy-unknown until read_thread succeeds. Suppress shared status
    // publication during that window; public threads opt back in after metadata validation.
    allowSharedPublication: !opts.threadId,
  };
  const reportFile = `${opts.agentId.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'bridge-agent'}.${startedAt}.json`;
  const reportPath = path.join(opts.outDir, reportFile);
  const runtimeProfile = await measurePhase(phaseTimings, 'detect_runtime_profile_ms', () => detectRuntimeProfile(opts));
  runtimeProfile.model = buildModelProfile(opts);
  let existingAgentToken = await measurePhase(
    phaseTimings,
    'read_agent_token_ms',
    () => readAgentToken(opts.agentAuthToken, opts.agentTokenFile),
  );
  // Persist a strong client-generated credential before the first registration request. If the
  // server commits registration but its response is lost, the next run can prove ownership with
  // the same credential instead of orphaning the stable agent id.
  if (!existingAgentToken && opts.agentTokenFile) {
    existingAgentToken = await measurePhase(
      phaseTimings,
      'prepare_agent_token_ms',
      () => getOrCreateAgentToken(opts.agentTokenFile, `${randomUUID()}-${randomUUID()}`),
    );
  }

  const mcp = await measurePhase(phaseTimings, 'mcp_initialize_ms', () => createMcpClient(opts.endpoint));
  let authToken = '';
  let heartbeat = null;
  let activeClaim = null;
  let activeClaimRenewal = null;
  let activeClaimReleased = false;
  let threadPublication = {
    is_private: Boolean(opts.threadId),
    private_peer: null,
    allow_shared_publication: !opts.threadId,
  };
  const backendAbort = new AbortController();
  let shutdownSignal = null;
  const requestShutdown = (signalName) => {
    shutdownSignal = shutdownSignal || signalName;
    backendAbort.abort(new Error(`received ${signalName}`));
  };
  const onSigint = () => requestShutdown('SIGINT');
  const onSigterm = () => requestShutdown('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    runState.phase = 'registering';
    const registerArgs = {
      id: opts.agentId,
      name: opts.agentName,
      type: `bridge:${opts.backend}`,
      role: opts.role,
      register_token: opts.registerToken || undefined,
      auth_token: existingAgentToken || undefined,
      capabilities: ['bridge', 'external-runtime', opts.backend, ...parseCsv(opts.capabilities)].join(','),
      lifecycle: opts.lifecycle,
      onboarding_mode: opts.onboardingMode,
      runtime_profile: runtimeProfile,
      client_capabilities: {
        response_modes: ['nano', 'tiny', 'compact'],
        blob_resolve: true,
        artifact_tickets: false,
        snapshot_reads: true,
        push_transports: ['sse_events', 'wait_for_updates'],
      },
    };
    const registration = await measurePhase(phaseTimings, 'register_agent_ms', () => mcp.call('register_agent', registerArgs));
    authToken = registration?.auth?.token || '';
    const negotiatedReadMode = selectNegotiatedReadMode(registration);
    if (!authToken) {
      const errorCode = registration?.error_code ? ` error_code=${registration.error_code}` : '';
      const registerError = registration?.error ? ` error=${truncate(registration.error, 240)}` : '';
      throw new Error(`register_agent did not return auth token.${errorCode}${registerError}`);
    }
    if (opts.agentTokenFile) {
      await measurePhase(
        phaseTimings,
        'write_agent_token_ms',
        () => writeAgentToken(opts.agentTokenFile, authToken),
      );
    }
    runState.phase = 'registered';
    runState.status = 'running';
    await publishRunStatus(mcp, opts, authToken, prompt, runState);

    runState.phase = 'preflight';
    const hubDigest = await measurePhase(phaseTimings, 'get_hub_digest_ms', () => mcp.call('get_hub_digest', {
      agent_id: opts.agentId,
      auth_token: authToken,
      sections: ['signals', 'events', 'memory'],
      memory_namespace: opts.memoryNamespace || undefined,
      response_mode: negotiatedReadMode,
      limit_per_source: 5,
    }));
    let threadTail = null;
    if (opts.threadId) {
      const threadAccess = await measurePhase(phaseTimings, 'read_thread_preflight_ms', () => mcp.call('read_thread', {
        agent_id: opts.agentId,
        auth_token: authToken,
        thread_id: opts.threadId,
        // Keep compact here: compactThreadPreflight depends on content_preview.
        response_mode: 'compact',
        limit: Math.max(1, opts.threadTail),
      })).catch((error) => ({
        success: false,
        error: String(error?.message || error),
      }));
      if (threadAccess?.success !== true) {
        throw new Error(`read_thread preflight failed: ${truncate(threadAccess?.error || threadAccess?.error_code || 'unknown error', 240)}`);
      }
      if (typeof threadAccess?.thread?.private !== 'boolean') {
        throw new Error('read_thread preflight did not return authoritative privacy metadata');
      }
      threadPublication = resolveThreadPublicationPolicy(threadAccess, opts.agentId);
      runState.allowSharedPublication = threadPublication.allow_shared_publication;
      threadTail = opts.threadTail > 0 ? threadAccess : null;
    }
    let taskRouting = null;
    if (Number.isInteger(opts.taskId) && opts.taskId > 0) {
      taskRouting = await measurePhase(phaseTimings, 'suggest_task_agents_preflight_ms', () => mcp.call('suggest_task_agents', {
        requesting_agent: opts.agentId,
        auth_token: authToken,
        task_id: opts.taskId,
        include_requesting_agent: true,
        response_mode: 'tiny',
        limit: 10,
      })).catch((error) => ({
        success: false,
        error: String(error?.message || error),
      }));
    }
    const preflight = {
      agent_id: opts.agentId,
      namespace: opts.namespace,
      hub_digest: hubDigest,
      thread: threadTail,
      task_routing: taskRouting,
    };
    const preflightSerialized = serializePreflight(preflight);
    const backendPrompt = buildBackendPrompt(prompt, preflight, Number.isInteger(opts.taskId) && opts.taskId > 0);
    await publishRunStatus(mcp, opts, authToken, prompt, runState);

    if (Number.isInteger(opts.taskId) && opts.taskId > 0) {
      if (taskRequiresIndependentVerifier(taskRouting)) {
        throw new Error('STRICT_TASK_REQUIRES_VERIFIER_WORKFLOW: bridge runner will not claim strict tasks without an independent reviewer attestation phase');
      }
      runState.phase = 'claiming';
      await publishRunStatus(mcp, opts, authToken, prompt, runState);
      activeClaim = await measurePhase(phaseTimings, 'claim_task_ms', () => mcp.call('claim_task', {
        task_id: opts.taskId,
        agent_id: opts.agentId,
        auth_token: authToken,
        lease_seconds: opts.leaseSeconds,
        namespace: opts.namespace || undefined,
        idempotency_key: runIdempotencyKey(runId, 'claim', opts.taskId),
      }));
      if (activeClaim.success !== true) {
        throw new Error(`claim_task failed: ${JSON.stringify(activeClaim)}`);
      }
      if (taskRequiresIndependentVerifier(activeClaim)) {
        const returned = await mcp.call('release_task_claim', {
          task_id: opts.taskId,
          agent_id: opts.agentId,
          auth_token: authToken,
          claim_id: activeClaim.claim?.claim_id,
          next_status: 'pending',
          preserve_assignment: true,
          idempotency_key: runIdempotencyKey(runId, 'release-strict-unsupported', opts.taskId),
        });
        activeClaimReleased = returned?.success === true;
        throw new Error('STRICT_TASK_REQUIRES_VERIFIER_WORKFLOW: claimed task was returned to pending');
      }
      activeClaimRenewal = startClaimRenewal(mcp, opts, authToken, activeClaim, backendAbort, runId);
    }

    let backendResult;
    let renewalSummary = null;
    try {
      runState.phase = 'backend_running';
      await publishRunStatus(mcp, opts, authToken, prompt, runState);
      heartbeat = startRunHeartbeat(mcp, opts, authToken, prompt, runState);
      backendResult = await measurePhase(phaseTimings, 'backend_ms', () => runBackend(opts, backendPrompt, backendAbort.signal));
    } finally {
      heartbeat?.stop();
      heartbeat = null;
      if (activeClaimRenewal) {
        renewalSummary = await measurePhase(phaseTimings, 'claim_renewal_stop_ms', () => activeClaimRenewal.stop());
        activeClaimRenewal = null;
      }
    }
    backendResult.run_id = runId;
    backendResult.started_at = startedAt;
    backendResult.finished_at = Date.now();
    backendResult.duration_ms_total = backendResult.finished_at - startedAt;
    backendResult.phase_timings_ms = phaseTimings;
    backendResult.rpc_retries = rpcRetries;
    backendResult.heartbeat_count = runState.heartbeatCount;
    backendResult.publish_attempts = runState.publishAttempts;
    backendResult.publish_failures = runState.publishFailures;
    backendResult.negotiated_read_mode = negotiatedReadMode;
    backendResult.preflight_digest_mode = negotiatedReadMode;
    backendResult.preflight_thread_mode = opts.threadId && opts.threadTail > 0 ? 'compact' : null;
    backendResult.preflight_truncated = preflightSerialized.truncated;
    backendResult.preflight_original_chars = preflightSerialized.original_chars;
    backendResult.preflight_wire_chars = preflightSerialized.wire_chars;
    backendResult.preflight_sent_chars = preflightSerialized.text.length;
    backendResult.preflight_bridge_result_summaries = countBridgeResultPreviews(threadTail);
    const compactTaskRouting = compactTaskRoutingPreflight(taskRouting, opts.agentId);
    backendResult.task_routing_self_rank = compactTaskRouting?.self_rank ?? null;
    backendResult.task_routing_top_agent = compactTaskRouting?.top_agent ?? null;
    backendResult.task_routing_error = taskRouting?.success === false ? (taskRouting.error || taskRouting.error_code || 'suggest_task_agents_failed') : undefined;
    if (renewalSummary) {
      backendResult.claim_renewals = renewalSummary.renewals;
      backendResult.claim_renewal_error = renewalSummary.last_error || undefined;
      if (renewalSummary.last_error) {
        backendResult.ok = false;
        backendResult.error = backendResult.error || 'claim_renewal_failed';
      }
    }
    if (shutdownSignal) {
      backendResult.ok = false;
      backendResult.aborted = true;
      backendResult.error = backendResult.error || `shutdown_signal:${shutdownSignal}`;
    }
    const completion = assessTaskCompletion(backendResult.output);
    if (opts.expectJson || (Number.isInteger(opts.taskId) && opts.taskId > 0)) {
      backendResult.json_valid = completion.json_valid;
      backendResult.parsed_json = completion.parsed || undefined;
    }
    backendResult.completion_verified = completion.verification_passed;
    backendResult.completion_confidence = completion.confidence;
    if (opts.expectJson && !completion.json_valid) {
      backendResult.ok = false;
      backendResult.error = backendResult.error || 'expected_json_not_returned';
    }
    if (Number.isInteger(opts.taskId) && opts.taskId > 0 && backendResult.ok) {
      if (!completion.completion_ready) {
        backendResult.ok = false;
        backendResult.error = backendResult.error || 'task_completion_contract_missing';
      }
    }
    if (backendResult.error || backendResult.stderr) {
      backendResult.error_digest = errorDigest(backendResult.error || backendResult.stderr);
    }
    if (threadPublication.allow_shared_publication && opts.rememberKey && backendResult.ok && backendResult.output) {
      const memory = await measurePhase(phaseTimings, 'write_memory_ms', () => mcp.call('write_memory', {
        agent_id: opts.agentId,
        auth_token: authToken,
        namespace: opts.memoryNamespace || opts.namespace,
        key: opts.rememberKey,
        text: truncate(backendResult.output, 1800),
        tags: ['bridge', opts.backend, ...parseCsv(opts.rememberTags)],
        importance: 0.7,
        idempotency_key: runIdempotencyKey(runId, 'memory', opts.rememberKey),
      })).catch((error) => ({ success: false, error: String(error?.message || error) }));
      if (memory?.success === true) {
        backendResult.memory_id = memory.memory?.id;
        backendResult.memory_key = memory.memory?.key;
      } else {
        backendResult.memory_error = memory?.error_code || memory?.error || 'write_memory_failed';
      }
    }

    let fullReport = {
      ...compactResult(opts, prompt, backendResult),
      output: backendResult.output,
      stderr: backendResult.stderr,
      raw_error: backendResult.error,
      parsed_json: backendResult.parsed_json,
    };
    await measurePhase(phaseTimings, 'write_report_initial_ms', () => writePrivateJson(reportPath, fullReport));

    runState.phase = 'publishing';
    await publishRunStatus(mcp, opts, authToken, prompt, runState);
    const resultBlob = buildResultBlobPayload(fullReport);
    if (threadPublication.is_private || resultBlob.payload.length >= RESULT_BLOB_MIN_CHARS) {
      const blob = await measurePhase(phaseTimings, 'store_result_blob_ms', () => mcp.call('store_protocol_blob', {
        agent_id: opts.agentId,
        auth_token: authToken,
        payload: resultBlob.payload,
        compression_mode: 'json',
        visibility: threadPublication.is_private ? 'private' : 'public',
        share_with_agents: threadPublication.private_peer ? [threadPublication.private_peer] : undefined,
        hash_truncate: 16,
      }));
      if (blob.success === true) {
        backendResult.result_blob_hash = blob.hash;
        backendResult.result_blob_short_hash = blob.short_hash;
        backendResult.result_blob_chars = blob.blob_chars;
        backendResult.result_blob_truncated = resultBlob.truncated;
        backendResult.result_blob_original_chars = resultBlob.original_chars;
      } else {
        backendResult.result_blob_error = blob.error_code || blob.error || 'store_protocol_blob_failed';
      }
    }
    let payload = buildPublishPayload(opts, prompt, backendResult);
    let context = null;
    if (threadPublication.allow_shared_publication) {
      context = await measurePhase(phaseTimings, 'share_context_ms', () => mcp.call('share_context', {
        agent_id: opts.agentId,
        auth_token: authToken,
        key: opts.key,
        namespace: opts.namespace,
        value: payload,
        idempotency_key: runIdempotencyKey(runId, 'context', opts.key),
      }));
      if (context.success !== true) {
        backendResult.ok = false;
        backendResult.error = backendResult.error || 'publish_context_failed';
        backendResult.context_error = context.error_code || context.error || 'share_context_failed';
      }
    }
    let message = null;
    const shouldPublishMessage = threadPublication.allow_shared_publication
      && (opts.messageMode === 'always' || (opts.messageMode === 'auto' && !opts.threadId));
    if (shouldPublishMessage) {
      message = await measurePhase(phaseTimings, 'send_message_ms', () => mcp.call('send_message', {
        from_agent: opts.agentId,
        auth_token: authToken,
        content: truncate(payload, MAX_MESSAGE_CHARS),
        idempotency_key: runIdempotencyKey(runId, 'message'),
      }));
      if (message.success !== true) {
        backendResult.ok = false;
        backendResult.error = backendResult.error || 'publish_message_failed';
        backendResult.message_error = message.error_code || message.error || 'send_message_failed';
      }
    }
    let threadReply = null;
    if (opts.threadId) {
      threadReply = await measurePhase(phaseTimings, 'reply_thread_ms', () => mcp.call('reply_thread', {
        from_agent: opts.agentId,
        auth_token: authToken,
        thread_id: opts.threadId,
        role: opts.threadRole,
        content: truncate(payload, MAX_MESSAGE_CHARS),
        idempotency_key: runIdempotencyKey(runId, 'thread', opts.threadId, opts.key),
      }));
      if (threadReply.success === true) {
        backendResult.thread_message_id = threadReply.message?.id;
      } else {
        backendResult.ok = false;
        backendResult.error = backendResult.error || 'publish_thread_failed';
        backendResult.thread_error = threadReply.error_code || threadReply.error || 'reply_thread_failed';
      }
    }
    if (context?.success === true && (backendResult.message_error || backendResult.thread_error)) {
      payload = buildPublishPayload(opts, prompt, backendResult);
      context = await measurePhase(phaseTimings, 'share_context_publish_correction_ms', () => mcp.call('share_context', {
        agent_id: opts.agentId,
        auth_token: authToken,
        key: opts.key,
        namespace: opts.namespace,
        value: payload,
        idempotency_key: runIdempotencyKey(runId, 'context-publish-correction', opts.key),
      }));
      if (context.success !== true) {
        backendResult.context_error = context.error_code || context.error || 'share_context_publish_correction_failed';
      }
    }
    let release = null;
    if (activeClaim && Number.isInteger(opts.taskId) && opts.taskId > 0) {
      runState.phase = 'releasing';
      await publishRunStatus(mcp, opts, authToken, prompt, runState);
      const contextId = context?.context?.id;
      const messageId = message?.message?.id;
      const threadMessageId = threadReply?.message?.id;
      const evidenceRefs = [
        contextId ? `context_id:${contextId}` : null,
        messageId ? `message_id:${messageId}` : null,
        threadMessageId ? `message_id:${threadMessageId}` : null,
        backendResult.result_blob_hash ? `blob:${backendResult.result_blob_hash}` : null,
      ].filter(Boolean);
      release = await measurePhase(phaseTimings, 'release_task_claim_ms', () => mcp.call('release_task_claim', {
        task_id: opts.taskId,
        agent_id: opts.agentId,
        auth_token: authToken,
        claim_id: activeClaim.claim?.claim_id,
        next_status: backendResult.ok ? 'done' : opts.failureStatus,
        preserve_assignment: backendResult.ok ? undefined : true,
        confidence: backendResult.ok ? backendResult.completion_confidence : undefined,
        verification_passed: backendResult.ok ? backendResult.completion_verified : undefined,
        evidence_refs: backendResult.ok ? evidenceRefs : undefined,
        idempotency_key: runIdempotencyKey(runId, 'release', opts.taskId),
      }));
      if (release.success !== true && backendResult.ok) {
        const releaseError = release;
        backendResult.ok = false;
        backendResult.error = 'done_release_failed';
        backendResult.release_error = releaseError.error_code || releaseError.error || 'release_task_claim_failed';
        release = await measurePhase(phaseTimings, 'release_task_claim_failed_done_ms', () => mcp.call('release_task_claim', {
          task_id: opts.taskId,
          agent_id: opts.agentId,
          auth_token: authToken,
          claim_id: activeClaim.claim?.claim_id,
          next_status: opts.failureStatus,
          preserve_assignment: true,
          idempotency_key: runIdempotencyKey(runId, 'release-failed-done', opts.taskId),
        }));
        backendResult.failure_release = release.success === true;
        if (threadPublication.allow_shared_publication) {
          await measurePhase(phaseTimings, 'share_context_release_correction_ms', () => mcp.call('share_context', {
            agent_id: opts.agentId,
            auth_token: authToken,
            key: opts.key,
            namespace: opts.namespace,
            value: buildPublishPayload(opts, prompt, backendResult),
            idempotency_key: runIdempotencyKey(runId, 'context-release-correction', opts.key),
          }));
        }
      }
      if (release.success !== true) {
        throw new Error(`release_task_claim failed: ${JSON.stringify(release)}`);
      }
      activeClaimReleased = true;
    }
    backendResult.rpc_retries = rpcRetries;
    backendResult.finished_at = Date.now();
    backendResult.duration_ms_total = backendResult.finished_at - startedAt;
    backendResult.heartbeat_count = runState.heartbeatCount;
    backendResult.publish_attempts = runState.publishAttempts;
    backendResult.publish_failures = runState.publishFailures;
    fullReport = {
      ...compactResult(opts, prompt, backendResult),
      output: backendResult.output,
      stderr: backendResult.stderr,
      raw_error: backendResult.error,
      parsed_json: backendResult.parsed_json,
    };
    await measurePhase(phaseTimings, 'write_report_final_ms', () => writePrivateJson(reportPath, fullReport));
    runState.phase = 'final';
    runState.status = backendResult.ok ? 'pass' : (backendResult.timed_out ? 'timeout' : 'degraded');
    await publishRunStatus(mcp, opts, authToken, prompt, runState);
    console.log(JSON.stringify({
      ok: backendResult.ok,
      backend: opts.backend,
      agent_id: opts.agentId,
      namespace: opts.namespace,
      context_id: context?.context?.id || null,
      message_id: message?.message?.id || null,
      thread_message_id: threadReply?.message?.id || null,
      task_id: opts.taskId || null,
      released: release?.success === true || false,
      report_path: reportPath,
      output_digest: sha256(backendResult.output || '').slice(0, 16),
      result_blob_short_hash: backendResult.result_blob_short_hash || null,
      json_valid: backendResult.json_valid ?? null,
      rpc_retries: backendResult.rpc_retries ?? 0,
      preflight_truncated: backendResult.preflight_truncated ?? false,
      error: backendResult.error || null,
    }));
    process.exitCode = backendResult.ok ? 0 : 2;
  } catch (error) {
    heartbeat?.stop();
    heartbeat = null;
    runState.phase = runState.phase || 'failed';
    runState.status = 'failed';
    runState.errorDigest = errorDigest(error);
    runState.errorClass = error?.name || 'Error';
    runState.errorPreview = truncate(error?.message || String(error), 500);
    let failureRelease = null;
    if (activeClaimRenewal) {
      await measurePhase(phaseTimings, 'claim_renewal_stop_after_error_ms', () => activeClaimRenewal.stop()).catch(() => undefined);
      activeClaimRenewal = null;
    }
    if (activeClaim && !activeClaimReleased && authToken) {
      failureRelease = await measurePhase(phaseTimings, 'release_task_claim_after_error_ms', () => mcp.call('release_task_claim', {
        task_id: opts.taskId,
        agent_id: opts.agentId,
        auth_token: authToken,
        claim_id: activeClaim.claim?.claim_id,
        next_status: opts.failureStatus,
        preserve_assignment: true,
        idempotency_key: runIdempotencyKey(runId, 'release-after-error', opts.taskId),
      })).catch((releaseError) => ({
        success: false,
        error: String(releaseError?.message || releaseError),
      }));
      activeClaimReleased = failureRelease?.success === true;
    }
    await publishRunStatus(mcp, opts, authToken, prompt, runState);
    const failureReport = {
      schema: 'bridge-result-v1',
      status: 'failed',
      run_id: runId,
      backend: opts.backend,
      agent_id: opts.agentId,
      namespace: opts.namespace,
      started_at: startedAt,
      finished_at: Date.now(),
      error_digest: runState.errorDigest,
      error: runState.errorPreview,
      failure_status: opts.failureStatus,
      failure_release: failureRelease?.success ?? null,
      failure_release_error: failureRelease?.success === false ? (failureRelease.error_code || failureRelease.error || 'release_task_claim_failed') : undefined,
      phase: runState.phase,
      phase_timings_ms: phaseTimings,
      rpc_retries: rpcRetries,
      publish_attempts: runState.publishAttempts,
      publish_failures: runState.publishFailures,
    };
    await writePrivateJson(reportPath, failureReport).catch(() => undefined);
    throw error;
  } finally {
    heartbeat?.stop();
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    await measurePhase(phaseTimings, 'mcp_close_ms', () => mcp.close());
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
