import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, createTask, getUpdateWatermark, initDb, logActivity, registerAgent, sendMessage, shareContext } from '../src/db.js';
import { handleGetActivityLog, handleGetKpiSnapshot, handleGetTransportSnapshot, handleReadSnapshot, handleWaitForUpdates } from '../src/tools/activity.js';

beforeEach(() => {
  initDb(':memory:');
});

afterEach(() => {
  closeDb();
});

describe('wait_for_updates response modes', () => {
  it('returns compact timeout payload by default', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });

    const result = await handleWaitForUpdates({
      agent_id: 'watcher',
      wait_ms: 120,
      poll_interval_ms: 100,
      adaptive_retry: false,
    }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.retry_after_ms).toBe(100);
    expect('watermark' in result).toBe(false);
    expect('changed_streams' in result).toBe(false);
  });

  it('returns full timeout payload when response_mode=full', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });

    const result = await handleWaitForUpdates({
      agent_id: 'watcher',
      wait_ms: 120,
      poll_interval_ms: 100,
      response_mode: 'full',
    }) as Record<string, any>;

    expect(result.success).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.changed_streams).toEqual({
      messages: false,
      tasks: false,
      context: false,
      activity: false,
    });
    expect(result.watermark.latest_message_ts).toBeTypeOf('number');
    expect(result.watermark.latest_task_ts).toBeTypeOf('number');
    expect(result.watermark.latest_context_ts).toBeTypeOf('number');
    expect(result.watermark.latest_activity_ts).toBeTypeOf('number');
  });

  it('returns tiny timeout payload when response_mode=tiny', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });

    const result = await handleWaitForUpdates({
      agent_id: 'watcher',
      wait_ms: 120,
      poll_interval_ms: 100,
      response_mode: 'tiny',
      adaptive_retry: false,
    }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.changed).toBe(false);
    expect(typeof result.cursor).toBe('string');
    expect(result.retry_after_ms).toBe(100);
    expect('elapsed_ms' in result).toBe(false);
    expect('watermark' in result).toBe(false);
  });

  it('returns micro timeout payload when response_mode=micro', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });

    const result = await handleWaitForUpdates({
      agent_id: 'watcher',
      wait_ms: 120,
      poll_interval_ms: 100,
      response_mode: 'micro',
      adaptive_retry: false,
    }) as Record<string, unknown>;

    expect(result.changed).toBe(false);
    expect(typeof result.cursor).toBe('string');
    expect(result.retry_after_ms).toBe(100);
    expect(result.success).toBeUndefined();
    expect(result.watermark).toBeUndefined();
  });

  it('returns nano timeout payload with compact keys when response_mode=nano', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });

    const result = await handleWaitForUpdates({
      agent_id: 'watcher',
      wait_ms: 120,
      poll_interval_ms: 100,
      response_mode: 'nano',
      adaptive_retry: false,
    }) as Record<string, unknown>;

    expect(result.c).toBe(0);
    expect(typeof result.u).toBe('string');
    expect(result.r).toBe(100);
    expect(result.changed).toBeUndefined();
    expect(result.cursor).toBeUndefined();
  });

  it('returns minimal timeout payload when timeout_response=minimal', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });

    const result = await handleWaitForUpdates({
      agent_id: 'watcher',
      wait_ms: 120,
      poll_interval_ms: 100,
      response_mode: 'tiny',
      timeout_response: 'minimal',
    }) as Record<string, unknown>;

    expect(result.changed).toBe(false);
    expect(result.success).toBeUndefined();
    expect(result.retry_after_ms).toBeUndefined();
    expect(Object.keys(result)).toEqual(['changed']);
  });

  it('returns minimal nano timeout payload when timeout_response=minimal', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });

    const result = await handleWaitForUpdates({
      agent_id: 'watcher',
      wait_ms: 120,
      poll_interval_ms: 100,
      response_mode: 'nano',
      timeout_response: 'minimal',
    }) as Record<string, unknown>;

    expect(result.c).toBe(0);
    expect(result.changed).toBeUndefined();
    expect(result.r).toBeUndefined();
    expect(result.u).toBeUndefined();
    expect(Object.keys(result)).toEqual(['c']);
  });

  it('returns adaptive retry_after_ms that grows across consecutive timeouts', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });

    const first = await handleWaitForUpdates({
      agent_id: 'watcher',
      wait_ms: 120,
      poll_interval_ms: 100,
      response_mode: 'micro',
    }) as Record<string, unknown>;
    const second = await handleWaitForUpdates({
      agent_id: 'watcher',
      cursor: first.cursor as string,
      wait_ms: 120,
      poll_interval_ms: 100,
      response_mode: 'micro',
    }) as Record<string, unknown>;

    expect(first.changed).toBe(false);
    expect(second.changed).toBe(false);
    expect((first.retry_after_ms as number) >= 100).toBe(true);
    expect((second.retry_after_ms as number) >= (first.retry_after_ms as number)).toBe(true);
  });

  it('returns compact hit payload with changed streams and watermark', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    const baseline = getUpdateWatermark('watcher');

    setTimeout(() => {
      sendMessage('sender', 'watcher', 'ping');
    }, 50);

    const result = await handleWaitForUpdates({
      agent_id: 'watcher',
      message_since_ts: baseline.latest_message_ts,
      task_since_ts: baseline.latest_task_ts,
      context_since_ts: baseline.latest_context_ts,
      activity_since_ts: baseline.latest_activity_ts,
      wait_ms: 1000,
      poll_interval_ms: 100,
      response_mode: 'compact',
    }) as Record<string, any>;

    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
    expect(typeof result.cursor).toBe('string');
    expect(result.streams).toContain('messages');
    expect(result.watermark.latest_message_ts).toBeGreaterThan(baseline.latest_message_ts);
  });

  it('does not log timeout events by default', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });

    await handleWaitForUpdates({
      agent_id: 'watcher',
      wait_ms: 120,
      poll_interval_ms: 100,
      response_mode: 'tiny',
    });

    const log = handleGetActivityLog({ agent_id: 'watcher', limit: 50 }) as Record<string, any>;
    const timeoutEntries = (log.entries || []).filter((entry: { action?: string }) => entry.action === 'wait_for_updates_timeout');
    expect(timeoutEntries).toHaveLength(0);
  });

  it('returns tiny hit payload with compact watermark fields', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    const baseline = getUpdateWatermark('watcher');

    setTimeout(() => {
      sendMessage('sender', 'watcher', 'ping');
    }, 50);

    const result = await handleWaitForUpdates({
      agent_id: 'watcher',
      message_since_ts: baseline.latest_message_ts,
      task_since_ts: baseline.latest_task_ts,
      context_since_ts: baseline.latest_context_ts,
      activity_since_ts: baseline.latest_activity_ts,
      wait_ms: 1000,
      poll_interval_ms: 100,
      response_mode: 'tiny',
    }) as Record<string, any>;

    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
    expect(typeof result.cursor).toBe('string');
    expect(result.streams).toContain('messages');
    expect(result.watermark.message).toBeGreaterThan(baseline.latest_message_ts);
    expect(result.watermark.latest_message_ts).toBeUndefined();
  });

  it('returns micro hit payload without watermark fields', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    const baseline = getUpdateWatermark('watcher');

    setTimeout(() => {
      sendMessage('sender', 'watcher', 'micro-ping');
    }, 50);

    const result = await handleWaitForUpdates({
      agent_id: 'watcher',
      message_since_ts: baseline.latest_message_ts,
      task_since_ts: baseline.latest_task_ts,
      context_since_ts: baseline.latest_context_ts,
      activity_since_ts: baseline.latest_activity_ts,
      wait_ms: 1000,
      poll_interval_ms: 100,
      response_mode: 'micro',
    }) as Record<string, any>;

    expect(result.changed).toBe(true);
    expect(Array.isArray(result.streams)).toBe(true);
    expect(result.streams).toContain('messages');
    expect(typeof result.cursor).toBe('string');
    expect(result.success).toBeUndefined();
    expect(result.watermark).toBeUndefined();
  });

  it('returns nano hit payload with compact keys', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    const baseline = getUpdateWatermark('watcher');

    setTimeout(() => {
      sendMessage('sender', 'watcher', 'nano-ping');
    }, 50);

    const result = await handleWaitForUpdates({
      agent_id: 'watcher',
      message_since_ts: baseline.latest_message_ts,
      task_since_ts: baseline.latest_task_ts,
      context_since_ts: baseline.latest_context_ts,
      activity_since_ts: baseline.latest_activity_ts,
      wait_ms: 1000,
      poll_interval_ms: 100,
      response_mode: 'nano',
    }) as Record<string, any>;

    expect(result.c).toBe(1);
    expect(Array.isArray(result.s)).toBe(true);
    expect(result.s).toContain('messages');
    expect(typeof result.u).toBe('string');
    expect(result.changed).toBeUndefined();
    expect(result.cursor).toBeUndefined();
  });

  it('accepts cursor and detects updates without explicit *_since_ts fields', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });

    const first = await handleWaitForUpdates({
      agent_id: 'watcher',
      wait_ms: 120,
      poll_interval_ms: 100,
      response_mode: 'tiny',
    }) as Record<string, any>;
    expect(first.success).toBe(true);
    expect(typeof first.cursor).toBe('string');

    setTimeout(() => {
      sendMessage('sender', 'watcher', 'cursor-ping');
    }, 50);

    const second = await handleWaitForUpdates({
      agent_id: 'watcher',
      cursor: first.cursor,
      wait_ms: 1000,
      poll_interval_ms: 100,
      response_mode: 'tiny',
    }) as Record<string, any>;

    expect(second.success).toBe(true);
    expect(second.changed).toBe(true);
    expect(second.streams).toContain('messages');
    expect(typeof second.cursor).toBe('string');
    expect(second.cursor).not.toBe(first.cursor);
  });

  it('rejects invalid cursor format', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    const result = await handleWaitForUpdates({
      agent_id: 'watcher',
      cursor: 'bad-cursor',
      wait_ms: 120,
      poll_interval_ms: 100,
      response_mode: 'tiny',
    }) as Record<string, any>;
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('CURSOR_INVALID');
  });

  it('should support stream filtering and ignore non-watched updates', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    const baseline = getUpdateWatermark('watcher');

    setTimeout(() => {
      sendMessage('sender', 'watcher', 'message-ignored-for-tasks-stream');
    }, 50);

    const ignored = await handleWaitForUpdates({
      agent_id: 'watcher',
      streams: ['tasks'],
      message_since_ts: baseline.latest_message_ts,
      task_since_ts: baseline.latest_task_ts,
      context_since_ts: baseline.latest_context_ts,
      activity_since_ts: baseline.latest_activity_ts,
      wait_ms: 250,
      poll_interval_ms: 100,
      response_mode: 'micro',
    }) as Record<string, any>;

    expect(ignored.changed).toBe(false);
    expect(typeof ignored.cursor).toBe('string');

    setTimeout(() => {
      createTask({ title: 'watched-task-change', created_by: 'watcher' });
    }, 50);

    const watched = await handleWaitForUpdates({
      agent_id: 'watcher',
      streams: ['tasks'],
      cursor: ignored.cursor,
      wait_ms: 1000,
      poll_interval_ms: 100,
      response_mode: 'micro',
    }) as Record<string, any>;

    expect(watched.changed).toBe(true);
    expect(Array.isArray(watched.streams)).toBe(true);
    expect(watched.streams).toContain('tasks');
    expect(watched.streams).not.toContain('messages');
  });

  it('should reject invalid stream names', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    const result = await handleWaitForUpdates({
      agent_id: 'watcher',
      streams: ['invalid-stream' as any],
      wait_ms: 120,
      poll_interval_ms: 100,
    }) as Record<string, any>;

    expect(result.success).toBe(false);
    expect(result.error_code).toBe('STREAMS_INVALID');
  });
});

