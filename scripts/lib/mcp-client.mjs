const DEFAULT_HTTP_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_TIMEOUT_MS = 15_000;

const IDEMPOTENCY_SUPPORTED_TOOL_NAMES = new Set([
  'attach_task_artifact',
  'claim_task',
  'create_artifact_download',
  'create_artifact_upload',
  'create_task',
  'create_task_artifact_downloads',
  'delete_task',
  'poll_and_claim',
  'release_task_claim',
  'renew_task_claim',
  'reply_thread',
  'send_blob_message',
  'send_message',
  'share_artifact',
  'share_blob_context',
  'share_context',
  'start_thread',
  'update_task',
  'write_memory',
]);
const REPLAY_SAFE_TOOL_NAMES = new Set([
  'hash_payload',
  'pack_protocol_message',
  'unpack_protocol_message',
  'store_protocol_blob',
]);

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
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
    throw new Error(`MCP response is not JSON or SSE data: ${raw.slice(0, 200)}`);
  }
  return JSON.parse(dataFrames[dataFrames.length - 1]);
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

export function isReplaySafeToolCall(name, args = {}) {
  if (
    IDEMPOTENCY_SUPPORTED_TOOL_NAMES.has(name)
    && typeof args?.idempotency_key === 'string'
    && args.idempotency_key.length > 0
  ) return true;
  if (REPLAY_SAFE_TOOL_NAMES.has(name)) return true;
  if (name === 'read_messages') return args.mark_read === false;
  if (name === 'read_filter_feed') return args.advance_cursor !== true;
  if (name === 'fetch_hub_refs') return args.mark_messages_read !== true;
  if (name === 'get_task_handoff') return args.include_downloads !== true;
  return /^(read_|get_|list_|search_|fetch_|suggest_)/.test(name);
}

export async function createMcpClient(endpoint, options = {}) {
  const httpRetries = clampNumber(options.httpRetries, DEFAULT_HTTP_RETRIES, 0, 5);
  const retryDelayMs = clampNumber(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS, 25, 5_000);
  const timeoutMs = clampNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, 250, 120_000);
  const protocolVersion = options.protocolVersion || '2025-06-18';
  const clientName = options.clientName || 'mcp-script-client';
  const clientVersion = options.clientVersion || '1.0.0';
  let nextId = 1;
  let sessionId = '';
  let rpcRetries = 0;
  let unsafeRetriesSuppressed = 0;

  const recordRetry = (reason) => {
    rpcRetries += 1;
    options.onRetry?.(reason, rpcRetries);
  };

  const postRpc = async (body, currentSessionId = sessionId, maxRetries = httpRetries) => {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(currentSessionId ? { 'mcp-session-id': currentSessionId } : {}),
          },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        let json = null;
        if (text.trim()) {
          try {
            json = extractMcpJson(text);
          } catch (error) {
            if (res.ok) throw error;
          }
        }
        if (!res.ok) {
          // The hub intentionally returns JSON-RPC -32000 in an HTTP 400/404 response for an
          // expired session. Preserve that body so call() can reinitialize instead of turning the
          // recoverable protocol error into an opaque HTTP exception.
          if (json?.error) return { res, json, text };
          const error = new Error(`MCP HTTP ${res.status}: ${text}`);
          if (res.status >= 500 && attempt < maxRetries) {
            lastError = error;
          } else {
            throw error;
          }
        } else {
          return { res, json, text };
        }
      } catch (error) {
        lastError = controller.signal.aborted
          ? new Error(`MCP HTTP request timed out after ${timeoutMs}ms`)
          : error;
        if (attempt >= maxRetries) throw lastError;
      } finally {
        clearTimeout(timer);
      }
      recordRetry('http');
      await sleep(retryDelayMs + Math.floor(Math.random() * retryDelayMs));
    }
    throw lastError || new Error('MCP RPC failed');
  };

  const initializeSession = async () => {
    const init = await postRpc({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'initialize',
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: clientName, version: clientVersion },
      },
    }, '');
    const nextSessionId = init.res.headers.get('mcp-session-id');
    if (!nextSessionId) throw new Error('MCP initialize did not return mcp-session-id');
    await postRpc({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, nextSessionId);
    sessionId = nextSessionId;
  };

  await initializeSession();

  return {
    get sessionId() {
      return sessionId;
    },
    get stats() {
      return { rpc_retries: rpcRetries, unsafe_retries_suppressed: unsafeRetriesSuppressed };
    },
    async call(name, args) {
      const body = {
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      };
      const replaySafe = isReplaySafeToolCall(name, args);
      const callRetries = replaySafe ? httpRetries : 0;
      if (!replaySafe && httpRetries > 0) unsafeRetriesSuppressed += 1;
      let { json } = await postRpc(body, sessionId, callRetries);
      if (isReinitializeRequired(json)) {
        recordRetry('reinitialize');
        await initializeSession();
        ({ json } = await postRpc(body, sessionId, callRetries));
      } else if (isRetryableJsonRpcError(json) && replaySafe) {
        recordRetry('jsonrpc');
        await sleep(retryDelayMs);
        ({ json } = await postRpc(body, sessionId, callRetries));
      }
      return parseMcpPayload(json);
    },
    async close() {
      if (!sessionId) return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      await fetch(endpoint, {
        method: 'DELETE',
        signal: controller.signal,
        headers: { 'mcp-session-id': sessionId },
      }).catch(() => {}).finally(() => clearTimeout(timer));
    },
  };
}
