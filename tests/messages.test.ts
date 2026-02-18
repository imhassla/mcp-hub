import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, registerAgent } from '../src/db.js';
import { handleSendMessage, handleSendBlobMessage, handleReadMessages } from '../src/tools/messages.js';

beforeEach(() => {
  initDb(':memory:');
  registerAgent({ id: 'a1', name: 'A1', type: 'claude', capabilities: '' });
  registerAgent({ id: 'a2', name: 'A2', type: 'codex', capabilities: '' });
});
afterEach(() => { closeDb(); });

describe('message tools', () => {
  it('send_message should create a message', () => {
    const result = handleSendMessage({ from_agent: 'a1', to_agent: 'a2', content: 'Hello' });
    expect(result.success).toBe(true);
    expect(result.message.content).toBe('Hello');
  });

  it('send_message should preserve trace_id/span_id in full and nano reads', () => {
    handleSendMessage({
      from_agent: 'a1',
      to_agent: 'a2',
      content: 'trace-check',
      trace_id: 'trace-1234567890',
      span_id: 'span-abcdef',
    });
    const full = handleReadMessages({ agent_id: 'a2' });
    expect(full.messages).toHaveLength(1);
    expect(full.messages[0].trace_id).toBe('trace-1234567890');
    expect(full.messages[0].span_id).toBe('span-abcdef');

    handleSendMessage({
      from_agent: 'a1',
      to_agent: 'a2',
      content: 'trace-nano',
      trace_id: 'trace-zzzzzz',
      span_id: 'span-yyyyyy',
    });
    const nano = handleReadMessages({ agent_id: 'a2', response_mode: 'nano', unread_only: true });
    expect(nano.m).toHaveLength(1);
    expect(nano.m[0].x).toBe('trace-zzzzzz');
    expect(nano.m[0].y).toBe('span-yyyyyy');
  });

  it('read_messages should return messages', () => {
    handleSendMessage({ from_agent: 'a1', to_agent: 'a2', content: 'Test' });
    const result = handleReadMessages({ agent_id: 'a2' });
    expect(result.messages).toHaveLength(1);
  });

  it('broadcast should be readable by any agent', () => {
    handleSendMessage({ from_agent: 'a1', content: 'Broadcast' });
    const r1 = handleReadMessages({ agent_id: 'a2' });
    expect(r1.messages).toHaveLength(1);
  });

  it('send_message should reject oversized content', () => {
    const tooLong = 'x'.repeat(1025);
    const result = handleSendMessage({ from_agent: 'a1', to_agent: 'a2', content: tooLong });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error_code).toBe('CONTENT_TOO_LONG');
  });

  it('read_messages should apply default limit when not provided', () => {
    for (let i = 0; i < 60; i += 1) {
      handleSendMessage({ from_agent: 'a1', to_agent: 'a2', content: `m${i}` });
    }
    const result = handleReadMessages({ agent_id: 'a2' });
    expect(result.messages).toHaveLength(50);
  });

  it('send_message should support idempotency key', () => {
    const first = handleSendMessage({ from_agent: 'a1', to_agent: 'a2', content: 'same', idempotency_key: 'msg-1' });
    const second = handleSendMessage({ from_agent: 'a1', to_agent: 'a2', content: 'different', idempotency_key: 'msg-1' });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(first.message.id).toBe(second.message.id);
  });

  it('read_messages compact mode should return previews', () => {
    handleSendMessage({ from_agent: 'a1', to_agent: 'a2', content: 'A very long message body for compact mode' });
    const result = handleReadMessages({ agent_id: 'a2', response_mode: 'compact' });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content_preview).toContain('long message');
    expect(result.messages[0].content_chars).toBeGreaterThan(10);
  });

  it('read_messages tiny mode should return digest/size without preview', () => {
    handleSendMessage({ from_agent: 'a1', to_agent: 'a2', content: 'Token-efficient payload for tiny mode' });
    const result = handleReadMessages({ agent_id: 'a2', response_mode: 'tiny' });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content_chars).toBeGreaterThan(10);
    expect(result.messages[0].content_digest).toHaveLength(16);
    expect(result.messages[0].content_preview).toBeUndefined();
  });

  it('read_messages nano mode should return short-key payload', () => {
    handleSendMessage({ from_agent: 'a1', to_agent: 'a2', content: 'Nano payload check' });
    const result = handleReadMessages({ agent_id: 'a2', response_mode: 'nano' });
    expect(Array.isArray(result.m)).toBe(true);
    expect(result.m).toHaveLength(1);
    expect(result.m[0].i).toBeDefined();
    expect(result.m[0].f).toBe('a1');
    expect(result.m[0].t).toBe('a2');
    expect(result.m[0].c).toBeGreaterThan(5);
    expect(result.m[0].d).toHaveLength(12);
    expect(result.messages).toBeUndefined();
  });

  it('read_messages should reject full mode in polling cycle', () => {
    handleSendMessage({ from_agent: 'a1', to_agent: 'a2', content: 'poll-loop' });
    const result = handleReadMessages({ agent_id: 'a2', response_mode: 'full', polling: true }) as Record<string, any>;
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error_code).toBe('FULL_MODE_FORBIDDEN_IN_POLLING');
  });

  it('send_blob_message should store payload and send compact reference envelope', () => {
    const payload = JSON.stringify({
      task_id: 42,
      summary: 'large handoff payload',
      evidence: Array.from({ length: 20 }, (_, i) => `artifact-${i}`),
      notes: 'x'.repeat(600),
    });
    const result = handleSendBlobMessage({ from_agent: 'a1', to_agent: 'a2', payload, compression_mode: 'json' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.blob_ref.hash).toHaveLength(64);
    expect(result.transport.message_chars).toBeLessThan(payload.length);

    const inbox = handleReadMessages({ agent_id: 'a2', resolve_blob_refs: true });
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0].blob_ref.hash).toBe(result.blob_ref.hash);
    expect(inbox.messages[0].blob_ref.resolved).toBe(true);
    expect(inbox.messages[0].resolved_content).toContain('large handoff payload');
  });

  it('send_blob_message lossless_auto should preserve payload exactly on resolve', () => {
    const payload = JSON.stringify({
      scope: 'strict-lossless',
      multiline: 'line1\nline2\nline3',
      whitespace_sensitive: 'a  b   c',
      unicode_safe: 'ASCII-only-check',
      notes: 'x'.repeat(2400),
    });
    const result = handleSendBlobMessage({
      from_agent: 'a1',
      to_agent: 'a2',
      payload,
      compression_mode: 'lossless_auto',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.compression.lossless).toBe(true);

    const inbox = handleReadMessages({ agent_id: 'a2', resolve_blob_refs: true });
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0].blob_ref.integrity_ok).toBe(true);
    expect(inbox.messages[0].resolved_content).toBe(payload);
  });

  it('read_messages delta cursor should support incremental reads', () => {
    handleSendMessage({ from_agent: 'a1', to_agent: 'a2', content: 'd1' });
    handleSendMessage({ from_agent: 'a1', to_agent: 'a2', content: 'd2' });
    handleSendMessage({ from_agent: 'a1', to_agent: 'a2', content: 'd3' });

    const first = handleReadMessages({ agent_id: 'a2', since_ts: 0, limit: 2, response_mode: 'compact' });
    expect(first.messages).toHaveLength(2);
    expect(first.has_more).toBe(true);
    expect(typeof first.next_cursor).toBe('string');

    const second = handleReadMessages({ agent_id: 'a2', cursor: first.next_cursor, limit: 2, response_mode: 'compact' });
    expect(second.messages).toHaveLength(1);
    expect(second.has_more).toBe(false);
  });
});
