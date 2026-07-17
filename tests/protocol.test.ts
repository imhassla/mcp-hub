import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { initDb, closeDb, registerAgent } from '../src/db.js';
import {
  handlePackProtocolMessage,
  handleUnpackProtocolMessage,
  handleHashPayload,
  handleStoreProtocolBlob,
  handleGetProtocolBlob,
  handleListProtocolBlobs,
} from '../src/tools/protocol.js';

beforeEach(() => {
  initDb(':memory:');
  registerAgent({ id: 'a1', name: 'A1', type: 'codex', capabilities: 'protocol' });
});

afterEach(() => {
  closeDb();
});

describe('protocol tools', () => {
  it('pack_protocol_message should produce a valid packet and metrics', () => {
    const payload = JSON.stringify({
      agent_id: 'a1',
      task_id: 42,
      status: 'in_progress',
      confidence: 0.93,
      summary: 'working',
    });

    const packed = handlePackProtocolMessage({
      agent_id: 'a1',
      payload,
      payload_format: 'json',
      mode: 'auto',
    });

    expect(packed.success).toBe(true);
    if (!packed.success) return;
    expect(packed.packet.v).toBe('caep-1');
    expect(packed.packet.h.length).toBe(64);
    expect(packed.metrics.original_chars).toBeGreaterThan(0);
    expect(packed.metrics.packed_chars).toBeGreaterThan(0);
    expect(packed.policy.mode).toBe('auto');
  });

  it('auto mode should skip dictionary when payload is below threshold', () => {
    const payload = JSON.stringify({
      agent_id: 'a1',
      task_id: 1,
      status: 'pending',
      summary: 'small payload',
    });
    const packed = handlePackProtocolMessage({
      agent_id: 'a1',
      payload,
      payload_format: 'json',
      mode: 'auto',
      auto_min_payload_chars: 500,
      auto_min_gain_pct: 0,
    });

    expect(packed.success).toBe(true);
    if (!packed.success) return;
    expect(packed.packet.enc).toBe('json');
    expect(packed.policy.dictionary_applied).toBe(false);
    expect(packed.policy.decision).toBe('below_min_payload_chars');
  });

  it('auto mode should skip dictionary when expected gain is below threshold', () => {
    const payload = JSON.stringify({
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
      f: 6,
      g: 7,
      h: 8,
      i: 9,
      j: 10,
      k: 11,
      l: 12,
      m: 13,
      n: 14,
      o: 15,
      p: 16,
      q: 17,
      r: 18,
      s: 19,
      t: 20,
      note: 'x'.repeat(2300),
    });
    const packed = handlePackProtocolMessage({
      agent_id: 'a1',
      payload,
      payload_format: 'json',
      mode: 'auto',
      auto_min_payload_chars: 100,
      auto_min_gain_pct: 3,
    });

    expect(packed.success).toBe(true);
    if (!packed.success) return;
    expect(packed.packet.enc).toBe('json');
    expect(packed.policy.dictionary_applied).toBe(false);
    expect(packed.policy.decision).toBe('below_min_gain_pct');
  });

  it('auto mode should apply dictionary when payload and gain thresholds are met', () => {
    const payload = JSON.stringify({
      items: Array.from({ length: 90 }, (_, idx) => ({
        agent_id: `worker-${idx % 5}`,
        task_id: idx + 1,
        status: 'in_progress',
        confidence: 0.91,
        summary: 'adaptive-lossless-check',
        metadata: { created_at: Date.now(), updated_at: Date.now() + idx },
        message: 'optimize protocol',
      })),
    });
    const packed = handlePackProtocolMessage({
      agent_id: 'a1',
      payload,
      payload_format: 'json',
      mode: 'auto',
      auto_min_payload_chars: 200,
      auto_min_gain_pct: 3,
    });

    expect(packed.success).toBe(true);
    if (!packed.success) return;
    expect(packed.packet.enc).toBe('dictionary');
    expect(packed.policy.dictionary_applied).toBe(true);
    expect(packed.policy.decision).toBe('gain_threshold_met');
    expect(packed.metrics.dictionary_candidate_gain_pct).toBeGreaterThanOrEqual(3);
  });

  it('unpack_protocol_message should validate hash and decode payload', () => {
    const payload = JSON.stringify({ agent_id: 'a1', task_id: 7, status: 'done', summary: 'ok' });
    const packed = handlePackProtocolMessage({
      agent_id: 'a1',
      payload,
      payload_format: 'json',
      mode: 'dictionary',
    });
    expect(packed.success).toBe(true);
    if (!packed.success) return;

    const unpacked = handleUnpackProtocolMessage({
      agent_id: 'a1',
      packet_json: packed.packet_json,
    });
    expect(unpacked.success).toBe(true);
    if (!unpacked.success) return;
    expect(unpacked.hash_valid).toBe(true);
    expect((unpacked.decoded_payload as { status?: string }).status).toBe('done');
  });

  it('unpack_protocol_message rejects tampered payloads without returning decoded data', () => {
    const packed = handlePackProtocolMessage({
      agent_id: 'a1',
      payload: JSON.stringify({ trusted: true }),
      payload_format: 'json',
      mode: 'json',
    });
    expect(packed.success).toBe(true);
    if (!packed.success) return;
    const packet = JSON.parse(packed.packet_json);
    packet.d = { trusted: false };

    const unpacked = handleUnpackProtocolMessage({ agent_id: 'a1', packet_json: JSON.stringify(packet) });
    expect(unpacked.success).toBe(false);
    if (unpacked.success) return;
    expect(unpacked.error_code).toBe('HASH_MISMATCH');
    expect('decoded_payload' in unpacked).toBe(false);
  });

  it('unpack_protocol_message returns INVALID_PACKET for malformed text data instead of throwing', () => {
    const body = { d: null, enc: 'json', fmt: 'text', ts: 1, v: 'caep-1' };
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const result = handleUnpackProtocolMessage({
      agent_id: 'a1',
      packet_json: JSON.stringify({ ...body, h: hash }),
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error_code).toBe('INVALID_PACKET');
  });

  it('hash_payload should return deterministic digest', () => {
    const h1 = handleHashPayload({
      agent_id: 'a1',
      payload: JSON.stringify({ b: 1, a: 2 }),
      normalize_json: true,
      truncate: 12,
    });
    const h2 = handleHashPayload({
      agent_id: 'a1',
      payload: JSON.stringify({ a: 2, b: 1 }),
      normalize_json: true,
      truncate: 12,
    });

    expect(h1.success).toBe(true);
    expect(h2.success).toBe(true);
    if (!h1.success || !h2.success) return;
    expect(h1.hash).toBe(h2.hash);
    expect(h1.short_hash.length).toBe(12);
  });

  it('store/get/list protocol blob should work', () => {
    registerAgent({ id: 'a2', name: 'A2', type: 'codex', capabilities: 'protocol' });
    const payload = JSON.stringify({ agent_id: 'a1', task_id: 99, status: 'done', summary: 'blob-data' });
    const stored = handleStoreProtocolBlob({
      agent_id: 'a1',
      payload,
      compression_mode: 'json',
      hash_truncate: 10,
    });
    expect(stored.success).toBe(true);
    if (!stored.success) return;
    expect(stored.hash.length).toBe(64);
    expect(stored.short_hash.length).toBe(10);

    const fetched = handleGetProtocolBlob({
      agent_id: 'a1',
      hash: stored.hash,
    });
    expect(fetched.success).toBe(true);
    if (!fetched.success) return;
    expect(fetched.blob.value).toContain('blob-data');

    const listed = handleListProtocolBlobs({
      agent_id: 'a1',
      limit: 10,
    });
    expect(listed.success).toBe(true);
    expect(listed.blobs.find((blob) => blob.hash === stored.hash)).toBeTruthy();

    const forbidden = handleGetProtocolBlob({ agent_id: 'a2', hash: stored.hash });
    expect(forbidden.success).toBe(false);
    if (!forbidden.success) expect(forbidden.error_code).toBe('BLOB_NOT_FOUND_OR_FORBIDDEN');
    const outsiderList = handleListProtocolBlobs({ agent_id: 'a2', limit: 10 });
    expect(outsiderList.blobs.some((blob) => blob.hash === stored.hash)).toBe(false);
  });

  it('store_protocol_blob preserves payload bytes by default', () => {
    const payload = 'line one\n    line two\n        line three';
    const stored = handleStoreProtocolBlob({ agent_id: 'a1', payload });
    expect(stored.success).toBe(true);
    if (!stored.success) return;
    expect(stored.compression_mode).toBe('none');

    const fetched = handleGetProtocolBlob({ agent_id: 'a1', hash: stored.hash });
    expect(fetched.success).toBe(true);
    if (!fetched.success) return;
    expect(fetched.blob.value).toBe(payload);
  });

  it('requires an explicit grant before another agent can read a stored blob', () => {
    registerAgent({ id: 'a2', name: 'A2', type: 'codex', capabilities: 'protocol' });
    const shared = handleStoreProtocolBlob({
      agent_id: 'a1',
      payload: 'shared result',
      share_with_agents: ['a2'],
    });
    expect(shared.success).toBe(true);
    if (!shared.success) return;
    expect(handleGetProtocolBlob({ agent_id: 'a2', hash: shared.hash }).success).toBe(true);

    const publicBlob = handleStoreProtocolBlob({ agent_id: 'a1', payload: 'public result', visibility: 'public' });
    expect(publicBlob.success).toBe(true);
    if (!publicBlob.success) return;
    expect(handleGetProtocolBlob({ agent_id: 'a2', hash: publicBlob.hash }).success).toBe(true);
  });

  it('dictionary packing is lossless for colliding keys (T78-F1)', () => {
    // All previously-colliding pairs present at once: agent/agent_id, task/task_id,
    // created_at/timestamp, references/refs, text/content.
    const original = {
      agent: 'a-x', agent_id: 'id-y',
      task: 'tname', task_id: 9,
      created_at: 111, timestamp: 222,
      references: ['r1'], refs: ['r2'],
      text: 'hello', content: 'world',
    };
    const packed = handlePackProtocolMessage({
      agent_id: 'a1', payload: JSON.stringify(original), payload_format: 'json', mode: 'dictionary',
    });
    expect(packed.success).toBe(true);
    if (!packed.success) return;

    const unpacked = handleUnpackProtocolMessage({ agent_id: 'a1', packet_json: packed.packet_json });
    expect(unpacked.success).toBe(true);
    if (!unpacked.success) return;
    expect(unpacked.hash_valid).toBe(true);
    // Round-trip must be exactly lossless (pre-fix this corrupted agent->agent_id, text->content, etc).
    expect(unpacked.decoded_payload).toEqual(original);
  });
});
