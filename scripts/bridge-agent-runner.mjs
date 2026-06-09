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

let rpcRetries = 0;

function parseArgs(argv) {
  const out = {
    endpoint: DEFAULT_ENDPOINT,
    backend: 'codex',
    agentId: '',
    agentName: '',
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
    publishMessage: true,
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
    else if (arg === '--expect-json') out.expectJson = true;
    else if (arg === '--no-message') out.publishMessage = false;
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bridge-agent-runner.mjs --backend claude|codex|custom --prompt "..." [options]

Options:
  --endpoint URL       MCP Streamable HTTP endpoint (default ${DEFAULT_ENDPOINT})
  --agent-id ID        Bridge agent id (default bridge-<backend>-<ts>)
  --agent-name NAME    Registered hub display name (default agent id)
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

function serializePreflight(preflight) {
  const full = JSON.stringify(preflight);
  if (full.length <= MAX_PREFLIGHT_CHARS) {
    return { text: full, truncated: false, original_chars: full.length };
  }
  const digest = preflight?.hub_digest?.digest || {};
  let stub = {
    truncated: true,
    original_chars: full.length,
    agent_id: preflight?.agent_id,
    namespace: preflight?.namespace,
    digest_sections: Object.keys(digest),
    signal_count: digest.signals?.count ?? digest.signals?.c ?? null,
    memory_count: digest.memory?.count ?? digest.memory?.c ?? null,
    event_cursor: digest.events?.cursor ?? digest.events?.c ?? null,
    thread: compactThreadPreflight(preflight?.thread, 180),
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

async function createMcpClient(endpoint) {
  let nextId = 1;
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
  const sessionId = init.res.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('MCP initialize did not return mcp-session-id');
  await postRpc(endpoint, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, sessionId);
  return {
    sessionId,
    async call(name, args) {
      const { json } = await postRpc(endpoint, {
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      }, sessionId);
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
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 0,
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
  return {
    schema: 'bridge-result-v1',
    status: backendResult.ok ? 'pass' : 'degraded',
    backend: opts.backend,
    agent_id: opts.agentId,
    namespace: opts.namespace,
    prompt_digest: sha256(prompt).slice(0, 16),
    output_digest: sha256(output).slice(0, 16),
    output_preview: truncate(output || errors, 1200),
    backend_result: {
      ok: backendResult.ok,
      duration_ms: backendResult.duration_ms,
      exit_code: backendResult.exit_code,
      timed_out: backendResult.timed_out,
      model: backendResult.model,
      error: backendResult.error,
      json_valid: backendResult.json_valid,
      phase_timings_ms: backendResult.phase_timings_ms,
      rpc_retries: backendResult.rpc_retries,
      preflight_truncated: backendResult.preflight_truncated,
      preflight_original_chars: backendResult.preflight_original_chars,
      context_error: backendResult.context_error,
      message_error: backendResult.message_error,
      memory_id: backendResult.memory_id,
      memory_key: backendResult.memory_key,
      memory_error: backendResult.memory_error,
      thread_message_id: backendResult.thread_message_id,
      thread_error: backendResult.thread_error,
      release_error: backendResult.release_error,
      blocked_release: backendResult.blocked_release,
      claim_renewals: backendResult.claim_renewals,
      claim_renewal_error: backendResult.claim_renewal_error,
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
  const runtimeProfile = await measurePhase(phaseTimings, 'detect_runtime_profile_ms', () => detectRuntimeProfile(opts));

  const mcp = await measurePhase(phaseTimings, 'mcp_initialize_ms', () => createMcpClient(opts.endpoint));
  try {
    const registerArgs = {
      id: opts.agentId,
      name: opts.agentName,
      type: `bridge:${opts.backend}`,
      register_token: opts.registerToken || undefined,
      capabilities: ['bridge', 'external-runtime', opts.backend, ...parseCsv(opts.capabilities)].join(','),
      lifecycle: opts.lifecycle,
      onboarding_mode: opts.onboardingMode,
      runtime_profile: runtimeProfile,
      client_capabilities: {
        response_modes: ['tiny', 'compact'],
        blob_resolve: true,
        artifact_tickets: false,
        snapshot_reads: true,
        push_transports: ['wait_for_updates'],
      },
    };
    const registration = await measurePhase(phaseTimings, 'register_agent_ms', () => mcp.call('register_agent', registerArgs));
    const authToken = registration?.auth?.token;
    if (!authToken) {
      const errorCode = registration?.error_code ? ` error_code=${registration.error_code}` : '';
      const registerError = registration?.error ? ` error=${truncate(registration.error, 240)}` : '';
      throw new Error(`register_agent did not return auth token.${errorCode}${registerError}`);
    }

    const hubDigest = await measurePhase(phaseTimings, 'get_hub_digest_ms', () => mcp.call('get_hub_digest', {
      agent_id: opts.agentId,
      auth_token: authToken,
      sections: ['signals', 'events', 'memory'],
      memory_namespace: opts.memoryNamespace || undefined,
      response_mode: 'tiny',
      limit_per_source: 5,
    }));
    let threadTail = null;
    if (opts.threadId && opts.threadTail > 0) {
      threadTail = await measurePhase(phaseTimings, 'read_thread_preflight_ms', () => mcp.call('read_thread', {
        agent_id: opts.agentId,
        auth_token: authToken,
        thread_id: opts.threadId,
        response_mode: 'compact',
        limit: opts.threadTail,
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
    };
    const preflightSerialized = serializePreflight(preflight);
    const backendPrompt = buildBackendPrompt(prompt, preflight);

    let claim = null;
    let claimRenewal = null;
    if (Number.isInteger(opts.taskId) && opts.taskId > 0) {
      claim = await measurePhase(phaseTimings, 'claim_task_ms', () => mcp.call('claim_task', {
        task_id: opts.taskId,
        agent_id: opts.agentId,
        auth_token: authToken,
        lease_seconds: opts.leaseSeconds,
        namespace: opts.namespace || undefined,
        idempotency_key: `${opts.agentId}:claim:${opts.taskId}`,
      }));
      if (claim.success !== true) {
        throw new Error(`claim_task failed: ${JSON.stringify(claim)}`);
      }
      claimRenewal = startClaimRenewal(mcp, opts, authToken, claim);
    }

    let backendResult;
    let renewalSummary = null;
    try {
      backendResult = await measurePhase(phaseTimings, 'backend_ms', () => runBackend(opts, backendPrompt));
    } finally {
      if (claimRenewal) renewalSummary = await measurePhase(phaseTimings, 'claim_renewal_stop_ms', () => claimRenewal.stop());
    }
    backendResult.phase_timings_ms = phaseTimings;
    backendResult.rpc_retries = rpcRetries;
    backendResult.preflight_truncated = preflightSerialized.truncated;
    backendResult.preflight_original_chars = preflightSerialized.original_chars;
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
    const reportPath = path.join(opts.outDir, `${opts.agentId}.json`);
    await measurePhase(phaseTimings, 'write_report_initial_ms', () => fs.writeFile(reportPath, `${JSON.stringify(fullReport, null, 2)}\n`));

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
    if (opts.publishMessage) {
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
    if (claim && Number.isInteger(opts.taskId) && opts.taskId > 0) {
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
        claim_id: claim.claim?.claim_id,
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
          claim_id: claim.claim?.claim_id,
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
    }
    backendResult.rpc_retries = rpcRetries;
    fullReport = {
      ...compactResult(opts, prompt, backendResult),
      output: backendResult.output,
      stderr: backendResult.stderr,
      raw_error: backendResult.error,
      parsed_json: backendResult.parsed_json,
    };
    await measurePhase(phaseTimings, 'write_report_final_ms', () => fs.writeFile(reportPath, `${JSON.stringify(fullReport, null, 2)}\n`));
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
  } finally {
    await measurePhase(phaseTimings, 'mcp_close_ms', () => mcp.close());
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
