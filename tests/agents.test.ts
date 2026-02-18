import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb } from '../src/db.js';
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
    expect(result.runtime_guidance.strategy).toBe('direct_repo_execution');
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
