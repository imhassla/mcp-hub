#!/usr/bin/env node

import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { z } from 'zod';
import { getDb } from './db.js';
import { agentTools, handleRegisterAgent, handleListAgents, handleSuggestAgents, handleGetOnboarding, handleUpdateRuntimeProfile } from './tools/agents.js';
import { messageTools, handleSendMessage, handleSendBlobMessage, handleReadMessages } from './tools/messages.js';
import {
  taskTools,
  handleCreateTask,
  handleUpdateTask,
  handleListTasks,
  handleSuggestTaskAgents,
  handlePollAndClaim,
  handleClaimTask,
  handleRenewTaskClaim,
  handleReleaseTaskClaim,
  handleListTaskClaims,
  handleDeleteTask,
  handleAttachTaskArtifact,
  handleListTaskArtifacts,
  handleGetTaskHandoff,
} from './tools/tasks.js';
import { contextTools, handleShareContext, handleShareBlobContext, handleGetContext } from './tools/context.js';
import {
  activityTools,
  handleGetActivityLog,
  handleGetKpiSnapshot,
  handleGetTransportSnapshot,
  handleReadSnapshot,
  handleWaitForUpdates,
  handleReadEventDeltas,
  handleEvaluateSloAlerts,
  handleListSloAlerts,
  handleGetAuthCoverage,
  handleRunMaintenance,
} from './tools/activity.js';
import {
  consensusTools,
  handleResolveConsensus,
  handleResolveConsensusFromContext,
  handleResolveConsensusFromMessage,
  handleListConsensusDecisions,
} from './tools/consensus.js';
import {
  protocolTools,
  handlePackProtocolMessage,
  handleUnpackProtocolMessage,
  handleHashPayload,
  handleStoreProtocolBlob,
  handleGetProtocolBlob,
  handleListProtocolBlobs,
} from './tools/protocol.js';
import {
  runMaintenance,
  validateAgentToken,
  recordAuthEvent,
  finalizeArtifactUpload,
  getArtifactById,
  incrementArtifactAccess,
  logActivity,
  getStreamEventWatermark,
  getMinStreamEventId,
  listStreamEventsAfter,
} from './db.js';
import {
  artifactTools,
  configureArtifactTicketIssuer,
  handleCreateArtifactUpload,
  handleCreateArtifactDownload,
  handleCreateTaskArtifactDownloads,
  handleListArtifacts,
  handleShareArtifact,
} from './tools/artifacts.js';
import { searchTools, handleSearchHub } from './tools/search.js';
import { refTools, handleFetchHubRefs } from './tools/refs.js';
import { filterTools, handleSaveFilter, handleListFilters, handleReadFilterFeed, handleDeleteFilter } from './tools/filters.js';
import { signalTools, handleReadSignalFeed, handleAckFeedItems } from './tools/signals.js';
import { digestTools, handleGetHubDigest } from './tools/digest.js';
import { memoryTools, handleWriteMemory, handleSearchMemory, handleGetMemoryDigest } from './tools/memory.js';
import { traceTools, handleGetTraceTimeline } from './tools/traces.js';
import { threadTools, handleStartThread, handleReplyThread, handleReadThread } from './tools/threads.js';
import { validateRegisterToken } from './auth.js';

function createServer() {
  return new McpServer({
    name: 'mcp-agent-hub',
    version: '1.0.0',
  });
}

function upsertRawHeader(rawHeaders: string[], name: string, value: string) {
  const target = name.toLowerCase();
  let replaced = false;

  for (let i = 0; i < rawHeaders.length; i += 2) {
    if ((rawHeaders[i] ?? '').toLowerCase() === target) {
      rawHeaders[i + 1] = value;
      replaced = true;
    }
  }

  if (!replaced) {
    rawHeaders.push(name, value);
  }
}

function mcpTextResponse(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  };
}

function setServerCapabilityHeaders(res: express.Response) {
  res.setHeader('x-mcp-hub-capabilities', 'nano,blob_resolve,artifact_tickets,read_snapshot,read_event_deltas,sse_events,search_hub,fetch_hub_refs,saved_filters,signal_feed,hub_digest,shared_memory,trace_timeline,discussion_threads,namespace_quotas,adaptive_consistency');
}

function isInitializeMethod(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const method = (body as { method?: unknown }).method;
  return method === 'initialize';
}

function jsonRpcErrorResponse(id: unknown, code: number, message: string, data?: Record<string, unknown>) {
  return {
    jsonrpc: '2.0',
    error: data ? { code, message, data } : { code, message },
    id: id ?? null,
  };
}

function extractAgentAuthPayload(args: Record<string, unknown>): { agentId: string | null; authToken: string | null } {
  const candidateAgentKeys = ['agent_id', 'from_agent', 'created_by', 'requesting_agent'] as const;
  const candidateTokenKeys = ['auth_token', 'token'] as const;
  let agentId: string | null = null;
  let authToken: string | null = null;

  for (const key of candidateAgentKeys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      agentId = value.trim();
      break;
    }
  }
  for (const key of candidateTokenKeys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      authToken = value.trim();
      break;
    }
  }

  return { agentId, authToken };
}

type TokenBucket = {
  tokens: number;
  lastRefillAt: number;
};

const rateLimitBuckets = new Map<string, TokenBucket>();
const namespaceRateBuckets = new Map<string, TokenBucket>();
const namespaceTokenBudgetWindows = new Map<string, { windowStartAt: number; tokensUsed: number }>();
const RATE_LIMIT_RPS = Number(process.env.MCP_HUB_RATE_LIMIT_RPS || 30);
const RATE_LIMIT_BURST = Number(process.env.MCP_HUB_RATE_LIMIT_BURST || 60);
const NAMESPACE_QUOTA_MODE = (() => {
  const configured = String(process.env.MCP_HUB_NAMESPACE_QUOTA_MODE || 'off').toLowerCase().trim();
  if (configured === 'warn' || configured === 'enforce') return configured;
  return 'off';
})();
const NAMESPACE_QUOTA_RPS = Number(process.env.MCP_HUB_NAMESPACE_QUOTA_RPS || 0);
const NAMESPACE_QUOTA_BURST = Number(process.env.MCP_HUB_NAMESPACE_QUOTA_BURST || 0);
const NAMESPACE_TOKEN_BUDGET_PER_MIN = Number(process.env.MCP_HUB_NAMESPACE_TOKEN_BUDGET_PER_MIN || 0);
const NAMESPACE_QUOTA_FALLBACK = (process.env.MCP_HUB_NAMESPACE_QUOTA_FALLBACK || 'default').trim() || 'default';
const RATE_LIMIT_BUCKET_IDLE_TTL_MS = Number.isFinite(Number(process.env.MCP_HUB_RATE_LIMIT_BUCKET_IDLE_TTL_MS))
  ? Math.max(60_000, Math.min(24 * 60 * 60 * 1000, Math.floor(Number(process.env.MCP_HUB_RATE_LIMIT_BUCKET_IDLE_TTL_MS))))
  : 10 * 60 * 1000;
const REQUIRE_AUTH = String(process.env.MCP_HUB_REQUIRE_AUTH || '').toLowerCase() === 'true';
const AUTH_MODE = (() => {
  const configured = String(process.env.MCP_HUB_AUTH_MODE || '').toLowerCase().trim();
  if (configured === 'observe' || configured === 'warn' || configured === 'enforce') return configured;
  return REQUIRE_AUTH ? 'enforce' : 'observe';
})();
const REGISTER_TOKEN = String(process.env.MCP_HUB_REGISTER_TOKEN || '').trim();
const MAINTENANCE_INTERVAL_MS = Number(process.env.MCP_HUB_MAINTENANCE_INTERVAL_MS || 30_000);
const SESSION_IDLE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.MCP_HUB_SESSION_IDLE_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return 6 * 60 * 60 * 1000;
  const normalized = Math.floor(raw);
  if (normalized <= 0) return 0;
  return Math.max(60_000, Math.min(7 * 24 * 60 * 60 * 1000, normalized));
})();
const SESSION_GC_ENABLED = SESSION_IDLE_TIMEOUT_MS > 0;
const SESSION_IDLE_TIMEOUT_LABEL = SESSION_GC_ENABLED ? String(SESSION_IDLE_TIMEOUT_MS) : 'disabled';
const SESSION_GC_INTERVAL_MS = Number.isFinite(Number(process.env.MCP_HUB_SESSION_GC_INTERVAL_MS))
  ? Math.max(1_000, Math.min(30 * 60 * 1000, Math.floor(Number(process.env.MCP_HUB_SESSION_GC_INTERVAL_MS))))
  : 60_000;
const ARTIFACT_TICKET_TTL_SEC = Number.isFinite(Number(process.env.MCP_HUB_ARTIFACT_TICKET_TTL_SEC))
  ? Math.max(30, Math.floor(Number(process.env.MCP_HUB_ARTIFACT_TICKET_TTL_SEC)))
  : 300;
const ARTIFACT_MAX_BYTES = Number.isFinite(Number(process.env.MCP_HUB_ARTIFACT_MAX_BYTES))
  ? Math.max(1024, Math.floor(Number(process.env.MCP_HUB_ARTIFACT_MAX_BYTES)))
  : 50 * 1024 * 1024;
const ARTIFACTS_DIR = process.env.MCP_HUB_ARTIFACTS_DIR || '/data/artifacts';
const EVENT_STREAM_DEFAULT_INTERVAL_MS = Number.isFinite(Number(process.env.MCP_HUB_EVENT_STREAM_INTERVAL_MS))
  ? Math.max(250, Math.min(10_000, Math.floor(Number(process.env.MCP_HUB_EVENT_STREAM_INTERVAL_MS))))
  : 1_000;
const EVENT_STREAM_HEARTBEAT_MS = Number.isFinite(Number(process.env.MCP_HUB_EVENT_STREAM_HEARTBEAT_MS))
  ? Math.max(2_000, Math.min(60_000, Math.floor(Number(process.env.MCP_HUB_EVENT_STREAM_HEARTBEAT_MS))))
  : 15_000;
const EVENT_STREAM_MAX_CONNECTIONS = Number.isFinite(Number(process.env.MCP_HUB_EVENT_STREAM_MAX_CONNECTIONS))
  ? Math.max(1, Math.min(10_000, Math.floor(Number(process.env.MCP_HUB_EVENT_STREAM_MAX_CONNECTIONS))))
  : 200;
const EVENT_STREAM_MAX_PER_AGENT = Number.isFinite(Number(process.env.MCP_HUB_EVENT_STREAM_MAX_PER_AGENT))
  ? Math.max(1, Math.min(EVENT_STREAM_MAX_CONNECTIONS, Math.floor(Number(process.env.MCP_HUB_EVENT_STREAM_MAX_PER_AGENT))))
  : 10;
const EVENT_STREAM_MAX_BUFFER_BYTES = Number.isFinite(Number(process.env.MCP_HUB_EVENT_STREAM_MAX_BUFFER_BYTES))
  ? Math.max(16 * 1024, Math.min(16 * 1024 * 1024, Math.floor(Number(process.env.MCP_HUB_EVENT_STREAM_MAX_BUFFER_BYTES))))
  : 1024 * 1024;
const EVENT_STREAM_DRAIN_TIMEOUT_MS = Number.isFinite(Number(process.env.MCP_HUB_EVENT_STREAM_DRAIN_TIMEOUT_MS))
  ? Math.max(500, Math.min(60_000, Math.floor(Number(process.env.MCP_HUB_EVENT_STREAM_DRAIN_TIMEOUT_MS))))
  : 5_000;
const ORIGIN_MODE = (() => {
  const configured = String(process.env.MCP_HUB_ORIGIN_MODE || 'warn').toLowerCase().trim();
  return configured === 'enforce' ? 'enforce' : 'warn';
})();
const STRICT_SESSION_STATUS = String(process.env.MCP_HUB_STRICT_SESSION_STATUS || '').toLowerCase() === 'true';

type ArtifactTicket = {
  token: string;
  kind: 'upload' | 'download';
  artifact_id: string;
  agent_id: string;
  expires_at: number;
  max_bytes: number;
};

const artifactTickets = new Map<string, ArtifactTicket>();
const eventStreamCountsByAgent = new Map<string, number>();
let activeEventStreamCount = 0;

function consumeRateLimit(agentId: string, now = Date.now()): boolean {
  if (!Number.isFinite(RATE_LIMIT_RPS) || RATE_LIMIT_RPS <= 0 || !Number.isFinite(RATE_LIMIT_BURST) || RATE_LIMIT_BURST <= 0) {
    return true;
  }
  const bucket = rateLimitBuckets.get(agentId) || { tokens: RATE_LIMIT_BURST, lastRefillAt: now };
  const elapsedMs = Math.max(0, now - bucket.lastRefillAt);
  const refill = (elapsedMs / 1000) * RATE_LIMIT_RPS;
  bucket.tokens = Math.min(RATE_LIMIT_BURST, bucket.tokens + refill);
  bucket.lastRefillAt = now;
  if (bucket.tokens < 1) {
    rateLimitBuckets.set(agentId, bucket);
    return false;
  }
  bucket.tokens -= 1;
  rateLimitBuckets.set(agentId, bucket);
  return true;
}

