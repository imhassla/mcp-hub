import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initDb, closeDb, getDb, registerAgent, listAgents, heartbeat,
  sendMessage, readMessages,
  createTask, updateTask, listTasks, pollAndClaim, getTaskDependencies, getTaskWithDependencies,
  claimTask, renewTaskClaim, releaseTaskClaim, listTaskClaims,
  getAgentQuality, recordTaskCompletion, recordTaskRollback,
  shareContext, getContext,
  getIdempotencyRecord, saveIdempotencyRecord,
  logActivity, getActivityLog,
  getKpiWindows, evaluateSloAlerts, listSloAlerts,
  recordAuthEvent, getAuthCoverageSnapshot, getUpdateWatermark, runMaintenance,
} from '../src/db.js';

beforeEach(() => {
  initDb(':memory:');
});

afterEach(() => {
  closeDb();
});

describe('agents', () => {
  it('should register and list agents', () => {
    registerAgent({ id: 'a1', name: 'Agent 1', type: 'claude', capabilities: 'code,review' });
    registerAgent({ id: 'a2', name: 'Agent 2', type: 'codex', capabilities: 'code' });

    const agents = listAgents();
    expect(agents).toHaveLength(2);
    expect(agents[0].status).toBe('online');
    expect(agents[0].lifecycle).toBe('persistent');
  });

  it('should upsert on re-register', () => {
    registerAgent({ id: 'a1', name: 'Agent 1', type: 'claude', capabilities: '' });
    registerAgent({ id: 'a1', name: 'Agent 1 Updated', type: 'claude', capabilities: 'new' });

    const agents = listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('Agent 1 Updated');
    expect(agents[0].capabilities).toBe('new');
  });

  it('should update heartbeat', () => {
    registerAgent({ id: 'a1', name: 'Agent 1', type: 'claude', capabilities: '' });
    const before = listAgents()[0].last_seen;

    // Small delay to ensure timestamp differs
    heartbeat('a1');
    const after = listAgents()[0].last_seen;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('should store explicit ephemeral lifecycle', () => {
    registerAgent({ id: 'sw-1', name: 'Swarm 1', type: 'codex', capabilities: '', lifecycle: 'ephemeral' });
    const byId = new Map(listAgents().map((agent) => [agent.id, agent]));
    expect(byId.get('sw-1')?.lifecycle).toBe('ephemeral');
  });

  it('should mark inactive agents offline and purge stale offline agents in maintenance', () => {
    const now = Date.now();
    registerAgent({ id: 'fresh', name: 'Fresh Agent', type: 'claude', capabilities: '' });
    registerAgent({ id: 'inactive', name: 'Inactive Agent', type: 'claude', capabilities: '' });
    registerAgent({ id: 'stale', name: 'Stale Agent', type: 'claude', capabilities: '' });

    const db = getDb();
    db.prepare("UPDATE agents SET last_seen = ?, status = 'online' WHERE id = ?").run(now - 2 * 60 * 60 * 1000, 'inactive');
    db.prepare("UPDATE agents SET last_seen = ?, status = 'offline' WHERE id = ?").run(now - 10 * 24 * 60 * 60 * 1000, 'stale');

    const summary = runMaintenance(now);
    expect(summary.agents_marked_offline).toBeGreaterThanOrEqual(1);
    expect(summary.agents_deleted).toBeGreaterThanOrEqual(1);

    const byId = new Map(listAgents().map((agent) => [agent.id, agent]));
    expect(byId.has('stale')).toBe(false);
    expect(byId.get('inactive')?.status).toBe('offline');
    expect(byId.get('fresh')?.status).toBe('online');
  });

  it('should reap claims and requeue tasks from offline ephemeral workers', () => {
    const now = Date.now();
    registerAgent({ id: 'orch', name: 'Orch', type: 'codex', capabilities: 'orchestration' });
    registerAgent({ id: 'sw-1', name: 'Swarm 1', type: 'codex', capabilities: 'worker', lifecycle: 'ephemeral' });

    const task = createTask({ title: 'ephemeral task', created_by: 'orch', assigned_to: 'sw-1', priority: 'high' });
    const claim = claimTask(task.id, 'sw-1', 600);
    expect(claim.success).toBe(true);
    if (!claim.success) return;

    const db = getDb();
    db.prepare("UPDATE agents SET status = 'offline', last_seen = ? WHERE id = ?").run(now - (10 * 60 * 1000), 'sw-1');
    db.prepare("UPDATE task_claims SET updated_at = ? WHERE task_id = ?").run(now - (20 * 60 * 1000), task.id);

    const summary = runMaintenance(now);
    expect(summary.ephemeral_claims_reaped).toBeGreaterThanOrEqual(1);
    expect(summary.orphaned_assignments_requeued).toBeGreaterThanOrEqual(0);

    const refreshed = listTasks({}).find((row) => row.id === task.id);
    expect(refreshed?.status).toBe('pending');
    expect(refreshed?.assigned_to).toBeNull();
    expect(listTaskClaims({}).some((row) => row.task_id === task.id)).toBe(false);
  });
});

describe('messages', () => {
  it('should send and read messages', () => {
    const msg = sendMessage('a1', 'a2', 'Hello!');
    expect(msg.id).toBeDefined();
    expect(msg.read).toBe(0);

    const messages = readMessages('a2');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Hello!');
  });

  it('should support broadcast messages', () => {
    sendMessage('a1', null, 'Broadcast!');

    const forA2 = readMessages('a2');
    expect(forA2).toHaveLength(1);

    const forA3 = readMessages('a3');
    expect(forA3).toHaveLength(1);
  });

  it('should mark messages as read', () => {
    sendMessage('a1', 'a2', 'Test');
    readMessages('a2'); // marks as read

    const unread = readMessages('a2', { unread_only: true });
    expect(unread).toHaveLength(0);
  });

  it('should filter by sender', () => {
    sendMessage('a1', 'a3', 'From a1');
    sendMessage('a2', 'a3', 'From a2');

    const messages = readMessages('a3', { from: 'a1' });
    expect(messages).toHaveLength(1);
    expect(messages[0].from_agent).toBe('a1');
  });
});

describe('tasks', () => {
  it('should create and list tasks', () => {
    createTask({ title: 'Task 1', created_by: 'a1', priority: 'high' });
    createTask({ title: 'Task 2', created_by: 'a2' });

    const tasks = listTasks();
    expect(tasks).toHaveLength(2);
  });

  it('should update task', () => {
    const task = createTask({ title: 'Task', created_by: 'a1' });
    const updated = updateTask(task.id, { status: 'in_progress', assigned_to: 'a2' });

    expect(updated!.status).toBe('in_progress');
    expect(updated!.assigned_to).toBe('a2');
  });

  it('should filter tasks', () => {
    createTask({ title: 'T1', created_by: 'a1', assigned_to: 'a2' });
    const t2 = createTask({ title: 'T2', created_by: 'a1' });
    updateTask(t2.id, { status: 'done' });

    expect(listTasks({ status: 'pending' })).toHaveLength(1);
    expect(listTasks({ assigned_to: 'a2' })).toHaveLength(1);
    expect(listTasks({ status: 'done' })).toHaveLength(1);
  });

  it('should return null for unknown task', () => {
    expect(updateTask(999, { status: 'done' })).toBeNull();
  });

  it('should persist and update task dependencies', () => {
    const t1 = createTask({ title: 'dep-a', created_by: 'a1' });
    const t2 = createTask({ title: 'dep-b', created_by: 'a1' });
    const parent = createTask({ title: 'parent', created_by: 'a1', depends_on: [t1.id, t2.id] });

    expect(getTaskDependencies(parent.id)).toEqual([t1.id, t2.id]);
    const updated = updateTask(parent.id, { depends_on: [t2.id] });
    expect(updated).not.toBeNull();
    expect(getTaskDependencies(parent.id)).toEqual([t2.id]);

    const withDeps = getTaskWithDependencies(parent.id);
    expect(withDeps?.depends_on).toEqual([t2.id]);
  });

  it('should poll only dependency-ready tasks', () => {
    const upstream = createTask({ title: 'upstream', created_by: 'a1', priority: 'medium' });
    createTask({ title: 'blocked-critical', created_by: 'a1', priority: 'critical', depends_on: [upstream.id] });
    const readyHigh = createTask({ title: 'ready-high', created_by: 'a1', priority: 'high' });

    const first = pollAndClaim('a2', 120);
    expect(first?.task.id).toBe(readyHigh.id);
    if (first) {
      releaseTaskClaim(first.task.id, 'a2', 'done', first.claim.claim_id);
    }
    const second = pollAndClaim('a2', 120);
    expect(second?.task.id).toBe(upstream.id);
  });
});

describe('task claims', () => {
  it('should claim task and set in_progress assignment', () => {
    const task = createTask({ title: 'Lease me', created_by: 'a1' });
    const claimed = claimTask(task.id, 'a2', 120);
    expect(claimed.success).toBe(true);
    if (!claimed.success) return;

    expect(claimed.task.status).toBe('in_progress');
    expect(claimed.task.assigned_to).toBe('a2');
    expect(claimed.claim.agent_id).toBe('a2');
    expect(claimed.claim.task_id).toBe(task.id);
  });

  it('should prevent claim hijack while lease is active', () => {
    const task = createTask({ title: 'Contended', created_by: 'a1' });
    const first = claimTask(task.id, 'a2', 300);
    expect(first.success).toBe(true);

    const second = claimTask(task.id, 'a3', 300);
    expect(second.success).toBe(false);
    if (second.success) return;
    expect(second.error).toContain('already claimed');
    expect(second.current_claim?.agent_id).toBe('a2');
  });

  it('should renew and list claims', () => {
    const task = createTask({ title: 'Renewable', created_by: 'a1' });
    const first = claimTask(task.id, 'a2', 60);
    expect(first.success).toBe(true);
    if (!first.success) return;

    const renewed = renewTaskClaim(task.id, 'a2', 180);
    expect(renewed.success).toBe(true);
    if (!renewed.success) return;
    expect(renewed.claim.lease_expires_at).toBeGreaterThan(first.claim.lease_expires_at);

    const claims = listTaskClaims({ agent_id: 'a2' });
    expect(claims).toHaveLength(1);
    expect(claims[0].task_id).toBe(task.id);
    expect(claims[0].task_title).toBe('Renewable');
  });

  it('should rotate claim_id when same agent re-claims', () => {
    const task = createTask({ title: 'Reclaimable', created_by: 'a1' });
    const first = claimTask(task.id, 'a2', 120);
    expect(first.success).toBe(true);
    if (!first.success) return;

    const second = claimTask(task.id, 'a2', 180);
    expect(second.success).toBe(true);
    if (!second.success) return;

    expect(second.claim.claim_id).not.toBe(first.claim.claim_id);
    expect(second.claim.lease_expires_at).toBeGreaterThan(first.claim.lease_expires_at);
  });

  it('should release claim and set requested status', () => {
    const task = createTask({ title: 'Finish me', created_by: 'a1' });
    const first = claimTask(task.id, 'a2', 120);
    expect(first.success).toBe(true);

    const released = releaseTaskClaim(task.id, 'a2', 'done');
    expect(released.success).toBe(true);
    if (!released.success) return;
    expect(released.task.status).toBe('done');
    expect(released.task.assigned_to).toBe('a2');
    expect(listTaskClaims({})).toHaveLength(0);
  });

  it('should reject renew/release when claim_id does not match', () => {
    const task = createTask({ title: 'Claim guard', created_by: 'a1' });
    const first = claimTask(task.id, 'a2', 120);
    expect(first.success).toBe(true);
    if (!first.success) return;

    const badRenew = renewTaskClaim(task.id, 'a2', 120, 'wrong-claim-id');
    expect(badRenew.success).toBe(false);
    if (badRenew.success) return;
    expect(badRenew.error_code).toBe('CLAIM_ID_MISMATCH');

    const badRelease = releaseTaskClaim(task.id, 'a2', 'done', 'wrong-claim-id');
    expect(badRelease.success).toBe(false);
    if (badRelease.success) return;
    expect(badRelease.error_code).toBe('CLAIM_ID_MISMATCH');
  });

  it('should avoid assigning task when stale claim row already exists', () => {
    const task = createTask({ title: 'Stale claim row', created_by: 'a1', priority: 'high' });
    const now = Date.now();
    const db = getDb();
    db.prepare(`
      INSERT INTO task_claims (task_id, agent_id, claim_id, claimed_at, lease_expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(task.id, 'ghost-agent', 'ghost-claim-id', now, now + 60_000, now);

    const claimed = pollAndClaim('a2', 120);
    expect(claimed).toBeNull();

    const refreshed = listTasks({ status: 'pending' });
    expect(refreshed.find((t) => t.id === task.id)?.assigned_to ?? null).toBeNull();
    expect(listTaskClaims({}).find((c) => c.task_id === task.id)?.agent_id).toBe('ghost-agent');
  });
});

describe('context', () => {
  it('should share and get context', () => {
    shareContext('a1', 'project', 'mcp-hub');
    const ctx = getContext({ agent_id: 'a1', key: 'project' });
    expect(ctx).toHaveLength(1);
    expect(ctx[0].value).toBe('mcp-hub');
  });

  it('should upsert context', () => {
    shareContext('a1', 'status', 'working');
    shareContext('a1', 'status', 'done');

    const ctx = getContext({ agent_id: 'a1', key: 'status' });
    expect(ctx).toHaveLength(1);
    expect(ctx[0].value).toBe('done');
  });

  it('should get all context', () => {
    shareContext('a1', 'k1', 'v1');
    shareContext('a2', 'k2', 'v2');

    const all = getContext();
    expect(all).toHaveLength(2);
  });
});

describe('activity log', () => {
  it('should log and retrieve activity', () => {
    logActivity('a1', 'test_action', 'details here');
    logActivity('a2', 'other_action', '');

    const log = getActivityLog();
    expect(log).toHaveLength(2);
  });

  it('should filter by agent', () => {
    logActivity('a1', 'action1', '');
    logActivity('a2', 'action2', '');

    const log = getActivityLog({ agent_id: 'a1' });
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe('action1');
  });

  it('should respect limit', () => {
    for (let i = 0; i < 10; i++) {
      logActivity('a1', `action_${i}`, '');
    }
    const log = getActivityLog({ limit: 3 });
    expect(log).toHaveLength(3);
  });
});

describe('agent quality and idempotency', () => {
  it('should track completion and rollback counters', () => {
    expect(getAgentQuality('a1').completed_count).toBe(0);
    recordTaskCompletion('a1');
    recordTaskCompletion('a1');
    recordTaskRollback('a1');
    const quality = getAgentQuality('a1');
    expect(quality.completed_count).toBe(2);
    expect(quality.rollback_count).toBe(1);
  });

  it('should store and retrieve idempotency record', () => {
    expect(getIdempotencyRecord('a1', 'send_message', 'idem-1')).toBeNull();
    saveIdempotencyRecord('a1', 'send_message', 'idem-1', { success: true, n: 1 });
    const record = getIdempotencyRecord('a1', 'send_message', 'idem-1');
    expect(record).not.toBeNull();
    expect(record?.response_json).toContain('"success":true');
  });
});

describe('kpi and update watermark', () => {
  it('should provide KPI windows and watermark snapshots', () => {
    registerAgent({ id: 'observer', name: 'Observer', type: 'codex', capabilities: '' });
    const t1 = createTask({ title: 'kpi-task', created_by: 'a1' });
    updateTask(t1.id, { status: 'in_progress', assigned_to: 'a2' });
    sendMessage('a1', 'a2', 'hello');
    shareContext('a1', 'status', 'running');
    logActivity('a1', 'list_tasks', 'kpi probe');
    logActivity('a1', 'claim_task_failed', 'Task #10: mismatch (PROFILE_MISMATCH)');
    logActivity('a1', 'create_artifact_upload', 'artifact_id=a');
    logActivity('a1', 'artifact_upload_http', 'artifact_id=a bytes=10');
    logActivity('a1', 'create_artifact_download', 'artifact_id=a');
    logActivity('a1', 'artifact_download_http', 'artifact_id=a bytes=10');
    logActivity('a1', 'share_artifact', 'artifact_id=a to=*');
    logActivity('a1', 'attach_task_artifact', 'task_id=1 artifact_id=a created=1 shared_to_assignee=1');
    logActivity('a1', 'list_task_artifacts', 'task_id=1 count=1');
    logActivity('a1', 'poll_and_claim', 'No dependency-ready tasks available ns=* include_artifacts=1 (retry_after_ms=1000)');
    logActivity('a1', 'claim_task', 'Claimed task #1 claim_id=x deps=0 include_artifacts=1 until 2026-02-17T00:00:00.000Z');
    logActivity('a1', 'wait_for_updates_hit', 'changed={"messages":true}');
    logActivity('a1', 'wait_for_updates_timeout', 'wait_ms=1500 retry_after_ms=220 mode=micro adaptive=1 streams=messages');
    logActivity('a1', 'wait_for_updates_timeout', 'wait_ms=1500 retry_after_ms=260 mode=micro adaptive=1 streams=messages');
    recordAuthEvent('a1', 'wait_for_updates', 'valid');
    recordAuthEvent('a1', 'wait_for_updates', 'valid');
    recordAuthEvent('a1', 'wait_for_updates', 'valid');

    const kpi = getKpiWindows([60_000, 300_000]);
    expect(kpi.windows).toHaveLength(2);
    expect(kpi.queue.tasks_pending + kpi.queue.tasks_in_progress + kpi.queue.tasks_done).toBeGreaterThanOrEqual(1);
    expect(kpi.execution_backlog.length).toBeGreaterThanOrEqual(1);
    expect(kpi.windows[0].profile_mismatch_claims).toBeGreaterThanOrEqual(1);
    expect(kpi.windows[0].artifact_uploads).toBeGreaterThanOrEqual(2);
    expect(kpi.windows[0].artifact_downloads).toBeGreaterThanOrEqual(2);
    expect(kpi.windows[0].artifact_shares).toBeGreaterThanOrEqual(1);
    expect(kpi.windows[0].task_artifact_attaches).toBeGreaterThanOrEqual(1);
    expect(kpi.windows[0].task_artifact_queries).toBeGreaterThanOrEqual(1);
    expect(kpi.windows[0].claim_with_artifact_hints).toBeGreaterThanOrEqual(1);
    expect(kpi.windows[0].wait_calls).toBeGreaterThanOrEqual(kpi.windows[0].wait_hits);
    expect(kpi.windows[0].wait_hits).toBeGreaterThanOrEqual(1);
    expect(kpi.windows[0].wait_timeouts).toBeGreaterThanOrEqual(2);
    expect(kpi.windows[0].wait_retry_after_avg_ms).toBeGreaterThanOrEqual(200);
    expect(kpi.windows[0].wait_retry_after_p95_ms).toBeGreaterThanOrEqual(220);

    const watermark = getUpdateWatermark('a2');
    expect(watermark.latest_message_ts).toBeGreaterThan(0);
    expect(watermark.latest_task_ts).toBeGreaterThan(0);
    expect(watermark.latest_context_ts).toBeGreaterThan(0);
  });
});

describe('slo alerts', () => {
  it('should trigger and list SLO alerts for old pending and stale in_progress tasks', () => {
    const db = getDb();
    const pending = createTask({ title: 'old pending', created_by: 'a1' });
    const stale = createTask({ title: 'stale in progress', created_by: 'a1', assigned_to: 'a2' });
    updateTask(stale.id, { status: 'in_progress', assigned_to: 'a2' });

    const now = Date.now();
    db.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?').run(now - (31 * 60 * 1000), now - (31 * 60 * 1000), pending.id);
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now - (21 * 60 * 1000), stale.id);
    db.prepare('DELETE FROM task_claims WHERE task_id = ?').run(stale.id);

    const evalResult = evaluateSloAlerts(now);
    expect(evalResult.open_alerts.length).toBeGreaterThanOrEqual(1);
    const codes = evalResult.open_alerts.map((a) => a.code);
    expect(codes).toContain('high_pending_age');
    expect(codes).toContain('stale_in_progress');

    const listed = listSloAlerts({ open_only: true });
    expect(listed.length).toBeGreaterThanOrEqual(2);
  });
});

describe('auth coverage', () => {
  it('should aggregate auth event coverage', () => {
    recordAuthEvent('a1', 'list_tasks', 'valid');
    recordAuthEvent('a1', 'read_messages', 'missing');
    recordAuthEvent('a2', 'list_tasks', 'invalid');
    recordAuthEvent(null, 'register_agent', 'skipped');

    const coverage = getAuthCoverageSnapshot(60_000);
    expect(coverage.total_events).toBe(4);
    expect(coverage.valid_events).toBe(1);
    expect(coverage.missing_events).toBe(1);
    expect(coverage.invalid_events).toBe(1);
    expect(coverage.skipped_events).toBe(1);
    expect(coverage.valid_coverage_pct).toBeCloseTo(33.33, 2);
    expect(coverage.by_tool.length).toBeGreaterThanOrEqual(1);
  });
});
