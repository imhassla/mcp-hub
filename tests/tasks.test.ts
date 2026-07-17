import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, registerAgent, createArtifactRecord, finalizeArtifactUpload } from '../src/db.js';
import { configureArtifactTicketIssuer } from '../src/tools/artifacts.js';
import {
  handleCreateTask,
  handleUpdateTask,
  handleListTasks,
  handlePollAndClaim,
  handleClaimTask,
  handleRenewTaskClaim,
  handleReleaseTaskClaim,
  handleListTaskClaims,
  handleAttachTaskArtifact,
  handleListTaskArtifacts,
  handleGetTaskHandoff,
} from '../src/tools/tasks.js';

beforeEach(() => {
  initDb(':memory:');
  registerAgent({ id: 'a1', name: 'A1', type: 'claude', capabilities: '' });
  registerAgent({ id: 'a2', name: 'A2', type: 'codex', capabilities: '' });
});
afterEach(() => { closeDb(); });

describe('task tools', () => {
  it('create_task should return success', () => {
    const result = handleCreateTask({ title: 'Fix bug', created_by: 'a1', priority: 'high' });
    expect(result.success).toBe(true);
    expect(result.task.title).toBe('Fix bug');
    expect(result.task.priority).toBe('high');
  });

  it('update_task should change status', () => {
    const { task } = handleCreateTask({ title: 'Task', created_by: 'a1' });
    const result = handleUpdateTask({ id: task.id, agent_id: 'a2', status: 'in_progress' });
    expect(result.success).toBe(true);
    expect(result.task!.status).toBe('in_progress');
  });

  it('update_task should reject a self-dependency', () => {
    const { task } = handleCreateTask({ title: 'Self dependency', created_by: 'a1' });

    const result = handleUpdateTask({ id: task.id, agent_id: 'a1', depends_on: [task.id] });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error_code).toBe('DEPENDENCY_CYCLE');
  });

  it('update_task should reject done while dependencies are unmet', () => {
    const { task: upstream } = handleCreateTask({ title: 'unfinished handler dependency', created_by: 'a1' });
    const { task } = handleCreateTask({
      title: 'handler dependent',
      created_by: 'a1',
      depends_on: [upstream.id],
    });

    const result = handleUpdateTask({
      id: task.id,
      agent_id: 'a1',
      status: 'done',
      confidence: 0.96,
      verification_passed: true,
      evidence_refs: ['test:handler-too-early'],
    });

    expect(result).toMatchObject({
      success: false,
      error_code: 'DEPENDENCIES_NOT_MET',
      unmet_dependencies: [upstream.id],
    });
  });

  it('update_task should reject in_progress while dependencies are unmet', () => {
    const { task: upstream } = handleCreateTask({ title: 'unfinished start dependency', created_by: 'a1' });
    const { task } = handleCreateTask({
      title: 'handler must not start',
      created_by: 'a1',
      depends_on: [upstream.id],
    });

    const result = handleUpdateTask({
      id: task.id,
      agent_id: 'a2',
      status: 'in_progress',
      assigned_to: 'a2',
    });

    expect(result).toMatchObject({
      success: false,
      error_code: 'DEPENDENCIES_NOT_MET',
      unmet_dependencies: [upstream.id],
    });
    expect(handleListTasks({ assigned_to: 'a2', agent_id: 'a2' }).tasks).toHaveLength(0);
  });

  it('update_task should report active dependents that block an upstream rollback', () => {
    const { task: upstream } = handleCreateTask({ title: 'completed upstream', created_by: 'a1' });
    expect(handleUpdateTask({
      id: upstream.id,
      agent_id: 'a1',
      status: 'done',
      confidence: 0.96,
      verification_passed: true,
      evidence_refs: ['test:rollback-upstream'],
    }).success).toBe(true);
    const { task: dependent } = handleCreateTask({
      title: 'active downstream',
      created_by: 'a1',
      depends_on: [upstream.id],
    });
    expect(handleClaimTask({ task_id: dependent.id, agent_id: 'a2', lease_seconds: 120 }).success).toBe(true);

    expect(handleUpdateTask({
      id: upstream.id,
      agent_id: 'a1',
      status: 'pending',
    })).toMatchObject({
      success: false,
      error_code: 'TASK_HAS_ACTIVE_DEPENDENTS',
      dependent_task_ids: [dependent.id],
    });
  });

  it('update_task should reject dependency mutation after work starts', () => {
    const { task: upstream } = handleCreateTask({ title: 'handler lock input', created_by: 'a1' });
    const { task } = handleCreateTask({ title: 'handler lock target', created_by: 'a1' });
    const claimed = handleClaimTask({ task_id: task.id, agent_id: 'a2', lease_seconds: 120 });
    expect(claimed.success).toBe(true);

    const result = handleUpdateTask({ id: task.id, agent_id: 'a1', depends_on: [upstream.id] });

    expect(result).toMatchObject({
      success: false,
      error_code: 'TASK_DEPENDENCIES_LOCKED',
    });
  });

  it('list_tasks should filter by status', () => {
    handleCreateTask({ title: 'T1', created_by: 'a1' });
    const { task: t2 } = handleCreateTask({ title: 'T2', created_by: 'a1' });
    handleUpdateTask({
      id: t2.id,
      agent_id: 'a1',
      status: 'done',
      confidence: 0.96,
      verification_passed: true,
      evidence_refs: ['test:list-status'],
    });

    const pending = handleListTasks({ status: 'pending', agent_id: 'a1' });
    expect(pending.tasks).toHaveLength(1);
  });

  it('claim/renew/release flow should work', () => {
    const { task } = handleCreateTask({ title: 'Claimable', created_by: 'a1' });

    const claimed = handleClaimTask({ task_id: task.id, agent_id: 'a2', lease_seconds: 120 });
    expect(claimed.success).toBe(true);
    if (!claimed.success) return;
    expect(claimed.task.assigned_to).toBe('a2');

    const renewed = handleRenewTaskClaim({ task_id: task.id, agent_id: 'a2', lease_seconds: 300 });
    expect(renewed.success).toBe(true);

    const claims = handleListTaskClaims({ requesting_agent: 'a1' });
    expect(claims.claims).toHaveLength(1);
    expect(claims.claims[0].task_id).toBe(task.id);

    const released = handleReleaseTaskClaim({
      task_id: task.id,
      agent_id: 'a2',
      next_status: 'done',
      confidence: 0.95,
      verification_passed: true,
      evidence_refs: ['test:claim-release'],
    });
    expect(released.success).toBe(true);
    if (!released.success) return;
    expect(released.task.status).toBe('done');
  });

  it('release_task_claim can keep a pending task assigned to the claimant', () => {
    const { task } = handleCreateTask({ title: 'Retry with same agent', created_by: 'a1', assigned_to: 'a2' });
    const claimed = handleClaimTask({ task_id: task.id, agent_id: 'a2', lease_seconds: 120 });
    expect(claimed.success).toBe(true);
    if (!claimed.success) return;

    const released = handleReleaseTaskClaim({
      task_id: task.id,
      agent_id: 'a2',
      claim_id: claimed.claim.claim_id,
      next_status: 'pending',
      preserve_assignment: true,
    });

    expect(released.success).toBe(true);
    if (!released.success) return;
    expect(released.task.status).toBe('pending');
    expect(released.task.assigned_to).toBe('a2');
  });

  it('poll_and_claim should return claim metadata and retry hint', () => {
    const claimedTask = handleCreateTask({ title: 'Queue item', created_by: 'a1' });
    const claimed = handlePollAndClaim({ agent_id: 'a2', lease_seconds: 120 });
    expect(claimed.success).toBe(true);
    expect(claimed.task?.id).toBe(claimedTask.task.id);
    expect(claimed.claim?.agent_id).toBe('a2');
    expect(claimed.claim?.lease_expires_at).toBeGreaterThan(Date.now());

    const empty = handlePollAndClaim({ agent_id: 'poller-no-task' });
    expect(empty.success).toBe(true);
    expect(empty.task).toBeNull();
    expect(empty.retry_after_ms).toBeGreaterThanOrEqual(200);
    expect(empty.retry_after_ms).toBeLessThanOrEqual(12000);
  });

  it('done transition should fail without confidence/verification', () => {
    const { task } = handleCreateTask({ title: 'Guarded done', created_by: 'a1' });
    const result = handleUpdateTask({ id: task.id, agent_id: 'a1', status: 'done' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error_code).toBe('DONE_GATE_FAILED');
  });

  it('strict consistency should require independent verifier for done transition', () => {
    const created = handleCreateTask({
      title: 'Critical strict task',
      created_by: 'a1',
      priority: 'critical',
    });
    expect(created.success).toBe(true);
    if (!created.success) return;
    expect(created.task.consistency_mode).toBe('strict');

    const blocked = handleUpdateTask({
      id: created.task.id,
      agent_id: 'a1',
      status: 'done',
      confidence: 0.98,
      verification_passed: true,
      evidence_refs: ['ev-1', 'ev-2'],
    });
    expect(blocked.success).toBe(false);
    if (blocked.success) return;
    expect(blocked.error_code).toBe('VERIFIER_REQUIRED');

    const unattested = handleUpdateTask({
      id: created.task.id,
      agent_id: 'a1',
      status: 'done',
      confidence: 0.98,
      verification_passed: true,
      verified_by: 'a2',
      evidence_refs: ['ev-1', 'ev-2'],
    });
    expect(unattested.success).toBe(false);
    if (!unattested.success) expect(unattested.error_code).toBe('VERIFIER_REQUIRED');

    const attestation = handleUpdateTask({
      id: created.task.id,
      agent_id: 'a2',
      evidence_refs: ['review:a2-approved'],
    });
    expect(attestation.success).toBe(true);

    const finalized = handleUpdateTask({
      id: created.task.id,
      agent_id: 'a1',
      status: 'done',
      confidence: 0.98,
      verification_passed: true,
      verified_by: 'a2',
      evidence_refs: ['ev-1'],
    });
    expect(finalized.success).toBe(true);
    if (!finalized.success) return;
    expect(finalized.task.status).toBe('done');
  });

  it('does not let a claimant downgrade a strict done gate or name an unknown verifier', () => {
    const created = handleCreateTask({
      title: 'Strict invariant',
      created_by: 'a1',
      consistency_mode: 'strict',
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    const claimed = handleClaimTask({ task_id: created.task.id, agent_id: 'a1' });
    expect(claimed.success).toBe(true);
    if (!claimed.success) return;

    const downgraded = handleReleaseTaskClaim({
      task_id: created.task.id,
      agent_id: 'a1',
      claim_id: claimed.claim.claim_id,
      next_status: 'done',
      consistency_mode: 'cheap',
      confidence: 0.98,
      verification_passed: true,
      evidence_refs: ['ev-1', 'ev-2'],
    });
    expect(downgraded.success).toBe(false);
    if (!downgraded.success) expect(downgraded.error_code).toBe('VERIFIER_REQUIRED');

    const fakeVerifier = handleReleaseTaskClaim({
      task_id: created.task.id,
      agent_id: 'a1',
      claim_id: claimed.claim.claim_id,
      next_status: 'done',
      consistency_mode: 'cheap',
      confidence: 0.98,
      verification_passed: true,
      verified_by: 'not-a-registered-agent',
      evidence_refs: ['ev-1', 'ev-2'],
    });
    expect(fakeVerifier.success).toBe(false);
    if (!fakeVerifier.success) expect(fakeVerifier.error_code).toBe('VERIFIER_REQUIRED');

    const unattestedVerifier = handleReleaseTaskClaim({
      task_id: created.task.id,
      agent_id: 'a1',
      claim_id: claimed.claim.claim_id,
      next_status: 'done',
      consistency_mode: 'cheap',
      confidence: 0.98,
      verification_passed: true,
      verified_by: 'a2',
      evidence_refs: ['claimant:result', 'claimant:tests'],
    });
    expect(unattestedVerifier.success).toBe(false);
    if (!unattestedVerifier.success) expect(unattestedVerifier.error_code).toBe('VERIFIER_REQUIRED');

    const update = handleUpdateTask({
      id: created.task.id,
      agent_id: 'a1',
      consistency_mode: 'cheap',
    });
    expect(update.success).toBe(true);
    if (update.success) expect(update.task.consistency_mode).toBe('strict');

    const attestation = handleUpdateTask({
      id: created.task.id,
      agent_id: 'a2',
      evidence_refs: ['review:a2-approved'],
    });
    expect(attestation.success).toBe(true);

    const finalized = handleReleaseTaskClaim({
      task_id: created.task.id,
      agent_id: 'a1',
      claim_id: claimed.claim.claim_id,
      next_status: 'done',
      consistency_mode: 'cheap',
      confidence: 0.98,
      verification_passed: true,
      verified_by: 'a2',
      evidence_refs: ['claimant:result'],
    });
    expect(finalized.success).toBe(true);
    if (finalized.success) expect(finalized.task.status).toBe('done');
  });

  it('poll_and_claim should prefer dependency-ready tasks', () => {
    const base = handleCreateTask({ title: 'Base', created_by: 'a1', priority: 'medium' });
    handleCreateTask({ title: 'Blocked', created_by: 'a1', priority: 'critical', depends_on: [base.task.id] });
    const ready = handleCreateTask({ title: 'Ready', created_by: 'a1', priority: 'high' });

    const first = handlePollAndClaim({ agent_id: 'a2' });
    expect(first.success).toBe(true);
    expect(first.task?.id).toBe(ready.task.id);
    if (first.task) {
      handleReleaseTaskClaim({
        task_id: first.task.id,
        agent_id: 'a2',
        next_status: 'done',
        confidence: 0.95,
        verification_passed: true,
        evidence_refs: ['test:ready-release'],
      });
    }

    const second = handlePollAndClaim({ agent_id: 'a2' });
    expect(second.success).toBe(true);
    expect(second.task?.id).toBe(base.task.id);
  });

  it('create_task should support idempotency key', () => {
    const first = handleCreateTask({ title: 'Idempotent', created_by: 'a1', idempotency_key: 'create-1' });
    const second = handleCreateTask({ title: 'Idempotent', created_by: 'a1', idempotency_key: 'create-1' });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(first.task.id).toBe(second.task.id);

    const listed = handleListTasks({ agent_id: 'a1' });
    expect(listed.tasks.filter((task) => task.title.includes('Idempotent'))).toHaveLength(1);
  });

  it('create_task should reject idempotency key reuse with different arguments', () => {
    const first = handleCreateTask({ title: 'Original title', created_by: 'a1', idempotency_key: 'create-conflict' });
    const conflict = handleCreateTask({ title: 'Changed title', created_by: 'a1', idempotency_key: 'create-conflict' });

    expect(first.success).toBe(true);
    expect(conflict).toMatchObject({ success: false, error_code: 'IDEMPOTENCY_KEY_CONFLICT' });
    const listed = handleListTasks({ agent_id: 'a1' });
    expect(listed.tasks.filter((task) => task.title === 'Original title')).toHaveLength(1);
    expect(listed.tasks.filter((task) => task.title === 'Changed title')).toHaveLength(0);
  });

  it('list_tasks delta cursor should support incremental task reads', () => {
    handleCreateTask({ title: 'delta-1', created_by: 'a1' });
    handleCreateTask({ title: 'delta-2', created_by: 'a1' });
    handleCreateTask({ title: 'delta-3', created_by: 'a1' });

    const first = handleListTasks({ agent_id: 'a1', updated_after: 0, limit: 2, response_mode: 'compact' });
    expect(first.tasks).toHaveLength(2);
    expect(first.has_more).toBe(true);
    expect(typeof first.next_cursor).toBe('string');

    const second = handleListTasks({ agent_id: 'a1', cursor: first.next_cursor, limit: 2, response_mode: 'compact' });
    expect(second.tasks).toHaveLength(1);
    expect(second.has_more).toBe(false);
  });

  it('surfaces a newly ready dependent task after an existing delta cursor', () => {
    const base = handleCreateTask({ title: 'cursor dependency', created_by: 'a1' });
    const child = handleCreateTask({
      title: 'cursor dependent',
      created_by: 'a1',
      depends_on: [base.task.id],
    });
    const before = handleListTasks({
      agent_id: 'a1',
      status: 'pending',
      ready_only: true,
      updated_after: 0,
      response_mode: 'compact',
    });
    expect(before.tasks.map((task) => task.id)).toContain(base.task.id);
    expect(before.tasks.map((task) => task.id)).not.toContain(child.task.id);

    const completed = handleUpdateTask({
      id: base.task.id,
      agent_id: 'a1',
      status: 'done',
      confidence: 0.95,
      verification_passed: true,
      evidence_refs: ['test:dependency-complete'],
    });
    expect(completed.success).toBe(true);

    const after = handleListTasks({
      agent_id: 'a1',
      status: 'pending',
      ready_only: true,
      cursor: before.next_cursor,
      response_mode: 'compact',
    });
    expect(after.tasks.map((task) => task.id)).toContain(child.task.id);
  });

  it('list_tasks tiny mode should return minimal routing fields', () => {
    handleCreateTask({ title: 'Tiny task payload title', created_by: 'a1', priority: 'high', namespace: 'exp-tiny' });
    const result = handleListTasks({ agent_id: 'a1', response_mode: 'tiny' });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].id).toBeDefined();
    expect(result.tasks[0].title_preview).toContain('Tiny task');
    expect(result.tasks[0].title_chars).toBeGreaterThan(5);
    expect(result.tasks[0].title).toBeUndefined();
  });

  it('list_tasks nano mode should return short-key routing payload', () => {
    handleCreateTask({ title: 'Nano task payload title', created_by: 'a1', priority: 'high', namespace: 'exp-nano' });
    const result = handleListTasks({ agent_id: 'a1', response_mode: 'nano' });
    expect(Array.isArray(result.t)).toBe(true);
    expect(result.t).toHaveLength(1);
    expect(result.t[0].i).toBeDefined();
    expect(result.t[0].n).toBe('exp-nano');
    expect(result.t[0].tc).toBeGreaterThan(5);
    expect(result.t[0].t).toContain('Nano task');
    expect(result.tasks).toBeUndefined();
  });

  it('list_tasks should reject full mode in polling cycle', () => {
    handleCreateTask({ title: 'Polling full forbidden', created_by: 'a1', priority: 'medium', namespace: 'exp-poll' });
    const result = handleListTasks({ agent_id: 'a1', response_mode: 'full', polling: true }) as Record<string, any>;
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error_code).toBe('FULL_MODE_FORBIDDEN_IN_POLLING');
  });

  it('namespace governance should warn for swarm-like flows without namespace', () => {
    const created = handleCreateTask({
      title: 'SWARM protocol experiment',
      description: 'worker round',
      created_by: 'orchestrator',
    });
    expect(created.success).toBe(true);
    if (!created.success) return;
    expect(created.namespace_policy.mode).toBeDefined();
    expect(created.namespace_policy.warning).toContain('Namespace is required');
  });

  it('claim_task should reject runtime/profile mismatch for execution_mode', () => {
    handleCreateTask({
      title: 'Repo-only task',
      created_by: 'a1',
      execution_mode: 'repo',
    });
    registerAgent({
      id: 'a2',
      name: 'A2 isolated',
      type: 'codex',
      capabilities: '',
      runtime_profile: { mode: 'isolated', source: 'client_declared' },
    });

    const listed = handleListTasks({ agent_id: 'a1', response_mode: 'compact' });
    const taskId = listed.tasks[0].id as number;

    const claimed = handleClaimTask({ task_id: taskId, agent_id: 'a2' });
    expect(claimed.success).toBe(false);
    if (claimed.success) return;
    expect(claimed.error_code).toBe('PROFILE_MISMATCH');
  });

  it('poll_and_claim should route tasks by execution_mode compatibility', () => {
    registerAgent({
      id: 'a2',
      name: 'A2 isolated',
      type: 'codex',
      capabilities: '',
      runtime_profile: { mode: 'isolated', source: 'client_declared' },
    });

    const repoTask = handleCreateTask({ title: 'Repo task', created_by: 'a1', execution_mode: 'repo', priority: 'critical' });
    const isolatedTask = handleCreateTask({ title: 'Isolated task', created_by: 'a1', execution_mode: 'isolated', priority: 'high' });
    expect(repoTask.success).toBe(true);
    expect(isolatedTask.success).toBe(true);

    const polled = handlePollAndClaim({ agent_id: 'a2' });
    expect(polled.success).toBe(true);
    expect(polled.task?.execution_mode).toBe('isolated');
    expect(polled.task?.title).toBe('Isolated task');
  });

  it('attach_task_artifact should auto-share to current assignee and list as accessible', () => {
    const { task } = handleCreateTask({ title: 'Task with artifact', created_by: 'a1', assigned_to: 'a2' });
    const artifact = createArtifactRecord({
      id: 'art-1',
      created_by: 'a1',
      name: 'spec.txt',
      namespace: 'default',
    });
    finalizeArtifactUpload({
      id: artifact.id,
      size_bytes: 8,
      sha256: 'a'.repeat(64),
      storage_path: '/tmp/spec.txt',
    });

    const attached = handleAttachTaskArtifact({
      task_id: task.id,
      artifact_id: artifact.id,
      agent_id: 'a1',
    });
    expect(attached.success).toBe(true);
    if (!attached.success) return;
    expect(attached.shared_to_assignee).toBe(true);

    const listed = handleListTaskArtifacts({
      task_id: task.id,
      agent_id: 'a2',
      response_mode: 'tiny',
    });
    expect(listed.success).toBe(true);
    if (!listed.success) return;
    expect(listed.artifacts).toHaveLength(1);
    expect(listed.artifacts[0].artifact_id).toBe(artifact.id);
    expect(listed.artifacts[0].has_access).toBe(true);
    expect(listed.artifacts[0].ready).toBe(true);

    const claimed = handleClaimTask({
      task_id: task.id,
      agent_id: 'a2',
      include_artifacts: true,
    });
    expect(claimed.success).toBe(true);
    if (!claimed.success) return;
    expect(claimed.task_artifacts).toHaveLength(1);
    expect(claimed.task_artifacts?.[0].artifact_id).toBe(artifact.id);
    expect(claimed.task_artifacts?.[0].has_access).toBe(true);
    expect(claimed.task_artifacts?.[0].ready).toBe(true);
  });

  it('list_task_artifacts should support pagination', () => {
    const { task } = handleCreateTask({ title: 'Task with many artifacts', created_by: 'a1', assigned_to: 'a2' });
    for (let i = 0; i < 3; i += 1) {
      const artifact = createArtifactRecord({
        id: `art-page-${i}`,
        created_by: 'a1',
        name: `artifact-${i}.bin`,
        namespace: 'default',
      });
      finalizeArtifactUpload({
        id: artifact.id,
        size_bytes: 10 + i,
        sha256: String.fromCharCode(97 + i).repeat(64),
        storage_path: `/tmp/art-page-${i}.bin`,
      });
      const attached = handleAttachTaskArtifact({
        task_id: task.id,
        artifact_id: artifact.id,
        agent_id: 'a1',
      });
      expect(attached.success).toBe(true);
    }

    const firstPage = handleListTaskArtifacts({
      task_id: task.id,
      agent_id: 'a2',
      response_mode: 'tiny',
      limit: 2,
      offset: 0,
    });
    expect(firstPage.success).toBe(true);
    if (!firstPage.success) return;
    expect(firstPage.artifacts).toHaveLength(2);
    expect(firstPage.has_more).toBe(true);
    expect(firstPage.next_offset).toBe(2);

    const secondPage = handleListTaskArtifacts({
      task_id: task.id,
      agent_id: 'a2',
      response_mode: 'tiny',
      limit: 2,
      offset: firstPage.next_offset || 0,
    });
    expect(secondPage.success).toBe(true);
    if (!secondPage.success) return;
    expect(secondPage.artifacts).toHaveLength(1);
    expect(secondPage.has_more).toBe(false);
    expect(secondPage.next_offset).toBeNull();
  });

  it('get_task_handoff should return consolidated tiny packet', () => {
    const base = handleCreateTask({ title: 'handoff-base', created_by: 'a1' });
    const { task } = handleCreateTask({
      title: 'handoff-main',
      created_by: 'a1',
      assigned_to: 'a2',
      depends_on: [base.task.id],
    });
    expect(handleUpdateTask({
      id: base.task.id,
      agent_id: 'a1',
      status: 'done',
      confidence: 0.96,
      verification_passed: true,
      evidence_refs: ['test:handoff-base'],
    }).success).toBe(true);
    expect(handleUpdateTask({
      id: task.id,
      agent_id: 'a1',
      status: 'in_progress',
      evidence_refs: ['handoff:evidence-1'],
    }).success).toBe(true);

    const artifact = createArtifactRecord({
      id: 'art-handoff-1',
      created_by: 'a1',
      name: 'handoff.bin',
      namespace: 'default',
    });
    finalizeArtifactUpload({
      id: artifact.id,
      size_bytes: 32,
      sha256: 'f'.repeat(64),
      storage_path: '/tmp/handoff.bin',
    });
    const attached = handleAttachTaskArtifact({
      task_id: task.id,
      artifact_id: artifact.id,
      agent_id: 'a1',
    });
    expect(attached.success).toBe(true);

    const handoff = handleGetTaskHandoff({
      task_id: task.id,
      agent_id: 'a2',
      response_mode: 'tiny',
    });
    expect(handoff.success).toBe(true);
    if (!handoff.success) return;
    expect(handoff.task.id).toBe(task.id);
    expect(handoff.depends_on).toContain(base.task.id);
    expect(handoff.evidence_refs).toContain('handoff:evidence-1');
    expect(handoff.artifacts).toHaveLength(1);
    expect(handoff.artifacts[0].artifact_id).toBe(artifact.id);
    expect(handoff.artifacts[0].has_access).toBe(true);
  });

  it('get_task_handoff should optionally include artifact download tickets', () => {
    configureArtifactTicketIssuer((args) => ({
      token: `${args.kind}-${args.artifact_id}-${args.agent_id}`,
      expires_at: Date.now() + (args.ttl_sec * 1000),
    }));

    const { task } = handleCreateTask({
      title: 'handoff-with-downloads',
      created_by: 'a1',
      assigned_to: 'a2',
    });
    const artifact = createArtifactRecord({
      id: 'art-handoff-2',
      created_by: 'a1',
      name: 'handoff-2.bin',
      namespace: 'default',
    });
    finalizeArtifactUpload({
      id: artifact.id,
      size_bytes: 64,
      sha256: 'e'.repeat(64),
      storage_path: '/tmp/handoff-2.bin',
    });
    const attached = handleAttachTaskArtifact({
      task_id: task.id,
      artifact_id: artifact.id,
      agent_id: 'a1',
    });
    expect(attached.success).toBe(true);

    const handoff = handleGetTaskHandoff({
      task_id: task.id,
      agent_id: 'a2',
      response_mode: 'tiny',
      include_downloads: true,
      download_ttl_sec: 120,
    });
    expect(handoff.success).toBe(true);
    if (!handoff.success) return;
    expect(handoff.artifact_downloads).toHaveLength(1);
    expect(handoff.artifact_downloads[0].artifact_id).toBe(artifact.id);
    expect(handoff.artifact_downloads[0].url).toContain('/artifacts/download/');
    expect(handoff.artifact_downloads_error).toBeUndefined();
  });

  it('attach_task_artifact should reject caller without artifact access', () => {
    registerAgent({ id: 'a3', name: 'A3', type: 'claude', capabilities: '' });
    const { task } = handleCreateTask({ title: 'Task with protected artifact', created_by: 'a1' });
    const artifact = createArtifactRecord({
      id: 'art-2',
      created_by: 'a1',
      name: 'private.bin',
      namespace: 'default',
    });

    const attached = handleAttachTaskArtifact({
      task_id: task.id,
      artifact_id: artifact.id,
      agent_id: 'a3',
    });
    expect(attached.success).toBe(false);
    if (attached.success) return;
    expect(attached.error_code).toBe('ARTIFACT_ACCESS_DENIED');
  });
});