describe('read_snapshot', () => {
  it('returns nano batch with unified cursor', () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });

    const cursor = '0.0.0.0';

    sendMessage('sender', 'watcher', 'snapshot-msg');
    createTask({ title: 'snapshot-task', created_by: 'watcher' });
    shareContext('watcher', 'snapshot-key', '{"ok":true}');

    const result = handleReadSnapshot({
      agent_id: 'watcher',
      cursor,
      response_mode: 'nano',
      task_ready_only: true,
    }) as Record<string, any>;

    expect(result.u).toBeTypeOf('string');
    expect(result.s).toBeDefined();
    expect(Array.isArray(result.s.m)).toBe(true);
    expect(Array.isArray(result.s.t)).toBe(true);
    expect(Array.isArray(result.s.c)).toBe(true);
    expect(result.ch.m).toBe(1);
    expect(result.ch.t).toBe(1);
    expect(result.ch.c).toBe(1);
  });

  it('rejects full response_mode for snapshot polling', () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    const result = handleReadSnapshot({
      agent_id: 'watcher',
      response_mode: 'full',
    }) as Record<string, any>;
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('FULL_MODE_FORBIDDEN_IN_POLLING');
  });
});

describe('get_activity_log response modes', () => {
  it('returns compact entries with trimmed details', () => {
    logActivity('watcher', 'compact_test', 'hello compact log');

    const result = handleGetActivityLog({ response_mode: 'compact', limit: 10 }) as Record<string, any>;
    expect(result.success).toBe(true);
    expect(Array.isArray(result.entries)).toBe(true);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries[0].details_chars).toBeTypeOf('number');
  });

  it('returns summary aggregates in summary mode', () => {
    logActivity('a1', 'summary_test', 'summary-check');
    logActivity('a2', 'summary_test', 'summary-check-2');

    const result = handleGetActivityLog({ response_mode: 'summary', limit: 50 }) as Record<string, any>;
    expect(result.success).toBe(true);
    expect(result.summary.count).toBeGreaterThan(0);
    expect(result.summary.unique_agents).toBeGreaterThan(0);
    expect(Array.isArray(result.summary.top_actions)).toBe(true);
  });
});

