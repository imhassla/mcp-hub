import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDb,
  createArtifactRecord,
  createTask,
  getDb,
  grantArtifactAccess,
  initDb,
  readMessages,
  registerAgent,
  sendMessage,
  shareContext,
  updateTask,
} from '../src/db.js';
import { handleSearchHub } from '../src/tools/search.js';
import { handleFetchHubRefs } from '../src/tools/refs.js';

beforeEach(() => {
  initDb(':memory:');
  registerAgent({ id: 'a1', name: 'Agent 1', type: 'codex', capabilities: '' });
  registerAgent({ id: 'a2', name: 'Agent 2', type: 'codex', capabilities: '' });
  registerAgent({ id: 'a3', name: 'Agent 3', type: 'codex', capabilities: '' });
});

afterEach(() => {
  closeDb();
});

describe('search_hub', () => {
  it('searches visible messages without marking them read', () => {
    sendMessage('a1', 'a2', 'needle private message');
    sendMessage('a1', 'a3', 'hidden private message');

    const result = handleSearchHub({
      agent_id: 'a2',
      q: 'needle private',
      scopes: ['messages'],
      response_mode: 'compact',
    }) as Record<string, any>;

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.results[0].source).toBe('messages');
    expect(result.results[0].preview).toContain('needle private');
    expect(readMessages('a2', { unread_only: true })).toHaveLength(1);

    const denied = handleSearchHub({
      agent_id: 'a2',
      q: 'hidden private',
      scopes: ['messages'],
      response_mode: 'compact',
    }) as Record<string, any>;
    expect(denied.count).toBe(0);
  });

  it('searches tasks and context with namespace filters', () => {
    const task = createTask({
      title: 'Implement replayable search',
      description: 'needle task details',
      created_by: 'a1',
      namespace: 'EXP-SEARCH',
    });
    updateTask(task.id, { status: 'in_progress', assigned_to: 'a2' });
    shareContext('a2', 'search-notes', 'needle context value', undefined, undefined, 'EXP-SEARCH');

    const result = handleSearchHub({
      agent_id: 'a2',
      q: 'needle search',
      scopes: ['tasks', 'context'],
      namespace: 'EXP-SEARCH',
      response_mode: 'tiny',
      limit: 10,
    }) as Record<string, any>;

    expect(result.success).toBe(true);
    expect(result.results.map((row: { source: string }) => row.source)).toContain('tasks');
    expect(result.results.map((row: { source: string }) => row.source)).toContain('context');
    expect(result.results.every((row: { namespace: string }) => row.namespace === 'EXP-SEARCH')).toBe(true);
  });

  it('enforces artifact visibility and supports nano output', () => {
    const artifact = createArtifactRecord({
      id: 'artifact-search-1',
      created_by: 'a1',
      name: 'needle-artifact.txt',
      summary: 'needle artifact summary',
      namespace: 'EXP-A',
    });

    const beforeShare = handleSearchHub({
      agent_id: 'a2',
      q: 'needle artifact',
      scopes: ['artifacts'],
      response_mode: 'nano',
    }) as Record<string, any>;
    expect(beforeShare.c).toBe(0);

    grantArtifactAccess({ artifact_id: artifact.id, to_agent: 'a2', granted_by: 'a1' });
    const afterShare = handleSearchHub({
      agent_id: 'a2',
      q: 'needle artifact',
      scopes: ['artifacts'],
      response_mode: 'nano',
    }) as Record<string, any>;

    expect(afterShare.c).toBe(1);
    expect(afterShare.r[0].s).toBe('artifacts');
    expect(afterShare.r[0].i).toBe(artifact.id);
  });

  it('rejects empty or too-short queries', () => {
    const result = handleSearchHub({
      agent_id: 'a2',
      q: 'x',
      scopes: ['messages'],
    }) as Record<string, any>;
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('QUERY_TOO_SHORT');
  });

  it('supports since_ts to bound search scans by source timestamp', () => {
    const oldTask = createTask({
      title: 'needle old task',
      description: 'old search target',
      created_by: 'a1',
    });
    const newTask = createTask({
      title: 'needle new task',
      description: 'new search target',
      created_by: 'a1',
    });
    const cutoff = Date.now();
    const db = getDb();
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(cutoff - 10_000, oldTask.id);
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(cutoff + 10_000, newTask.id);

    const result = handleSearchHub({
      agent_id: 'a2',
      q: 'needle task',
      scopes: ['tasks'],
      since_ts: cutoff,
      response_mode: 'tiny',
    }) as Record<string, any>;

    expect(result.success).toBe(true);
    expect(result.since_ts).toBe(cutoff);
    expect(result.results.map((row: { id: string }) => Number(row.id))).toEqual([newTask.id]);
  });
});

