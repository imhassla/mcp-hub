#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_ENDPOINT = process.env.ENDPOINT || process.env.MCP_ENDPOINT || 'http://127.0.0.1:3000/mcp';
const MAX_CONTEXT_CHARS = Number(process.env.BRIDGE_CONTEXT_MAX_CHARS || 1900);
const MAX_MESSAGE_CHARS = Number(process.env.BRIDGE_MESSAGE_MAX_CHARS || 900);
const MAX_PREFLIGHT_CHARS = Number(process.env.BRIDGE_PREFLIGHT_MAX_CHARS || 3000);
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
    capabilities: process.env.BRIDGE_AGENT_CAPABILITIES || '',
    namespace: `BRIDGE-${Date.now()}`,
    key: '',
    taskId: 0,
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
    else if (arg === '--register-token') out.registerToken = next();
    else if (arg === '--capabilities') out.capabilities = next();
    else if (arg === '--namespace') out.namespace = next();
    else if (arg === '--key') out.key = next();
    else if (arg === '--task-id') out.taskId = Number(next());
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
  --register-token T   Registration secret when MCP_HUB_REGISTER_TOKEN is configured
  --capabilities CSV   Extra registered capabilities
  --namespace NAME     Context namespace
  --key KEY            Context key
  --task-id ID         Claim and release a hub task around backend execution
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

