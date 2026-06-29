import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb, logActivity, registerAgent } from '../src/db.js';
import { handleShareContext } from '../src/tools/context.js';
import { handleSendMessage } from '../src/tools/messages.js';
import { handleCreateTask } from '../src/tools/tasks.js';
import { handleGetTraceTimeline } from '../src/tools/traces.js';

beforeEach(() => {
  initDb(':memory:');
  registerAgent({ id: 'a1', name: 'A1', type: 'claude', capabilities: '' });
  registerAgent({ id: 'a2', name: 'A2', type: 'codex', capabilities: '' });
  registerAgent({ id: 'a3', name: 'A3', type: 'codex', capabilities: '' });
});

afterEach(() => {
  closeDb();
});

describe('get_trace_timeline', () => {
  it('returns a compact ordered trace across visible messages, tasks, context, and own activity', () => {
    handleSendMessage({ from_agent: 'a1', to_agent: 'a2', content: 'trace hello', trace_id: 'trace-1', span_id: 'span-msg' });
    handleCreateTask({ title: 'Trace task', created_by: 'a1', assigned_to: 'a2', trace_id: 'trace-1', span_id: 'span-task' });
    handleShareContext({ agent_id: 'a2', key: 'trace-state', value: 'working', trace_id: 'trace-1', span_id: 'span-ctx' });
    logActivity('a2', 'trace_marker', 'trace-1 reached bridge runner');

    const result = handleGetTraceTimeline({
      agent_id: 'a2',
      trace_id: 'trace-1',
      response_mode: 'compact',
    }) as Record<string, any>;

    expect(result.success).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(4);
    expect(result.counts.messages).toBe(1);
    expect(result.counts.tasks).toBe(1);
    expect(result.counts.context).toBe(1);
    expect(result.counts.activity).toBe(1);
    expect(result.timeline.map((item: { source: string }) => item.source)).toContain('messages');
    expect(result.timeline.map((item: { span_id: string | null }) => item.span_id)).toContain('span-task');
  });

  it('does not expose private messages outside the requesting agent visibility', () => {
    handleSendMessage({ from_agent: 'a1', to_agent: 'a2', content: 'private trace hello', trace_id: 'trace-private' });

    const result = handleGetTraceTimeline({
      agent_id: 'a3',
      trace_id: 'trace-private',
      response_mode: 'tiny',
    }) as Record<string, any>;

    expect(result.success).toBe(true);
    expect(result.timeline.some((item: { source: string }) => item.source === 'messages')).toBe(false);
  });

  it('supports nano output', () => {
    handleCreateTask({ title: 'Nano trace task', created_by: 'a1', assigned_to: 'a2', trace_id: 'trace-nano' });

    const result = handleGetTraceTimeline({
      agent_id: 'a2',
      trace_id: 'trace-nano',
      response_mode: 'nano',
    }) as Record<string, any>;

    expect(result.t).toBe('trace-nano');
    expect(result.c).toBe(1);
    expect(result.i[0][0]).toBe('t');
  });
});
