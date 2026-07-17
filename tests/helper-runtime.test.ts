import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMcpClient, isReplaySafeToolCall } from '../scripts/lib/mcp-client.mjs';
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
} from '../scripts/lib/bridge-runtime.mjs';

function rpcResponse(body: unknown, status = 200, sessionId?: string): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (sessionId) headers.set('mcp-session-id', sessionId);
  return new Response(JSON.stringify(body), { status, headers });
}

function initializedResponse(): Response {
  return new Response(null, { status: 202 });
}

function toolResponse(id: number, payload: unknown): Response {
  return rpcResponse({
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shared MCP helper client', () => {
  it('classifies replay safety from both tool contract and side-effecting arguments', () => {
    expect(isReplaySafeToolCall('send_message', { idempotency_key: 'run-1' })).toBe(true);
    expect(isReplaySafeToolCall('resolve_consensus', { idempotency_key: 'ignored-by-server' })).toBe(false);
    expect(isReplaySafeToolCall('read_messages', { mark_read: false, unread_only: true })).toBe(true);
    expect(isReplaySafeToolCall('read_messages', { unread_only: true })).toBe(false);
    expect(isReplaySafeToolCall('read_filter_feed', { advance_cursor: true })).toBe(false);
    expect(isReplaySafeToolCall('fetch_hub_refs', { mark_messages_read: true })).toBe(false);
    expect(isReplaySafeToolCall('get_task_handoff', { include_downloads: true })).toBe(false);
    expect(isReplaySafeToolCall('get_task_handoff', { include_downloads: false })).toBe(true);
    expect(isReplaySafeToolCall('pack_protocol_message', {})).toBe(true);
  });

  it('reinitializes when the hub returns -32000 in an HTTP 400 response', async () => {
    const requests: Array<Record<string, any>> = [];
    let initializeCount = 0;
    let toolCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, any>;
      requests.push(body);
      if (body.method === 'initialize') {
        initializeCount += 1;
        return rpcResponse({ jsonrpc: '2.0', id: body.id, result: {} }, 200, `session-${initializeCount}`);
      }
      if (body.method === 'notifications/initialized') return initializedResponse();
      toolCount += 1;
      if (toolCount === 1) {
        return rpcResponse({
          jsonrpc: '2.0',
          id: body.id,
          error: {
            code: -32000,
            message: 'Unknown or expired MCP session',
            data: { reinitialize_required: true, reason: 'unknown_or_expired_session' },
          },
        }, 400);
      }
      return toolResponse(body.id, { success: true, recovered: true });
    }));

    const client = await createMcpClient('http://hub.test/mcp', { httpRetries: 0 });
    const result = await client.call('get_hub_digest', { agent_id: 'a1' });
    await client.close();

    expect(result).toEqual({ success: true, recovered: true });
    expect(initializeCount).toBe(2);
    const toolRequests = requests.filter((request) => request.method === 'tools/call');
    expect(toolRequests).toHaveLength(2);
    expect(toolRequests[1]).toEqual(toolRequests[0]);
  });

  it('does not replay an unsafe mutation without an idempotency key after response loss', async () => {
    let toolAttempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, any>;
      if (body.method === 'initialize') return rpcResponse({ jsonrpc: '2.0', id: body.id, result: {} }, 200, 'session-1');
      if (body.method === 'notifications/initialized') return initializedResponse();
      toolAttempts += 1;
      throw new TypeError('response lost');
    }));

    const client = await createMcpClient('http://hub.test/mcp', { httpRetries: 2, retryDelayMs: 25 });
    await expect(client.call('send_message', {
      from_agent: 'a1',
      to_agent: 'a2',
      content: 'unsafe without replay guard',
    })).rejects.toThrow('response lost');
    expect(toolAttempts).toBe(1);
    expect(client.stats.unsafe_retries_suppressed).toBe(1);
    await client.close();
  });

  it('replays the exact same guarded mutation after response loss', async () => {
    const toolRequests: Array<Record<string, any>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, any>;
      if (body.method === 'initialize') return rpcResponse({ jsonrpc: '2.0', id: body.id, result: {} }, 200, 'session-1');
      if (body.method === 'notifications/initialized') return initializedResponse();
      toolRequests.push(body);
      if (toolRequests.length === 1) throw new TypeError('response lost');
      return toolResponse(body.id, { success: true, message: { id: 7 } });
    }));

    const client = await createMcpClient('http://hub.test/mcp', { httpRetries: 1, retryDelayMs: 25 });
    const result = await client.call('send_message', {
      from_agent: 'a1',
      to_agent: 'a2',
      content: 'guarded',
      idempotency_key: 'run-1:message',
    });
    await client.close();

    expect(result.success).toBe(true);
    expect(toolRequests).toHaveLength(2);
    expect(toolRequests[1]).toEqual(toolRequests[0]);
    expect(toolRequests[1].params.arguments.idempotency_key).toBe('run-1:message');
  });
});

