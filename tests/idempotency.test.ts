import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  closeDb,
  getDb,
  getIdempotencyRecord,
  initDb,
  registerAgent,
  saveIdempotencyRecord,
} from '../src/db.js';
import {
  notifyStreamEvent,
  onStreamEvent,
  runWithDeferredStreamNotifications,
} from '../src/eventNotifier.js';
import { handleSendMessage } from '../src/tools/messages.js';
import { handleCreateTask } from '../src/tools/tasks.js';
import { configureArtifactTicketIssuer, handleCreateArtifactUpload } from '../src/tools/artifacts.js';
import { ArtifactUploadTicketLimiter } from '../src/artifact-ticket-limits.js';
import { idempotencyRequestHash, MAX_IDEMPOTENCY_KEY_CHARS } from '../src/utils.js';

beforeEach(() => {
  initDb(':memory:');
  registerAgent({ id: 'a1', name: 'A1', type: 'codex', capabilities: '' });
  registerAgent({ id: 'a2', name: 'A2', type: 'codex', capabilities: '' });
  configureArtifactTicketIssuer((args) => ({
    token: `ticket-${args.kind}-${args.artifact_id}`,
    expires_at: Date.now() + (args.ttl_sec * 1000),
  }));
});

afterEach(() => closeDb());

describe('idempotency hardening', () => {
  it('canonicalizes object order while excluding only top-level retry secrets', () => {
    const first = idempotencyRequestHash({
      z: 2,
      nested: { z: true, a: 'value' },
      auth_token: 'old-agent-token',
      register_token: 'old-register-token',
      idempotency_key: 'first-key',
    });
    const reordered = idempotencyRequestHash({
      registration_token: 'rotated-register-token',
      nested: { a: 'value', z: true },
      z: 2,
      auth_token: 'rotated-agent-token',
      idempotency_key: 'second-key',
    });

    expect(first).toBe(reordered);
    expect(first).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(idempotencyRequestHash({ nested: { auth_token: 'semantic-a' } }))
      .not.toBe(idempotencyRequestHash({ nested: { auth_token: 'semantic-b' } }));
  });

  it('bounds idempotency keys before any mutation or record write', () => {
    const result = handleSendMessage({
      from_agent: 'a1',
      to_agent: 'a2',
      content: 'must not be sent',
      idempotency_key: 'x'.repeat(MAX_IDEMPOTENCY_KEY_CHARS + 1),
    });

    expect(result).toMatchObject({ success: false, error_code: 'IDEMPOTENCY_KEY_INVALID' });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM idempotency_keys').get()).toEqual({ count: 0 });
  });

  it('fails closed for legacy records without a payload fingerprint', () => {
    saveIdempotencyRecord('a1', 'send_message', 'legacy-key', { success: true, unsafe: 'old-response' });

    const result = handleSendMessage({
      from_agent: 'a1',
      to_agent: 'a2',
      content: 'must not run',
      idempotency_key: 'legacy-key',
    });

    expect(result).toMatchObject({ success: false, error_code: 'IDEMPOTENCY_LEGACY_RECORD' });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
  });

  it('fails closed when a matching cached response is corrupt', () => {
    const args = {
      from_agent: 'a1',
      to_agent: 'a2',
      content: 'must not run',
      idempotency_key: 'corrupt-key',
    };
    getDb().prepare(`
      INSERT INTO idempotency_keys (
        agent_id, tool_name, idempotency_key, request_hash, response_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('a1', 'send_message', args.idempotency_key, idempotencyRequestHash(args), '{broken', Date.now());

    const result = handleSendMessage(args);

    expect(result).toMatchObject({ success: false, error_code: 'IDEMPOTENCY_RECORD_CORRUPT' });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
  });

  it('rolls back a message and discards notifications when the record insert fails', () => {
    getDb().exec(`
      CREATE TEMP TRIGGER fail_idempotency_insert
      BEFORE INSERT ON idempotency_keys
      BEGIN
        SELECT RAISE(ABORT, 'forced idempotency failure');
      END
    `);
    const notified: number[] = [];
    const unsubscribe = onStreamEvent((event) => notified.push(event.id));
    try {
      expect(() => handleSendMessage({
        from_agent: 'a1',
        to_agent: 'a2',
        content: 'rolled back',
        idempotency_key: 'rollback-message',
      })).toThrow(/forced idempotency failure/);
      expect(getDb().prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
      expect(getDb().prepare('SELECT COUNT(*) AS count FROM stream_events').get()).toEqual({ count: 0 });
      expect(notified).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('rolls back nested task transactions with the idempotency record', () => {
    getDb().exec(`
      CREATE TEMP TRIGGER fail_nested_idempotency_insert
      BEFORE INSERT ON idempotency_keys
      BEGIN
        SELECT RAISE(ABORT, 'forced nested idempotency failure');
      END
    `);
    const notified: number[] = [];
    const unsubscribe = onStreamEvent((event) => notified.push(event.id));
    try {
      expect(() => handleCreateTask({
        title: 'rolled back task',
        created_by: 'a1',
        idempotency_key: 'rollback-task',
      })).toThrow(/forced nested idempotency failure/);
      expect(getDb().prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });
      expect(getDb().prepare('SELECT COUNT(*) AS count FROM stream_events').get()).toEqual({ count: 0 });
      expect(notified).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('flushes nested deferred notifications only after the outer scope succeeds', () => {
    const notified: number[] = [];
    const unsubscribe = onStreamEvent((event) => notified.push(event.id));
    try {
      runWithDeferredStreamNotifications(() => {
        notifyStreamEvent({ id: 1, stream: 'messages', agent_id: 'a1', target_agent_id: 'a2' });
        runWithDeferredStreamNotifications(() => {
          notifyStreamEvent({ id: 2, stream: 'tasks', agent_id: 'a1', target_agent_id: null });
        });
        expect(notified).toEqual([]);
      });
      expect(notified).toEqual([1, 2]);
    } finally {
      unsubscribe();
    }
  });

  it('stores a fingerprint and replays the exact response for matching arguments', () => {
    const args = {
      from_agent: 'a1',
      to_agent: 'a2',
      content: 'same request',
      idempotency_key: 'matching-replay',
    };
    const first = handleSendMessage(args);
    const replay = handleSendMessage({ ...args });

    expect(first.success).toBe(true);
    expect(replay).toEqual(first);
    const record = getIdempotencyRecord('a1', 'send_message', args.idempotency_key);
    expect(record?.request_hash).toBe(idempotencyRequestHash(args));
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 });
  });

  it('encrypts volatile ticket responses while preserving same-process replay', () => {
    let issued = 0;
    const token = 'upload-ticket-plaintext-must-not-reach-sqlite';
    configureArtifactTicketIssuer((args) => {
      issued += 1;
      return { token, expires_at: Date.now() + (args.ttl_sec * 1000) };
    });
    const args = {
      agent_id: 'a1',
      name: 'secret-ticket.bin',
      idempotency_key: 'volatile-ticket-replay',
    };

    const first = handleCreateArtifactUpload(args);
    const replay = handleCreateArtifactUpload({ ...args });

    expect(first.success).toBe(true);
    expect(replay).toEqual(first);
    expect(issued).toBe(1);
    if (!first.success) return;
    expect(first.upload.headers['X-Artifact-Token']).toBe(token);
    const record = getIdempotencyRecord('a1', 'create_artifact_upload', args.idempotency_key);
    expect(record?.response_json).not.toContain(token);
    expect(JSON.parse(record?.response_json || '{}')).toMatchObject({
      v: 'idempotency-aes-gcm-1',
      alg: 'aes-256-gcm',
    });
  });

  it('releases an issued ticket and limiter capacity when idempotency persistence fails', () => {
    const limiter = new ArtifactUploadTicketLimiter(1, 1);
    const activeTickets = new Set<string>();
    configureArtifactTicketIssuer((args) => {
      limiter.acquire(args.agent_id);
      const token = `rollback-ticket-${args.artifact_id}`;
      activeTickets.add(token);
      return {
        token,
        expires_at: Date.now() + (args.ttl_sec * 1000),
        rollback: () => {
          if (!activeTickets.delete(token)) return;
          limiter.release(args.agent_id);
        },
      };
    });
    getDb().exec(`
      CREATE TEMP TRIGGER fail_ticket_idempotency_insert
      BEFORE INSERT ON idempotency_keys
      BEGIN
        SELECT RAISE(ABORT, 'forced ticket idempotency failure');
      END
    `);

    expect(() => handleCreateArtifactUpload({
      agent_id: 'a1',
      name: 'rollback-ticket.bin',
      idempotency_key: 'rollback-ticket-key',
    })).toThrow(/forced ticket idempotency failure/);

    expect(activeTickets.size).toBe(0);
    expect(limiter.snapshot()).toMatchObject({ active: 0, tracked_agents: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM artifacts').get()).toEqual({ count: 0 });
  });

  it('fails closed when a volatile response can no longer be decrypted', () => {
    let issued = 0;
    configureArtifactTicketIssuer((args) => {
      issued += 1;
      return { token: `volatile-${issued}`, expires_at: Date.now() + (args.ttl_sec * 1000) };
    });
    const args = {
      agent_id: 'a1',
      name: 'expired-ticket.bin',
      idempotency_key: 'volatile-ticket-expired',
    };
    expect(handleCreateArtifactUpload(args).success).toBe(true);
    getDb().prepare(`
      UPDATE idempotency_keys
      SET response_json = '{"v":"idempotency-volatile-expired-1"}'
      WHERE agent_id = ? AND tool_name = ? AND idempotency_key = ?
    `).run('a1', 'create_artifact_upload', args.idempotency_key);

    const expired = handleCreateArtifactUpload({ ...args });

    expect(expired).toMatchObject({
      success: false,
      error_code: 'IDEMPOTENCY_VOLATILE_RESPONSE_EXPIRED',
    });
    expect(issued).toBe(1);
  });

  it('scrubs legacy plaintext ticket responses during database initialization', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-idempotency-scrub-'));
    const dbPath = path.join(dir, 'hub.db');
    const leakedToken = 'legacy-plaintext-upload-ticket';
    closeDb();
    try {
      initDb(dbPath);
      saveIdempotencyRecord(
        'legacy-agent',
        'create_artifact_upload',
        'legacy-ticket-key',
        { success: true, upload: { headers: { 'X-Artifact-Token': leakedToken } } },
      );
      closeDb();

      initDb(dbPath);
      const row = getDb().prepare(`
        SELECT response_json FROM idempotency_keys
        WHERE agent_id = ? AND tool_name = ? AND idempotency_key = ?
      `).get('legacy-agent', 'create_artifact_upload', 'legacy-ticket-key') as { response_json: string };
      expect(row.response_json).toBe('{"v":"idempotency-volatile-expired-1"}');
      expect(row.response_json).not.toContain(leakedToken);
    } finally {
      closeDb();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
