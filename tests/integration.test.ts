import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb } from '../src/db.js';
import { handleRegisterAgent, handleListAgents } from '../src/tools/agents.js';
import { handleSendMessage, handleReadMessages } from '../src/tools/messages.js';
import { handleCreateTask, handleUpdateTask, handleListTasks } from '../src/tools/tasks.js';
import { handleShareContext, handleShareBlobContext, handleGetContext } from '../src/tools/context.js';
import { handleGetActivityLog } from '../src/tools/activity.js';

beforeEach(() => { initDb(':memory:'); });
afterEach(() => { closeDb(); });

describe('integration: full multi-agent scenario', () => {
  it('two agents coordinate on a task via messages and shared context', () => {
    // Step 1: Both agents register
    handleRegisterAgent({ id: 'claude-1', name: 'Claude', type: 'claude', capabilities: 'code,review' });
    handleRegisterAgent({ id: 'codex-1', name: 'Codex', type: 'codex', capabilities: 'code,refactor' });

    const agents = handleListAgents({});
    expect(agents.agents).toHaveLength(2);

    // Step 2: Claude creates a task and assigns to Codex
    const { task } = handleCreateTask({
      title: 'Refactor auth module',
      description: 'Extract auth logic into separate service',
      created_by: 'claude-1',
      assigned_to: 'codex-1',
      priority: 'high',
    });

    // Step 3: Claude sends a message to Codex about the task
    handleSendMessage({
      from_agent: 'claude-1',
      to_agent: 'codex-1',
      content: `I created task #${task.id} for you. Please refactor the auth module.`,
    });

    // Step 4: Codex reads messages
    const inbox = handleReadMessages({ agent_id: 'codex-1', unread_only: true });
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0].content).toContain('refactor');

    // Step 5: Codex picks up the task
    handleUpdateTask({ id: task.id, agent_id: 'codex-1', status: 'in_progress' });

    // Step 6: Codex shares context about what it's working on
    handleShareContext({
      agent_id: 'codex-1',
      key: 'current_file',
      value: 'src/auth/service.ts',
    });
    handleShareContext({
      agent_id: 'codex-1',
      key: 'findings',
      value: JSON.stringify({ duplicated_code: 3, files_affected: ['auth.ts', 'middleware.ts', 'routes.ts'] }),
    });

    // Step 7: Claude checks Codex's context
    const ctx = handleGetContext({ requesting_agent: 'claude-1', agent_id: 'codex-1' });
    expect(ctx.contexts).toHaveLength(2);

    // Step 8: Codex completes and notifies
    handleUpdateTask({
      id: task.id,
      agent_id: 'codex-1',
      status: 'done',
      confidence: 0.95,
      verification_passed: true,
      evidence_refs: ['context:findings', 'message:completion'],
    });
    handleSendMessage({
      from_agent: 'codex-1',
      to_agent: 'claude-1',
      content: 'Task done. Refactored 3 files.',
    });

    // Step 9: Claude reads completion message
    const completion = handleReadMessages({ agent_id: 'claude-1', from: 'codex-1' });
    expect(completion.messages).toHaveLength(1);

    // Step 10: Verify task board
    const doneTasks = handleListTasks({ status: 'done' });
    expect(doneTasks.tasks).toHaveLength(1);

    // Step 11: Check activity log has all actions
    const log = handleGetActivityLog({ limit: 100 });
    expect(log.log.length).toBeGreaterThanOrEqual(10);
  });

  it('broadcast messages reach all agents', () => {
    handleRegisterAgent({ id: 'a1', name: 'A1', type: 'claude' });
    handleRegisterAgent({ id: 'a2', name: 'A2', type: 'codex' });
    handleRegisterAgent({ id: 'a3', name: 'A3', type: 'custom' });

    // a1 broadcasts
    handleSendMessage({ from_agent: 'a1', content: 'Team standup: what are you working on?' });

    // All others can read
    const m2 = handleReadMessages({ agent_id: 'a2' });
    const m3 = handleReadMessages({ agent_id: 'a3' });
    expect(m2.messages).toHaveLength(1);
    expect(m3.messages).toHaveLength(1);
  });

  it('context upsert works correctly', () => {
    handleRegisterAgent({ id: 'a1', name: 'A1', type: 'claude' });

    handleShareContext({ agent_id: 'a1', key: 'status', value: 'starting', trace_id: 'trace-ctx', span_id: 'span-1' });
    handleShareContext({ agent_id: 'a1', key: 'status', value: 'in_progress', trace_id: 'trace-ctx', span_id: 'span-2' });
    handleShareContext({ agent_id: 'a1', key: 'status', value: 'done', trace_id: 'trace-ctx', span_id: 'span-3' });

    const ctx = handleGetContext({ agent_id: 'a1', key: 'status' });
    expect(ctx.contexts).toHaveLength(1);
    expect(ctx.contexts[0].value).toBe('done');
    expect(ctx.contexts[0].trace_id).toBe('trace-ctx');
    expect(ctx.contexts[0].span_id).toBe('span-3');
  });

  it('context tools should enforce value and query limits', () => {
    handleRegisterAgent({ id: 'a1', name: 'A1', type: 'claude' });

    const oversized = handleShareContext({
      agent_id: 'a1',
      key: 'too_big',
      value: 'x'.repeat(2049),
    });
    expect(oversized.success).toBe(false);

    for (let i = 0; i < 120; i += 1) {
      handleShareContext({ agent_id: 'a1', key: `k${i}`, value: `v${i}` });
    }
    const limited = handleGetContext({ agent_id: 'a1', limit: 25 });
    expect(limited.contexts).toHaveLength(25);
  });

  it('get_context should reject full mode in polling cycle', () => {
    handleRegisterAgent({ id: 'a1', name: 'A1', type: 'claude' });
    handleShareContext({ agent_id: 'a1', key: 'k1', value: 'v1' });
    const result = handleGetContext({ requesting_agent: 'a1', response_mode: 'full', polling: true }) as Record<string, any>;
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error_code).toBe('FULL_MODE_FORBIDDEN_IN_POLLING');
  });

  it('context summary mode should return token-efficient aggregate', () => {
    handleRegisterAgent({ id: 'a1', name: 'A1', type: 'claude' });
    for (let i = 0; i < 10; i += 1) {
      handleShareContext({
        agent_id: 'a1',
        key: `summary-${i}`,
        value: JSON.stringify({ idx: i, text: `payload-${i}` }),
      });
    }

    const summary = handleGetContext({ agent_id: 'a1', response_mode: 'summary' });
    expect(summary.summary.count).toBe(10);
    expect(summary.contexts.length).toBeGreaterThan(0);
  });

  it('share_blob_context should exchange large payload via hash ref and resolve on demand', () => {
    handleRegisterAgent({ id: 'a1', name: 'A1', type: 'claude' });
    const payload = JSON.stringify({
      scope: 'worker-round',
      summary: 'Optimized handoff using blob references',
      findings: ['latency sensitive', 'token savings on message surface'],
    });

    const shared = handleShareBlobContext({
      agent_id: 'a1',
      key: 'round-plan',
      payload,
      compression_mode: 'json',
    });
    expect(shared.success).toBe(true);
    if (!shared.success) return;
    expect(shared.blob_ref.hash).toHaveLength(64);

    const unresolved = handleGetContext({ agent_id: 'a1', key: 'round-plan', response_mode: 'compact' });
    expect(unresolved.contexts).toHaveLength(1);
    expect(unresolved.contexts[0].value_preview).toContain('"h"');

    const tiny = handleGetContext({ agent_id: 'a1', key: 'round-plan', response_mode: 'tiny' });
    expect(tiny.contexts).toHaveLength(1);
    expect(tiny.contexts[0].value_digest).toHaveLength(16);
    expect(tiny.contexts[0].value_preview).toBeUndefined();

    const nano = handleGetContext({ agent_id: 'a1', key: 'round-plan', response_mode: 'nano' });
    expect(Array.isArray(nano.c)).toBe(true);
    expect(nano.c).toHaveLength(1);
    expect(nano.c[0].i).toBeDefined();
    expect(nano.c[0].k).toBe('round-plan');
    expect(nano.c[0].d).toHaveLength(12);
    expect(nano.contexts).toBeUndefined();

    const resolved = handleGetContext({
      agent_id: 'a1',
      key: 'round-plan',
      resolve_blob_refs: true,
    });
    expect(resolved.contexts).toHaveLength(1);
    expect(resolved.contexts[0].blob_ref.resolved).toBe(true);
    expect(resolved.contexts[0].resolved_value).toContain('Optimized handoff');
  });

  it('share_blob_context lossless_auto should preserve exact payload after resolve', () => {
    handleRegisterAgent({ id: 'a1', name: 'A1', type: 'claude' });
    const payload = JSON.stringify({
      mode: 'lossless-auto',
      text: 'line-1\nline-2\nline-3',
      spacing: 'a  b   c',
      notes: 'z'.repeat(2600),
    });

    const shared = handleShareBlobContext({
      agent_id: 'a1',
      key: 'lossless-check',
      payload,
      compression_mode: 'lossless_auto',
    });
    expect(shared.success).toBe(true);
    if (!shared.success) return;
    expect(shared.compression.lossless).toBe(true);

    const resolved = handleGetContext({
      agent_id: 'a1',
      key: 'lossless-check',
      resolve_blob_refs: true,
    });
    expect(resolved.contexts).toHaveLength(1);
    expect(resolved.contexts[0].blob_ref.integrity_ok).toBe(true);
    expect(resolved.contexts[0].resolved_value).toBe(payload);
  });
});
