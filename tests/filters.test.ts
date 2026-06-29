import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb, registerAgent, sendMessage } from '../src/db.js';
import { handleWaitForUpdates } from '../src/tools/activity.js';
import { handleDeleteFilter, handleListFilters, handleReadFilterFeed, handleSaveFilter } from '../src/tools/filters.js';

beforeEach(() => {
  initDb(':memory:');
  registerAgent({ id: 'a1', name: 'Agent 1', type: 'codex', capabilities: '' });
  registerAgent({ id: 'a2', name: 'Agent 2', type: 'codex', capabilities: '' });
});

afterEach(() => {
  closeDb();
});

describe('saved filters', () => {
  it('saves and reads a search filter feed', () => {
    sendMessage('a1', 'a2', 'saved filter needle');
    const saved = handleSaveFilter({
      agent_id: 'a2',
      name: 'needle-search',
      filter: { kind: 'search', q: 'saved needle', scopes: ['messages'] },
      namespace: 'EXP-F',
    }) as Record<string, any>;

    expect(saved.success).toBe(true);
    const listed = handleListFilters({ agent_id: 'a2', response_mode: 'tiny' }) as Record<string, any>;
    expect(listed.filters).toHaveLength(1);
    expect(listed.filters[0].name).toBe('needle-search');

    const feed = handleReadFilterFeed({
      agent_id: 'a2',
      name: 'needle-search',
      response_mode: 'compact',
    }) as Record<string, any>;
    expect(feed.success).toBe(true);
    expect(feed.result.success).toBe(true);
    expect(feed.result.results[0].source).toBe('messages');
  });

  it('saves event delta cursor and advances it on read', async () => {
    const baseline = await handleWaitForUpdates({
      agent_id: 'a2',
      streams: ['messages'],
      wait_ms: 20,
      poll_interval_ms: 10,
      response_mode: 'compact',
      timeout_response: 'default',
      adaptive_retry: false,
    }) as Record<string, any>;

    const saved = handleSaveFilter({
      agent_id: 'a2',
      name: 'message-deltas',
      filter: { kind: 'event_deltas', streams: ['messages'] },
      cursor: baseline.cursor,
    }) as Record<string, any>;
    expect(saved.success).toBe(true);

    const message = sendMessage('a1', 'a2', 'delta saved filter');
    const feed = handleReadFilterFeed({
      agent_id: 'a2',
      name: 'message-deltas',
      response_mode: 'tiny',
      advance_cursor: true,
    }) as Record<string, any>;
    expect(feed.success).toBe(true);
    expect(feed.result.events.some((event: { entity_id: string }) => event.entity_id === String(message.id))).toBe(true);

    const listed = handleListFilters({ agent_id: 'a2', response_mode: 'compact' }) as Record<string, any>;
    expect(listed.filters[0].cursor).toBe(feed.cursor);

    const empty = handleReadFilterFeed({
      agent_id: 'a2',
      name: 'message-deltas',
      response_mode: 'tiny',
    }) as Record<string, any>;
    expect(empty.result.changed).toBe(false);
  });

  it('deletes only owned filters', () => {
    handleSaveFilter({ agent_id: 'a2', name: 'owned', filter: { kind: 'event_deltas', streams: ['messages'] } });
    const denied = handleDeleteFilter({ agent_id: 'a1', name: 'owned' }) as Record<string, any>;
    expect(denied.success).toBe(false);
    expect(denied.error_code).toBe('FILTER_NOT_FOUND');

    const deleted = handleDeleteFilter({ agent_id: 'a2', name: 'owned' }) as Record<string, any>;
    expect(deleted.success).toBe(true);
    const listed = handleListFilters({ agent_id: 'a2' }) as Record<string, any>;
    expect(listed.filters).toHaveLength(0);
  });
});
