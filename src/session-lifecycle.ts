import { extractAgentAuthPayload } from './auth.js';

export type SessionExpiryReason = 'provisional' | 'idle' | null;

export type SessionAdmissionCounts = {
  activeSessions: number;
  pendingSessions: number;
  activeForSource: number;
  pendingForSource: number;
};

export type SessionAdmissionResult = { ok: true } | { ok: false; scope: 'rate' | 'global' | 'source' };

export type RefillableTokenBucket = {
  tokens: number;
  lastRefillAt: number;
};

type SessionExpiryOptions = {
  authenticated: boolean;
  createdAt: number;
  lastActivityAt: number;
  now: number;
  provisionalTtlMs: number;
  idleTimeoutMs: number;
};

export function getSessionExpiryReason(options: SessionExpiryOptions): SessionExpiryReason {
  if (!options.authenticated) {
    return options.now - options.createdAt > options.provisionalTtlMs ? 'provisional' : null;
  }
  if (options.idleTimeoutMs <= 0) return null;
  return options.now - options.lastActivityAt > options.idleTimeoutMs ? 'idle' : null;
}

export function evaluateSessionInitializationAdmission(options: {
  maxSessions: number;
  maxSessionsPerSource: number;
  consumeRateLimit: () => boolean;
  readCounts: () => SessionAdmissionCounts;
  reclaimExpiredSessions: () => void;
}): SessionAdmissionResult {
  // Rate-limit every attempt before any potentially O(active sessions) reclamation scan.
  if (!options.consumeRateLimit()) return { ok: false, scope: 'rate' };

  let counts = options.readCounts();
  const needsReclaim = counts.activeSessions + counts.pendingSessions >= options.maxSessions
    || counts.activeForSource + counts.pendingForSource >= options.maxSessionsPerSource;
  if (needsReclaim) {
    options.reclaimExpiredSessions();
    counts = options.readCounts();
  }

  if (counts.activeSessions + counts.pendingSessions >= options.maxSessions) {
    return { ok: false, scope: 'global' };
  }
  if (counts.activeForSource + counts.pendingForSource >= options.maxSessionsPerSource) {
    return { ok: false, scope: 'source' };
  }
  return { ok: true };
}

export function pruneIdleRefilledTokenBuckets(
  buckets: Map<string, RefillableTokenBucket>,
  options: { now: number; idleTtlMs: number; burst: number; rps: number },
): number {
  let cleaned = 0;
  for (const [key, bucket] of buckets.entries()) {
    const elapsedMs = Math.max(0, options.now - bucket.lastRefillAt);
    if (elapsedMs < options.idleTtlMs) continue;
    const effectiveTokens = Math.min(options.burst, bucket.tokens + (elapsedMs / 1000) * options.rps);
    if (effectiveTokens < options.burst) continue;
    buckets.delete(key);
    cleaned += 1;
  }
  return cleaned;
}

export function requestHasPromotableAgentAuth(
  body: unknown,
  validate: (agentId: string, authToken: string) => boolean,
  allowUnverifiedKnownSubject = false,
): boolean {
  const requests = Array.isArray(body) ? body : [body];
  for (const request of requests) {
    if (!request || typeof request !== 'object') continue;
    const rpcRequest = request as { method?: unknown; params?: unknown };
    if (rpcRequest.method !== 'tools/call' || !rpcRequest.params || typeof rpcRequest.params !== 'object') continue;
    const params = rpcRequest.params as { name?: unknown; arguments?: unknown };
    if (typeof params.name !== 'string' || params.name === 'register_agent') continue;
    if (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) continue;
    const { agentId, authToken } = extractAgentAuthPayload(params.name, params.arguments as Record<string, unknown>);
    if (agentId && authToken && validate(agentId, authToken)) return true;
    if (agentId && allowUnverifiedKnownSubject) return true;
  }
  return false;
}
