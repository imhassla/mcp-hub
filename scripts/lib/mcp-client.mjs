const DEFAULT_HTTP_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_TIMEOUT_MS = 15_000;

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

  const recordRetry = (reason) => {
    rpcRetries += 1;
    options.onRetry?.(reason, rpcRetries);
  };

  const postRpc = async (body, currentSessionId = sessionId) => {
    let lastError;
    for (let attempt = 0; attempt <= httpRetries; attempt += 1) {
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
        if (!res.ok) {
          const error = new Error(`MCP HTTP ${res.status}: ${text}`);
          if (res.status >= 500 && attempt < httpRetries) {
            lastError = error;
          } else {
            throw error;
          }
        } else {
          return { res, json: text.trim() ? extractMcpJson(text) : null, text };
        }
      } catch (error) {
        lastError = controller.signal.aborted
          ? new Error(`MCP HTTP request timed out after ${timeoutMs}ms`)
          : error;
        if (attempt >= httpRetries) throw lastError;
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
      return { rpc_retries: rpcRetries };
    },
    async call(name, args) {
      const body = {
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      };
      let { json } = await postRpc(body);
      if (isReinitializeRequired(json)) {
        recordRetry('reinitialize');
        await initializeSession();
        ({ json } = await postRpc(body));
      } else if (isRetryableJsonRpcError(json)) {
        recordRetry('jsonrpc');
        await sleep(retryDelayMs);
        ({ json } = await postRpc(body));
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