function consumeNamespaceRateLimit(namespace: string, now = Date.now()): boolean {
  if (!Number.isFinite(NAMESPACE_QUOTA_RPS) || NAMESPACE_QUOTA_RPS <= 0 || !Number.isFinite(NAMESPACE_QUOTA_BURST) || NAMESPACE_QUOTA_BURST <= 0) {
    return true;
  }
  const key = namespace.toLowerCase();
  const bucket = namespaceRateBuckets.get(key) || { tokens: NAMESPACE_QUOTA_BURST, lastRefillAt: now };
  const elapsedMs = Math.max(0, now - bucket.lastRefillAt);
  const refill = (elapsedMs / 1000) * NAMESPACE_QUOTA_RPS;
  bucket.tokens = Math.min(NAMESPACE_QUOTA_BURST, bucket.tokens + refill);
  bucket.lastRefillAt = now;
  if (bucket.tokens < 1) {
    namespaceRateBuckets.set(key, bucket);
    return false;
  }
  bucket.tokens -= 1;
  namespaceRateBuckets.set(key, bucket);
  return true;
}

function estimateTokensFromValue(value: unknown): number {
  try {
    const raw = JSON.stringify(value);
    if (!raw) return 1;
    return Math.max(1, Math.ceil(raw.length / 4));
  } catch {
    return 1;
  }
}

function namespaceQuotaError(namespace: string, details: Record<string, unknown> = {}) {
  return {
    success: false,
    error_code: 'NAMESPACE_QUOTA_EXCEEDED',
    error: `Namespace quota exceeded for "${namespace}"`,
    namespace,
    quota_mode: NAMESPACE_QUOTA_MODE,
    retry_after_ms: 1000,
    ...details,
  };
}

function consumeNamespaceTokenBudget(namespace: string, tokenCost: number, now = Date.now()): boolean {
  if (!Number.isFinite(NAMESPACE_TOKEN_BUDGET_PER_MIN) || NAMESPACE_TOKEN_BUDGET_PER_MIN <= 0) {
    return true;
  }
  const windowMs = 60_000;
  const key = namespace.toLowerCase();
  const existing = namespaceTokenBudgetWindows.get(key);
  if (!existing || (now - existing.windowStartAt) >= windowMs) {
    namespaceTokenBudgetWindows.set(key, { windowStartAt: now, tokensUsed: tokenCost });
    return tokenCost <= NAMESPACE_TOKEN_BUDGET_PER_MIN;
  }
  if (existing.tokensUsed + tokenCost > NAMESPACE_TOKEN_BUDGET_PER_MIN) {
    return false;
  }
  existing.tokensUsed += tokenCost;
  namespaceTokenBudgetWindows.set(key, existing);
  return true;
}

function cleanupRateLimitState(now = Date.now()): number {
  let cleaned = 0;
  const cleanupBuckets = (buckets: Map<string, TokenBucket>, burst: number, rps: number) => {
    for (const [key, bucket] of buckets.entries()) {
      if ((now - bucket.lastRefillAt) < RATE_LIMIT_BUCKET_IDLE_TTL_MS) continue;
      const elapsedMs = Math.max(0, now - bucket.lastRefillAt);
      const effectiveTokens = Math.min(burst, bucket.tokens + (elapsedMs / 1000) * rps);
      if (effectiveTokens < burst) continue;
      buckets.delete(key);
      cleaned += 1;
    }
  };

  if (Number.isFinite(RATE_LIMIT_RPS) && RATE_LIMIT_RPS > 0 && Number.isFinite(RATE_LIMIT_BURST) && RATE_LIMIT_BURST > 0) {
    cleanupBuckets(rateLimitBuckets, RATE_LIMIT_BURST, RATE_LIMIT_RPS);
  }
  if (Number.isFinite(NAMESPACE_QUOTA_RPS) && NAMESPACE_QUOTA_RPS > 0 && Number.isFinite(NAMESPACE_QUOTA_BURST) && NAMESPACE_QUOTA_BURST > 0) {
    cleanupBuckets(namespaceRateBuckets, NAMESPACE_QUOTA_BURST, NAMESPACE_QUOTA_RPS);
  }

  for (const [key, window] of namespaceTokenBudgetWindows.entries()) {
    if ((now - window.windowStartAt) < Math.max(2 * 60_000, RATE_LIMIT_BUCKET_IDLE_TTL_MS)) continue;
    namespaceTokenBudgetWindows.delete(key);
    cleaned += 1;
  }

  return cleaned;
}

