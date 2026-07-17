import { describe, expect, it } from 'vitest';
import {
  extractAgentAuthPayload,
  extractRegisterToken,
  resolveAuthMode,
  resolveOriginMode,
  validateRegisterToken,
} from '../src/auth.js';

describe('registration auth helpers', () => {
  it('disables register token validation when no secret is configured', () => {
    expect(validateRegisterToken('', {})).toEqual({ ok: true, status: 'disabled' });
  });

  it('rejects registration when a configured token is missing', () => {
    const result = validateRegisterToken('secret', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('missing');
    expect(result.error_code).toBe('REGISTER_TOKEN_REQUIRED');
  });

  it('rejects registration when token does not match', () => {
    const result = validateRegisterToken('secret', { register_token: 'wrong' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('invalid');
    expect(result.error_code).toBe('REGISTER_TOKEN_INVALID');
  });

  it('accepts the exact register token and trims caller input', () => {
    expect(validateRegisterToken('secret', { register_token: ' secret ' })).toEqual({ ok: true, status: 'valid' });
  });

  it('extracts the explicit registration token aliases only', () => {
    expect(extractRegisterToken({ registration_token: ' alias ' })).toBe('alias');
    expect(extractRegisterToken({ auth_token: 'not-registration' })).toBeNull();
  });
});

describe('tool auth subject mapping', () => {
  it('uses the explicit caller instead of target and filter agent ids', () => {
    const args = {
      requesting_agent: 'caller',
      agent_id: 'target',
      from_agent: 'filter',
      auth_token: ' token ',
    };

    for (const toolName of [
      'get_context',
      'list_task_claims',
      'wait_for_updates',
      'read_snapshot',
      'read_event_deltas',
      'get_activity_log',
      'resolve_consensus_from_message',
    ]) {
      expect(extractAgentAuthPayload(toolName, args)).toEqual({
        agentId: 'caller',
        authToken: 'token',
        subjectKey: 'requesting_agent',
      });
    }
  });

  it('does not fall back to a filter identity when the explicit caller is missing', () => {
    expect(extractAgentAuthPayload('resolve_consensus_from_message', {
      from_agent: 'message-sender-filter',
      auth_token: 'token',
    })).toEqual({
      agentId: null,
      authToken: 'token',
      subjectKey: 'requesting_agent',
    });
  });

  it('supports explicit legacy agent_id fallbacks without overriding requesting_agent', () => {
    for (const toolName of [
      'get_context',
      'list_task_claims',
      'wait_for_updates',
      'read_snapshot',
      'read_event_deltas',
      'get_activity_log',
    ]) {
      expect(extractAgentAuthPayload(toolName, { agent_id: 'legacy-caller', auth_token: 'token' })).toEqual({
        agentId: 'legacy-caller',
        authToken: 'token',
        subjectKey: 'agent_id',
      });
      expect(extractAgentAuthPayload(toolName, {
        requesting_agent: 'explicit-caller',
        agent_id: 'target',
        auth_token: 'token',
      })).toMatchObject({ agentId: 'explicit-caller', subjectKey: 'requesting_agent' });
    }
  });

  it('uses register_agent.id and fails closed for unknown tools', () => {
    expect(extractAgentAuthPayload('register_agent', { id: 'new-agent' })).toMatchObject({
      agentId: 'new-agent',
      subjectKey: 'id',
    });
    expect(extractAgentAuthPayload('unknown_tool', { agent_id: 'forged', auth_token: 'token' })).toEqual({
      agentId: null,
      authToken: 'token',
      subjectKey: null,
    });
  });
});

describe('security mode parsing', () => {
  it('preserves legacy defaults but rejects explicit typos', () => {
    expect(resolveAuthMode('', false)).toBe('observe');
    expect(resolveAuthMode('', true)).toBe('enforce');
    expect(resolveOriginMode(undefined)).toBe('warn');
    expect(() => resolveAuthMode('enfore')).toThrow(/Invalid MCP_HUB_AUTH_MODE/);
    expect(() => resolveOriginMode('off')).toThrow(/Invalid MCP_HUB_ORIGIN_MODE/);
  });
});
