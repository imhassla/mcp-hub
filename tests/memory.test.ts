import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb, registerAgent } from '../src/db.js';
import { handleGetMemoryDigest, handleSearchMemory, handleWriteMemory } from '../src/tools/memory.js';
import { handleSearchHub } from '../src/tools/search.js';

beforeEach(() => {
  initDb(':memory:');
  registerAgent({ id: 'claude-1', name: 'Claude 1', type: 'claude', capabilities: '' });
  registerAgent({ id: 'codex-1', name: 'Codex 1', type: 'codex', capabilities: '' });
});

afterEach(() => {
  closeDb();
});

describe('shared memory tools', () => {
  it('writes searchable shared memory without exposing full text in tiny mode', () => {
    const written = handleWriteMemory({
      agent_id: 'claude-1',
      key: 'release/decision',
      namespace: 'PROJECT-A',
      text: 'Use Authorization Bearer for SSE and deny query auth tokens.',
      tags: ['security', 'sse'],
      importance: 0.95,
    }) as Record<string, any>;

    expect(written.success).toBe(true);
    expect(written.memory.key).toBe('release/decision');
    expect(written.memory.tags).toEqual(['security', 'sse']);

    const found = handleSearchMemory({
      agent_id: 'codex-1',
      q: 'bearer sse',
      namespace: 'PROJECT-A',
      tags: ['security'],
      response_mode: 'tiny',
    }) as Record<string, any>;

    expect(found.success).toBe(true);
    expect(found.count).toBe(1);
    expect(found.memories[0].key).toBe('release/decision');
    expect(found.memories[0].text_digest).toHaveLength(16);
    expect('text_preview' in found.memories[0]).toBe(false);
  });

  it('returns highest-importance recent memory digest', () => {
    handleWriteMemory({
      agent_id: 'claude-1',
      key: 'low-note',
      namespace: 'PROJECT-A',
      text: 'Low importance note',
      importance: 0.1,
    });
    handleWriteMemory({
      agent_id: 'codex-1',
      key: 'high-note',
      namespace: 'PROJECT-A',
      text: 'High importance shared decision',
      importance: 0.9,
    });

    const digest = handleGetMemoryDigest({
      agent_id: 'claude-1',
      namespace: 'PROJECT-A',
      limit: 2,
      response_mode: 'compact',
    }) as Record<string, any>;

    expect(digest.success).toBe(true);
    expect(digest.memories.map((item: any) => item.key)).toEqual(['high-note', 'low-note']);
    expect(digest.memories[0].text_preview).toContain('High importance');
  });

  it('is backed by context so existing hub search can discover memory rows', () => {
    handleWriteMemory({
      agent_id: 'claude-1',
      key: 'bridge-pattern',
      namespace: 'PROJECT-A',
      text: 'Bridge runners should publish compact JSON reports.',
      tags: ['bridge'],
    });

    const hubSearch = handleSearchHub({
      agent_id: 'codex-1',
      q: 'compact json reports',
      scopes: ['context'],
      namespace: 'PROJECT-A',
      response_mode: 'compact',
    }) as Record<string, any>;

    expect(hubSearch.success).toBe(true);
    // Memory keys are now namespace-scoped: memory:<namespace>:<key> (T78-F4).
    expect(hubSearch.results.some((row: any) => row.title.includes('memory:PROJECT-A:bridge-pattern'))).toBe(true);
  });

  it('keeps the same key under different namespaces as distinct memories (T78-F4)', () => {
    handleWriteMemory({ agent_id: 'codex-1', key: 'summary', namespace: 'projA', text: 'A summary' });
    handleWriteMemory({ agent_id: 'codex-1', key: 'summary', namespace: 'projB', text: 'B summary' });

    const a = handleSearchMemory({ agent_id: 'codex-1', namespace: 'projA' }) as Record<string, any>;
    const b = handleSearchMemory({ agent_id: 'codex-1', namespace: 'projB' }) as Record<string, any>;
    expect(a.count).toBe(1);
    expect(b.count).toBe(1);
    expect(a.memories[0].text_preview).toContain('A summary');
    expect(b.memories[0].text_preview).toContain('B summary');
    // Both bare keys are still reported as 'summary'.
    expect(a.memories[0].key).toBe('summary');
    expect(b.memories[0].key).toBe('summary');
  });
});