describe('fetch_hub_refs', () => {
  it('hydrates search refs without marking messages read by default', () => {
    const message = sendMessage('a1', 'a2', 'hydrate needle message');
    const found = handleSearchHub({
      agent_id: 'a2',
      q: 'hydrate needle',
      scopes: ['messages'],
      response_mode: 'tiny',
    }) as Record<string, any>;

    const fetched = handleFetchHubRefs({
      agent_id: 'a2',
      refs: { messages: [Number(found.results[0].id)] },
      response_mode: 'compact',
    }) as Record<string, any>;

    expect(fetched.success).toBe(true);
    expect(fetched.counts.messages).toBe(1);
    expect(fetched.items.messages[0].id).toBe(message.id);
    expect(fetched.items.messages[0].content_preview).toContain('hydrate needle');
    expect(readMessages('a2', { unread_only: true })).toHaveLength(1);
  });

  it('can explicitly mark fetched messages read', () => {
    const message = sendMessage('a1', 'a2', 'mark read explicitly');
    const fetched = handleFetchHubRefs({
      agent_id: 'a2',
      refs: { messages: [message.id] },
      response_mode: 'tiny',
      mark_messages_read: true,
    }) as Record<string, any>;

    expect(fetched.success).toBe(true);
    expect(fetched.counts.messages).toBe(1);
    expect(readMessages('a2', { unread_only: true })).toHaveLength(0);
  });

  it('reports denied message and artifact refs', () => {
    const hiddenMessage = sendMessage('a1', 'a3', 'hidden from a2');
    const artifact = createArtifactRecord({
      id: 'fetch-hidden-artifact',
      created_by: 'a1',
      name: 'hidden artifact',
    });

    const fetched = handleFetchHubRefs({
      agent_id: 'a2',
      refs: {
        messages: [hiddenMessage.id],
        artifacts: [artifact.id],
        tasks: [99999],
      },
      response_mode: 'tiny',
    }) as Record<string, any>;

    expect(fetched.success).toBe(true);
    expect(fetched.counts.messages).toBe(0);
    expect(fetched.counts.artifacts).toBe(0);
    expect(fetched.denied.messages).toEqual([hiddenMessage.id]);
    expect(fetched.denied.artifacts).toEqual([artifact.id]);
    expect(fetched.missing.tasks).toEqual([99999]);
  });

  it('hydrates multiple source types in nano mode', () => {
    const task = createTask({ title: 'Fetch task ref', created_by: 'a1' });
    const ctx = shareContext('a1', 'fetch-key', 'fetch context value');

    const fetched = handleFetchHubRefs({
      agent_id: 'a2',
      refs: {
        tasks: [task.id],
        context: [ctx.id],
      },
      response_mode: 'nano',
    }) as Record<string, any>;

    expect(fetched.c.tasks).toBe(1);
    expect(fetched.c.context).toBe(1);
    expect(fetched.t[0][0]).toBe(task.id);
    expect(fetched.x[0][0]).toBe(ctx.id);
  });
});
