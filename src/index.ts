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
import { agentTools, handleRegisterAgent, handleListAgents, handleGetOnboarding, handleUpdateRuntimeProfile } from './tools/agents.js';
import { messageTools, handleSendMessage, handleSendBlobMessage, handleReadMessages } from './tools/messages.js';
import {
  taskTools,
  handleCreateTask,
  handleUpdateTask,
  handleListTasks,
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
  getUpdateWatermark,
  validateAgentToken,
  recordAuthEvent,
  finalizeArtifactUpload,
  getArtifactById,
  incrementArtifactAccess,
  logActivity,
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
  res.setHeader('x-mcp-hub-capabilities', 'nano,blob_resolve,artifact_tickets,read_snapshot,sse_events,namespace_quotas,adaptive_consistency');
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

type UnknownSessionPolicy = 'error' | 'stateless_fallback';

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
const REQUIRE_AUTH = String(process.env.MCP_HUB_REQUIRE_AUTH || '').toLowerCase() === 'true';
const AUTH_MODE = (() => {
  const configured = String(process.env.MCP_HUB_AUTH_MODE || '').toLowerCase().trim();
  if (configured === 'observe' || configured === 'warn' || configured === 'enforce') return configured;
  return REQUIRE_AUTH ? 'enforce' : 'observe';
})();
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
const UNKNOWN_SESSION_POLICY: UnknownSessionPolicy = (() => {
  const configured = String(process.env.MCP_HUB_UNKNOWN_SESSION_POLICY || '').toLowerCase().trim();
  return configured === 'stateless_fallback' ? 'stateless_fallback' : 'error';
})();
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

type ArtifactTicket = {
  token: string;
  kind: 'upload' | 'download';
  artifact_id: string;
  agent_id: string;
  expires_at: number;
  max_bytes: number;
};

const artifactTickets = new Map<string, ArtifactTicket>();

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

function estimateTokensFromPayload(args: Record<string, unknown>): number {
  try {
    const raw = JSON.stringify(args);
    if (!raw) return 1;
    return Math.max(1, Math.ceil(raw.length / 4));
  } catch {
    return 1;
  }
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

type EventStream = 'messages' | 'tasks' | 'context' | 'activity';

function parseEventStreams(raw: string | string[] | undefined): EventStream[] {
  const values = Array.isArray(raw) ? raw.join(',') : (raw || '');
  const items = values
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  const supported = new Set<EventStream>(['messages', 'tasks', 'context', 'activity']);
  const normalized = items.filter((item): item is EventStream => supported.has(item as EventStream));
  if (normalized.length === 0) return ['messages', 'tasks', 'context', 'activity'];
  return [...new Set(normalized)];
}

function encodeEventCursor(watermark: {
  latest_message_ts: number;
  latest_task_ts: number;
  latest_context_ts: number;
  latest_activity_ts: number;
}): string {
  return [
    watermark.latest_message_ts,
    watermark.latest_task_ts,
    watermark.latest_context_ts,
    watermark.latest_activity_ts,
  ]
    .map((value) => Math.max(0, Math.floor(Number(value) || 0)).toString(36))
    .join('.');
}

function parseEventCursor(cursor?: string): {
  message_since_ts: number;
  task_since_ts: number;
  context_since_ts: number;
  activity_since_ts: number;
} | null {
  if (typeof cursor !== 'string' || cursor.trim().length === 0) return null;
  const parts = cursor.trim().split('.');
  if (parts.length !== 4) return null;
  const values = parts.map((part) => Number.parseInt(part, 36));
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return null;
  return {
    message_since_ts: Math.floor(values[0]),
    task_since_ts: Math.floor(values[1]),
    context_since_ts: Math.floor(values[2]),
    activity_since_ts: Math.floor(values[3]),
  };
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
  | { allowed: true; warnings?: string[] }
  | { allowed: false; response: Record<string, unknown> };

function shouldBypassAuth(toolName: string): boolean {
  return toolName === 'register_agent';
}

function guardToolCall(toolName: string, args: Record<string, unknown>): ToolGuardResult {
  const { agentId, authToken } = extractAgentAuthPayload(args);
  const now = Date.now();
  const warnings: string[] = [];

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
    const namespaceRpsOk = consumeNamespaceRateLimit(namespace, now);
    const tokenCost = estimateTokensFromPayload(args);
    const namespaceTokenOk = consumeNamespaceTokenBudget(namespace, tokenCost, now);
    if (!namespaceRpsOk || !namespaceTokenOk) {
      const quotaError = {
        success: false,
        error_code: 'NAMESPACE_QUOTA_EXCEEDED',
        error: `Namespace quota exceeded for "${namespace}"`,
        namespace,
        quota_mode: NAMESPACE_QUOTA_MODE,
        retry_after_ms: 1000,
      };
      if (NAMESPACE_QUOTA_MODE === 'enforce') {
        return { allowed: false, response: quotaError };
      }
      warnings.push(`[namespace_quota_warn] ${quotaError.error}`);
    }
  }

  if (!agentId || shouldBypassAuth(toolName)) {
    recordAuthEvent(agentId, toolName, 'skipped');
    return warnings.length > 0 ? { allowed: true, warnings } : { allowed: true };
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
    return { allowed: true, warnings };
  }

  return warnings.length > 0 ? { allowed: true, warnings } : { allowed: true };
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
      if (guard.warnings && guard.warnings.length > 0 && result && typeof result === 'object' && !Array.isArray(result)) {
        const responseObject = result as Record<string, unknown>;
        const existingWarnings = Array.isArray(responseObject.warnings)
          ? responseObject.warnings as unknown[]
          : (typeof responseObject.warning === 'string' ? [responseObject.warning] : []);
        return mcpTextResponse({
          ...responseObject,
          warnings: [...existingWarnings, ...guard.warnings],
          auth_mode: AUTH_MODE,
        });
      }
      return mcpTextResponse(result);
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
      response_mode: z.enum(['full', 'compact', 'summary']).optional().describe('compact trims fields, summary returns counts only'),
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('list_agents', (args) => handleListAgents(args as any))
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
      auth_token: z.string().optional().describe('Optional auth token from register_agent'),
    },
    guardedTool('read_messages', (args) => handleReadMessages(args as any))
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
      min_non_abstain_votes: z.number().optional().describe('Minimum non-abstain votes needed for direct decision (default 2)'),
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
      min_non_abstain_votes: z.number().optional().describe('Minimum non-abstain votes needed for direct decision (default 2)'),
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
      min_non_abstain_votes: z.number().optional().describe('Minimum non-abstain votes needed for direct decision (default 2)'),
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
      streams: z.array(z.enum(['messages', 'tasks', 'context', 'activity'])).optional().describe('Optional stream filter (default all): messages|tasks|context|activity'),
      cursor: z.string().optional().describe('Compact cursor from previous wait_for_updates response (<message>.<task>.<context>.<activity> in base36)'),
      message_since_ts: z.number().optional().describe('Last seen message watermark'),
      task_since_ts: z.number().optional().describe('Last seen task watermark'),
      context_since_ts: z.number().optional().describe('Last seen context watermark'),
      activity_since_ts: z.number().optional().describe('Last seen activity watermark'),
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

const app = createMcpExpressApp({ host: HOST });
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

async function createConnectedTransport(options?: { stateless?: boolean }) {
  const stateless = options?.stateless === true;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: stateless ? undefined : () => randomUUID(),
    // Improves compatibility with clients that expect JSON response bodies on POST requests.
    enableJsonResponse: true,
  });
  const server = createServer();
  registerTools(server);
  await server.connect(transport);
  return { server, transport };
}

