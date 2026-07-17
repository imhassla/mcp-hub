import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendStreamEvent, cleanupStreamEvents, closeDb, createTask, getStreamEventWatermark, initDb, logActivity, readMessages, registerAgent, sendMessage, shareContext } from '../src/db.js';
import { handleGetActivityLog, handleGetKpiSnapshot, handleGetTransportSnapshot, handleReadEventDeltas, handleReadSnapshot, handleWaitForUpdates } from '../src/tools/activity.js';

beforeEach(() => {
  initDb(':memory:');
});

afterEach(() => {
  closeDb();
});

describe('watcher identity scoping', () => {
  it('rejects a requesting_agent/agent_id mismatch across snapshot, wait, and delta reads', async () => {
    const args = { requesting_agent: 'agent-a', agent_id: 'agent-b' };
    const snapshot = handleReadSnapshot(args) as Record<string, unknown>;
    const wait = await handleWaitForUpdates({ ...args, wait_ms: 10 }) as Record<string, unknown>;
    const deltas = handleReadEventDeltas(args) as Record<string, unknown>;

    for (const result of [snapshot, wait, deltas]) {
      expect(result.success).toBe(false);
      expect(result.error_code).toBe('AGENT_SCOPE_MISMATCH');
    }
  });
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
      artifacts: false,
      consensus: false,
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

  it('detects same-millisecond message bursts with event cursors', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });

    const idle = await handleWaitForUpdates({
      agent_id: 'watcher',
      wait_ms: 20,
      poll_interval_ms: 10,
      response_mode: 'compact',
      adaptive_retry: false,
    }) as Record<string, any>;

    expect(idle.changed).toBe(false);
    expect(idle.cursor).toMatch(/^e:/);

    sendMessage('sender', 'watcher', 'event-1');
    sendMessage('sender', 'watcher', 'event-2');

    const hit = await handleWaitForUpdates({
      agent_id: 'watcher',
      cursor: idle.cursor,
      wait_ms: 120,
      poll_interval_ms: 10,
      response_mode: 'compact',
    }) as Record<string, any>;

    expect(hit.changed).toBe(true);
    expect(hit.cursor).toMatch(/^e:/);
    expect(hit.streams).toEqual(['messages']);
    expect(hit.events.map((event: { op: string }) => event.op)).toEqual(['message.created', 'message.created']);
    expect(hit.events[0].id).toBeLessThan(hit.events[1].id);

    const snapshot = handleReadSnapshot({
      agent_id: 'watcher',
      cursor: idle.cursor,
      response_mode: 'compact',
      message_limit: 10,
      task_limit: 10,
      context_limit: 10,
    }) as Record<string, any>;

    expect(snapshot.changed.messages).toBe(true);
    expect(snapshot.cursor).toMatch(/^e:/);
    expect(snapshot.events.map((event: { op: string }) => event.op)).toContain('message.created');

    const afterSnapshot = await handleWaitForUpdates({
      agent_id: 'watcher',
      cursor: snapshot.cursor,
      wait_ms: 120,
      poll_interval_ms: 10,
      response_mode: 'compact',
      adaptive_retry: false,
    }) as Record<string, any>;
    expect(afterSnapshot.changed).toBe(false);
  });

  it('accepts artifact and consensus streams advertised by the tool schema', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    const baseline = await handleWaitForUpdates({
      agent_id: 'watcher',
      wait_ms: 20,
      poll_interval_ms: 10,
      response_mode: 'compact',
      adaptive_retry: false,
    }) as Record<string, any>;

    appendStreamEvent({ stream: 'artifacts', op: 'artifact.ready', entity_id: 'artifact-1', target_agent_id: 'watcher' });
    appendStreamEvent({ stream: 'consensus', op: 'consensus.saved', entity_id: 'decision-1', target_agent_id: 'watcher' });

    const hit = await handleWaitForUpdates({
      agent_id: 'watcher',
      cursor: baseline.cursor,
      streams: ['artifacts', 'consensus'] as any,
      wait_ms: 120,
      poll_interval_ms: 10,
      response_mode: 'compact',
      adaptive_retry: false,
    }) as Record<string, any>;

    expect(hit.success).toBe(true);
    expect(hit.changed).toBe(true);
    expect(hit.streams).toEqual(['artifacts', 'consensus']);
    expect(hit.events.map((event: { op: string }) => event.op)).toEqual(['artifact.ready', 'consensus.saved']);
  });

  it('returns compact hit payload with changed streams and event metadata', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    const baseline = await handleWaitForUpdates({
      agent_id: 'watcher',
      wait_ms: 20,
      poll_interval_ms: 10,
      response_mode: 'compact',
      adaptive_retry: false,
    }) as Record<string, any>;

    setTimeout(() => {
      sendMessage('sender', 'watcher', 'ping');
    }, 50);

    const result = await handleWaitForUpdates({
      agent_id: 'watcher',
      cursor: baseline.cursor,
      wait_ms: 1000,
      poll_interval_ms: 100,
      response_mode: 'compact',
    }) as Record<string, any>;

    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
    expect(typeof result.cursor).toBe('string');
    expect(result.streams).toContain('messages');
    expect(result.event_id).toBeGreaterThan(baseline.event_id);
    expect(result.events[0].op).toBe('message.created');
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

  it('returns tiny hit payload with compact event metadata', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    const baseline = await handleWaitForUpdates({
      agent_id: 'watcher',
      wait_ms: 20,
      poll_interval_ms: 10,
      response_mode: 'tiny',
      adaptive_retry: false,
    }) as Record<string, any>;

    setTimeout(() => {
      sendMessage('sender', 'watcher', 'ping');
    }, 50);

    const result = await handleWaitForUpdates({
      agent_id: 'watcher',
      cursor: baseline.cursor,
      wait_ms: 1000,
      poll_interval_ms: 100,
      response_mode: 'tiny',
    }) as Record<string, any>;

    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
    expect(typeof result.cursor).toBe('string');
    expect(result.streams).toContain('messages');
    expect(result.event_id).toBeGreaterThan(baseline.event_id);
    expect(result.watermark).toBeUndefined();
  });

  it('returns micro hit payload without watermark fields', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    const baseline = await handleWaitForUpdates({
      agent_id: 'watcher',
      wait_ms: 20,
      poll_interval_ms: 10,
      response_mode: 'micro',
      adaptive_retry: false,
    }) as Record<string, any>;

    setTimeout(() => {
      sendMessage('sender', 'watcher', 'micro-ping');
    }, 50);

    const result = await handleWaitForUpdates({
      agent_id: 'watcher',
      cursor: baseline.cursor,
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
    const baseline = await handleWaitForUpdates({
      agent_id: 'watcher',
      wait_ms: 20,
      poll_interval_ms: 10,
      response_mode: 'nano',
      adaptive_retry: false,
    }) as Record<string, any>;

    setTimeout(() => {
      sendMessage('sender', 'watcher', 'nano-ping');
    }, 50);

    const result = await handleWaitForUpdates({
      agent_id: 'watcher',
      cursor: baseline.u,
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

    const partial = await handleWaitForUpdates({
      agent_id: 'watcher',
      cursor: 'e:1!junk',
      wait_ms: 120,
      poll_interval_ms: 100,
      response_mode: 'tiny',
    }) as Record<string, any>;
    expect(partial.success).toBe(false);
    expect(partial.error_code).toBe('CURSOR_INVALID');
  });

  it('marks wait cursors stale when retained event history has a gap', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    const oldEvent = appendStreamEvent({
      stream: 'messages',
      op: 'created',
      entity_id: 'old',
      target_agent_id: 'watcher',
      created_at: 1_000,
    });
    const missedEvent = appendStreamEvent({
      stream: 'messages',
      op: 'created',
      entity_id: 'missed',
      target_agent_id: 'watcher',
      created_at: 1_200,
    });
    const retainedEvent = appendStreamEvent({
      stream: 'messages',
      op: 'created',
      entity_id: 'retained',
      target_agent_id: 'watcher',
      created_at: 2_000,
    });
    cleanupStreamEvents(2_500, 1_000);

    const result = await handleWaitForUpdates({
      agent_id: 'watcher',
      cursor: `e:${oldEvent.id.toString(36)}`,
      streams: ['messages'],
      wait_ms: 20,
      poll_interval_ms: 10,
      response_mode: 'tiny',
      adaptive_retry: false,
    }) as Record<string, any>;

    expect(result.success).toBe(true);
    expect(result.cursor_stale).toBe(true);
    expect(result.resync_required).toBe(true);
    expect(result.resync_hint).toBe('read_snapshot');
    expect(result.min_event_id).toBe(missedEvent.id);
    expect(result.event_id).toBe(retainedEvent.id);
  });

  it('should support stream filtering and ignore non-watched updates', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    const baseline = await handleWaitForUpdates({
      agent_id: 'watcher',
      streams: ['tasks'],
      wait_ms: 20,
      poll_interval_ms: 10,
      response_mode: 'micro',
      adaptive_retry: false,
    }) as Record<string, any>;

    setTimeout(() => {
      sendMessage('sender', 'watcher', 'message-ignored-for-tasks-stream');
    }, 50);

    const ignored = await handleWaitForUpdates({
      agent_id: 'watcher',
      streams: ['tasks'],
      cursor: baseline.cursor,
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
  it('performs a full state resync when TTL cleanup removed the entire event window', () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    createTask({ title: 'known-before-cursor', created_by: 'watcher' });
    const oldCursor = getStreamEventWatermark({ agent_id: 'watcher' });
    const missedTask = createTask({ title: 'missed-after-cursor', created_by: 'watcher' });

    cleanupStreamEvents(Date.now() + 10_000, 1);

    const snapshot = handleReadSnapshot({
      agent_id: 'watcher',
      cursor: `e:${oldCursor.toString(36)}`,
      response_mode: 'compact',
    }) as Record<string, any>;

    expect(snapshot.success).toBe(true);
    expect(snapshot.cursor_stale).toBe(true);
    expect(snapshot.resync_performed).toBe(true);
    expect(snapshot.event_id).toBeGreaterThan(oldCursor);
    expect(snapshot.cursor).toBe(`e:${snapshot.event_id.toString(36)}`);
    expect(snapshot.snapshot.tasks.tasks.map((task: { id: number }) => task.id)).toContain(missedTask.id);
  });

  it('returns nano batch with unified event cursor', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });

    const baseline = await handleWaitForUpdates({
      agent_id: 'watcher',
      wait_ms: 20,
      poll_interval_ms: 10,
      response_mode: 'nano',
      adaptive_retry: false,
    }) as Record<string, any>;

    sendMessage('sender', 'watcher', 'snapshot-msg');
    createTask({ title: 'snapshot-task', created_by: 'watcher' });
    shareContext('watcher', 'snapshot-key', '{"ok":true}');

    const result = handleReadSnapshot({
      agent_id: 'watcher',
      cursor: baseline.u,
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

  it('does not advance cursor past unreturned event refs under burst load', () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    const baseline = getStreamEventWatermark({ agent_id: 'watcher', streams: ['activity'] });
    for (let i = 0; i < 1005; i += 1) {
      appendStreamEvent({
        stream: 'activity',
        op: 'burst',
        entity_id: `burst-${i}`,
        agent_id: 'sender',
      });
    }

    const first = handleReadSnapshot({
      agent_id: 'watcher',
      cursor: `e:${baseline.toString(36)}`,
      response_mode: 'compact',
    }) as Record<string, any>;

    expect(first.success).toBe(true);
    expect(first.events).toHaveLength(1000);
    expect(first.events_has_more).toBe(true);
    expect(first.event_id).toBe(first.events[999].id);
    expect(first.event_watermark).toBeGreaterThan(first.event_id);
    expect(first.cursor).toBe(`e:${first.event_id.toString(36)}`);

    const second = handleReadSnapshot({
      agent_id: 'watcher',
      cursor: first.cursor,
      response_mode: 'compact',
    }) as Record<string, any>;

    expect(second.success).toBe(true);
    expect(second.events).toHaveLength(5);
    expect(second.events_has_more).toBe(false);
    expect(second.event_id).toBe(second.event_watermark);
  });

  it('includes artifact and consensus refs in snapshot event deltas', () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    const baseline = getStreamEventWatermark({ agent_id: 'watcher' });
    appendStreamEvent({ stream: 'artifacts', op: 'artifact.ready', entity_id: 'artifact-2', target_agent_id: 'watcher' });
    appendStreamEvent({ stream: 'consensus', op: 'consensus.saved', entity_id: 'decision-2', target_agent_id: 'watcher' });

    const snapshot = handleReadSnapshot({
      agent_id: 'watcher',
      cursor: `e:${baseline.toString(36)}`,
      response_mode: 'compact',
    }) as Record<string, any>;

    expect(snapshot.success).toBe(true);
    expect(snapshot.changed.artifacts).toBe(true);
    expect(snapshot.changed.consensus).toBe(true);
    expect(snapshot.events.map((event: { stream: string }) => event.stream)).toEqual(['artifacts', 'consensus']);
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

  it('does not read unchanged streams when an event cursor has no changes', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    sendMessage('sender', 'watcher', 'pre-cursor-unread');

    const baseline = await handleWaitForUpdates({
      agent_id: 'watcher',
      wait_ms: 20,
      poll_interval_ms: 10,
      response_mode: 'compact',
      adaptive_retry: false,
    }) as Record<string, any>;

    const snapshot = handleReadSnapshot({
      agent_id: 'watcher',
      cursor: baseline.cursor,
      response_mode: 'compact',
      message_unread_only: true,
    }) as Record<string, any>;

    expect(snapshot.changed.messages).toBe(false);
    expect(snapshot.snapshot.messages.messages).toEqual([]);
    expect(readMessages('watcher', { unread_only: true })).toHaveLength(1);
  });

  it('does not mark pre-cursor unread messages read when a later message event changes the stream', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    const oldMessage = sendMessage('sender', 'watcher', 'old-unread-before-cursor');

    const baseline = await handleWaitForUpdates({
      agent_id: 'watcher',
      wait_ms: 20,
      poll_interval_ms: 10,
      response_mode: 'compact',
      adaptive_retry: false,
    }) as Record<string, any>;

    sendMessage('sender', 'watcher', 'new-unread-after-cursor');
    const snapshot = handleReadSnapshot({
      agent_id: 'watcher',
      cursor: baseline.cursor,
      response_mode: 'compact',
      message_unread_only: true,
    }) as Record<string, any>;

    expect(snapshot.changed.messages).toBe(true);
    expect(snapshot.snapshot.messages.messages.length).toBeGreaterThan(0);
    const unread = readMessages('watcher', { unread_only: true, mark_read: false });
    expect(unread.some((message) => message.id === oldMessage.id)).toBe(true);
  });
});

describe('read_event_deltas', () => {
  it('returns exact changed refs for retained events', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    const baseline = await handleWaitForUpdates({
      agent_id: 'watcher',
      wait_ms: 20,
      poll_interval_ms: 10,
      response_mode: 'compact',
      adaptive_retry: false,
    }) as Record<string, any>;

    const message = sendMessage('sender', 'watcher', 'delta-message');
    const task = createTask({ title: 'delta-task', created_by: 'watcher' });
    shareContext('watcher', 'delta-key', 'delta-value');

    const deltas = handleReadEventDeltas({
      agent_id: 'watcher',
      cursor: baseline.cursor,
      streams: ['messages', 'tasks', 'context'],
      response_mode: 'compact',
      include_payload: true,
    }) as Record<string, any>;

    expect(deltas.success).toBe(true);
    expect(deltas.changed).toBe(true);
    expect(deltas.cursor).toMatch(/^e:/);
    expect(deltas.events.map((event: { entity_id: string }) => event.entity_id)).toContain(String(message.id));
    expect(deltas.events.map((event: { entity_id: string }) => event.entity_id)).toContain(String(task.id));
    expect(deltas.events.every((event: { payload?: unknown }) => event.payload !== undefined)).toBe(true);

    const next = handleReadEventDeltas({
      agent_id: 'watcher',
      cursor: deltas.cursor,
      streams: ['messages', 'tasks', 'context'],
      response_mode: 'tiny',
    }) as Record<string, any>;
    expect(next.changed).toBe(false);
    expect(next.events).toEqual([]);
  });

  it('supports e:0 replay and nano output', () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    sendMessage('sender', 'watcher', 'delta-replay');

    const result = handleReadEventDeltas({
      agent_id: 'watcher',
      cursor: 'e:0',
      streams: ['messages'],
      response_mode: 'nano',
    }) as Record<string, any>;

    expect(result.c).toBe(1);
    expect(result.u).toMatch(/^e:/);
    expect(result.s).toEqual(['messages']);
    expect(result.e[0][1]).toBe('messages');
  });

  it('marks delta cursors stale when older retained events were cleaned up', () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    const oldEvent = appendStreamEvent({
      stream: 'messages',
      op: 'created',
      entity_id: 'old-delta',
      target_agent_id: 'watcher',
      created_at: 1_000,
    });
    const missedEvent = appendStreamEvent({
      stream: 'messages',
      op: 'created',
      entity_id: 'missed-delta',
      target_agent_id: 'watcher',
      created_at: 1_200,
    });
    const retainedEvent = appendStreamEvent({
      stream: 'messages',
      op: 'created',
      entity_id: 'retained-delta',
      target_agent_id: 'watcher',
      created_at: 2_000,
    });
    cleanupStreamEvents(2_500, 1_000);

    const result = handleReadEventDeltas({
      agent_id: 'watcher',
      cursor: `e:${oldEvent.id.toString(36)}`,
      streams: ['messages'],
      response_mode: 'tiny',
    }) as Record<string, any>;

    expect(result.success).toBe(true);
    expect(result.cursor_stale).toBe(true);
    expect(result.resync_required).toBe(true);
    expect(result.min_event_id).toBe(missedEvent.id);
    expect(result.events.map((event: { entity_id: string }) => event.entity_id)).toEqual(['retained-delta']);
  });

  it('does not mark a cursor stale merely because it precedes the first visible event', () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    appendStreamEvent({ stream: 'messages', op: 'created', entity_id: 'private-1', target_agent_id: 'other' });
    appendStreamEvent({ stream: 'messages', op: 'created', entity_id: 'private-2', target_agent_id: 'other' });
    const visibleEvent = appendStreamEvent({
      stream: 'messages',
      op: 'created',
      entity_id: 'visible',
      target_agent_id: 'watcher',
    });

    const result = handleReadEventDeltas({
      agent_id: 'watcher',
      cursor: 'e:1',
      streams: ['messages'],
      response_mode: 'tiny',
    }) as Record<string, any>;

    expect(result.success).toBe(true);
    expect(result.cursor_stale).toBeUndefined();
    expect(result.resync_required).toBeUndefined();
    expect(result.events.map((event: { entity_id: string }) => event.entity_id)).toEqual(['visible']);
    expect(result.event_id).toBe(visibleEvent.id);
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

describe('wait_for_updates final-window event delivery (F4)', () => {
  it('delivers an event that arrives during the final poll window instead of skipping it on timeout', async () => {
    registerAgent({ id: 'watcher', name: 'Watcher', type: 'codex', capabilities: '' });
    registerAgent({ id: 'sender', name: 'Sender', type: 'codex', capabilities: '' });

    // Insert the message ~50ms in: after the single in-loop query (t=0) but before the deadline.
    // With poll_interval_ms large and wait_ms small, the loop queries once then sleeps past the
    // deadline; only the post-loop final query can catch this event. The pre-fix code advanced
    // the timeout cursor to the watermark (which includes this event) and reported changed:false,
    // permanently skipping it.
    setTimeout(() => { sendMessage('sender', 'watcher', 'final-window'); }, 50);

    const result = await handleWaitForUpdates({
      agent_id: 'watcher',
      streams: ['messages'],
      wait_ms: 150,
      poll_interval_ms: 2000,
      response_mode: 'compact',
      adaptive_retry: false,
    }) as Record<string, any>;

    expect(result.changed).toBe(true);
    expect(result.streams).toContain('messages');
    expect(result.events?.[0]?.op).toBe('message.created');
  });
});