Custom backend env:
  BRIDGE_CUSTOM_COMMAND executable path
  BRIDGE_CUSTOM_ARGS_JSON optional JSON string array of arguments`);
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
  if (!Number.isFinite(opts.threadTail) || opts.threadTail < 0) {
    throw new Error('--thread-tail must be a non-negative number');
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
      content_preview: truncate(message.content_preview || '', previewChars),
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
  const full = JSON.stringify(preflight);
  if (full.length <= MAX_PREFLIGHT_CHARS) {
    return { text: full, truncated: false, original_chars: full.length };
  }
  const digest = preflight?.hub_digest?.digest || preflight?.hub_digest?.d || {};
  const digestSections = preflight?.hub_digest?.sections || preflight?.hub_digest?.s || Object.keys(digest);
  let stub = {
    truncated: true,
    original_chars: full.length,
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
  return { text, truncated: true, original_chars: full.length };
}

function buildBackendPrompt(prompt, preflight) {
  const serialized = serializePreflight(preflight);
  const context = serialized.text;
  const notice = serialized.truncated
    ? `\nPreflight note: context was truncated from ${serialized.original_chars} chars; retained thread tail is prioritized when available.\n`
    : '\n';
  return `Hub preflight context (bounded JSON; use if relevant, do not repeat verbatim):\n${context}${notice}\nUser task:\n${prompt}`;
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

function extractMcpJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (raw.startsWith('{') || raw.startsWith('[')) return JSON.parse(raw);
  const dataFrames = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== '[DONE]');
  if (dataFrames.length === 0) {
    throw new Error(`MCP response is not JSON or SSE data: ${truncate(raw, 200)}`);
  }
  return JSON.parse(dataFrames[dataFrames.length - 1]);
}

async function postRpc(endpoint, body, sessionId) {
  let lastError;
  for (let attempt = 0; attempt <= BRIDGE_HTTP_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BRIDGE_HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        const error = new Error(`MCP HTTP ${res.status}: ${text}`);
        if (res.status >= 500 && attempt < BRIDGE_HTTP_RETRIES) {
          lastError = error;
        } else {
          throw error;
        }
      } else {
        return { res, json: text.trim() ? extractMcpJson(text) : null, text };
      }
    } catch (error) {
      lastError = controller.signal.aborted
        ? new Error(`MCP HTTP request timed out after ${BRIDGE_HTTP_TIMEOUT_MS}ms`)
        : error;
      if (attempt >= BRIDGE_HTTP_RETRIES) throw lastError;
    } finally {
      clearTimeout(timer);
    }
    rpcRetries += 1;
    await sleep(BRIDGE_HTTP_RETRY_DELAY_MS + Math.floor(Math.random() * BRIDGE_HTTP_RETRY_DELAY_MS));
  }
  throw lastError || new Error('MCP RPC failed');
}

function parseMcpPayload(json) {
  if (json?.error) throw new Error(`MCP error: ${JSON.stringify(json.error)}`);
  const text = json?.result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error(`Missing MCP tool payload: ${JSON.stringify(json)}`);
  return JSON.parse(text);
}

function isReinitializeRequired(json) {
  const error = json?.error;
  if (!error) return false;
  const text = `${error.code ?? ''} ${error.message ?? ''} ${JSON.stringify(error.data ?? '')}`.toLowerCase();
  return text.includes('reinitialize_required')
    || (text.includes('session') && (text.includes('expired') || text.includes('invalid') || text.includes('not found')));
}

function isRetryableJsonRpcError(json) {
  const error = json?.error;
  if (!error) return false;
  const text = `${error.message ?? ''} ${JSON.stringify(error.data ?? '')}`.toLowerCase();
  return error.code === -32603 && (
    text.includes('temporar')
    || text.includes('timeout')
    || text.includes('busy')
    || text.includes('retry')
    || text.includes('transient')
  );
}

async function createMcpClient(endpoint) {
  let nextId = 1;
  let sessionId = '';
  async function initializeSession() {
    const init = await postRpc(endpoint, {
      jsonrpc: '2.0',
      id: nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'bridge-agent-runner', version: '1.0.0' },
      },
    });
    const nextSessionId = init.res.headers.get('mcp-session-id');
    if (!nextSessionId) throw new Error('MCP initialize did not return mcp-session-id');
    await postRpc(endpoint, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, nextSessionId);
    sessionId = nextSessionId;
  }
  await initializeSession();
  return {
    get sessionId() {
      return sessionId;
    },
    async call(name, args) {
      const body = {
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      };
      let { json } = await postRpc(endpoint, body, sessionId);
      if (isReinitializeRequired(json)) {
        rpcRetries += 1;
        await initializeSession();
        ({ json } = await postRpc(endpoint, body, sessionId));
      } else if (isRetryableJsonRpcError(json)) {
        rpcRetries += 1;
        await sleep(BRIDGE_HTTP_RETRY_DELAY_MS);
        ({ json } = await postRpc(endpoint, body, sessionId));
      }
      return parseMcpPayload(json);
    },
    async close() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), BRIDGE_HTTP_TIMEOUT_MS);
      await fetch(endpoint, {
        method: 'DELETE',
        signal: controller.signal,
        headers: { 'mcp-session-id': sessionId },
      }).catch(() => {}).finally(() => clearTimeout(timer));
    },
  };
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, options.timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: 127,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: '',
        stderr: String(error?.stack || error),
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal: signal || null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function buildBackendEnv(extra = {}) {
  const blockedEnvPatterns = [/^MCP_HUB_/, /^BRIDGE_/, /^WORKER_.*MCP_/, /^CODEX_.*MCP_/];
  const blockedKeys = new Set(['ENDPOINT', 'MCP_ENDPOINT', 'HUB_ENDPOINT', 'MCP_CONFIG_FILE']);
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (blockedKeys.has(key)) continue;
    if (blockedEnvPatterns.some((pattern) => pattern.test(key))) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
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

async function runCodex(opts, prompt) {
  const args = ['exec', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', opts.codexSandbox];
  if (opts.codexModel) args.push('--model', opts.codexModel);
  args.push(prompt);
  const result = await runProcess(opts.codexBin, args, { timeoutMs: opts.timeoutMs, env: buildBackendEnv() });
  return {
    backend: 'codex',
    ok: result.exitCode === 0 && !result.timedOut,
    output: result.stdout.trim(),
    stderr: result.stderr.trim(),
    exit_code: result.exitCode,
    exit_signal: result.signal,
    timed_out: result.timedOut,
    duration_ms: result.durationMs,
  };
}

async function runClaude(opts, prompt) {
  const args = ['-p', '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config'];
  if (opts.claudeModel) args.push('--model', opts.claudeModel);
  args.push(prompt);
  const result = await runProcess(opts.claudeBin, args, { timeoutMs: opts.timeoutMs, env: buildBackendEnv() });
  return {
    backend: 'claude',
    ok: result.exitCode === 0 && !result.timedOut,
    output: result.stdout.trim(),
    stderr: result.stderr.trim(),
    exit_code: result.exitCode,
    exit_signal: result.signal,
    timed_out: result.timedOut,
    duration_ms: result.durationMs,
  };
}

async function runCustom(opts, prompt) {
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
    env: buildBackendEnv({ BRIDGE_PROMPT: prompt }),
  });
  return {
    backend: 'custom',
    ok: result.exitCode === 0 && !result.timedOut,
    output: result.stdout.trim(),
    stderr: result.stderr.trim(),
    exit_code: result.exitCode,
    exit_signal: result.signal,
    timed_out: result.timedOut,
    duration_ms: result.durationMs,
  };
}

async function runBackend(opts, prompt) {
  if (opts.backend === 'claude') return runClaude(opts, prompt);
  if (opts.backend === 'codex') return runCodex(opts, prompt);
  if (opts.backend === 'custom') return runCustom(opts, prompt);
  throw new Error(`Unsupported backend: ${opts.backend}`);
}

function startClaimRenewal(mcp, opts, authToken, claim) {
  const intervalMs = Math.max(10_000, Math.min(60_000, Math.floor(opts.leaseSeconds * 1000 / 3)));
  let stopped = false;
  let inFlight = null;
  let renewals = 0;
  let lastError = null;
  const renew = () => {
    if (stopped || inFlight) return;
    inFlight = mcp.call('renew_task_claim', {
      task_id: opts.taskId,
      agent_id: opts.agentId,
      auth_token: authToken,
      claim_id: claim.claim?.claim_id,
      lease_seconds: opts.leaseSeconds,
    })
      .then((result) => {
        if (result.success === true) {
          renewals += 1;
          return;
        }
        lastError = JSON.stringify(result);
      })
      .catch((error) => {
        lastError = String(error?.message || error);
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
      model: backendResult.model,
      error: backendResult.error,
      json_valid: backendResult.json_valid,
      phase_timings_ms: backendResult.phase_timings_ms,
      rpc_retries: backendResult.rpc_retries,
      negotiated_read_mode: backendResult.negotiated_read_mode,
      preflight_digest_mode: backendResult.preflight_digest_mode,
      preflight_thread_mode: backendResult.preflight_thread_mode,
      preflight_truncated: backendResult.preflight_truncated,
      preflight_original_chars: backendResult.preflight_original_chars,
      context_error: backendResult.context_error,
      message_error: backendResult.message_error,
      memory_id: backendResult.memory_id,
      memory_key: backendResult.memory_key,
      memory_error: backendResult.memory_error,
      thread_message_id: backendResult.thread_message_id,
      thread_error: backendResult.thread_error,
      task_routing_self_rank: backendResult.task_routing_self_rank,
      task_routing_top_agent: backendResult.task_routing_top_agent,
      task_routing_error: backendResult.task_routing_error,
      release_error: backendResult.release_error,
      blocked_release: backendResult.blocked_release,
      claim_renewals: backendResult.claim_renewals,
      claim_renewal_error: backendResult.claim_renewal_error,
    },
  };
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
  if (!mcp || !authToken) return false;
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

function parseLooseJson(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const normalizeParsed = (parsed) => {
    if (typeof parsed === 'string') {
      const nested = parsed.trim();
      if (nested.startsWith('{') || nested.startsWith('[')) {
        return parseLooseJson(nested) ?? parsed;
      }
    }
    return parsed;
  };
  try {
    return normalizeParsed(JSON.parse(value));
  } catch {
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      try {
        return normalizeParsed(JSON.parse(fenced[1].trim()));
      } catch {
        return null;
      }
    }
    const start = value.indexOf('{');
    const end = value.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return normalizeParsed(JSON.parse(value.slice(start, end + 1)));
      } catch {
        return null;
      }
    }
    return null;
  }
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
  const prompt = await readPrompt(opts);
  opts.agentId ||= `bridge-${opts.backend}-${Date.now()}`;
  opts.agentName ||= opts.agentId;
  opts.key ||= `bridge-result-${opts.backend}`;
  await fs.mkdir(opts.outDir, { recursive: true });
  const phaseTimings = {};
  const startedAt = Date.now();
  const runId = `${opts.agentId}:${startedAt}`;
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
  };
  const reportPath = path.join(opts.outDir, `${opts.agentId}.json`);
  const runtimeProfile = await measurePhase(phaseTimings, 'detect_runtime_profile_ms', () => detectRuntimeProfile(opts));
  runtimeProfile.model = buildModelProfile(opts);

  const mcp = await measurePhase(phaseTimings, 'mcp_initialize_ms', () => createMcpClient(opts.endpoint));
  let authToken = '';
  let heartbeat = null;
  let activeClaim = null;
  let activeClaimRenewal = null;
  let activeClaimReleased = false;
  try {
    runState.phase = 'registering';
    const registerArgs = {
      id: opts.agentId,
      name: opts.agentName,
      type: `bridge:${opts.backend}`,
      role: opts.role,
      register_token: opts.registerToken || undefined,
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
    if (opts.threadId && opts.threadTail > 0) {
      threadTail = await measurePhase(phaseTimings, 'read_thread_preflight_ms', () => mcp.call('read_thread', {
        agent_id: opts.agentId,
        auth_token: authToken,
        thread_id: opts.threadId,
        // Keep compact here: compactThreadPreflight depends on content_preview.
        response_mode: 'compact',
        limit: opts.threadTail,
      })).catch((error) => ({
        success: false,
        error: String(error?.message || error),
      }));
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
    const backendPrompt = buildBackendPrompt(prompt, preflight);

    if (Number.isInteger(opts.taskId) && opts.taskId > 0) {
      runState.phase = 'claiming';
      await publishRunStatus(mcp, opts, authToken, prompt, runState);
      activeClaim = await measurePhase(phaseTimings, 'claim_task_ms', () => mcp.call('claim_task', {
        task_id: opts.taskId,
        agent_id: opts.agentId,
        auth_token: authToken,
        lease_seconds: opts.leaseSeconds,
        namespace: opts.namespace || undefined,
        idempotency_key: `${opts.agentId}:claim:${opts.taskId}`,
      }));
      if (activeClaim.success !== true) {
        throw new Error(`claim_task failed: ${JSON.stringify(activeClaim)}`);
      }
      activeClaimRenewal = startClaimRenewal(mcp, opts, authToken, activeClaim);
    }

    let backendResult;
    let renewalSummary = null;
    try {
      runState.phase = 'backend_running';
      await publishRunStatus(mcp, opts, authToken, prompt, runState);
      heartbeat = startRunHeartbeat(mcp, opts, authToken, prompt, runState);
      backendResult = await measurePhase(phaseTimings, 'backend_ms', () => runBackend(opts, backendPrompt));
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
    if (opts.expectJson) {
      const parsed = parseLooseJson(backendResult.output);
      backendResult.json_valid = Boolean(parsed);
      backendResult.parsed_json = parsed || undefined;
      if (!parsed) {
        backendResult.ok = false;
        backendResult.error = backendResult.error || 'expected_json_not_returned';
      }
    }
    if (backendResult.error || backendResult.stderr) {
      backendResult.error_digest = errorDigest(backendResult.error || backendResult.stderr);
    }
    if (opts.rememberKey && backendResult.ok && backendResult.output) {
      const memory = await measurePhase(phaseTimings, 'write_memory_ms', () => mcp.call('write_memory', {
        agent_id: opts.agentId,
        auth_token: authToken,
        namespace: opts.memoryNamespace || opts.namespace,
        key: opts.rememberKey,
        text: truncate(backendResult.output, 1800),
        tags: ['bridge', opts.backend, ...parseCsv(opts.rememberTags)],
        importance: 0.7,
        idempotency_key: `${opts.agentId}:memory:${opts.rememberKey}`,
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
    await measurePhase(phaseTimings, 'write_report_initial_ms', () => fs.writeFile(reportPath, `${JSON.stringify(fullReport, null, 2)}\n`));

    runState.phase = 'publishing';
    await publishRunStatus(mcp, opts, authToken, prompt, runState);
    let payload = JSON.stringify(compactResult(opts, prompt, backendResult));
    if (payload.length > MAX_CONTEXT_CHARS) {
      payload = JSON.stringify({
        ...compactResult(opts, prompt, backendResult),
        output_preview: truncate(backendResult.output || backendResult.error || backendResult.stderr || '', 700),
      });
    }
    let context = await measurePhase(phaseTimings, 'share_context_ms', () => mcp.call('share_context', {
      agent_id: opts.agentId,
      auth_token: authToken,
      key: opts.key,
      namespace: opts.namespace,
      value: payload,
      idempotency_key: `${opts.agentId}:${opts.key}`,
    }));
    if (context.success !== true) {
      backendResult.ok = false;
      backendResult.error = backendResult.error || 'publish_context_failed';
      backendResult.context_error = context.error_code || context.error || 'share_context_failed';
    }
    let message = null;
    const shouldPublishMessage = opts.messageMode === 'always' || (opts.messageMode === 'auto' && !opts.threadId);
    if (shouldPublishMessage) {
      message = await measurePhase(phaseTimings, 'send_message_ms', () => mcp.call('send_message', {
        from_agent: opts.agentId,
        auth_token: authToken,
        content: truncate(payload, MAX_MESSAGE_CHARS),
        idempotency_key: `${opts.agentId}:message`,
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
        idempotency_key: `${opts.agentId}:thread:${opts.threadId}:${opts.key}`,
      }));
      if (threadReply.success === true) {
        backendResult.thread_message_id = threadReply.message?.id;
      } else {
        backendResult.ok = false;
        backendResult.error = backendResult.error || 'publish_thread_failed';
        backendResult.thread_error = threadReply.error_code || threadReply.error || 'reply_thread_failed';
      }
    }
    if (context.success === true && (backendResult.message_error || backendResult.thread_error)) {
      payload = JSON.stringify(compactResult(opts, prompt, backendResult));
      if (payload.length > MAX_CONTEXT_CHARS) {
        payload = JSON.stringify({
          ...compactResult(opts, prompt, backendResult),
          output_preview: truncate(backendResult.output || backendResult.error || backendResult.stderr || '', 700),
        });
      }
      context = await measurePhase(phaseTimings, 'share_context_publish_correction_ms', () => mcp.call('share_context', {
        agent_id: opts.agentId,
        auth_token: authToken,
        key: opts.key,
        namespace: opts.namespace,
        value: payload,
        idempotency_key: `${opts.agentId}:${opts.key}:publish-correction`,
      }));
      if (context.success !== true) {
        backendResult.context_error = context.error_code || context.error || 'share_context_publish_correction_failed';
      }
    }
    let release = null;
    if (activeClaim && Number.isInteger(opts.taskId) && opts.taskId > 0) {
      runState.phase = 'releasing';
      await publishRunStatus(mcp, opts, authToken, prompt, runState);
      const contextId = context.context?.id;
      const messageId = message?.message?.id;
      const threadMessageId = threadReply?.message?.id;
      const evidenceRefs = [
        contextId ? `context_id:${contextId}` : null,
        messageId ? `message_id:${messageId}` : null,
        threadMessageId ? `message_id:${threadMessageId}` : null,
      ].filter(Boolean);
      release = await measurePhase(phaseTimings, 'release_task_claim_ms', () => mcp.call('release_task_claim', {
        task_id: opts.taskId,
        agent_id: opts.agentId,
        auth_token: authToken,
        claim_id: activeClaim.claim?.claim_id,
        next_status: backendResult.ok ? 'done' : 'blocked',
        confidence: backendResult.ok ? 0.9 : undefined,
        verification_passed: backendResult.ok ? true : undefined,
        evidence_refs: backendResult.ok ? evidenceRefs : undefined,
        idempotency_key: `${opts.agentId}:release:${opts.taskId}`,
      }));
      if (release.success !== true && backendResult.ok) {
        const releaseError = release;
        backendResult.ok = false;
        backendResult.error = 'done_release_failed';
        backendResult.release_error = releaseError.error_code || releaseError.error || 'release_task_claim_failed';
        release = await measurePhase(phaseTimings, 'release_task_claim_blocked_ms', () => mcp.call('release_task_claim', {
          task_id: opts.taskId,
          agent_id: opts.agentId,
          auth_token: authToken,
          claim_id: activeClaim.claim?.claim_id,
          next_status: 'blocked',
          idempotency_key: `${opts.agentId}:release-blocked:${opts.taskId}`,
        }));
        backendResult.blocked_release = release.success === true;
        await measurePhase(phaseTimings, 'share_context_release_correction_ms', () => mcp.call('share_context', {
          agent_id: opts.agentId,
          auth_token: authToken,
          key: opts.key,
          namespace: opts.namespace,
          value: JSON.stringify(compactResult(opts, prompt, backendResult)).slice(0, MAX_CONTEXT_CHARS),
          idempotency_key: `${opts.agentId}:${opts.key}:release-correction`,
        }));
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
    await measurePhase(phaseTimings, 'write_report_final_ms', () => fs.writeFile(reportPath, `${JSON.stringify(fullReport, null, 2)}\n`));
    runState.phase = 'final';
    runState.status = backendResult.ok ? 'pass' : (backendResult.timed_out ? 'timeout' : 'degraded');
    await publishRunStatus(mcp, opts, authToken, prompt, runState);
    console.log(JSON.stringify({
      ok: backendResult.ok,
      backend: opts.backend,
      agent_id: opts.agentId,
      namespace: opts.namespace,
      context_id: context.context?.id || null,
      message_id: message?.message?.id || null,
      thread_message_id: threadReply?.message?.id || null,
      task_id: opts.taskId || null,
      released: release?.success === true || false,
      report_path: reportPath,
      output_digest: sha256(backendResult.output || '').slice(0, 16),
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
    let blockedRelease = null;
    if (activeClaimRenewal) {
      await measurePhase(phaseTimings, 'claim_renewal_stop_after_error_ms', () => activeClaimRenewal.stop()).catch(() => undefined);
      activeClaimRenewal = null;
    }
    if (activeClaim && !activeClaimReleased && authToken) {
      blockedRelease = await measurePhase(phaseTimings, 'release_task_claim_after_error_ms', () => mcp.call('release_task_claim', {
        task_id: opts.taskId,
        agent_id: opts.agentId,
        auth_token: authToken,
        claim_id: activeClaim.claim?.claim_id,
        next_status: 'blocked',
        idempotency_key: `${opts.agentId}:release-after-error:${opts.taskId}:${startedAt}`,
      })).catch((releaseError) => ({
        success: false,
        error: String(releaseError?.message || releaseError),
      }));
      activeClaimReleased = blockedRelease?.success === true;
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
      blocked_release: blockedRelease?.success ?? null,
      blocked_release_error: blockedRelease?.success === false ? (blockedRelease.error_code || blockedRelease.error || 'release_task_claim_failed') : undefined,
      phase: runState.phase,
      phase_timings_ms: phaseTimings,
      rpc_retries: rpcRetries,
      publish_attempts: runState.publishAttempts,
      publish_failures: runState.publishFailures,
    };
    await fs.writeFile(reportPath, `${JSON.stringify(failureReport, null, 2)}\n`).catch(() => undefined);
    throw error;
  } finally {
    heartbeat?.stop();
    await measurePhase(phaseTimings, 'mcp_close_ms', () => mcp.close());
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
