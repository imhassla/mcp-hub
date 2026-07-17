import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendStreamEvent, cleanupStreamEvents, closeDb, getStreamEventWatermark, initDb, registerAgent } from '../src/db.js';
import { handleGetHubDigest } from '../src/tools/digest.js';
import { handleSendMessage, handleReadMessages } from '../src/tools/messages.js';
import { handleCreateTask } from '../src/tools/tasks.js';
import { handleShareContext } from '../src/tools/context.js';
import { handleWriteMemory } from '../src/tools/memory.js';

beforeEach(() => {
  initDb(':memory:');
  registerAgent({ id: 'a1', name: 'A1', type: 'claude', capabilities: '' });
  registerAgent({ id: 'a2', name: 'A2', type: 'codex', capabilities: '' });
});

afterEach(() => {
  closeDb();
});

describe('get_hub_digest', () => {
  it('returns bounded cross-source digest without marking signal messages read', () => {
    const baseline = getStreamEventWatermark({ agent_id: 'a2', streams: ['messages', 'tasks', 'context'] });
    const sent = handleSendMessage({ from_agent: 'a1', to_agent: 'a2', content: 'digest message' });
    expect(sent.success).toBe(true);
    if (!sent.success) return;
    const task = handleCreateTask({ title: 'Digest task', created_by: 'a1', assigned_to: 'a2', priority: 'high' });
    handleShareContext({ agent_id: 'a2', key: 'digest-key', value: 'digest context value' });

    const digest = handleGetHubDigest({
      agent_id: 'a2',
      sections: ['signals', 'events', 'tasks', 'context'],
      streams: ['messages', 'tasks', 'context'],
      cursor: `e:${baseline.toString(36)}`,
      limit_per_source: 3,
      response_mode: 'compact',
    });
    expect(digest.success).toBe(true);
    expect(digest.sections).toEqual(['signals', 'events', 'tasks', 'context']);
    expect((digest.digest as any).signals.items.some((item: any) => item.source === 'messages' && item.id === String(sent.message.id))).toBe(true);
    expect((digest.digest as any).events.events.some((event: any) => event.stream === 'messages' && event.entity_id === String(sent.message.id))).toBe(true);
    expect((digest.digest as any).tasks.items.some((item: any) => item.id === task.task.id)).toBe(true);
    expect((digest.digest as any).context.some((item: any) => item.key === 'digest-key')).toBe(true);

    const unread = handleReadMessages({ agent_id: 'a2', unread_only: true, response_mode: 'compact' });
    expect(unread.messages).toHaveLength(1);
    expect(unread.messages[0].id).toBe(sent.message.id);
  });

  it('supports tiny and nano bounded modes', () => {
    handleCreateTask({ title: 'Tiny digest task', created_by: 'a1', assigned_to: 'a2' });
    const tiny = handleGetHubDigest({
      agent_id: 'a2',
      sections: ['tasks'],
      limit_per_source: 1,
      response_mode: 'tiny',
    });
    expect(tiny.success).toBe(true);
    expect((tiny.digest as any).tasks.items).toHaveLength(1);
    expect((tiny.digest as any).tasks.items[0].digest).toHaveLength(12);

    const nano = handleGetHubDigest({
      agent_id: 'a2',
      sections: ['tasks'],
      limit_per_source: 1,
      response_mode: 'nano',
    });
    expect(nano.s).toEqual(['tasks']);
    expect((nano.d as any).tasks.i).toHaveLength(1);
  });

  it('includes shared memory as a bounded digest section', () => {
    const written = handleWriteMemory({
      agent_id: 'a1',
      namespace: 'project-memory',
      key: 'decision-runtime-bridge',
      text: 'Use bridge-runner as default for Codex MCP cancellation risk.',
      tags: ['bridge', 'codex'],
      importance: 0.91,
    }) as Record<string, any>;
    expect(written.success).toBe(true);

    const digest = handleGetHubDigest({
      agent_id: 'a2',
      sections: ['memory'],
      memory_namespace: 'project-memory',
      limit_per_source: 2,
      response_mode: 'compact',
    }) as Record<string, any>;

    expect(digest.success).toBe(true);
    expect(digest.sections).toEqual(['memory']);
    expect(digest.digest.memory.count).toBe(1);
    expect(digest.digest.memory.memories[0].key).toBe('decision-runtime-bridge');
  });

  it('rejects malformed event cursors', () => {
    const result = handleGetHubDigest({
      agent_id: 'a2',
      sections: ['events'],
      cursor: 'e:12-not-valid',
    }) as Record<string, any>;
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('CURSOR_INVALID');
  });

  it('parses prefixed event cursors as base36 even when they contain only digits', () => {
    const baseline = getStreamEventWatermark({ agent_id: 'a2', streams: ['messages'] });
    for (let i = 0; i < 40; i += 1) {
      handleSendMessage({ from_agent: 'a1', to_agent: 'a2', content: `cursor message ${i}` });
    }

    const decimalTen = handleGetHubDigest({
      agent_id: 'a2',
      sections: ['events'],
      streams: ['messages'],
      cursor: '10',
      limit_per_source: 100,
      response_mode: 'compact',
    }) as Record<string, any>;
    const base36Ten = handleGetHubDigest({
      agent_id: 'a2',
      sections: ['events'],
      streams: ['messages'],
      cursor: 'e:10',
      limit_per_source: 100,
      response_mode: 'compact',
    }) as Record<string, any>;

    expect(decimalTen.success).toBe(true);
    expect(base36Ten.success).toBe(true);
    expect((decimalTen.digest.events.events as any[]).length).toBeGreaterThan((base36Ten.digest.events.events as any[]).length);
    expect((base36Ten.digest.events.events as any[]).every((event) => event.id > 36)).toBe(true);
    expect(baseline).toBeGreaterThanOrEqual(0);
  });

  it('marks digest event cursors stale after stream event cleanup', () => {
    const oldEvent = appendStreamEvent({
      stream: 'messages',
      op: 'created',
      entity_id: 'digest-old',
      target_agent_id: 'a2',
      created_at: 1_000,
    });
    const missedEvent = appendStreamEvent({
      stream: 'messages',
      op: 'created',
      entity_id: 'digest-missed',
      target_agent_id: 'a2',
      created_at: 1_200,
    });
    appendStreamEvent({
      stream: 'messages',
      op: 'created',
      entity_id: 'digest-retained',
      target_agent_id: 'a2',
      created_at: 2_000,
    });
    cleanupStreamEvents(2_500, 1_000);

    const digest = handleGetHubDigest({
      agent_id: 'a2',
      sections: ['events'],
      streams: ['messages'],
      cursor: `e:${oldEvent.id.toString(36)}`,
      response_mode: 'tiny',
    }) as Record<string, any>;

    expect(digest.success).toBe(true);
    expect(digest.digest.events.cursor_stale).toBe(true);
    expect(digest.digest.events.resync_required).toBe(true);
    expect(digest.digest.events.min_event_id).toBe(missedEvent.id);
  });
});