async function closeConnectedTransport(server: McpServer, transport: StreamableHTTPServerTransport) {
  const maybeClosableTransport = transport as unknown as { close?: () => void | Promise<void> };
  await Promise.allSettled([
    Promise.resolve(maybeClosableTransport.close?.()),
    server.close(),
  ]);
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
    if (sessionId && UNKNOWN_SESSION_POLICY === 'stateless_fallback') {
      // Unknown/expired stateful session: recover transparently using one-shot stateless transport.
      // This avoids mid-task client failures after container restarts or session GC.
      const { server, transport } = await createConnectedTransport({ stateless: true });
      try {
        res.setHeader('x-mcp-session-recovery', 'stateless_fallback');
        await transport.handleRequest(req, res, req.body);
      } finally {
        await closeConnectedTransport(server, transport);
      }
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
  const { server, transport } = await createConnectedTransport({ stateless: false });

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
    res.status(404).json({ error: 'Session not found' });
  }
});

app.get('/events', (req, res) => {
  setServerCapabilityHeaders(res);
  const agentId = typeof req.query.agent_id === 'string' ? req.query.agent_id.trim() : '';
  const authToken = typeof req.query.auth_token === 'string' ? req.query.auth_token.trim() : '';
  const responseMode = typeof req.query.response_mode === 'string' ? req.query.response_mode.trim().toLowerCase() : 'compact';
  const streams = parseEventStreams(req.query.streams as string | string[] | undefined);
  const cursorRaw = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  const parsedCursor = parseEventCursor(cursorRaw);
  const pollMs = Number.isFinite(Number(req.query.poll_ms))
    ? Math.max(250, Math.min(10_000, Math.floor(Number(req.query.poll_ms))))
    : EVENT_STREAM_DEFAULT_INTERVAL_MS;

  if (!agentId) {
    res.status(400).json({ success: false, error: 'agent_id is required' });
    return;
  }
  if (cursorRaw && !parsedCursor) {
    res.status(400).json({ success: false, error: 'Invalid cursor format' });
    return;
  }

  const hasToken = authToken.length > 0;
  const authValid = hasToken ? validateAgentToken(agentId, authToken) : false;
  const authStatus = authValid ? 'valid' : (hasToken ? 'invalid' : 'missing');
  recordAuthEvent(agentId, 'events_stream', authStatus);
  if (AUTH_MODE === 'enforce' && !authValid) {
    res.status(401).json({
      success: false,
      error_code: hasToken ? 'AUTH_TOKEN_INVALID' : 'AUTH_TOKEN_REQUIRED',
      error: hasToken ? 'Invalid auth_token for this agent' : 'auth_token is required in enforce mode',
      auth_mode: AUTH_MODE,
    });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const initialWatermark = getUpdateWatermark(agentId, { streams });
  let since = parsedCursor || {
    message_since_ts: initialWatermark.latest_message_ts,
    task_since_ts: initialWatermark.latest_task_ts,
    context_since_ts: initialWatermark.latest_context_ts,
    activity_since_ts: initialWatermark.latest_activity_ts,
  };
  let lastHeartbeatAt = Date.now();

  const writeEvent = (eventName: string, payload: Record<string, unknown>) => {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const authWarning = (AUTH_MODE === 'warn' && !authValid)
    ? (hasToken
      ? 'Auth token is invalid (warn mode). This will fail once auth_mode=enforce.'
      : 'Auth token missing (warn mode). This will fail once auth_mode=enforce.')
    : null;

  writeEvent('hello', {
    success: true,
    mode: responseMode === 'nano' ? 'nano' : 'compact',
    streams,
    cursor: encodeEventCursor(initialWatermark),
    warning: authWarning || undefined,
  });
  logActivity(agentId, 'events_subscribe', `streams=${streams.join(',')} mode=${responseMode} poll_ms=${pollMs}`);

  const timer = setInterval(() => {
    try {
      const watermark = getUpdateWatermark(agentId, {
        streams,
        fallback: {
          latest_message_ts: since.message_since_ts,
          latest_task_ts: since.task_since_ts,
          latest_context_ts: since.context_since_ts,
          latest_activity_ts: since.activity_since_ts,
        },
      });
      const changed = {
        messages: streams.includes('messages') && watermark.latest_message_ts > since.message_since_ts,
        tasks: streams.includes('tasks') && watermark.latest_task_ts > since.task_since_ts,
        context: streams.includes('context') && watermark.latest_context_ts > since.context_since_ts,
        activity: streams.includes('activity') && watermark.latest_activity_ts > since.activity_since_ts,
      };
      const changedStreams = Object.entries(changed)
        .filter(([, value]) => value)
        .map(([key]) => key);
      const cursor = encodeEventCursor(watermark);

      if (changedStreams.length > 0) {
        if (responseMode === 'nano') {
          writeEvent('update', {
            c: 1,
            s: changedStreams,
            u: cursor,
          });
        } else {
          writeEvent('update', {
            changed: true,
            streams: changedStreams,
            cursor,
            watermark,
          });
        }
        since = {
          message_since_ts: watermark.latest_message_ts,
          task_since_ts: watermark.latest_task_ts,
          context_since_ts: watermark.latest_context_ts,
          activity_since_ts: watermark.latest_activity_ts,
        };
        lastHeartbeatAt = Date.now();
        return;
      }

      const now = Date.now();
      if ((now - lastHeartbeatAt) >= EVENT_STREAM_HEARTBEAT_MS) {
        if (responseMode === 'nano') {
          writeEvent('heartbeat', { c: 0, u: cursor });
        } else {
          writeEvent('heartbeat', { changed: false, cursor });
        }
        lastHeartbeatAt = now;
      }
    } catch (error) {
      writeEvent('error', { success: false, error: 'event_stream_internal_error' });
    }
  }, pollMs);

  const cleanup = () => {
    clearInterval(timer);
    logActivity(agentId, 'events_unsubscribe', `streams=${streams.join(',')}`);
  };
  req.on('close', cleanup);
  req.on('end', cleanup);
});

app.get('/health', (_req, res) => {
  setServerCapabilityHeaders(res);
  res.json({
    status: 'ok',
    sessions: transports.size,
    auth_mode: AUTH_MODE,
    namespace_quota_mode: NAMESPACE_QUOTA_MODE,
    namespace_quota_rps: NAMESPACE_QUOTA_RPS,
    namespace_token_budget_per_min: NAMESPACE_TOKEN_BUDGET_PER_MIN,
    event_stream: {
      endpoint: '/events',
      default_interval_ms: EVENT_STREAM_DEFAULT_INTERVAL_MS,
      heartbeat_ms: EVENT_STREAM_HEARTBEAT_MS,
    },
    artifact_tickets: artifactTickets.size,
    session_idle_timeout_ms: SESSION_IDLE_TIMEOUT_MS,
    session_gc_enabled: SESSION_GC_ENABLED,
    unknown_session_policy: UNKNOWN_SESSION_POLICY,
  });
});

setInterval(() => {
  try {
    const expiredTickets = cleanupExpiredArtifactTickets();
    const maintenance = runMaintenance();
    if (expiredTickets > 0 || maintenance.slo.triggered > 0 || maintenance.slo.resolved > 0) {
      console.log(
        `[maintenance] claims=${maintenance.claims_cleaned} artifacts=${maintenance.artifacts_cleaned} tickets_expired=${expiredTickets} archived=${maintenance.tasks_archived} slo_triggered=${maintenance.slo.triggered} slo_resolved=${maintenance.slo.resolved}`
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
    `MCP Agent Hub running at http://${HOST}:${PORT}/mcp (auth_mode=${AUTH_MODE}, unknown_session_policy=${UNKNOWN_SESSION_POLICY}, session_idle_timeout_ms=${SESSION_IDLE_TIMEOUT_LABEL})`
  );
});