describe('get_kpi_snapshot response modes', () => {
  it('returns tiny KPI payload when response_mode=tiny', () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    createTask({ title: 'kpi tiny task', created_by: 'watcher' });
    logActivity('watcher', 'kpi_tiny_probe', 'probe');

    const result = handleGetKpiSnapshot({
      requesting_agent: 'watcher',
      response_mode: 'tiny',
    }) as Record<string, any>;

    expect(result.success).toBe(true);
    expect(result.queue).toBeDefined();
    expect(result.latest_window).toBeDefined();
    expect(result.collective_accuracy).toBeDefined();
    expect(result.windows).toBeUndefined();
    expect(result.top_actions_5m).toBeUndefined();
    expect(result.namespace_backlog).toBeUndefined();
    expect(result.execution_backlog).toBeUndefined();
  });
});

describe('get_transport_snapshot', () => {
  it('returns tiny transport metrics payload', () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    logActivity('watcher', 'wait_for_updates_hit', 'changed={"messages":true}');
    logActivity('watcher', 'wait_for_updates_timeout', 'wait_ms=1500 retry_after_ms=240 mode=micro adaptive=1 streams=messages');

    const result = handleGetTransportSnapshot({
      requesting_agent: 'watcher',
      window_sec: 300,
      response_mode: 'tiny',
    }) as Record<string, any>;

    expect(result.success).toBe(true);
    expect(result.transport).toBeDefined();
    expect(result.transport.wait_hits).toBeGreaterThanOrEqual(1);
    expect(result.transport.wait_timeouts).toBeGreaterThanOrEqual(1);
    expect(result.transport.wait_hit_rate_pct).toBeTypeOf('number');
  });
});
