import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, cleanupStaleOfflineAgents, getActivityLog, getAgentById, getDb, validateAgentToken } from '../src/db.js';
import { handleRegisterAgent, handleListAgents, handleGetOnboarding, handleUpdateRuntimeProfile } from '../src/tools/agents.js';

beforeEach(() => { initDb(':memory:'); });
afterEach(() => { closeDb(); });

describe('agent tools', () => {
  it('register_agent should return success', () => {
    const result = handleRegisterAgent({ id: 'claude-1', name: 'Claude', type: 'claude', capabilities: 'code' });
    expect(result.success).toBe(true);
    expect(result.agent.id).toBe('claude-1');
    expect(result.agent.lifecycle).toBe('persistent');
    expect(result.agent.status).toBe('online');
    expect(result.onboarding.tool_count).toBeGreaterThanOrEqual(20);
    expect(result.onboarding.rules.session_recovery.error_code).toBe(-32000);
    expect(result.client_runtime.session_recovery.reinitialize_required_path).toBe('error.data.reinitialize_required');
    expect(result.registration.role).toBe('worker');
    expect(result.role_guidance.role).toBe('worker');
    expect(result.runtime_guidance.mode).toBe('unknown');
  });

  it('register_agent should default ephemeral workers to compact onboarding', () => {
    const result = handleRegisterAgent({ id: 'sw-1', name: 'Swarm Worker', type: 'codex', lifecycle: 'ephemeral' });
    expect(result.success).toBe(true);
    expect(result.agent.lifecycle).toBe('ephemeral');
    expect(result.registration.lifecycle).toBe('ephemeral');
    expect(result.registration.onboarding_mode).toBe('compact');
    expect(Array.isArray(result.onboarding.tool_names)).toBe(true);
  });

  it('register_agent should default re-registration onboarding to none', () => {
    const first = handleRegisterAgent({ id: 'rr-1', name: 'ReReg', type: 'codex' });
    const second = handleRegisterAgent({ id: 'rr-1', name: 'ReReg', type: 'codex' });

    expect(first.registration.is_new).toBe(true);
    expect(second.registration.is_new).toBe(false);
    expect(second.registration.onboarding_mode).toBe('none');
    expect(second.onboarding.quickstart.length).toBeGreaterThan(0);
    expect(second.onboarding.rules).toBeUndefined();
  });

  it('register_agent should persist runtime profile and return isolated warning', () => {
    const result = handleRegisterAgent({
      id: 'iso-1',
      name: 'Isolated Worker',
      type: 'claude',
      role: 'assistant',
      runtime_profile: {
        mode: 'isolated',
        cwd: '/tmp/empty',
        has_git: false,
        file_count: 0,
        empty_dir: true,
        source: 'client_auto',
      },
    });
    expect(result.success).toBe(true);
    expect(result.runtime_profile.mode).toBe('isolated');
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.warnings.join(' ')).toContain('isolated_runtime_detected');
    expect(result.registration.role).toBe('assistant');
    expect(result.role_guidance.role).toBe('assistant');
    expect(result.runtime_guidance.mode).toBe('isolated');
    expect(result.runtime_guidance.strategy).toBe('repo_isolated_handoff');
  });

  it('register_agent should return negotiated capability contract', () => {
    const result = handleRegisterAgent({
      id: 'cap-1',
      name: 'Cap Worker',
      type: 'codex',
      client_capabilities: {
        response_modes: ['nano', 'tiny'],
        blob_resolve: true,
        artifact_tickets: true,
        snapshot_reads: true,
        push_transports: ['sse_events', 'wait_for_updates'],
      },
    });
    expect(result.success).toBe(true);
    expect(result.capability_negotiation.client.response_modes).toContain('nano');
    expect(result.capability_negotiation.server.snapshot_reads).toBe(true);
    expect(result.capability_negotiation.negotiated.preferred_read_mode).toBe('nano');
    expect(result.capability_negotiation.negotiated.snapshot_tool).toBe('read_snapshot');
    expect(result.capability_negotiation.negotiated.push_transport).toBe('sse_events');
    expect(result.registration.contract_profile.wait_for_updates_mode).toBe('nano');
  });

  it('does not negotiate a push transport unsupported by the server', () => {
    const result = handleRegisterAgent({
      id: 'cap-ws',
      name: 'WebSocket-only Worker',
      type: 'custom',
      client_capabilities: { push_transports: ['websocket'] },
    });
    expect(result.capability_negotiation.server.push_transports).not.toContain('websocket');
    expect(result.capability_negotiation.negotiated.push_transport).toBeNull();
  });

  it('update_runtime_profile should persist updated runtime mode', () => {
    handleRegisterAgent({ id: 'a1', name: 'A1', type: 'claude' });
    const result = handleUpdateRuntimeProfile({
      agent_id: 'a1',
      runtime_profile: {
        mode: 'repo',
        cwd: '/workspace/repo',
        has_git: true,
        file_count: 42,
        source: 'client_declared',
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.agent.runtime_mode).toBe('repo');
    expect(result.runtime_profile.mode).toBe('repo');
    expect(result.runtime_profile.has_git).toBe(true);
    expect(result.runtime_guidance.mode).toBe('repo');
    expect(result.runtime_guidance.strategy).toBe('repo_workspace_execution');
  });

  it('update_runtime_profile should fail when agent does not exist', () => {
    const result = handleUpdateRuntimeProfile({
      agent_id: 'missing',
      runtime_profile: { mode: 'isolated', source: 'client_declared' },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error_code).toBe('AGENT_NOT_FOUND');
  });

  it('list_agents should return all agents', () => {
    handleRegisterAgent({ id: 'a1', name: 'A1', type: 'claude' });
    handleRegisterAgent({ id: 'a2', name: 'A2', type: 'codex' });

    const result = handleListAgents({ agent_id: 'a1' });
    expect(result.agents).toHaveLength(2);
  });

  it('list_agents summary mode should return aggregate counts', () => {
    handleRegisterAgent({ id: 'a1', name: 'A1', type: 'claude', lifecycle: 'persistent' });
    handleRegisterAgent({ id: 'a2', name: 'A2', type: 'codex', lifecycle: 'ephemeral' });

    const result = handleListAgents({ agent_id: 'a1', response_mode: 'summary' });
    expect(result.summary.total).toBe(2);
    expect(result.summary.persistent).toBe(1);
    expect(result.summary.ephemeral).toBe(1);
  });

  it('get_onboarding should return compact mode with role/runtime guidance', () => {
    handleRegisterAgent({ id: 'a1', name: 'A1', type: 'claude' });
    const result = handleGetOnboarding({
      agent_id: 'a1',
      mode: 'compact',
      role: 'reviewer',
      runtime_mode: 'isolated',
      empty_dir: true,
    });
    expect(result.success).toBe(true);
    expect(result.onboarding.protocol_version).toBe('hub-protocol-2026.02');
    expect(result.onboarding.tool_names.length).toBeGreaterThan(10);
    expect(result.role_guidance.role).toBe('reviewer');
    expect(result.runtime_guidance.mode).toBe('isolated');
    expect(result.runtime_guidance.cautions.join(' ')).toContain('empty_dir=true');
    expect(result.onboarding.rules.bootstrap_contract.startup_sequence).toEqual([
      'initialize',
      'notifications/initialized',
      'register_agent',
      'get_onboarding',
    ]);
  });
});

describe('register_agent auth-token disclosure (F1)', () => {
  it('returns the auth token to the registrant when the agent is newly created', () => {
    const res = handleRegisterAgent({ id: 'owner-1', name: 'Owner', type: 'claude' });
    expect(res.registration.is_new).toBe(true);
    expect(res.auth).not.toBeNull();
    expect(typeof res.auth?.token).toBe('string');
    expect((res.auth?.token as string).length).toBeGreaterThan(0);
    const stored = getDb().prepare('SELECT token FROM agent_tokens WHERE agent_id = ?').get('owner-1') as { token: string };
    expect(stored.token).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(stored.token).not.toBe(res.auth?.token);
    expect(validateAgentToken('owner-1', res.auth?.token as string)).toBe(true);
  });

  it('does NOT return an existing agent token to a caller without proof of ownership', () => {
    const first = handleRegisterAgent({ id: 'victim-1', name: 'Victim', type: 'claude' });
    const stolen = first.auth?.token as string;
    expect(stolen.length).toBeGreaterThan(0);
    const activityBefore = getActivityLog({ agent_id: 'victim-1', limit: 100 }).length;

    // Attacker re-registers the same id with no auth_token (the F1 takeover attempt).
    const attacker = handleRegisterAgent({
      id: 'victim-1',
      name: 'Impostor',
      type: 'custom',
      capabilities: 'poisoned',
      lifecycle: 'ephemeral',
      runtime_profile: { mode: 'isolated' },
    });
    expect(attacker.registration.is_new).toBe(false);
    expect(attacker.registration.update_applied).toBe(false);
    expect(attacker.auth?.token).toBeNull();
    expect((attacker.auth as Record<string, unknown>).proof_required).toBe(true);
    expect(getAgentById('victim-1')).toMatchObject({
      name: 'Victim',
      type: 'claude',
      capabilities: '',
      lifecycle: 'persistent',
      runtime_mode: 'unknown',
    });
    expect(getActivityLog({ agent_id: 'victim-1', limit: 100 })).toHaveLength(activityBefore);
  });

  it('updates and returns the token only when the caller proves ownership', () => {
    const first = handleRegisterAgent({ id: 'owner-2', name: 'Owner', type: 'claude' });
    const token = first.auth?.token as string;

    const reReg = handleRegisterAgent({
      id: 'owner-2',
      name: 'Updated Owner',
      type: 'codex',
      capabilities: 'review',
      lifecycle: 'ephemeral',
      runtime_profile: { mode: 'repo' },
      auth_token: token,
    });
    expect(reReg.registration.is_new).toBe(false);
    expect(reReg.registration.update_applied).toBe(true);
    expect(reReg.auth?.token).toBe(token);
    expect(getAgentById('owner-2')).toMatchObject({
      name: 'Updated Owner',
      type: 'codex',
      capabilities: 'review',
      lifecycle: 'ephemeral',
      runtime_mode: 'repo',
    });

    // A wrong token neither unlocks disclosure nor mutates the now-owned identity.
    const wrong = handleRegisterAgent({
      id: 'owner-2',
      name: 'Attacker',
      type: 'custom',
      capabilities: 'poisoned',
      lifecycle: 'persistent',
      runtime_profile: { mode: 'isolated' },
      auth_token: 'not-the-token',
    });
    expect(wrong.auth?.token).toBeNull();
    expect(wrong.registration.update_applied).toBe(false);
    expect(getAgentById('owner-2')).toMatchObject({
      name: 'Updated Owner',
      type: 'codex',
      capabilities: 'review',
      lifecycle: 'ephemeral',
      runtime_mode: 'repo',
    });
  });

  it('allows a one-time token claim for a legacy agent without rewriting its metadata', () => {
    handleRegisterAgent({
      id: 'legacy-agent',
      name: 'Legacy Owner',
      type: 'claude',
      capabilities: 'review',
      lifecycle: 'persistent',
      runtime_profile: { mode: 'repo' },
    });
    getDb().prepare('DELETE FROM agent_tokens WHERE agent_id = ?').run('legacy-agent');

    const claimed = handleRegisterAgent({
      id: 'legacy-agent',
      name: 'Untrusted Replacement',
      type: 'custom',
      capabilities: 'poisoned',
      lifecycle: 'ephemeral',
      runtime_profile: { mode: 'isolated' },
      allow_legacy_claim: true,
    });
    expect(claimed.registration).toMatchObject({
      is_new: false,
      update_applied: true,
      legacy_claim: true,
    });
    expect(claimed.auth?.token).toEqual(expect.any(String));
    expect(getAgentById('legacy-agent')).toMatchObject({
      name: 'Legacy Owner',
      type: 'claude',
      capabilities: 'review',
      lifecycle: 'persistent',
      runtime_mode: 'repo',
    });

    const replay = handleRegisterAgent({
      id: 'legacy-agent',
      name: 'Second Replacement',
      type: 'custom',
    });
    expect(replay.registration).toMatchObject({ update_applied: false, legacy_claim: false });
    expect(replay.auth?.token).toBeNull();
  });

  it('reserves a retired agent id and restores it only with the existing credential', () => {
    const first = handleRegisterAgent({ id: 'retired-agent', name: 'Original', type: 'claude' });
    const token = first.auth?.token as string;
    getDb().prepare('DELETE FROM agents WHERE id = ?').run('retired-agent');

    const attacker = handleRegisterAgent({ id: 'retired-agent', name: 'Attacker', type: 'custom' });
    expect(attacker.success).toBe(false);
    if (attacker.success) return;
    expect(attacker.error_code).toBe('AGENT_ID_RESERVED');

    const restored = handleRegisterAgent({
      id: 'retired-agent',
      name: 'Restored',
      type: 'codex',
      auth_token: token,
    });
    expect(restored.success).toBe(true);
    if (!restored.success) return;
    expect(restored.auth?.token).toBe(token);
    expect(restored.registration.is_new).toBe(false);
    expect(getAgentById('retired-agent')?.name).toBe('Restored');
  });

  it('accepts a strong client-generated credential for recoverable first registration', () => {
    const requestedToken = 'client-generated-token-'.padEnd(64, 'x');
    const first = handleRegisterAgent({
      id: 'recoverable-agent',
      name: 'Recoverable',
      type: 'bridge',
      auth_token: requestedToken,
    });
    expect(first.success).toBe(true);
    if (!first.success) return;
    expect(first.auth?.token).toBe(requestedToken);
    expect(first.registration.credential_source).toBe('client_provided');
    expect((first.agent as Record<string, unknown>).initial_auth_token).toBeUndefined();

    const replay = handleRegisterAgent({
      id: 'recoverable-agent',
      name: 'Recoverable',
      type: 'bridge',
      auth_token: requestedToken,
    });
    expect(replay.success).toBe(true);
    if (!replay.success) return;
    expect(replay.auth?.token).toBe(requestedToken);
    expect(replay.registration.credential_source).toBe('existing');
  });

  it('rolls back identity creation when a client credential is already bound elsewhere', () => {
    const sharedToken = 'shared-client-token-'.padEnd(64, 'z');
    const first = handleRegisterAgent({ id: 'token-owner', name: 'Owner', type: 'bridge', auth_token: sharedToken });
    expect(first.success).toBe(true);

    const duplicate = handleRegisterAgent({ id: 'token-duplicate', name: 'Duplicate', type: 'bridge', auth_token: sharedToken });
    expect(duplicate.success).toBe(false);
    if (duplicate.success) return;
    expect(duplicate.error_code).toBe('INITIAL_AUTH_TOKEN_CONFLICT');
    expect(getAgentById('token-duplicate')).toBeNull();
  });

  it('rejects wildcard agent ids reserved by server-side ACLs', () => {
    const result = handleRegisterAgent({ id: '*', name: 'Wildcard', type: 'custom' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error_code).toBe('AGENT_ID_INVALID');
  });

  it('tombstones a retired legacy id even when it had no credential row', () => {
    handleRegisterAgent({ id: 'legacy-retired', name: 'Legacy', type: 'custom' });
    getDb().prepare('DELETE FROM agent_tokens WHERE agent_id = ?').run('legacy-retired');
    getDb().prepare("UPDATE agents SET status = 'offline', last_seen = ? WHERE id = ?").run(1, 'legacy-retired');
    expect(cleanupStaleOfflineAgents(Date.now(), 1, 1)).toBe(1);

    const reused = handleRegisterAgent({ id: 'legacy-retired', name: 'Replacement', type: 'custom' });
    expect(reused.success).toBe(false);
    if (reused.success) return;
    expect(reused.error_code).toBe('AGENT_ID_RETIRED');
    expect(getAgentById('legacy-retired')).toBeNull();
  });
});
