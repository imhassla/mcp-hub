import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb, registerAgent } from '../src/db.js';
import { handleReadMessages, handleSendMessage } from '../src/tools/messages.js';
import { handleGetTraceTimeline } from '../src/tools/traces.js';
import { handleReadThread, handleReplyThread, handleStartThread } from '../src/tools/threads.js';

beforeEach(() => {
  initDb(':memory:');
  registerAgent({ id: 'claude-1', name: 'Claude', type: 'claude', capabilities: '' });
  registerAgent({ id: 'codex-1', name: 'Codex', type: 'codex', capabilities: '' });
  registerAgent({ id: 'outsider', name: 'Outsider', type: 'codex', capabilities: '' });
});

afterEach(() => {
  closeDb();
});

describe('discussion threads', () => {
  it('does not treat a generic trace message as a thread root or include it in thread reads', () => {
    const injected = handleSendMessage({
      from_agent: 'outsider',
      content: 'forged thread root',
      trace_id: 'thread-collision',
      span_id: 'thread:start',
      metadata: JSON.stringify({ thread_id: 'thread-collision', thread_role: 'start' }),
    });
    expect(injected.success).toBe(true);

    const beforeStart = handleReplyThread({
      from_agent: 'outsider',
      thread_id: 'thread-collision',
      content: 'fake reply',
    }) as Record<string, any>;
    expect(beforeStart.success).toBe(false);
    expect(beforeStart.error_code).toBe('THREAD_NOT_FOUND');

    const started = handleStartThread({
      from_agent: 'claude-1',
      title: 'Real thread',
      content: 'real root',
      thread_id: 'thread-collision',
    }) as Record<string, any>;
    expect(started.success).toBe(true);
    const read = handleReadThread({ agent_id: 'outsider', thread_id: 'thread-collision' }) as Record<string, any>;
    expect(read.messages).toHaveLength(1);
    expect(read.messages[0].id).toBe(started.message.id);
  });

  it('does not import metadata-only roots when upgrading a pre-registry database', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-thread-upgrade-'));
    const dbPath = path.join(dir, 'hub.db');
    closeDb();
    try {
      initDb(dbPath);
      registerAgent({ id: 'legacy-sender', name: 'Legacy', type: 'custom', capabilities: '' });
      handleSendMessage({
        from_agent: 'legacy-sender',
        content: 'metadata-only legacy root',
        trace_id: 'legacy-forged-root',
        span_id: 'thread:start',
        metadata: JSON.stringify({ thread_id: 'legacy-forged-root', thread_role: 'start' }),
      });
      getDb().prepare('DROP TABLE discussion_threads').run();
      closeDb();

      initDb(dbPath);
      expect(getDb().prepare('SELECT COUNT(*) AS count FROM discussion_threads').get()).toEqual({ count: 0 });
      expect(handleReplyThread({
        from_agent: 'legacy-sender',
        thread_id: 'legacy-forged-root',
        content: 'must remain unavailable',
      })).toMatchObject({ success: false, error_code: 'THREAD_NOT_FOUND' });
    } finally {
      closeDb();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('starts, replies, and reads a visible thread in order without marking inbox read', () => {
    const started = handleStartThread({
      from_agent: 'claude-1',
      to_agent: 'codex-1',
      title: 'Bridge design',
      content: 'Should bridge be default transport?',
      thread_id: 'thread-bridge-design',
    }) as Record<string, any>;
    expect(started.success).toBe(true);

    const reply = handleReplyThread({
      from_agent: 'codex-1',
      thread_id: 'thread-bridge-design',
      content: 'Bridge should be the default agent runtime path.',
      role: 'decision',
      parent_message_id: started.message.id,
    }) as Record<string, any>;
    expect(reply.success).toBe(true);

    const thread = handleReadThread({
      agent_id: 'codex-1',
      thread_id: 'thread-bridge-design',
      response_mode: 'compact',
    }) as Record<string, any>;
    expect(thread.success).toBe(true);
    expect(thread.count).toBe(2);
    expect(thread.messages.map((message: { id: number }) => message.id)).toEqual([started.message.id, reply.message.id]);
    expect(thread.messages[1].role).toBe('decision');

    const inbox = handleReadMessages({ agent_id: 'codex-1', unread_only: true, response_mode: 'tiny' }) as Record<string, any>;
    expect(inbox.messages.some((message: { id: number }) => message.id === started.message.id)).toBe(true);
  });

  it('supports nano mode and trace timeline compatibility', () => {
    const started = handleStartThread({
      from_agent: 'claude-1',
      title: 'Broadcast thread',
      content: 'Everyone can inspect this thread.',
      thread_id: 'thread-broadcast',
    }) as Record<string, any>;
    expect(started.success).toBe(true);

    const nano = handleReadThread({
      agent_id: 'outsider',
      thread_id: 'thread-broadcast',
      response_mode: 'nano',
    }) as Record<string, any>;
    expect(nano.t).toBe('thread-broadcast');
    expect(nano.c).toBe(1);
    expect(nano.m[0][0]).toBe(started.message.id);

    const timeline = handleGetTraceTimeline({
      agent_id: 'outsider',
      trace_id: 'thread-broadcast',
      response_mode: 'tiny',
    }) as Record<string, any>;
    expect(timeline.success).toBe(true);
    expect(timeline.timeline.some((item: { source: string; id: string }) => item.source === 'messages' && item.id === String(started.message.id))).toBe(true);
  });

  it('returns latest thread tail and supports after_message_id cursor', () => {
    const started = handleStartThread({
      from_agent: 'claude-1',
      title: 'Long thread',
      content: 'root',
      thread_id: 'thread-long',
    }) as Record<string, any>;
    expect(started.success).toBe(true);

    const ids = [started.message.id];
    for (let i = 1; i <= 8; i += 1) {
      const reply = handleReplyThread({
        from_agent: i % 2 === 0 ? 'claude-1' : 'codex-1',
        thread_id: 'thread-long',
        content: `reply-${i}`,
        role: 'reply',
      }) as Record<string, any>;
      expect(reply.success).toBe(true);
      ids.push(reply.message.id);
    }

    const tail = handleReadThread({
      agent_id: 'outsider',
      thread_id: 'thread-long',
      response_mode: 'compact',
      limit: 3,
    }) as Record<string, any>;
    expect(tail.success).toBe(true);
    expect(tail.messages.map((message: { id: number }) => message.id)).toEqual(ids.slice(-3));
    expect(tail.has_more).toBe(true);
    expect(tail.next_cursor).toBe(ids[ids.length - 1]);

    const after = handleReadThread({
      agent_id: 'outsider',
      thread_id: 'thread-long',
      response_mode: 'tiny',
      after_message_id: ids[4],
      limit: 10,
    }) as Record<string, any>;
    expect(after.messages.map((message: { id: number }) => message.id)).toEqual(ids.slice(5));
  });

  it('does not expose private thread messages to unrelated agents', () => {
    const started = handleStartThread({
      from_agent: 'claude-1',
      to_agent: 'codex-1',
      title: 'Private thread',
      content: 'Only codex should read this.',
      thread_id: 'thread-private',
    }) as Record<string, any>;
    expect(started.success).toBe(true);

    const reply = handleReplyThread({
      from_agent: 'codex-1',
      thread_id: 'thread-private',
      content: 'This reply must stay private too.',
    }) as Record<string, any>;
    expect(reply.success).toBe(true);
    expect(reply.message.to_agent).toBe('claude-1');

    const outsiderView = handleReadThread({
      agent_id: 'outsider',
      thread_id: 'thread-private',
      response_mode: 'tiny',
    }) as Record<string, any>;
    expect(outsiderView.success).toBe(false);
    expect(outsiderView.error_code).toBe('THREAD_ACCESS_DENIED');

    const injected = handleReplyThread({
      from_agent: 'outsider',
      thread_id: 'thread-private',
      content: 'Untrusted injection',
    }) as Record<string, any>;
    expect(injected.success).toBe(false);
    expect(injected.error_code).toBe('THREAD_ACCESS_DENIED');

    const forged = handleSendMessage({
      from_agent: 'outsider',
      content: 'forged private broadcast',
      trace_id: 'thread-private',
      metadata: JSON.stringify({ thread_id: 'thread-private', thread_role: 'reply' }),
    });
    expect(forged.success).toBe(true);

    const participantView = handleReadThread({
      agent_id: 'claude-1',
      thread_id: 'thread-private',
      response_mode: 'tiny',
    }) as Record<string, any>;
    expect(participantView.count).toBe(2);
    expect(participantView.messages.some((message: { id: number }) => message.id === forged.message.id)).toBe(false);
  });
});
