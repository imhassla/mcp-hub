import { describe, expect, it, vi } from 'vitest';
import {
  evaluateSessionInitializationAdmission,
  getSessionExpiryReason,
  pruneIdleRefilledTokenBuckets,
  requestHasPromotableAgentAuth,
} from '../src/session-lifecycle.js';

describe('provisional MCP session admission', () => {
  it('uses an absolute provisional deadline rather than last activity', () => {
    expect(getSessionExpiryReason({
      authenticated: false,
      createdAt: 1_000,
      lastActivityAt: 1_950,
      now: 2_001,
      provisionalTtlMs: 1_000,
      idleTimeoutMs: 60_000,
    })).toBe('provisional');
  });

  it('uses the normal idle timeout only after authentication', () => {
    expect(getSessionExpiryReason({
      authenticated: true,
      createdAt: 1_000,
      lastActivityAt: 1_950,
      now: 2_001,
      provisionalTtlMs: 1_000,
      idleTimeoutMs: 60_000,
    })).toBeNull();

    expect(getSessionExpiryReason({
      authenticated: true,
      createdAt: 1_000,
      lastActivityAt: 2_000,
      now: 62_001,
      provisionalTtlMs: 1_000,
      idleTimeoutMs: 60_000,
    })).toBe('idle');
  });

  it('does not promote register, protocol-only, unknown, or invalid-auth calls', () => {
    const validate = vi.fn(() => false);
    const requests = [
      { jsonrpc: '2.0', method: 'tools/list', params: {} },
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'register_agent', arguments: { id: 'agent-a', auth_token: 'token-a' } },
      },
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'unknown_tool', arguments: { agent_id: 'agent-a', auth_token: 'token-a' } },
      },
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'get_onboarding', arguments: { agent_id: 'agent-a', auth_token: 'bad-token' } },
      },
    ];

    for (const request of requests) {
      expect(requestHasPromotableAgentAuth(request, validate)).toBe(false);
    }
    expect(validate).toHaveBeenCalledOnce();
    expect(validate).toHaveBeenCalledWith('agent-a', 'bad-token');
  });

  it('promotes a known tool call only when its caller token validates', () => {
    const validate = vi.fn((agentId: string, token: string) => agentId === 'agent-a' && token === 'valid-token');
    const batch = [
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'get_onboarding',
          arguments: { agent_id: 'agent-a', auth_token: 'valid-token' },
        },
      },
    ];

    expect(requestHasPromotableAgentAuth(batch, validate)).toBe(true);
    expect(validate).toHaveBeenCalledWith('agent-a', 'valid-token');
  });

  it('can preserve observe/warn legacy sessions with a known caller subject', () => {
    const request = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'get_onboarding',
        arguments: { agent_id: 'legacy-agent' },
      },
    };
    expect(requestHasPromotableAgentAuth(request, () => false)).toBe(false);
    expect(requestHasPromotableAgentAuth(request, () => false, true)).toBe(true);
    expect(requestHasPromotableAgentAuth({
      ...request,
      params: { name: 'unknown_tool', arguments: { agent_id: 'legacy-agent' } },
    }, () => false, true)).toBe(false);
  });

  it('rate-limits before reclamation and only scans sessions when capacity is full', () => {
    const deniedOrder: string[] = [];
    const denied = evaluateSessionInitializationAdmission({
      maxSessions: 10,
      maxSessionsPerSource: 5,
      consumeRateLimit: () => { deniedOrder.push('rate'); return false; },
      readCounts: () => { deniedOrder.push('counts'); return { activeSessions: 10, pendingSessions: 0, activeForSource: 5, pendingForSource: 0 }; },
      reclaimExpiredSessions: () => { deniedOrder.push('reclaim'); },
    });
    expect(denied).toEqual({ ok: false, scope: 'rate' });
    expect(deniedOrder).toEqual(['rate']);

    const admittedOrder: string[] = [];
    let counts = { activeSessions: 10, pendingSessions: 0, activeForSource: 5, pendingForSource: 0 };
    const admitted = evaluateSessionInitializationAdmission({
      maxSessions: 10,
      maxSessionsPerSource: 5,
      consumeRateLimit: () => { admittedOrder.push('rate'); return true; },
      readCounts: () => { admittedOrder.push('counts'); return counts; },
      reclaimExpiredSessions: () => {
        admittedOrder.push('reclaim');
        counts = { activeSessions: 8, pendingSessions: 0, activeForSource: 3, pendingForSource: 0 };
      },
    });
    expect(admitted).toEqual({ ok: true });
    expect(admittedOrder).toEqual(['rate', 'counts', 'reclaim', 'counts']);

    const belowCapacityReclaim = vi.fn();
    expect(evaluateSessionInitializationAdmission({
      maxSessions: 10,
      maxSessionsPerSource: 5,
      consumeRateLimit: () => true,
      readCounts: () => ({ activeSessions: 2, pendingSessions: 0, activeForSource: 1, pendingForSource: 0 }),
      reclaimExpiredSessions: belowCapacityReclaim,
    })).toEqual({ ok: true });
    expect(belowCapacityReclaim).not.toHaveBeenCalled();
  });

  it('prunes idle initialize buckets only after they have fully refilled', () => {
    const buckets = new Map([
      ['idle-refilled', { tokens: 0, lastRefillAt: 0 }],
      ['recent', { tokens: 0, lastRefillAt: 9_500 }],
      ['another-idle-refilled', { tokens: 0, lastRefillAt: 0 }],
    ]);

    const first = pruneIdleRefilledTokenBuckets(buckets, {
      now: 10_000,
      idleTtlMs: 1_000,
      burst: 5,
      rps: 1,
    });
    expect(first).toBe(2);
    expect([...buckets.keys()]).toEqual(['recent']);

    const slowBuckets = new Map([['idle-not-refilled', { tokens: 0, lastRefillAt: 0 }]]);
    expect(pruneIdleRefilledTokenBuckets(slowBuckets, {
      now: 10_000,
      idleTtlMs: 1_000,
      burst: 100,
      rps: 0.1,
    })).toBe(0);
    expect(slowBuckets.has('idle-not-refilled')).toBe(true);
  });
});