function lookupNamespaceByTaskId(taskId: number): string | null {
  if (!Number.isFinite(taskId) || taskId <= 0) return null;
  try {
    const row = getDb().prepare('SELECT namespace FROM tasks WHERE id = ?').get(Math.floor(taskId)) as { namespace?: string } | undefined;
    if (!row?.namespace) return null;
    const normalized = String(row.namespace).trim();
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}

function extractNamespace(toolName: string, args: Record<string, unknown>): string {
  const namespaceKeys = ['namespace', 'task_namespace'] as const;
  for (const key of namespaceKeys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  const taskScopedTools = new Set([
    'update_task',
    'claim_task',
    'renew_task_claim',
    'release_task_claim',
    'delete_task',
    'attach_task_artifact',
    'list_task_artifacts',
    'get_task_handoff',
    'create_task_artifact_downloads',
  ]);
  if (taskScopedTools.has(toolName)) {
    const taskIdCandidate = Number.isFinite(Number(args.task_id))
      ? Number(args.task_id)
      : Number(args.id);
    const lookedUp = lookupNamespaceByTaskId(taskIdCandidate);
    if (lookedUp) return lookedUp;
  }

  return NAMESPACE_QUOTA_FALLBACK;
}

type EventStream = 'messages' | 'tasks' | 'context' | 'activity' | 'artifacts' | 'consensus';
const EVENT_STREAMS: EventStream[] = ['messages', 'tasks', 'context', 'activity', 'artifacts', 'consensus'];

function parseEventStreams(raw: string | string[] | undefined): EventStream[] {
  const values = Array.isArray(raw) ? raw.join(',') : (raw || '');
  const items = values
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  const supported = new Set<EventStream>(EVENT_STREAMS);
  const normalized = items.filter((item): item is EventStream => supported.has(item as EventStream));
  if (normalized.length === 0) return [...EVENT_STREAMS];
  return [...new Set(normalized)];
}

function encodeStreamEventCursor(eventId: number): string {
  return `e:${Math.max(0, Math.floor(Number(eventId) || 0)).toString(36)}`;
}

function parseStreamEventCursor(cursor?: string): number | null {
  if (typeof cursor !== 'string' || cursor.trim().length === 0) return null;
  const value = cursor.trim();
  const match = /^e:([0-9a-z]+)$/i.exec(value);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 36);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function parseLastEventId(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function parseAllowedOrigins(port: number): Set<string> | '*' {
  const configured = String(process.env.MCP_HUB_ALLOWED_ORIGINS || '').trim();
  if (configured === '*') return '*';
  const values = configured.length > 0
    ? configured.split(',').map((item) => item.trim()).filter(Boolean)
    : [
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      `http://[::1]:${port}`,
    ];
  return new Set(values.map((value) => {
    try {
      return new URL(value).origin;
    } catch {
      return value.replace(/\/+$/, '');
    }
  }));
}

function isAllowedOrigin(origin: string | undefined, allowedOrigins: Set<string> | '*'): boolean {
  if (!origin) return true;
  if (allowedOrigins === '*') return true;
  try {
    return allowedOrigins.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

function originGuard(allowedOrigins: Set<string> | '*'): express.RequestHandler {
  return (req, res, next) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (isAllowedOrigin(origin, allowedOrigins)) {
      next();
      return;
    }
    res.setHeader('x-mcp-hub-origin-rejected', '1');
    if (ORIGIN_MODE === 'enforce') {
      res.status(403).json({
        success: false,
        error_code: 'ORIGIN_FORBIDDEN',
        error: 'Origin is not allowed for this MCP Hub endpoint',
        origin,
      });
      return;
    }
    res.setHeader('x-mcp-hub-origin-warning', 'Origin is not in MCP_HUB_ALLOWED_ORIGINS');
    next();
  };
}

function extractBearerToken(req: express.Request): string {
  const header = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  if (typeof header !== 'string') return '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

function sendUnknownSessionError(res: express.Response, requestId: unknown, statusCode: number) {
  res.setHeader('x-mcp-reinit-required', '1');
  res.setHeader('x-mcp-error-reason', 'unknown_or_expired_session');
  res.status(statusCode).json(jsonRpcErrorResponse(requestId, -32000, 'MCP session not found. Start a new session with initialize.', {
    reinitialize_required: true,
    retryable: true,
    reason: 'unknown_or_expired_session',
    recovery_sequence: ['initialize', 'notifications/initialized', 'retry_original_request_once'],
  }));
}

function sanitizeArtifactId(value: string): string {
  return (value || '').replace(/[^a-zA-Z0-9-_]/g, '');
}

function artifactPathForId(artifactId: string): string {
  const safeId = sanitizeArtifactId(artifactId);
  return path.join(ARTIFACTS_DIR, safeId);
}

function issueArtifactTicket(args: {
  kind: 'upload' | 'download';
  artifact_id: string;
  agent_id: string;
  ttl_sec: number;
  max_bytes: number;
}): { token: string; expires_at: number } {
  const ttlSec = Number.isFinite(args.ttl_sec)
    ? Math.max(30, Math.min(24 * 60 * 60, Math.floor(Number(args.ttl_sec))))
    : ARTIFACT_TICKET_TTL_SEC;
  const maxBytes = Number.isFinite(args.max_bytes)
    ? Math.max(1024, Math.min(ARTIFACT_MAX_BYTES, Math.floor(Number(args.max_bytes))))
    : ARTIFACT_MAX_BYTES;
  const token = `${randomUUID()}-${randomUUID()}`;
  const expiresAt = Date.now() + ttlSec * 1000;
  artifactTickets.set(token, {
    token,
    kind: args.kind,
    artifact_id: args.artifact_id,
    agent_id: args.agent_id,
    expires_at: expiresAt,
    max_bytes: maxBytes,
  });
  return { token, expires_at: expiresAt };
}

function consumeArtifactTicket(token: string, kind: 'upload' | 'download', artifactId: string): ArtifactTicket | null {
  const ticket = artifactTickets.get(token);
  if (!ticket) return null;
  if (ticket.kind !== kind || ticket.artifact_id !== artifactId) return null;
  if (ticket.expires_at < Date.now()) {
    artifactTickets.delete(token);
    return null;
  }
  artifactTickets.delete(token);
  return ticket;
}

function cleanupExpiredArtifactTickets(now = Date.now()): number {
  let cleaned = 0;
  for (const [token, ticket] of artifactTickets.entries()) {
    if (ticket.expires_at >= now) continue;
    artifactTickets.delete(token);
    cleaned += 1;
  }
  return cleaned;
}

type ToolGuardResult =
  | { allowed: true; warnings?: string[]; namespace?: string; request_tokens_est?: number }
  | { allowed: false; response: Record<string, unknown> };

function shouldBypassAuth(toolName: string): boolean {
  return toolName === 'register_agent';
}

function canOmitResponseForQuota(toolName: string): boolean {
  return /^(get|read|list|search|fetch)_/.test(toolName)
    || toolName === 'wait_for_updates'
    || toolName === 'suggest_agents'
    || toolName === 'suggest_task_agents';
}

const runtimeModelProfileSchema = z.object({
  provider: z.string().optional(),
  id: z.string().optional(),
  family: z.string().optional(),
  context_window: z.number().optional(),
  max_output_tokens: z.number().optional(),
  strengths: z.array(z.string()).optional(),
  task_types: z.array(z.string()).optional(),
  cost_tier: z.enum(['low', 'medium', 'high', 'unknown']).optional(),
  latency_tier: z.enum(['low', 'medium', 'high', 'unknown']).optional(),
}).optional();

function guardToolCall(toolName: string, args: Record<string, unknown>): ToolGuardResult {
  const { agentId, authToken } = extractAgentAuthPayload(args);
  const now = Date.now();
  const warnings: string[] = [];
  let quotaNamespace: string | undefined;
  let requestTokensEst: number | undefined;
  const allow = (): ToolGuardResult => ({
    allowed: true,
    warnings: warnings.length > 0 ? warnings : undefined,
    namespace: quotaNamespace,
    request_tokens_est: requestTokensEst,
  });

  if (agentId && !consumeRateLimit(agentId, now)) {
    return {
      allowed: false,
      response: {
        success: false,
        error_code: 'RATE_LIMIT_EXCEEDED',
        error: 'Rate limit exceeded for this agent. Retry shortly.',
        retry_after_ms: 1000,
      },
    };
  }

  if (NAMESPACE_QUOTA_MODE !== 'off') {
    const namespace = extractNamespace(toolName, args);
    quotaNamespace = namespace;
    const namespaceRpsOk = consumeNamespaceRateLimit(namespace, now);
    const tokenCost = estimateTokensFromValue(args);
    requestTokensEst = tokenCost;
    const namespaceTokenOk = consumeNamespaceTokenBudget(namespace, tokenCost, now);
    if (!namespaceRpsOk || !namespaceTokenOk) {
      const quotaError = namespaceQuotaError(namespace, {
        request_tokens_est: tokenCost,
        quota_scope: !namespaceRpsOk ? 'request_rate' : 'request_tokens',
      });
      if (NAMESPACE_QUOTA_MODE === 'enforce') {
        return { allowed: false, response: quotaError };
      }
      warnings.push(`[namespace_quota_warn] ${quotaError.error}`);
    }
  }

  if (shouldBypassAuth(toolName)) {
    const registerAgentId = typeof args.id === 'string' && args.id.trim().length > 0 ? args.id.trim() : agentId;
    if (REGISTER_TOKEN) {
      const registerAuth = validateRegisterToken(REGISTER_TOKEN, args);
      if (!registerAuth.ok) {
        const status = registerAuth.status === 'invalid' ? 'invalid' : 'missing';
        recordAuthEvent(registerAgentId, toolName, status);
        return {
          allowed: false,
          response: {
            success: false,
            error_code: registerAuth.error_code,
            error: registerAuth.error,
            register_auth: 'required',
          },
        };
      }
      recordAuthEvent(registerAgentId, toolName, 'valid');
    } else {
      recordAuthEvent(registerAgentId, toolName, 'skipped');
    }
    return allow();
  }

  if (!agentId) {
    recordAuthEvent(null, toolName, 'missing');
    const warning = 'Agent identity is missing. This will fail once auth_mode=enforce.';
    if (AUTH_MODE === 'enforce') {
      return {
        allowed: false,
        response: {
          success: false,
          error_code: 'AUTH_AGENT_ID_REQUIRED',
          error: 'agent_id/from_agent/created_by/requesting_agent is required in enforce mode',
          auth_mode: AUTH_MODE,
        },
      };
    }
    if (AUTH_MODE === 'warn') {
      warnings.push(warning);
      return allow();
    }
    return allow();
  }

  const hasToken = typeof authToken === 'string' && authToken.length > 0;
  const valid = hasToken ? validateAgentToken(agentId, authToken as string) : false;
  const status = valid ? 'valid' : (hasToken ? 'invalid' : 'missing');
  recordAuthEvent(agentId, toolName, status);

  if (AUTH_MODE === 'enforce' && !valid) {
    return {
      allowed: false,
      response: {
        success: false,
        error_code: hasToken ? 'AUTH_TOKEN_INVALID' : 'AUTH_TOKEN_REQUIRED',
        error: hasToken
          ? 'Invalid auth_token for this agent'
          : 'auth_token is required in enforce mode',
        auth_mode: AUTH_MODE,
      },
    };
  }

  if (AUTH_MODE === 'warn' && !valid) {
    const warning = hasToken
      ? 'Auth token is invalid (warn mode). This will fail once auth_mode=enforce.'
      : 'Auth token missing (warn mode). This will fail once auth_mode=enforce.';
    warnings.push(warning);
    return allow();
  }

  return allow();
}

function mergeResponseMetadata(
  result: unknown,
  warnings: string[],
  metadata: Record<string, unknown>,
) {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const responseObject = result as Record<string, unknown>;
    const existingWarnings = Array.isArray(responseObject.warnings)
      ? responseObject.warnings as unknown[]
      : (typeof responseObject.warning === 'string' ? [responseObject.warning] : []);
    const merged: Record<string, unknown> = {
      ...responseObject,
      ...metadata,
    };
    if (warnings.length > 0) {
      merged.warnings = [...existingWarnings, ...warnings];
    }
    return merged;
  }
  if (warnings.length > 0 || Object.keys(metadata).length > 0) {
    return {
      success: true,
      result,
      ...metadata,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
  return result;
}

function registerTools(server: McpServer) {
  // Initialize DB on startup
  getDb();
  configureArtifactTicketIssuer((args) => issueArtifactTicket(args));

  const guardedTool = (toolName: string, handler: (args: Record<string, unknown>) => unknown | Promise<unknown>) => {
    return async (args: Record<string, unknown>) => {
      const guard = guardToolCall(toolName, args || {});
      if (!guard.allowed) {
        return mcpTextResponse(guard.response);
      }
      const result = await handler(args || {});
      const warnings = [...(guard.warnings || [])];
      const metadata: Record<string, unknown> = {};

      if (NAMESPACE_QUOTA_MODE !== 'off' && guard.namespace) {
        const responseTokensEst = estimateTokensFromValue(result);
        const responseTokenOk = consumeNamespaceTokenBudget(guard.namespace, responseTokensEst, Date.now());
        metadata.token_accounting = {
          namespace: guard.namespace,
          quota_mode: NAMESPACE_QUOTA_MODE,
          request_tokens_est: guard.request_tokens_est,
          response_tokens_est: responseTokensEst,
        };
        if (!responseTokenOk) {
          const quotaError = namespaceQuotaError(guard.namespace, {
            quota_scope: 'response_tokens',
            request_tokens_est: guard.request_tokens_est,
            response_tokens_est: responseTokensEst,
            response_omitted: NAMESPACE_QUOTA_MODE === 'enforce',
            tool: toolName,
          });
          if (NAMESPACE_QUOTA_MODE === 'enforce' && canOmitResponseForQuota(toolName)) {
            return mcpTextResponse(quotaError);
          }
          const quotaWarning = NAMESPACE_QUOTA_MODE === 'enforce'
            ? 'namespace_quota_enforce_deferred'
            : 'namespace_quota_warn';
          warnings.push(`[${quotaWarning}] ${quotaError.error} response_tokens_est=${responseTokensEst}`);
        }
      }

      if (warnings.length > 0) {
        metadata.auth_mode = AUTH_MODE;
      }

      return mcpTextResponse(mergeResponseMetadata(result, warnings, metadata));
    };
  };

  // --- Agent tools ---

  server.tool(
    'register_agent',
    agentTools.register_agent.description,
    {
      id: z.string().describe('Unique agent identifier'),
      name: z.string().describe('Human-readable agent name'),
      type: z.string().describe('Agent type (e.g. claude, codex, custom)'),
      register_token: z.string().optional().describe('Registration secret required when MCP_HUB_REGISTER_TOKEN is configured'),
      capabilities: z.string().optional().describe('Comma-separated list of capabilities'),
      client_capabilities: z.object({
        response_modes: z.array(z.enum(['full', 'compact', 'tiny', 'nano'])).optional(),
        blob_resolve: z.boolean().optional(),
        artifact_tickets: z.boolean().optional(),
        snapshot_reads: z.boolean().optional(),
        push_transports: z.array(z.enum(['wait_for_updates', 'sse_events', 'websocket'])).optional(),
      }).optional().describe('Client feature declaration for capability negotiation'),
      onboarding_mode: z.enum(['full', 'compact', 'none']).optional().describe('Optional onboarding detail override. Server default: new persistent=full, new ephemeral=compact, re-register=none (configurable via env).'),
      role: z.enum(['orchestrator', 'reviewer', 'assistant', 'worker']).optional().describe('Coordination role for tailored onboarding guidance (default worker)'),
      lifecycle: z.enum(['persistent', 'ephemeral']).optional().describe('Agent lifecycle class (default persistent; ephemeral recommended for short-lived swarm workers)'),
      runtime_profile: z.object({
        mode: z.enum(['repo', 'isolated', 'unknown']).optional(),
        cwd: z.string().optional(),
        has_git: z.boolean().optional(),
        file_count: z.number().optional(),
        empty_dir: z.boolean().optional(),
        source: z.enum(['client_auto', 'client_declared', 'server_inferred']).optional(),
        detected_at: z.number().optional(),
        notes: z.string().optional(),
        model: runtimeModelProfileSchema.describe('Optional model identity/capability profile for model-aware orchestration'),
      }).optional().describe('Optional runtime profile used for execution-mode task routing'),
    },
    guardedTool('register_agent', (args) => handleRegisterAgent(args as any))
  );

  server.tool(
    'update_runtime_profile',
    agentTools.update_runtime_profile.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      runtime_profile: z.object({
        mode: z.enum(['repo', 'isolated', 'unknown']).optional(),
        cwd: z.string().optional(),
        has_git: z.boolean().optional(),
        file_count: z.number().optional(),
        empty_dir: z.boolean().optional(),
        source: z.enum(['client_auto', 'client_declared', 'server_inferred']).optional(),
        detected_at: z.number().optional(),
        notes: z.string().optional(),
        model: runtimeModelProfileSchema.describe('Optional model identity/capability profile for model-aware orchestration'),
      }).describe('Current runtime profile'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('update_runtime_profile', (args) => handleUpdateRuntimeProfile(args as any))
  );

  server.tool(
    'list_agents',
    agentTools.list_agents.description,
    {
      agent_id: z.string().optional().describe('Your agent ID (for heartbeat)'),
      limit: z.number().optional().describe('Max rows to return (default 100)'),
      offset: z.number().optional().describe('Row offset for pagination (default 0)'),
      response_mode: z.enum(['full', 'compact', 'summary']).optional().describe('compact trims fields, summary returns runtime/model aggregate counts'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('list_agents', (args) => handleListAgents(args as any))
  );

  server.tool(
    'suggest_agents',
    agentTools.suggest_agents.description,
    {
      requesting_agent: z.string().optional().describe('Your agent ID (for heartbeat/activity)'),
      task_type: z.string().optional().describe('Desired task type, e.g. coding, review, research, planning, synthesis'),
      required_strengths: z.array(z.string()).optional().describe('Model strengths required or preferred for this task'),
      preferred_provider: z.string().optional().describe('Preferred model provider/runtime, e.g. codex, claude, custom'),
      preferred_family: z.string().optional().describe('Preferred model family'),
      execution_mode: z.enum(['any', 'repo', 'isolated']).optional().describe('Required workspace execution profile'),
      cost_tier: z.enum(['low', 'medium', 'high', 'unknown']).optional().describe('Preferred model cost tier'),
      latency_tier: z.enum(['low', 'medium', 'high', 'unknown']).optional().describe('Preferred model latency tier'),
      require_online: z.boolean().optional().describe('Only include agents seen online in the last 5 minutes (default true)'),
      include_requesting_agent: z.boolean().optional().describe('Allow the requesting agent to be returned (default false)'),
      exclude_agent_ids: z.array(z.string()).optional().describe('Additional agent IDs to exclude from suggestions'),
      limit: z.number().optional().describe('Max suggestions to return (default 10, max 50)'),
      response_mode: z.enum(['compact', 'tiny', 'nano']).optional().describe('compact includes reasons; tiny/nano reduce tokens'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('suggest_agents', (args) => handleSuggestAgents(args as any))
  );

  server.tool(
    'get_onboarding',
    agentTools.get_onboarding.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      mode: z.enum(['full', 'compact', 'none']).optional().describe('Onboarding detail level (default full)'),
      role: z.enum(['orchestrator', 'reviewer', 'assistant', 'worker']).optional().describe('Optional role override for tailored guidance'),
      runtime_mode: z.enum(['repo', 'isolated', 'unknown']).optional().describe('Optional runtime mode for tailored guidance'),
      empty_dir: z.boolean().optional().describe('Optional workspace-empty flag used in isolated guidance'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('get_onboarding', (args) => handleGetOnboarding(args as any))
  );

  // --- Message tools ---

  server.tool(
    'send_message',
    messageTools.send_message.description,
    {
      from_agent: z.string().describe('Your agent ID'),
      to_agent: z.string().optional().describe('Target agent ID (omit for broadcast)'),
      content: z.string().describe('Message content'),
      metadata: z.string().optional().describe('JSON metadata string'),
      trace_id: z.string().optional().describe('Optional trace identifier for cross-tool diagnostics'),
      span_id: z.string().optional().describe('Optional span identifier for this message emission'),
      compression_mode: z.enum(['none', 'whitespace', 'auto']).optional().describe('Optional token-saving compression mode (default auto)'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('send_message', (args) => handleSendMessage(args as any))
  );

  server.tool(
    'send_blob_message',
    messageTools.send_blob_message.description,
    {
      from_agent: z.string().describe('Your agent ID'),
      to_agent: z.string().optional().describe('Target agent ID (omit for broadcast)'),
      payload: z.string().describe('Payload text or JSON string to store and reference'),
      metadata: z.string().optional().describe('JSON metadata string'),
      trace_id: z.string().optional().describe('Optional trace identifier for cross-tool diagnostics'),
      span_id: z.string().optional().describe('Optional span identifier for this message emission'),
      compression_mode: z.enum(['none', 'json', 'whitespace', 'auto', 'lossless_auto']).optional().describe('Compression mode before hashing/storage (lossless_auto is strict and reversible)'),
      hash_truncate: z.number().optional().describe('Optional short hash length in response (8..64)'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('send_blob_message', (args) => handleSendBlobMessage(args as any))
  );

  server.tool(
    'read_messages',
    messageTools.read_messages.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      from: z.string().optional().describe('Filter by sender agent ID'),
      unread_only: z.boolean().optional().describe('Only return unread messages'),
      limit: z.number().optional().describe('Max number of messages to return (default 50, max 200)'),
      offset: z.number().optional().describe('Row offset for pagination (default 0)'),
      since_ts: z.number().optional().describe('Delta mode: return only messages newer than this timestamp (ms epoch)'),
      cursor: z.string().optional().describe('Delta cursor "<created_at>:<id>" from previous read_messages response'),
      response_mode: z.enum(['full', 'compact', 'tiny', 'nano']).optional().describe('compact returns previews; tiny returns digests/sizes; nano uses short keys for routing loops'),
      polling: z.boolean().optional().describe('Mark this call as polling-cycle read; full mode is forbidden when polling=true'),
      resolve_blob_refs: z.boolean().optional().describe('Resolve CAEP blob-ref envelopes into payloads'),
      mark_read: z.boolean().optional().describe('If false, visible messages are not marked read. Default true.'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('read_messages', (args) => handleReadMessages(args as any))
  );

  server.tool(
    'start_thread',
    threadTools.start_thread.description,
    {
      from_agent: z.string().describe('Your agent ID'),
      to_agent: z.string().optional().describe('Optional target agent; omit for broadcast thread'),
      title: z.string().describe('Thread title'),
      content: z.string().describe('Initial message content'),
      thread_id: z.string().optional().describe('Optional stable thread id; generated if omitted'),
      idempotency_key: z.string().optional().describe('Optional idempotency key'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('start_thread', (args) => handleStartThread(args as any))
  );

  server.tool(
    'reply_thread',
    threadTools.reply_thread.description,
    {
      from_agent: z.string().describe('Your agent ID'),
      thread_id: z.string().describe('Thread id returned by start_thread'),
      content: z.string().describe('Reply content'),
      to_agent: z.string().optional().describe('Optional target agent; omit for broadcast reply'),
      parent_message_id: z.number().optional().describe('Optional parent message id'),
      role: z.string().optional().describe('Optional role label, e.g. hypothesis/review/decision'),
      idempotency_key: z.string().optional().describe('Optional idempotency key'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('reply_thread', (args) => handleReplyThread(args as any))
  );

  server.tool(
    'read_thread',
    threadTools.read_thread.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      thread_id: z.string().describe('Thread id'),
      limit: z.number().optional().describe('Max messages'),
      response_mode: z.enum(['compact', 'tiny', 'nano']).optional().describe('Response verbosity'),
      after_message_id: z.number().optional().describe('Only return thread messages with id greater than this cursor'),
      before_message_id: z.number().optional().describe('Only return thread messages with id lower than this cursor'),
      order: z.enum(['latest', 'oldest']).optional().describe('Default latest returns newest tail in chronological output order'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('read_thread', (args) => handleReadThread(args as any))
  );

  server.tool(
    'search_hub',
    searchTools.search_hub.description,
    {
      agent_id: z.string().describe('Your agent ID; used for message/artifact visibility and heartbeat'),
      q: z.string().describe('Text query; tokens are matched case-insensitively'),
      scopes: z.array(z.enum(['messages', 'tasks', 'context', 'activity', 'artifacts', 'consensus'])).optional().describe('Optional sources to search; defaults to all'),
      namespace: z.string().optional().describe('Optional namespace filter for tasks/context/artifacts'),
      from_agent: z.string().optional().describe('Optional sender filter for message search'),
      context_agent_id: z.string().optional().describe('Optional context owner filter'),
      context_key: z.string().optional().describe('Optional exact context key filter'),
      task_status: z.enum(['pending', 'in_progress', 'done', 'blocked']).optional().describe('Optional task status filter'),
      task_assigned_to: z.string().optional().describe('Optional task assignee filter'),
      activity_agent_id: z.string().optional().describe('Optional activity owner filter'),
      since_ts: z.number().optional().describe('Optional lower timestamp bound. Messages/activity/consensus use created_at; tasks/context/artifacts use updated_at.'),
      limit: z.number().optional().describe('Max results to return (default 20, max 100)'),
      preview_chars: z.number().optional().describe('Preview chars per compact/nano result (default 180, max 500)'),
      response_mode: z.enum(['compact', 'tiny', 'nano']).optional().describe('compact includes previews; tiny returns refs/digests; nano uses shortest keys'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('search_hub', (args) => handleSearchHub(args as any))
  );

  server.tool(
    'fetch_hub_refs',
    refTools.fetch_hub_refs.description,
    {
      agent_id: z.string().describe('Your agent ID; used for message/artifact visibility and heartbeat'),
      refs: z.object({
        messages: z.array(z.number()).optional().describe('Message IDs'),
        tasks: z.array(z.number()).optional().describe('Task IDs'),
        context: z.array(z.number()).optional().describe('Context row IDs'),
        activity: z.array(z.number()).optional().describe('Activity log IDs'),
        artifacts: z.array(z.string()).optional().describe('Artifact IDs'),
        consensus: z.array(z.number()).optional().describe('Consensus decision IDs'),
      }).optional().describe('Refs to hydrate, grouped by source'),
      response_mode: z.enum(['compact', 'tiny', 'nano', 'full']).optional().describe('compact previews by default; full returns full stored rows for visible refs'),
      preview_chars: z.number().optional().describe('Preview chars for compact rows'),
      mark_messages_read: z.boolean().optional().describe('If true, mark fetched visible messages as read. Default false.'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('fetch_hub_refs', (args) => handleFetchHubRefs(args as any))
  );

  server.tool(
    'save_filter',
    filterTools.save_filter.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      name: z.string().describe('Unique filter name for this agent'),
      filter: z.record(z.unknown()).describe('Filter JSON. Use {kind:"search", q, scopes...} or {kind:"event_deltas", streams...}'),
      namespace: z.string().optional().describe('Optional namespace/tag for grouping saved filters'),
      cursor: z.string().optional().describe('Optional initial event cursor for event_deltas filters'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('save_filter', (args) => handleSaveFilter(args as any))
  );

  server.tool(
    'list_filters',
    filterTools.list_filters.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      namespace: z.string().optional().describe('Optional namespace/tag filter'),
      limit: z.number().optional().describe('Max rows to return'),
      offset: z.number().optional().describe('Row offset'),
      response_mode: z.enum(['compact', 'tiny', 'nano']).optional().describe('Response verbosity'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('list_filters', (args) => handleListFilters(args as any))
  );

  server.tool(
    'read_filter_feed',
    filterTools.read_filter_feed.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      filter_id: z.number().optional().describe('Saved filter ID'),
      name: z.string().optional().describe('Saved filter name if filter_id is omitted'),
      cursor: z.string().optional().describe('Optional cursor override for event_deltas filters'),
      advance_cursor: z.boolean().optional().describe('If true, persist returned cursor on the saved filter'),
      response_mode: z.enum(['compact', 'tiny', 'nano']).optional().describe('Response verbosity override'),
      limit: z.number().optional().describe('Max feed items/events'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('read_filter_feed', (args) => handleReadFilterFeed(args as any))
  );

  server.tool(
    'delete_filter',
    filterTools.delete_filter.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      filter_id: z.number().optional().describe('Saved filter ID'),
      name: z.string().optional().describe('Saved filter name if filter_id is omitted'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('delete_filter', (args) => handleDeleteFilter(args as any))
  );

  server.tool(
    'read_signal_feed',
    signalTools.read_signal_feed.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      sources: z.array(z.enum(['messages', 'tasks', 'artifacts', 'slo'])).optional().describe('Optional feed sources; defaults to all'),
      limit: z.number().optional().describe('Max items to return (default 50, max 200)'),
      response_mode: z.enum(['compact', 'tiny', 'nano']).optional().describe('Response verbosity'),
      include_self: z.boolean().optional().describe('If true, include your own broadcast messages; default false reduces self-noise'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('read_signal_feed', (args) => handleReadSignalFeed(args as any))
  );

  server.tool(
    'ack_feed_items',
    signalTools.ack_feed_items.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      refs: z.object({
        messages: z.array(z.union([z.string(), z.number()])).optional(),
        tasks: z.array(z.union([z.string(), z.number()])).optional(),
        artifacts: z.array(z.union([z.string(), z.number()])).optional(),
        slo: z.array(z.union([z.string(), z.number()])).optional(),
      }).optional().describe('Refs grouped by source: messages/tasks/artifacts/slo'),
      mark_messages_read: z.boolean().optional().describe('If true, message refs are also marked read'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('ack_feed_items', (args) => handleAckFeedItems(args as any))
  );

  server.tool(
    'get_hub_digest',
    digestTools.get_hub_digest.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      sections: z.array(z.enum(['signals', 'events', 'tasks', 'context', 'activity', 'artifacts', 'slo', 'memory', 'agents'])).optional().describe('Optional digest sections; defaults to all'),
      streams: z.array(z.enum(['messages', 'tasks', 'context', 'activity', 'artifacts', 'consensus'])).optional().describe('Event streams used by the events section'),
      cursor: z.string().optional().describe('Event cursor for the events section ("e:<id>"). Omit to start at current edge.'),
      namespace: z.string().optional().describe('Optional namespace for tasks/context/artifacts sections'),
      memory_namespace: z.string().optional().describe('Optional namespace for shared memory section'),
      context_agent_id: z.string().optional().describe('Optional context owner; defaults to agent_id'),
      limit_per_source: z.number().optional().describe('Bound each section (default 5, max 50)'),
      response_mode: z.enum(['compact', 'tiny', 'nano']).optional().describe('Response verbosity'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('get_hub_digest', (args) => handleGetHubDigest(args as any))
  );

  server.tool(
    'write_memory',
    memoryTools.write_memory.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      key: z.string().describe('Stable memory key; normalized under memory:<key>'),
      text: z.string().describe('Memory text'),
      namespace: z.string().optional().describe('Memory namespace (default memory)'),
      tags: z.array(z.string()).optional().describe('Optional tags'),
      importance: z.number().optional().describe('Importance 0..1 for digest ordering'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('write_memory', (args) => handleWriteMemory(args as any))
  );

  server.tool(
    'search_memory',
    memoryTools.search_memory.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      q: z.string().optional().describe('Optional text query'),
      namespace: z.string().optional().describe('Optional namespace filter'),
      tags: z.array(z.string()).optional().describe('Optional tag filters'),
      limit: z.number().optional().describe('Max memories'),
      response_mode: z.enum(['compact', 'tiny', 'nano']).optional().describe('Response verbosity'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('search_memory', (args) => handleSearchMemory(args as any))
  );

  server.tool(
    'get_memory_digest',
    memoryTools.get_memory_digest.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      namespace: z.string().optional().describe('Optional namespace filter'),
      tags: z.array(z.string()).optional().describe('Optional tag filters'),
      key_prefix: z.string().optional().describe('Optional memory key prefix filter'),
      updated_by: z.string().optional().describe('Optional source agent filter'),
      limit: z.number().optional().describe('Max memories'),
      response_mode: z.enum(['compact', 'tiny', 'nano']).optional().describe('Response verbosity'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('get_memory_digest', (args) => handleGetMemoryDigest(args as any))
  );

  server.tool(
    'get_trace_timeline',
    traceTools.get_trace_timeline.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      trace_id: z.string().describe('Trace identifier to inspect'),
      limit: z.number().optional().describe('Max timeline items'),
      response_mode: z.enum(['compact', 'tiny', 'nano']).optional().describe('Response verbosity'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('get_trace_timeline', (args) => handleGetTraceTimeline(args as any))
  );

  // --- Task tools ---

  server.tool(
    'create_task',
    taskTools.create_task.description,
    {
      title: z.string().describe('Task title'),
      description: z.string().optional().describe('Task description'),
      created_by: z.string().describe('Your agent ID'),
      assigned_to: z.string().optional().describe('Agent ID to assign to'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Task priority'),
      namespace: z.string().optional().describe('Task namespace/tag (default "default")'),
      execution_mode: z.enum(['any', 'repo', 'isolated']).optional().describe('Execution profile required by this task (default any)'),
      consistency_mode: z.enum(['auto', 'cheap', 'strict']).optional().describe('Consistency mode for completion gates (auto=critical->strict, otherwise default)'),
      trace_id: z.string().optional().describe('Optional trace identifier for cross-tool diagnostics'),
      span_id: z.string().optional().describe('Optional span identifier for task creation event'),
      depends_on: z.array(z.number()).optional().describe('Optional dependency task IDs that must be done first'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('create_task', (args) => handleCreateTask(args as any))
  );

  server.tool(
    'update_task',
    taskTools.update_task.description,
    {
      id: z.number().describe('Task ID'),
      agent_id: z.string().describe('Your agent ID'),
      status: z.enum(['pending', 'in_progress', 'done', 'blocked']).optional().describe('New status'),
      assigned_to: z.string().optional().describe('Reassign to agent ID'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('New priority'),
      namespace: z.string().optional().describe('Namespace/tag for task'),
      execution_mode: z.enum(['any', 'repo', 'isolated']).optional().describe('Update required execution profile for this task'),
      consistency_mode: z.enum(['cheap', 'strict']).optional().describe('Override task consistency mode for done gates'),
      trace_id: z.string().optional().describe('Optional trace identifier for cross-tool diagnostics'),
      span_id: z.string().optional().describe('Optional span identifier for this task update event'),
      depends_on: z.array(z.number()).optional().describe('Optional replacement dependency task IDs'),
      confidence: z.number().optional().describe('Confidence score (0..1), required for done transitions'),
      verification_passed: z.boolean().optional().describe('Whether verify-before-done checks passed (required for done)'),
      verified_by: z.string().optional().describe('Independent verifier agent ID (recommended when confidence below threshold)'),
      evidence_refs: z.array(z.string()).optional().describe('Optional evidence references persisted with task update; done transitions require evidence_refs coverage'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('update_task', (args) => handleUpdateTask(args as any))
  );

  server.tool(
    'list_tasks',
    taskTools.list_tasks.description,
    {
      agent_id: z.string().optional().describe('Your agent ID (for heartbeat)'),
      status: z.enum(['pending', 'in_progress', 'done', 'blocked']).optional().describe('Filter by status'),
      assigned_to: z.string().optional().describe('Filter by assigned agent'),
      namespace: z.string().optional().describe('Filter by namespace/tag'),
      execution_mode: z.enum(['any', 'repo', 'isolated']).optional().describe('Filter by required execution profile'),
      ready_only: z.boolean().optional().describe('Only return tasks whose dependencies are fully done'),
      include_dependencies: z.boolean().optional().describe('Include depends_on IDs per task'),
      limit: z.number().optional().describe('Max rows to return (default 100, max 500)'),
      offset: z.number().optional().describe('Row offset for pagination (default 0)'),
      updated_after: z.number().optional().describe('Delta mode: return tasks updated after this timestamp (ms epoch)'),
      cursor: z.string().optional().describe('Delta cursor "<updated_at>:<id>" from previous list_tasks response'),
      response_mode: z.enum(['full', 'compact', 'tiny', 'nano']).optional().describe('compact keeps titles; tiny returns minimal routing fields; nano uses short keys'),
      polling: z.boolean().optional().describe('Mark this call as polling-cycle read; full mode is forbidden when polling=true'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('list_tasks', (args) => handleListTasks(args as any))
  );

  server.tool(
    'suggest_task_agents',
    taskTools.suggest_task_agents.description,
    {
      requesting_agent: z.string().describe('Your agent ID (for heartbeat/activity/auth)'),
      task_id: z.number().describe('Task ID to route'),
      task_type: z.string().optional().describe('Optional explicit task type override'),
      required_strengths: z.array(z.string()).optional().describe('Optional explicit strengths override'),
      preferred_provider: z.string().optional().describe('Preferred model provider/runtime'),
      preferred_family: z.string().optional().describe('Preferred model family'),
      cost_tier: z.enum(['low', 'medium', 'high', 'unknown']).optional().describe('Preferred model cost tier'),
      latency_tier: z.enum(['low', 'medium', 'high', 'unknown']).optional().describe('Preferred model latency tier'),
      require_online: z.boolean().optional().describe('Only include agents seen online in the last 5 minutes (default true)'),
      include_requesting_agent: z.boolean().optional().describe('Allow the requesting agent to be returned (default false)'),
      exclude_agent_ids: z.array(z.string()).optional().describe('Additional agent IDs to exclude from suggestions'),
      limit: z.number().optional().describe('Max suggestions to return (default 10, max 50)'),
      response_mode: z.enum(['compact', 'tiny', 'nano']).optional().describe('compact includes task and reasons; tiny/nano reduce tokens'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('suggest_task_agents', (args) => handleSuggestTaskAgents(args as any))
  );

  server.tool(
    'poll_and_claim',
    taskTools.poll_and_claim.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      lease_seconds: z.number().optional().describe('Optional lease duration in seconds (default 300)'),
      namespace: z.string().optional().describe('Optional namespace/tag filter'),
      include_artifacts: z.boolean().optional().describe('Include tiny task artifact refs in claim response'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('poll_and_claim', (args) => handlePollAndClaim(args as any))
  );

  server.tool(
    'claim_task',
    taskTools.claim_task.description,
    {
      task_id: z.number().describe('Task ID to claim'),
      agent_id: z.string().describe('Your agent ID'),
      lease_seconds: z.number().optional().describe('Lease duration in seconds (30..86400, default 300)'),
      namespace: z.string().optional().describe('Optional namespace/tag guard'),
      include_artifacts: z.boolean().optional().describe('Include tiny task artifact refs in claim response'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('claim_task', (args) => handleClaimTask(args as any))
  );

  server.tool(
    'renew_task_claim',
    taskTools.renew_task_claim.description,
    {
      task_id: z.number().describe('Task ID'),
      agent_id: z.string().describe('Your agent ID'),
      lease_seconds: z.number().optional().describe('New lease duration in seconds (30..86400, default 300)'),
      claim_id: z.string().optional().describe('Optional expected claim ID (recommended for stale-write protection)'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('renew_task_claim', (args) => handleRenewTaskClaim(args as any))
  );

  server.tool(
    'release_task_claim',
    taskTools.release_task_claim.description,
    {
      task_id: z.number().describe('Task ID'),
      agent_id: z.string().describe('Your agent ID'),
      next_status: z.enum(['pending', 'done', 'blocked']).optional().describe('Final status after release (default pending)'),
      claim_id: z.string().optional().describe('Optional expected claim ID (recommended for stale-write protection)'),
      consistency_mode: z.enum(['cheap', 'strict']).optional().describe('Override task consistency mode for done gate evaluation in this release call'),
      confidence: z.number().optional().describe('Confidence score (0..1), required when next_status=done'),
      verification_passed: z.boolean().optional().describe('Whether verify-before-done checks passed (required when next_status=done)'),
      verified_by: z.string().optional().describe('Independent verifier agent ID (recommended when confidence below threshold)'),
      evidence_refs: z.array(z.string()).optional().describe('Optional evidence references persisted with claim release; done transitions require evidence_refs coverage'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('release_task_claim', (args) => handleReleaseTaskClaim(args as any))
  );

  server.tool(
    'list_task_claims',
    taskTools.list_task_claims.description,
    {
      requesting_agent: z.string().optional().describe('Your agent ID (for heartbeat)'),
      agent_id: z.string().optional().describe('Filter by owner agent ID'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('list_task_claims', (args) => handleListTaskClaims(args as any))
  );

  server.tool(
    'delete_task',
    taskTools.delete_task.description,
    {
      id: z.number().describe('Task ID'),
      agent_id: z.string().describe('Your agent ID'),
      archive: z.boolean().optional().describe('Archive before delete (default true)'),
      reason: z.string().optional().describe('Optional reason'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('delete_task', (args) => handleDeleteTask(args as any))
  );

  server.tool(
    'attach_task_artifact',
    taskTools.attach_task_artifact.description,
    {
      task_id: z.number().describe('Task ID'),
      artifact_id: z.string().describe('Artifact ID to attach'),
      agent_id: z.string().describe('Your agent ID'),
      auto_share_assignee: z.boolean().optional().describe('If true (default), grant artifact access to current task assignee'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('attach_task_artifact', (args) => handleAttachTaskArtifact(args as any))
  );

  server.tool(
    'list_task_artifacts',
    taskTools.list_task_artifacts.description,
    {
      task_id: z.number().describe('Task ID'),
      agent_id: z.string().describe('Your agent ID'),
      limit: z.number().optional().describe('Max artifacts to return (default 100, max 500)'),
      offset: z.number().optional().describe('Row offset for pagination (default 0)'),
      response_mode: z.enum(['full', 'compact', 'tiny']).optional().describe('compact/tiny reduce payload size'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('list_task_artifacts', (args) => handleListTaskArtifacts(args as any))
  );

  server.tool(
    'get_task_handoff',
    taskTools.get_task_handoff.description,
    {
      task_id: z.number().describe('Task ID'),
      agent_id: z.string().describe('Your agent ID'),
      response_mode: z.enum(['full', 'compact', 'tiny']).optional().describe('compact/tiny reduce payload size'),
      evidence_limit: z.number().optional().describe('Max evidence refs to include (default 16, max 100)'),
      artifact_limit: z.number().optional().describe('Max artifacts to include (default 32, max 200)'),
      include_downloads: z.boolean().optional().describe('Include one-time artifact download tickets in handoff response'),
      download_ttl_sec: z.number().optional().describe('Optional ticket TTL in seconds when include_downloads=true'),
      only_ready_downloads: z.boolean().optional().describe('If true (default), include tickets only for uploaded artifacts'),
      include_routing_suggestions: z.boolean().optional().describe('If true, include tiny suggest_task_agents output for this task'),
      routing_limit: z.number().optional().describe('Max routing suggestions to include (default 5, max 20)'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('get_task_handoff', (args) => handleGetTaskHandoff(args as any))
  );

  // --- Context tools ---

  server.tool(
    'share_context',
    contextTools.share_context.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      key: z.string().describe('Context key'),
      value: z.string().describe('Context value (can be JSON string; oversized values are rejected)'),
      namespace: z.string().optional().describe('Optional context namespace/tag (default "default")'),
      trace_id: z.string().optional().describe('Optional trace identifier for cross-tool diagnostics'),
      span_id: z.string().optional().describe('Optional span identifier for this context update'),
      compression_mode: z.enum(['none', 'json', 'whitespace', 'auto']).optional().describe('Optional token-saving compression mode (default auto)'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('share_context', (args) => handleShareContext(args as any))
  );

  server.tool(
    'share_blob_context',
    contextTools.share_blob_context.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      key: z.string().describe('Context key'),
      payload: z.string().describe('Payload text or JSON string to store and reference'),
      namespace: z.string().optional().describe('Optional context namespace/tag (default "default")'),
      trace_id: z.string().optional().describe('Optional trace identifier for cross-tool diagnostics'),
      span_id: z.string().optional().describe('Optional span identifier for this context update'),
      compression_mode: z.enum(['none', 'json', 'whitespace', 'auto', 'lossless_auto']).optional().describe('Compression mode before hashing/storage (lossless_auto is strict and reversible)'),
      hash_truncate: z.number().optional().describe('Optional short hash length in response (8..64)'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('share_blob_context', (args) => handleShareBlobContext(args as any))
  );

  server.tool(
    'get_context',
    contextTools.get_context.description,
    {
      requesting_agent: z.string().optional().describe('Your agent ID (for heartbeat)'),
      agent_id: z.string().optional().describe('Filter by agent ID'),
      key: z.string().optional().describe('Filter by key'),
      namespace: z.string().optional().describe('Filter by context namespace/tag'),
      limit: z.number().optional().describe('Max rows to return (default 100, max 500)'),
      offset: z.number().optional().describe('Row offset for pagination (default 0)'),
      updated_after: z.number().optional().describe('Delta mode: return context rows with updated_at > updated_after (ms epoch)'),
      cursor: z.string().optional().describe('Delta cursor "<updated_at>:<id>" from previous get_context response'),
      response_mode: z.enum(['full', 'compact', 'tiny', 'nano', 'summary']).optional().describe('compact shows previews, tiny shows digests/sizes, nano uses short keys, summary returns aggregates'),
      polling: z.boolean().optional().describe('Mark this call as polling-cycle read; full mode is forbidden when polling=true'),
      resolve_blob_refs: z.boolean().optional().describe('Resolve CAEP blob-ref values from protocol blob store'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('get_context', (args) => handleGetContext(args as any))
  );

  // --- Consensus tools ---

  server.tool(
    'resolve_consensus',
    consensusTools.resolve_consensus.description,
    {
      requesting_agent: z.string().describe('Your agent ID'),
      proposal_id: z.string().describe('Identifier for the proposal/conflict being resolved'),
      votes: z.array(z.object({
        agent_id: z.string(),
        decision: z.enum(['accept', 'reject', 'abstain']),
        confidence: z.number().optional(),
      })).optional().describe('Inline votes from agents with optional confidence'),
      votes_blob_hash: z.string().optional().describe('Optional protocol blob hash containing votes JSON (array or {"votes":[...]}), for token-efficient large rounds'),
      votes_blob_ref: z.string().optional().describe('Optional blob-ref envelope string (alternative to votes_blob_hash)'),
      disagreement_threshold: z.number().optional().describe('Escalate to verifier if disagreement ratio exceeds this threshold (default 0.35)'),
      min_non_abstain_votes: z.number().optional().describe('Minimum non-abstain votes needed for immediate decision (default 2)'),
      token_budget_cap: z.number().optional().describe('Optional token cap; if estimated cost exceeds cap, escalates to verifier'),
      dedupe_by_agent: z.boolean().optional().describe('If true (default), keep only latest vote per agent_id'),
      quality_weighting: z.enum(['on', 'off']).optional().describe('Quality-aware vote weighting using historical completion/rollback stats (default on)'),
      response_mode: z.enum(['full', 'compact', 'tiny']).optional().describe('tiny returns only outcome + essential metrics'),
      emit_blob_ref: z.boolean().optional().describe('Deprecated toggle for decision blob emit; prefer emit_blob_ref_policy'),
      emit_blob_ref_policy: z.enum(['never', 'always', 'on_escalate', 'on_conflict']).optional().describe('Policy for emitting decision blob reference'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('resolve_consensus', (args) => handleResolveConsensus(args as any))
  );

  server.tool(
    'resolve_consensus_from_context',
    consensusTools.resolve_consensus_from_context.description,
    {
      requesting_agent: z.string().describe('Your agent ID'),
      proposal_id: z.string().describe('Identifier for the proposal/conflict being resolved'),
      context_id: z.number().optional().describe('Context row id containing votes source'),
      context_agent_id: z.string().optional().describe('Context agent id (used with context_key when context_id is omitted)'),
      context_key: z.string().optional().describe('Context key (used with context_agent_id when context_id is omitted)'),
      disagreement_threshold: z.number().optional().describe('Escalate to verifier if disagreement ratio exceeds this threshold (default 0.35)'),
      min_non_abstain_votes: z.number().optional().describe('Minimum non-abstain votes needed for immediate decision (default 2)'),
      token_budget_cap: z.number().optional().describe('Optional token cap; if estimated cost exceeds cap, escalates to verifier'),
      dedupe_by_agent: z.boolean().optional().describe('If true (default), keep only latest vote per agent_id'),
      quality_weighting: z.enum(['on', 'off']).optional().describe('Quality-aware vote weighting using historical completion/rollback stats (default on)'),
      response_mode: z.enum(['full', 'compact', 'tiny']).optional().describe('tiny returns only outcome + essential metrics'),
      emit_blob_ref: z.boolean().optional().describe('Deprecated toggle for decision blob emit; prefer emit_blob_ref_policy'),
      emit_blob_ref_policy: z.enum(['never', 'always', 'on_escalate', 'on_conflict']).optional().describe('Policy for emitting decision blob reference'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('resolve_consensus_from_context', (args) => handleResolveConsensusFromContext(args as any))
  );

  server.tool(
    'resolve_consensus_from_message',
    consensusTools.resolve_consensus_from_message.description,
    {
      requesting_agent: z.string().describe('Your agent ID'),
      proposal_id: z.string().describe('Identifier for the proposal/conflict being resolved'),
      message_id: z.number().describe('Message id containing votes source (content or metadata)'),
      from_agent: z.string().optional().describe('Optional expected sender guard'),
      disagreement_threshold: z.number().optional().describe('Escalate to verifier if disagreement ratio exceeds this threshold (default 0.35)'),
      min_non_abstain_votes: z.number().optional().describe('Minimum non-abstain votes needed for immediate decision (default 2)'),
      token_budget_cap: z.number().optional().describe('Optional token cap; if estimated cost exceeds cap, escalates to verifier'),
      dedupe_by_agent: z.boolean().optional().describe('If true (default), keep only latest vote per agent_id'),
      quality_weighting: z.enum(['on', 'off']).optional().describe('Quality-aware vote weighting using historical completion/rollback stats (default on)'),
      response_mode: z.enum(['full', 'compact', 'tiny']).optional().describe('tiny returns only outcome + essential metrics'),
      emit_blob_ref: z.boolean().optional().describe('Deprecated toggle for decision blob emit; prefer emit_blob_ref_policy'),
      emit_blob_ref_policy: z.enum(['never', 'always', 'on_escalate', 'on_conflict']).optional().describe('Policy for emitting decision blob reference'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('resolve_consensus_from_message', (args) => handleResolveConsensusFromMessage(args as any))
  );

  server.tool(
    'list_consensus_decisions',
    consensusTools.list_consensus_decisions.description,
    {
      requesting_agent: z.string().optional().describe('Your agent ID'),
      proposal_id: z.string().optional().describe('Filter by proposal ID'),
      limit: z.number().optional().describe('Max rows to return (default 100)'),
      offset: z.number().optional().describe('Row offset for pagination (default 0)'),
      response_mode: z.enum(['full', 'compact', 'tiny']).optional().describe('compact trims stats/reasons, tiny returns only IDs/outcomes'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('list_consensus_decisions', (args) => handleListConsensusDecisions(args as any))
  );

  // --- Compact protocol tools ---

  server.tool(
    'pack_protocol_message',
    protocolTools.pack_protocol_message.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      payload: z.string().describe('Payload text or JSON string'),
      payload_format: z.enum(['json', 'text']).optional().describe('How to interpret payload (default json)'),
      mode: z.enum(['auto', 'json', 'dictionary']).optional().describe('Packing mode (default auto)'),
      auto_min_payload_chars: z.number().optional().describe('Auto-mode only: minimum payload chars before dictionary packing is considered (default env/2048)'),
      auto_min_gain_pct: z.number().optional().describe('Auto-mode only: minimum expected dictionary gain percent (default env/3)'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('pack_protocol_message', (args) => handlePackProtocolMessage(args as any))
  );

  server.tool(
    'unpack_protocol_message',
    protocolTools.unpack_protocol_message.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      packet_json: z.string().describe('CAEP-v1 packet JSON string'),
      response_mode: z.enum(['full', 'compact']).optional().describe('compact mode returns minimal fields'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('unpack_protocol_message', (args) => handleUnpackProtocolMessage(args as any))
  );

  server.tool(
    'hash_payload',
    protocolTools.hash_payload.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      payload: z.string().describe('Payload to hash'),
      normalize_json: z.boolean().optional().describe('Normalize JSON before hashing'),
      truncate: z.number().optional().describe('Optional short hash length (8..64, default 16)'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('hash_payload', (args) => handleHashPayload(args as any))
  );

  server.tool(
    'store_protocol_blob',
    protocolTools.store_protocol_blob.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      payload: z.string().describe('Payload text or JSON string'),
      compression_mode: z.enum(['none', 'json', 'whitespace', 'auto']).optional().describe('Optional compression mode before blob hashing/storage'),
      hash_truncate: z.number().optional().describe('Optional short hash length in response (8..64)'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('store_protocol_blob', (args) => handleStoreProtocolBlob(args as any))
  );

  server.tool(
    'get_protocol_blob',
    protocolTools.get_protocol_blob.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      hash: z.string().describe('Full blob hash'),
      response_mode: z.enum(['full', 'compact']).optional().describe('compact mode avoids returning full blob payload'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('get_protocol_blob', (args) => handleGetProtocolBlob(args as any))
  );

  server.tool(
    'list_protocol_blobs',
    protocolTools.list_protocol_blobs.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      limit: z.number().optional().describe('Maximum rows to return (default 100, max 1000)'),
      offset: z.number().optional().describe('Row offset for pagination (default 0)'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('list_protocol_blobs', (args) => handleListProtocolBlobs(args as any))
  );

  // --- Artifact side-channel tools ---

  server.tool(
    'create_artifact_upload',
    artifactTools.create_artifact_upload.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      name: z.string().describe('Artifact file name'),
      mime_type: z.string().optional().describe('Optional MIME type (default application/octet-stream)'),
      namespace: z.string().optional().describe('Optional artifact namespace/tag'),
      summary: z.string().optional().describe('Optional summary for reviewer/orchestrator'),
      ttl_sec: z.number().optional().describe('Upload ticket TTL in seconds'),
      retention_sec: z.number().optional().describe('Artifact retention time in seconds'),
      max_bytes: z.number().optional().describe('Upload size cap in bytes (server max applies)'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('create_artifact_upload', (args) => handleCreateArtifactUpload(args as any))
  );

  server.tool(
    'create_artifact_download',
    artifactTools.create_artifact_download.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      artifact_id: z.string().describe('Artifact ID to download'),
      ttl_sec: z.number().optional().describe('Download ticket TTL in seconds'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('create_artifact_download', (args) => handleCreateArtifactDownload(args as any))
  );

  server.tool(
    'create_task_artifact_downloads',
    artifactTools.create_task_artifact_downloads.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      task_id: z.number().describe('Task ID with attached artifacts'),
      ttl_sec: z.number().optional().describe('Optional download ticket TTL in seconds'),
      only_ready: z.boolean().optional().describe('If true (default), include only uploaded/ready artifacts'),
      limit: z.number().optional().describe('Optional max number of attached artifacts to scan for ticket emission'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('create_task_artifact_downloads', (args) => handleCreateTaskArtifactDownloads(args as any))
  );

  server.tool(
    'share_artifact',
    artifactTools.share_artifact.description,
    {
      from_agent: z.string().describe('Your agent ID'),
      artifact_id: z.string().describe('Artifact ID'),
      to_agent: z.string().optional().describe('Target agent ID (omit for broadcast share)'),
      task_id: z.number().optional().describe('Optional task ID to bind this artifact to'),
      auto_share_assignee: z.boolean().optional().describe('If task_id is set, auto-share artifact to current task assignee (default true)'),
      note: z.string().optional().describe('Optional short note attached to notification'),
      notify: z.boolean().optional().describe('If false, only grant access without message notification'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('share_artifact', (args) => handleShareArtifact(args as any))
  );

  server.tool(
    'list_artifacts',
    artifactTools.list_artifacts.description,
    {
      agent_id: z.string().describe('Your agent ID'),
      created_by: z.string().optional().describe('Optional filter by owner agent'),
      namespace: z.string().optional().describe('Optional namespace/tag filter'),
      limit: z.number().optional().describe('Max rows to return (default 100)'),
      offset: z.number().optional().describe('Row offset for pagination (default 0)'),
      response_mode: z.enum(['full', 'compact', 'tiny']).optional().describe('compact trims fields, tiny returns routing essentials'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('list_artifacts', (args) => handleListArtifacts(args as any))
  );

  // --- Activity tools ---

  server.tool(
    'get_activity_log',
    activityTools.get_activity_log.description,
    {
      requesting_agent: z.string().optional().describe('Your agent ID (for heartbeat)'),
      agent_id: z.string().optional().describe('Filter log by agent ID'),
      limit: z.number().optional().describe('Max entries to return (default 50)'),
      offset: z.number().optional().describe('Row offset for pagination (default 0)'),
      response_mode: z.enum(['full', 'compact', 'summary']).optional().describe('compact trims details fields, summary returns aggregates'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('get_activity_log', (args) => handleGetActivityLog(args as any))
  );

  server.tool(
    'get_kpi_snapshot',
    activityTools.get_kpi_snapshot.description,
    {
      requesting_agent: z.string().optional().describe('Your agent ID (for heartbeat)'),
      windows_sec: z.array(z.number()).optional().describe('Window sizes in seconds (default [60,300,1800])'),
      response_mode: z.enum(['full', 'tiny']).optional().describe('tiny returns queue + latest_window + collective_accuracy only'),
      include_auth: z.boolean().optional().describe('Include auth coverage metrics (30m)'),
      include_slo: z.boolean().optional().describe('Include open SLO alerts'),
      include_top_actions: z.boolean().optional().describe('Include top actions in last 5 minutes (default true)'),
      include_namespace: z.boolean().optional().describe('Include namespace backlog distribution (default true)'),
      include_execution: z.boolean().optional().describe('Include execution_mode backlog distribution (default true)'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('get_kpi_snapshot', (args) => handleGetKpiSnapshot(args as any))
  );

  server.tool(
    'get_transport_snapshot',
    activityTools.get_transport_snapshot.description,
    {
      requesting_agent: z.string().optional().describe('Your agent ID (for heartbeat)'),
      window_sec: z.number().optional().describe('Aggregation window in seconds (default 300)'),
      response_mode: z.enum(['tiny', 'full']).optional().describe('tiny returns compact transport metrics only; full includes latest_window and queue'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('get_transport_snapshot', (args) => handleGetTransportSnapshot(args as any))
  );

  server.tool(
    'wait_for_updates',
    activityTools.wait_for_updates.description,
    {
      requesting_agent: z.string().optional().describe('Your agent ID (for heartbeat)'),
      agent_id: z.string().optional().describe('Target agent scope (defaults to requesting_agent)'),
      streams: z.array(z.enum(['messages', 'tasks', 'context', 'activity', 'artifacts', 'consensus'])).optional().describe('Optional stream filter (default all): messages|tasks|context|activity|artifacts|consensus'),
      cursor: z.string().optional().describe('Event cursor from previous wait_for_updates/read_snapshot response ("e:<id>")'),
      wait_ms: z.number().optional().describe('Wait timeout in ms (server max applies)'),
      poll_interval_ms: z.number().optional().describe('Internal poll interval in ms (default 500)'),
      adaptive_retry: z.boolean().optional().describe('If true (default), timeout responses include adaptive retry_after_ms with backoff+jitter'),
      response_mode: z.enum(['nano', 'micro', 'tiny', 'compact', 'full']).optional().describe('nano is shortest machine mode (c/s/u keys); micro is compact cursor mode; tiny is compact; compact (default) includes elapsed+watermark; full includes full timeout payload'),
      timeout_response: z.enum(['default', 'minimal']).optional().describe('Timeout payload mode: default preserves per-mode fields; minimal returns only changed flag ({changed:false} or {c:0} in nano mode)'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('wait_for_updates', (args) => handleWaitForUpdates(args as any))
  );

  server.tool(
    'read_snapshot',
    activityTools.read_snapshot.description,
    {
      requesting_agent: z.string().optional().describe('Your agent ID (for heartbeat)'),
      agent_id: z.string().optional().describe('Target agent scope for inbox reads (defaults to requesting_agent)'),
      cursor: z.string().optional().describe('Snapshot cursor from previous read_snapshot/wait_for_updates response'),
      response_mode: z.enum(['compact', 'tiny', 'nano']).optional().describe('Use nano for shortest machine-readable payload'),
      message_limit: z.number().optional().describe('Max messages to include'),
      message_from: z.string().optional().describe('Optional sender filter for messages'),
      message_unread_only: z.boolean().optional().describe('If true, include only unread inbox messages'),
      task_limit: z.number().optional().describe('Max tasks to include'),
      task_status: z.enum(['pending', 'in_progress', 'done', 'blocked']).optional().describe('Optional task status filter'),
      task_assigned_to: z.string().optional().describe('Optional assignee filter'),
      task_namespace: z.string().optional().describe('Optional namespace/tag filter'),
      task_execution_mode: z.enum(['any', 'repo', 'isolated']).optional().describe('Optional task execution-mode filter'),
      task_ready_only: z.boolean().optional().describe('If true, include only dependency-ready tasks'),
      include_dependencies: z.boolean().optional().describe('If true, include depends_on IDs in task rows'),
      context_limit: z.number().optional().describe('Max context rows to include'),
      context_agent_id: z.string().optional().describe('Optional context owner filter'),
      context_key: z.string().optional().describe('Optional context key filter'),
      context_namespace: z.string().optional().describe('Optional context namespace filter'),
      resolve_blob_refs: z.boolean().optional().describe('Resolve blob-ref envelopes in messages/context'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('read_snapshot', (args) => handleReadSnapshot(args as any))
  );

  server.tool(
    'read_event_deltas',
    activityTools.read_event_deltas.description,
    {
      requesting_agent: z.string().optional().describe('Your agent ID (for heartbeat)'),
      agent_id: z.string().optional().describe('Target agent scope (defaults to requesting_agent)'),
      cursor: z.string().optional().describe('Event cursor from wait_for_updates/read_snapshot/read_event_deltas ("e:<id>"). Omit to start at current edge; pass e:0 to replay retained events.'),
      streams: z.array(z.enum(['messages', 'tasks', 'context', 'activity', 'artifacts', 'consensus'])).optional().describe('Optional stream filter; defaults to all stream_events sources'),
      limit: z.number().optional().describe('Max events to return (default 100, max 1000)'),
      include_payload: z.boolean().optional().describe('If true in compact mode, include event payload'),
      response_mode: z.enum(['compact', 'tiny', 'nano']).optional().describe('nano returns tuples; tiny returns event refs; compact can include payload metadata'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('read_event_deltas', (args) => handleReadEventDeltas(args as any))
  );

  server.tool(
    'evaluate_slo_alerts',
    activityTools.evaluate_slo_alerts.description,
    {
      requesting_agent: z.string().optional().describe('Your agent ID (for heartbeat/logging)'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('evaluate_slo_alerts', (args) => handleEvaluateSloAlerts(args as any))
  );

  server.tool(
    'list_slo_alerts',
    activityTools.list_slo_alerts.description,
    {
      requesting_agent: z.string().optional().describe('Your agent ID (for heartbeat)'),
      open_only: z.boolean().optional().describe('Only return open alerts'),
      code: z.string().optional().describe('Filter by alert code'),
      limit: z.number().optional().describe('Max rows to return (default 100)'),
      offset: z.number().optional().describe('Row offset for pagination (default 0)'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('list_slo_alerts', (args) => handleListSloAlerts(args as any))
  );

  server.tool(
    'get_auth_coverage',
    activityTools.get_auth_coverage.description,
    {
      requesting_agent: z.string().optional().describe('Your agent ID (for heartbeat)'),
      window_sec: z.number().optional().describe('Coverage window in seconds (default 1800)'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('get_auth_coverage', (args) => handleGetAuthCoverage(args as any))
  );

  server.tool(
    'run_maintenance',
    activityTools.run_maintenance.description,
    {
      requesting_agent: z.string().optional().describe('Your agent ID (for heartbeat/logging)'),
      dry_run: z.boolean().optional().describe('If true, return capability info without executing cleanup'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('run_maintenance', (args) => handleRunMaintenance(args as any))
  );
}

// --- Start server ---

const PORT = parseInt(process.env.MCP_HUB_PORT || '3000');
const HOST = process.env.MCP_HUB_HOST || '0.0.0.0';
const ALLOWED_ORIGINS = parseAllowedOrigins(PORT);

const app = createMcpExpressApp({ host: HOST });
app.use(originGuard(ALLOWED_ORIGINS));
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
const artifactUploadRaw = express.raw({ type: '*/*', limit: ARTIFACT_MAX_BYTES });

app.post('/artifacts/upload/:artifactId', artifactUploadRaw, async (req, res) => {
  try {
    const artifactId = sanitizeArtifactId(req.params.artifactId || '');
    const tokenCandidate = typeof req.query.token === 'string'
      ? req.query.token
      : (typeof req.headers['x-artifact-token'] === 'string' ? req.headers['x-artifact-token'] : '');
    if (!artifactId || !tokenCandidate) {
      res.status(400).json({ success: false, error: 'artifactId and token are required' });
      return;
    }
    const ticket = consumeArtifactTicket(tokenCandidate, 'upload', artifactId);
    if (!ticket) {
      res.status(401).json({ success: false, error: 'Invalid or expired upload ticket' });
      return;
    }

    const body = Buffer.isBuffer(req.body)
      ? req.body
      : (typeof req.body === 'string' ? Buffer.from(req.body) : Buffer.alloc(0));
    if (body.length === 0) {
      res.status(400).json({ success: false, error: 'Empty upload body' });
      return;
    }
    if (body.length > ticket.max_bytes || body.length > ARTIFACT_MAX_BYTES) {
      res.status(413).json({ success: false, error: 'Artifact exceeds size limit' });
      return;
    }

    const artifact = getArtifactById(artifactId);
    if (!artifact) {
      res.status(404).json({ success: false, error: 'Artifact not found' });
      return;
    }
    if (artifact.created_by !== ticket.agent_id) {
      res.status(403).json({ success: false, error: 'Upload ticket owner mismatch' });
      return;
    }

    await fsp.mkdir(ARTIFACTS_DIR, { recursive: true });
    const artifactPath = artifactPathForId(artifactId);
    await fsp.writeFile(artifactPath, body);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const finalized = finalizeArtifactUpload({
      id: artifactId,
      size_bytes: body.length,
      sha256,
      storage_path: artifactPath,
      mime_type: typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : artifact.mime_type,
    });
    if (!finalized) {
      res.status(500).json({ success: false, error: 'Failed to finalize artifact upload' });
      return;
    }
    logActivity(ticket.agent_id, 'artifact_upload_http', `artifact_id=${artifactId} bytes=${finalized.size_bytes}`);
    res.json({
      success: true,
      artifact_id: artifactId,
      size_bytes: finalized.size_bytes,
      sha256: finalized.sha256,
      name: finalized.name,
    });
  } catch (error) {
    console.error('[artifacts/upload] error', error);
    res.status(500).json({ success: false, error: 'artifact_upload_failed' });
  }
});

app.get('/artifacts/download/:artifactId', async (req, res) => {
  try {
    const artifactId = sanitizeArtifactId(req.params.artifactId || '');
    const tokenCandidate = typeof req.query.token === 'string'
      ? req.query.token
      : (typeof req.headers['x-artifact-token'] === 'string' ? req.headers['x-artifact-token'] : '');
    if (!artifactId || !tokenCandidate) {
      res.status(400).json({ success: false, error: 'artifactId and token are required' });
      return;
    }
    const ticket = consumeArtifactTicket(tokenCandidate, 'download', artifactId);
    if (!ticket) {
      res.status(401).json({ success: false, error: 'Invalid or expired download ticket' });
      return;
    }
    const artifact = getArtifactById(artifactId);
    if (!artifact || !artifact.storage_path) {
      res.status(404).json({ success: false, error: 'Artifact not found or unavailable' });
      return;
    }

    const content = await fsp.readFile(artifact.storage_path);
    incrementArtifactAccess(artifactId);
    logActivity(ticket.agent_id, 'artifact_download_http', `artifact_id=${artifactId} bytes=${content.length}`);
    res.setHeader('Content-Type', artifact.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', String(content.length));
    res.setHeader('Content-Disposition', `attachment; filename=\"${artifact.name || `${artifactId}.bin`}\"`);
    res.send(content);
  } catch (error) {
    console.error('[artifacts/download] error', error);
    res.status(500).json({ success: false, error: 'artifact_download_failed' });
  }
});

// Map to track transports by session ID
const transports = new Map<string, StreamableHTTPServerTransport>();
const sessionLastActivity = new Map<string, number>();

function touchSession(sessionId: string | undefined) {
  if (!sessionId) return;
  sessionLastActivity.set(sessionId, Date.now());
}

async function createConnectedTransport() {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    // Improves compatibility with clients that expect JSON response bodies on POST requests.
    enableJsonResponse: true,
  });
  const server = createServer();
  registerTools(server);
  await server.connect(transport);
  return { server, transport };
}

app.post('/mcp', async (req, res) => {
  setServerCapabilityHeaders(res);
  // Be tolerant of clients that only advertise one of the media types.
  // SDK currently requires both values in Accept for POST requests.
  const acceptHeader = Array.isArray(req.headers.accept)
    ? req.headers.accept.join(', ')
    : (req.headers.accept ?? '');
  if (!acceptHeader.includes('application/json') || !acceptHeader.includes('text/event-stream')) {
    const normalizedAccept = 'application/json, text/event-stream';
    req.headers.accept = normalizedAccept;
    upsertRawHeader(req.rawHeaders, 'Accept', normalizedAccept);
  }

  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const requestId = (req.body && typeof req.body === 'object') ? (req.body as { id?: unknown }).id : null;
  const isInitialize = isInitializeMethod(req.body);

  if (sessionId && transports.has(sessionId)) {
    // Existing session
    const transport = transports.get(sessionId)!;
    touchSession(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  if (!isInitialize) {
    if (sessionId && STRICT_SESSION_STATUS) {
      sendUnknownSessionError(res, requestId, 404);
      return;
    }
    const message = sessionId
      ? 'Bad Request: Unknown or expired MCP session. Re-run initialize + notifications/initialized.'
      : 'Bad Request: Server not initialized. Call initialize first, then notifications/initialized.';
    const reason = sessionId ? 'unknown_or_expired_session' : 'server_not_initialized';
    const data = {
      reinitialize_required: true,
      retryable: true,
      reason,
      recovery_sequence: ['initialize', 'notifications/initialized', 'retry_original_request_once'],
      onboarding_hint: 'After register_agent, call get_onboarding and pass auth_token on subsequent tool calls.',
      protocol_version: 'hub-protocol-2026.02',
    };
    res.setHeader('x-mcp-reinit-required', '1');
    res.setHeader('x-mcp-error-reason', reason);
    res.status(400).json(jsonRpcErrorResponse(requestId, -32000, message, data));
    return;
  }

  // New session — create server + transport
  const { server, transport } = await createConnectedTransport();

  transport.onclose = () => {
    const sid = [...transports.entries()].find(([, t]) => t === transport)?.[0];
    if (sid) {
      transports.delete(sid);
      sessionLastActivity.delete(sid);
    }
  };

  await transport.handleRequest(req, res, req.body);

  // Store with the generated session ID
  if (transport.sessionId) {
    transports.set(transport.sessionId, transport);
    touchSession(transport.sessionId);
  }
});

app.get('/mcp', async (req, res) => {
  setServerCapabilityHeaders(res);
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    if (sessionId && STRICT_SESSION_STATUS) {
      sendUnknownSessionError(res, null, 404);
      return;
    }
    res.status(400).json({ error: 'No active session. Send POST /mcp first.' });
    return;
  }
  const transport = transports.get(sessionId)!;
  touchSession(sessionId);
  await transport.handleRequest(req, res, req.body);
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    transports.delete(sessionId);
    sessionLastActivity.delete(sessionId);
  } else {
    if (sessionId && STRICT_SESSION_STATUS) {
      setServerCapabilityHeaders(res);
      sendUnknownSessionError(res, null, 404);
      return;
    }
    res.status(404).json({ error: 'Session not found' });
  }
});

app.get('/events', (req, res) => {
  setServerCapabilityHeaders(res);
  const agentId = typeof req.query.agent_id === 'string' ? req.query.agent_id.trim() : '';
  const bearerToken = extractBearerToken(req);
  const queryAuthToken = typeof req.query.auth_token === 'string' ? req.query.auth_token.trim() : '';
  const authToken = bearerToken;
  const responseMode = typeof req.query.response_mode === 'string' ? req.query.response_mode.trim().toLowerCase() : 'compact';
  const streams = parseEventStreams(req.query.streams as string | string[] | undefined);
  const cursorRaw = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  const parsedStreamCursor = parseStreamEventCursor(cursorRaw);
  const lastEventId = parseLastEventId(req.headers['last-event-id']);
  const pollMs = Number.isFinite(Number(req.query.poll_ms))
    ? Math.max(250, Math.min(10_000, Math.floor(Number(req.query.poll_ms))))
    : EVENT_STREAM_DEFAULT_INTERVAL_MS;

  if (!agentId) {
    res.status(400).json({ success: false, error: 'agent_id is required' });
    return;
  }
  if (cursorRaw && parsedStreamCursor === null) {
    res.status(400).json({ success: false, error: 'Invalid cursor format. Expected event cursor "e:<id>".' });
    return;
  }
  if (queryAuthToken) {
    res.status(401).json({
      success: false,
      error_code: 'QUERY_AUTH_TOKEN_DENIED',
      error: 'auth_token query parameter is disabled; use Authorization: Bearer <token>',
    });
    return;
  }

  const hasToken = authToken.length > 0;
  const authValid = hasToken ? validateAgentToken(agentId, authToken) : false;
  const authStatus = authValid ? 'valid' : (hasToken ? 'invalid' : 'missing');
  recordAuthEvent(agentId, 'events_stream', authStatus);
  if (!authValid) {
    res.status(401).json({
      success: false,
      error_code: hasToken ? 'AUTH_TOKEN_INVALID' : 'AUTH_TOKEN_REQUIRED',
      error: hasToken
        ? 'Invalid Authorization bearer token for this agent'
        : 'Authorization: Bearer <auth.token> is required for /events',
      auth_mode: AUTH_MODE,
      auth_scope: 'events_stream',
    });
    return;
  }

  const agentEventStreams = eventStreamCountsByAgent.get(agentId) || 0;
  if (activeEventStreamCount >= EVENT_STREAM_MAX_CONNECTIONS || agentEventStreams >= EVENT_STREAM_MAX_PER_AGENT) {
    const retryAfterMs = Math.max(1_000, pollMs);
    res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    res.status(429).json({
      success: false,
      error_code: 'EVENT_STREAM_LIMIT_EXCEEDED',
      error: activeEventStreamCount >= EVENT_STREAM_MAX_CONNECTIONS
        ? 'Global /events connection limit exceeded'
        : 'Per-agent /events connection limit exceeded',
      retry_after_ms: retryAfterMs,
      active_connections: activeEventStreamCount,
      active_agent_connections: agentEventStreams,
      max_connections: EVENT_STREAM_MAX_CONNECTIONS,
      max_per_agent: EVENT_STREAM_MAX_PER_AGENT,
    });
    return;
  }

  activeEventStreamCount += 1;
  eventStreamCountsByAgent.set(agentId, agentEventStreams + 1);
  logActivity(agentId, 'events_subscribe', `streams=${streams.join(',')} mode=${responseMode} poll_ms=${pollMs}`, { emit_stream_event: false });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const initialEventId = getStreamEventWatermark({ agent_id: agentId, streams });
  let sinceEventId = lastEventId ?? parsedStreamCursor ?? initialEventId;
  const minEventId = getMinStreamEventId({ agent_id: agentId, streams });
  const cursorStale = sinceEventId > 0 && minEventId > 0 && sinceEventId < minEventId;
  if (cursorStale) {
    sinceEventId = initialEventId;
  }
  let lastHeartbeatAt = Date.now();
  let streamClosed = false;
  let draining = false;
  let drainTimer: NodeJS.Timeout | null = null;
  let timer: NodeJS.Timeout | null = null;

  const cleanup = () => {
    if (streamClosed) return;
    streamClosed = true;
    if (timer) clearInterval(timer);
    if (drainTimer) clearTimeout(drainTimer);
    activeEventStreamCount = Math.max(0, activeEventStreamCount - 1);
    const currentAgentStreams = eventStreamCountsByAgent.get(agentId) || 0;
    if (currentAgentStreams <= 1) {
      eventStreamCountsByAgent.delete(agentId);
    } else {
      eventStreamCountsByAgent.set(agentId, currentAgentStreams - 1);
    }
    logActivity(agentId, 'events_unsubscribe', `streams=${streams.join(',')}`, { emit_stream_event: false });
  };

  const closeStream = (reason: string) => {
    if (streamClosed) return;
    logActivity(agentId, 'events_close', `${reason} streams=${streams.join(',')}`, { emit_stream_event: false });
    cleanup();
    if (!res.destroyed && !res.writableEnded) {
      res.end();
    }
  };

  const writeEvent = (eventName: string, payload: Record<string, unknown>, eventId?: number): boolean => {
    if (streamClosed || res.destroyed || res.writableEnded) {
      closeStream('write_after_close');
      return false;
    }
    if (res.writableLength > EVENT_STREAM_MAX_BUFFER_BYTES) {
      closeStream(`buffer_limit_exceeded bytes=${res.writableLength}`);
      return false;
    }
    const frame = `${Number.isFinite(eventId) ? `id: ${Math.floor(Number(eventId))}\n` : ''}event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    try {
      const canContinue = res.write(frame);
      if (!canContinue && !draining) {
        draining = true;
        drainTimer = setTimeout(() => {
          closeStream('drain_timeout');
        }, EVENT_STREAM_DRAIN_TIMEOUT_MS);
        drainTimer.unref();
        res.once('drain', () => {
          draining = false;
          if (drainTimer) clearTimeout(drainTimer);
          drainTimer = null;
        });
      }
      return canContinue;
    } catch (error) {
      closeStream('write_error');
      return false;
    }
  };

  const helloWritten = writeEvent('hello', {
    success: true,
    mode: responseMode === 'nano' ? 'nano' : 'compact',
    streams,
    cursor: encodeStreamEventCursor(sinceEventId),
    event_id: sinceEventId,
    resume: lastEventId !== null ? 'last-event-id' : (parsedStreamCursor !== null ? 'cursor' : 'edge'),
    cursor_stale: cursorStale || undefined,
    resync_required: cursorStale || undefined,
    resync_hint: cursorStale ? 'read_snapshot' : undefined,
    min_event_id: cursorStale ? minEventId : undefined,
  }, sinceEventId);
  if (!helloWritten && streamClosed) return;

  const emitAvailableEvents = () => {
    if (streamClosed || draining || res.destroyed || res.writableEnded) return false;
    try {
      const events = listStreamEventsAfter({
        agent_id: agentId,
        streams,
        after_id: sinceEventId,
        limit: 100,
      });
      if (events.length > 0) {
        const eventId = events[events.length - 1].id;
        const changedStreams = [...new Set(events.map((event) => event.stream))];
        const cursor = encodeStreamEventCursor(eventId);
        if (responseMode === 'nano') {
          if (!writeEvent('update', {
            c: 1,
            s: changedStreams,
            u: cursor,
            i: eventId,
          }, eventId)) return false;
        } else {
          if (!writeEvent('update', {
            changed: true,
            streams: changedStreams,
            cursor,
            event_id: eventId,
            events: events.map((event) => ({
              id: event.id,
              stream: event.stream,
              op: event.op,
              entity_id: event.entity_id,
              created_at: event.created_at,
            })),
          }, eventId)) return false;
        }
        sinceEventId = eventId;
        lastHeartbeatAt = Date.now();
        return true;
      }

      const now = Date.now();
      if ((now - lastHeartbeatAt) >= EVENT_STREAM_HEARTBEAT_MS) {
        const eventId = Math.max(sinceEventId, getStreamEventWatermark({ agent_id: agentId, streams }));
        const cursor = encodeStreamEventCursor(eventId);
        if (responseMode === 'nano') {
          if (!writeEvent('heartbeat', { c: 0, u: cursor, i: eventId })) return false;
        } else {
          if (!writeEvent('heartbeat', { changed: false, cursor, event_id: eventId })) return false;
        }
        lastHeartbeatAt = now;
      }
    } catch (error) {
      writeEvent('error', { success: false, error: 'event_stream_internal_error' });
      closeStream('event_stream_internal_error');
    }
    return false;
  };

  emitAvailableEvents();

  timer = setInterval(() => {
    emitAvailableEvents();
  }, pollMs);
  timer.unref();

  req.on('close', cleanup);
  req.on('end', cleanup);
  res.on('close', cleanup);
  res.on('error', () => closeStream('response_error'));
});

app.get('/health', (_req, res) => {
  setServerCapabilityHeaders(res);
  res.json({
    status: 'ok',
    sessions: transports.size,
    auth_mode: AUTH_MODE,
    origin_mode: ORIGIN_MODE,
    query_auth_token_mode: 'deny',
    namespace_quota_mode: NAMESPACE_QUOTA_MODE,
    namespace_quota_rps: NAMESPACE_QUOTA_RPS,
    namespace_token_budget_per_min: NAMESPACE_TOKEN_BUDGET_PER_MIN,
    event_stream: {
      endpoint: '/events',
      default_interval_ms: EVENT_STREAM_DEFAULT_INTERVAL_MS,
      heartbeat_ms: EVENT_STREAM_HEARTBEAT_MS,
      active_connections: activeEventStreamCount,
      tracked_agents: eventStreamCountsByAgent.size,
      max_connections: EVENT_STREAM_MAX_CONNECTIONS,
      max_per_agent: EVENT_STREAM_MAX_PER_AGENT,
      max_buffer_bytes: EVENT_STREAM_MAX_BUFFER_BYTES,
      drain_timeout_ms: EVENT_STREAM_DRAIN_TIMEOUT_MS,
    },
    artifact_tickets: artifactTickets.size,
    session_idle_timeout_ms: SESSION_IDLE_TIMEOUT_MS,
    session_gc_enabled: SESSION_GC_ENABLED,
    unknown_session_policy: 'error',
    strict_session_status: STRICT_SESSION_STATUS,
  });
});

setInterval(() => {
  try {
    const expiredTickets = cleanupExpiredArtifactTickets();
    const rateLimitStateCleaned = cleanupRateLimitState();
    const maintenance = runMaintenance();
    if (expiredTickets > 0 || rateLimitStateCleaned > 0 || maintenance.slo.triggered > 0 || maintenance.slo.resolved > 0) {
      console.log(
        `[maintenance] claims=${maintenance.claims_cleaned} artifacts=${maintenance.artifacts_cleaned} stream_events=${maintenance.stream_events_cleaned} tickets_expired=${expiredTickets} rate_limit_state=${rateLimitStateCleaned} archived=${maintenance.tasks_archived} slo_triggered=${maintenance.slo.triggered} slo_resolved=${maintenance.slo.resolved}`
      );
    }
  } catch (error) {
    console.error('[maintenance] error', error);
  }
}, Math.max(1_000, MAINTENANCE_INTERVAL_MS)).unref();

setInterval(() => {
  try {
    if (!SESSION_GC_ENABLED) return;
    const now = Date.now();
    let evicted = 0;
    for (const [sid, transport] of transports.entries()) {
      const last = sessionLastActivity.get(sid) ?? now;
      if (now - last <= SESSION_IDLE_TIMEOUT_MS) continue;
      const maybeClosable = transport as unknown as { close?: () => void | Promise<void> };
      Promise.resolve(maybeClosable.close?.()).catch(() => undefined);
      transports.delete(sid);
      sessionLastActivity.delete(sid);
      evicted += 1;
    }
    if (evicted > 0) {
      console.log(`[session-gc] evicted=${evicted} active=${transports.size} idle_timeout_ms=${SESSION_IDLE_TIMEOUT_LABEL}`);
    }
  } catch (error) {
    console.error('[session-gc] error', error);
  }
}, Math.max(1_000, SESSION_GC_INTERVAL_MS)).unref();

app.listen(PORT, HOST, () => {
  console.log(
    `MCP Agent Hub running at http://${HOST}:${PORT}/mcp (auth_mode=${AUTH_MODE}, unknown_session_policy=error, session_idle_timeout_ms=${SESSION_IDLE_TIMEOUT_LABEL})`
  );
});