describe('bridge runtime contract', () => {
  it('requires explicit verification and confidence before a task can be completed', () => {
    expect(assessTaskCompletion('{"result":"looks good"}').completion_ready).toBe(false);
    expect(assessTaskCompletion('{"verification_passed":true}').completion_ready).toBe(false);
    expect(assessTaskCompletion('{"verification_passed":true,"confidence":"0.9"}').completion_ready).toBe(false);
    expect(assessTaskCompletion('{"verification_passed":true,"confidence":0.9,"verification":{"checks":[]}}').completion_ready).toBe(false);

    const assessed = assessTaskCompletion(JSON.stringify({
      verification_passed: true,
      confidence: 0.93,
      verification: { passed: true, checks: ['tests passed'] },
    }));
    expect(assessed.completion_ready).toBe(true);
    expect(assessed.verification_passed).toBe(true);
    expect(assessed.confidence).toBe(0.93);
    expect(assessed.verification_checks).toEqual(['tests passed']);
  });

  it('removes hub credentials from model backend environments', () => {
    const sanitized = sanitizeBackendEnv({
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'backend-provider-key',
      HUB_REGISTER_TOKEN: 'register-secret',
      MCP_HUB_REGISTER_TOKEN: 'register-secret-2',
      BRIDGE_REGISTER_TOKEN: 'register-secret-3',
      HUB_AGENT_TOKEN_FILE: '/tmp/hub-agent.token',
      BRIDGE_AGENT_TOKEN_FILE: '/tmp/bridge-agent.token',
      BRIDGE_AGENT_AUTH_TOKEN: 'agent-secret',
      HUB_AUTH_TOKEN: 'agent-secret-2',
      AUTH_TOKEN_FILE: '/tmp/auth.token',
      AGENT_AUTH_TOKEN: 'agent-secret-3',
      REGISTER_TOKEN: 'register-secret-4',
      MCP_AUTH_TOKEN: 'agent-secret-4',
    });

    expect(sanitized).toEqual({
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'backend-provider-key',
    });
  });

  it('scopes private thread output to the other participant', () => {
    expect(resolveThreadPublicationPolicy({
      success: true,
      thread: { private: true, from_agent: 'reviewer', to_agent: 'worker' },
    }, 'worker')).toEqual({
      is_private: true,
      private_peer: 'reviewer',
      allow_shared_publication: false,
    });
    expect(resolveThreadPublicationPolicy({
      success: true,
      thread: { private: false, from_agent: 'reviewer', to_agent: null },
    }, 'worker').allow_shared_publication).toBe(true);
  });

  it('scopes idempotency keys to a concrete bridge run', () => {
    const first = runIdempotencyKey('worker:100', 'claim', 7);
    const retry = runIdempotencyKey('worker:100', 'claim', 7);
    const nextRun = runIdempotencyKey('worker:200', 'claim', 7);
    expect(first).toMatch(/^bridge-v1:[a-f0-9]{64}$/);
    expect(retry).toBe(first);
    expect(nextRun).not.toBe(first);
  });

  it('keeps bridge idempotency keys within the server limit for maximum identifiers', () => {
    const agentId = `a${'g'.repeat(119)}`;
    const runId = `${agentId}:${'f'.repeat(36)}`;
    const threadId = `t${'h'.repeat(119)}`;
    const contextKey = `k${'e'.repeat(119)}`;
    const key = runIdempotencyKey(runId, 'context-publish-correction', threadId, contextKey);

    expect(key).toHaveLength(74);
    expect(key.length).toBeLessThanOrEqual(256);
  });

  it('hashes an unambiguous canonical tuple instead of colon-joined parts', () => {
    const first = runIdempotencyKey('worker:a', 'thread', 'b:c', '');
    const repartitioned = runIdempotencyKey('worker', 'a:thread', 'b', 'c');
    const missingEmptyPart = runIdempotencyKey('worker:a', 'thread', 'b:c');

    expect(repartitioned).not.toBe(first);
    expect(missingEmptyPart).not.toBe(first);
  });

  it('keeps strict tasks out of the bridge path without a verifier workflow', () => {
    expect(taskRequiresIndependentVerifier({ task: { consistency_mode: 'strict' } })).toBe(true);
    expect(taskRequiresIndependentVerifier({ task: { consistency_mode: 'cheap' } })).toBe(false);
    expect(taskRequiresIndependentVerifier({ consistency_mode: 'strict' })).toBe(true);
  });

  it('persists reusable agent credentials outside reports with owner-only permissions', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bridge-token-test-'));
    const tokenFile = path.join(dir, 'tokens', 'worker.token');
    try {
      await writeAgentToken(tokenFile, 'secret-agent-token');
      expect(await readAgentToken('', tokenFile)).toBe('secret-agent-token');
      expect(await readFile(tokenFile, 'utf8')).toBe('secret-agent-token\n');
      expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('forces bridge reports to owner-only permissions even when replacing a permissive file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bridge-report-mode-'));
    const reportFile = path.join(dir, 'report.json');
    try {
      await writeFile(reportFile, '{}\n');
      await chmod(reportFile, 0o644);
      await writePrivateJson(reportFile, { success: true });

      expect(JSON.parse(await readFile(reportFile, 'utf8'))).toEqual({ success: true });
      expect((await stat(reportFile)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('publishes exactly one credential under concurrent first starts', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bridge-token-race-'));
    const tokenFile = path.join(dir, 'worker.token');
    try {
      const [first, second] = await Promise.all([
        getOrCreateAgentToken(tokenFile, 'candidate-one'.padEnd(64, '1')),
        getOrCreateAgentToken(tokenFile, 'candidate-two'.padEnd(64, '2')),
      ]);
      expect(first).toBe(second);
      expect(await readAgentToken('', tokenFile)).toBe(first);
      expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
