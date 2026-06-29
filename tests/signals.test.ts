import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, finalizeArtifactUpload, initDb, registerAgent } from '../src/db.js';
import { handleCreateArtifactUpload, handleShareArtifact, configureArtifactTicketIssuer } from '../src/tools/artifacts.js';
import { handleSendMessage, handleReadMessages } from '../src/tools/messages.js';
import { handleCreateTask } from '../src/tools/tasks.js';
import { handleAckFeedItems, handleReadSignalFeed } from '../src/tools/signals.js';

beforeEach(() => {
  initDb(':memory:');
  registerAgent({ id: 'a1', name: 'A1', type: 'claude', capabilities: '' });
  registerAgent({ id: 'a2', name: 'A2', type: 'codex', capabilities: '' });
  configureArtifactTicketIssuer((args) => ({
    token: `${args.kind}-${args.artifact_id}-${args.agent_id}`,
    expires_at: Date.now() + (args.ttl_sec * 1000),
  }));
});

afterEach(() => {
  closeDb();
});

describe('signal feed tools', () => {
  it('read_signal_feed returns unread messages without marking them read', () => {
    const sent = handleSendMessage({ from_agent: 'a1', to_agent: 'a2', content: 'signal payload' });
    expect(sent.success).toBe(true);
    if (!sent.success) return;

    const feed = handleReadSignalFeed({ agent_id: 'a2', sources: ['messages'], response_mode: 'compact' });
    expect(feed.success).toBe(true);
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      source: 'messages',
      id: String(sent.message.id),
      from_agent: 'a1',
      to_agent: 'a2',
    });

    const unread = handleReadMessages({ agent_id: 'a2', unread_only: true, response_mode: 'compact' });
    expect(unread.messages).toHaveLength(1);
    expect(unread.messages[0].id).toBe(sent.message.id);
  });

  it('adds thread metadata to message signals and suppresses self-broadcast by default', () => {
    const selfSent = handleSendMessage({
      from_agent: 'a1',
      content: 'self broadcast',
      metadata: JSON.stringify({ thread_id: 'thread-signal', thread_role: 'proposal' }),
      trace_id: 'thread-signal',
    });
    expect(selfSent.success).toBe(true);

    const selfFeed = handleReadSignalFeed({ agent_id: 'a1', sources: ['messages'], response_mode: 'compact' });
    expect(selfFeed.success).toBe(true);
    expect(selfFeed.items).toHaveLength(0);

    const selfIncluded = handleReadSignalFeed({ agent_id: 'a1', sources: ['messages'], response_mode: 'tiny', include_self: true });
    expect(selfIncluded.items).toHaveLength(1);
    expect(selfIncluded.items[0]).toMatchObject({
      source: 'messages',
      id: String(selfSent.message.id),
      trace_id: 'thread-signal',
      thread_id: 'thread-signal',
      thread_role: 'proposal',
    });

    const peerFeed = handleReadSignalFeed({ agent_id: 'a2', sources: ['messages'], response_mode: 'compact' });
    expect(peerFeed.items[0]).toMatchObject({
      source: 'messages',
      id: String(selfSent.message.id),
      trace_id: 'thread-signal',
      thread_id: 'thread-signal',
      thread_role: 'proposal',
    });
  });

  it('ack_feed_items hides message signals without marking them read by default', () => {
    const sent = handleSendMessage({ from_agent: 'a1', to_agent: 'a2', content: 'ack only' });
    expect(sent.success).toBe(true);
    if (!sent.success) return;

    const acked = handleAckFeedItems({ agent_id: 'a2', refs: { messages: [sent.message.id] } });
    expect(acked.success).toBe(true);
    expect(acked.acked).toBe(1);

    const feed = handleReadSignalFeed({ agent_id: 'a2', sources: ['messages'] });
    expect(feed.items).toHaveLength(0);

    const unread = handleReadMessages({ agent_id: 'a2', unread_only: true, response_mode: 'compact' });
    expect(unread.messages).toHaveLength(1);
    expect(unread.messages[0].id).toBe(sent.message.id);
  });

  it('ack_feed_items can mark message refs read explicitly', () => {
    const sent = handleSendMessage({ from_agent: 'a1', to_agent: 'a2', content: 'ack and read' });
    expect(sent.success).toBe(true);
    if (!sent.success) return;

    const acked = handleAckFeedItems({
      agent_id: 'a2',
      refs: { messages: [sent.message.id] },
      mark_messages_read: true,
    });
    expect(acked.success).toBe(true);
    expect(acked.acked).toBe(1);

    const unread = handleReadMessages({ agent_id: 'a2', unread_only: true, response_mode: 'compact' });
    expect(unread.messages).toHaveLength(0);
  });

  it('read_signal_feed surfaces assigned and high-priority unassigned tasks', () => {
    const assigned = handleCreateTask({ title: 'Assigned signal', created_by: 'a1', assigned_to: 'a2' });
    const high = handleCreateTask({ title: 'High signal', created_by: 'a1', priority: 'high' });
    handleCreateTask({ title: 'Low background', created_by: 'a1', priority: 'low' });

    const feed = handleReadSignalFeed({ agent_id: 'a2', sources: ['tasks'], response_mode: 'compact' });
    expect(feed.items.map((item: any) => item.id).sort()).toEqual([String(assigned.task.id), String(high.task.id)].sort());

    const acked = handleAckFeedItems({ agent_id: 'a2', refs: { tasks: [assigned.task.id] } });
    expect(acked.acked).toBe(1);

    const afterAck = handleReadSignalFeed({ agent_id: 'a2', sources: ['tasks'], response_mode: 'compact' });
    expect(afterAck.items.map((item: any) => item.id)).toEqual([String(high.task.id)]);
  });

  it('read_signal_feed surfaces visible ready artifacts and ack hides them', () => {
    const created = handleCreateArtifactUpload({
      agent_id: 'a1',
      name: 'signal.bin',
      summary: 'artifact signal payload',
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    finalizeArtifactUpload({
      id: created.artifact.id,
      size_bytes: 64,
      sha256: 'b'.repeat(64),
      storage_path: '/tmp/signal.bin',
    });
    handleShareArtifact({
      from_agent: 'a1',
      artifact_id: created.artifact.id,
      to_agent: 'a2',
      notify: false,
    });

    const feed = handleReadSignalFeed({ agent_id: 'a2', sources: ['artifacts'], response_mode: 'compact' });
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({ source: 'artifacts', id: created.artifact.id, name: 'signal.bin' });

    handleAckFeedItems({ agent_id: 'a2', refs: { artifacts: [created.artifact.id] } });
    const afterAck = handleReadSignalFeed({ agent_id: 'a2', sources: ['artifacts'], response_mode: 'compact' });
    expect(afterAck.items).toHaveLength(0);
  });
});
