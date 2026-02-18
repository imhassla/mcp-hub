import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, finalizeArtifactUpload, initDb, registerAgent } from '../src/db.js';
import {
  configureArtifactTicketIssuer,
  handleCreateArtifactDownload,
  handleCreateTaskArtifactDownloads,
  handleCreateArtifactUpload,
  handleListArtifacts,
  handleShareArtifact,
} from '../src/tools/artifacts.js';
import { handleAttachTaskArtifact, handleCreateTask, handleListTaskArtifacts } from '../src/tools/tasks.js';

beforeEach(() => {
  initDb(':memory:');
  registerAgent({ id: 'owner', name: 'Owner', type: 'codex', capabilities: 'artifacts' });
  registerAgent({ id: 'worker', name: 'Worker', type: 'claude', capabilities: 'consumer' });
  configureArtifactTicketIssuer((args) => ({
    token: `${args.kind}-${args.artifact_id}-${args.agent_id}`,
    expires_at: Date.now() + (args.ttl_sec * 1000),
  }));
});

afterEach(() => {
  closeDb();
});

describe('artifact tools', () => {
  it('should create upload ticket and persist artifact metadata', () => {
    const created = handleCreateArtifactUpload({
      agent_id: 'owner',
      name: 'handoff.patch',
      namespace: 'EXP-A',
      summary: 'patch from isolated worker',
    });

    expect(created.success).toBe(true);
    if (!created.success) return;
    expect(created.artifact.id).toBeTypeOf('string');
    expect(created.artifact.namespace).toBe('EXP-A');
    expect(created.upload.method).toBe('POST');
    expect(created.upload.url).toContain('/artifacts/upload/');
  });

  it('should require share before non-owner download', () => {
    const created = handleCreateArtifactUpload({
      agent_id: 'owner',
      name: 'result.bin',
      namespace: 'EXP-B',
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    const finalized = finalizeArtifactUpload({
      id: created.artifact.id,
      size_bytes: 128,
      sha256: 'a'.repeat(64),
      storage_path: '/tmp/fake-artifact.bin',
    });
    expect(finalized).not.toBeNull();

    const denied = handleCreateArtifactDownload({
      agent_id: 'worker',
      artifact_id: created.artifact.id,
    });
    expect(denied.success).toBe(false);
    if (denied.success) return;
    expect(denied.error_code).toBe('ARTIFACT_ACCESS_DENIED');

    const shared = handleShareArtifact({
      from_agent: 'owner',
      artifact_id: created.artifact.id,
      to_agent: 'worker',
      notify: false,
    });
    expect(shared.success).toBe(true);

    const granted = handleCreateArtifactDownload({
      agent_id: 'worker',
      artifact_id: created.artifact.id,
    });
    expect(granted.success).toBe(true);
    if (!granted.success) return;
    expect(granted.download.url).toContain('/artifacts/download/');
  });

  it('should list visible artifacts in tiny mode', () => {
    const created = handleCreateArtifactUpload({
      agent_id: 'owner',
      name: 'tiny-check.txt',
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    finalizeArtifactUpload({
      id: created.artifact.id,
      size_bytes: 16,
      sha256: 'b'.repeat(64),
      storage_path: '/tmp/fake-tiny.bin',
    });

    const list = handleListArtifacts({
      agent_id: 'owner',
      response_mode: 'tiny',
    });
    expect(list.success).toBe(true);
    expect(list.artifacts).toHaveLength(1);
    expect(list.artifacts[0].ready).toBe(true);
  });

  it('should issue bulk task artifact download tickets', () => {
    const task = handleCreateTask({ title: 'bulk download task', created_by: 'owner', assigned_to: 'worker' });
    expect(task.success).toBe(true);
    if (!task.success) return;

    const first = handleCreateArtifactUpload({
      agent_id: 'owner',
      name: 'a.bin',
    });
    const second = handleCreateArtifactUpload({
      agent_id: 'owner',
      name: 'b.bin',
    });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;

    finalizeArtifactUpload({
      id: first.artifact.id,
      size_bytes: 10,
      sha256: 'c'.repeat(64),
      storage_path: '/tmp/a.bin',
    });
    finalizeArtifactUpload({
      id: second.artifact.id,
      size_bytes: 20,
      sha256: 'd'.repeat(64),
      storage_path: '/tmp/b.bin',
    });

    const attachedFirst = handleAttachTaskArtifact({
      task_id: task.task.id,
      artifact_id: first.artifact.id,
      agent_id: 'owner',
    });
    const attachedSecond = handleAttachTaskArtifact({
      task_id: task.task.id,
      artifact_id: second.artifact.id,
      agent_id: 'owner',
    });
    expect(attachedFirst.success).toBe(true);
    expect(attachedSecond.success).toBe(true);

    const batch = handleCreateTaskArtifactDownloads({
      agent_id: 'worker',
      task_id: task.task.id,
    });
    expect(batch.success).toBe(true);
    if (!batch.success) return;
    expect(batch.downloads).toHaveLength(2);
    expect(batch.summary.issued).toBe(2);
    expect(batch.downloads[0].download.url).toContain('/artifacts/download/');
  });

  it('should support limit for bulk task artifact download tickets', () => {
    const task = handleCreateTask({ title: 'limited bulk download task', created_by: 'owner', assigned_to: 'worker' });
    expect(task.success).toBe(true);
    if (!task.success) return;

    for (let i = 0; i < 3; i += 1) {
      const created = handleCreateArtifactUpload({
        agent_id: 'owner',
        name: `limit-${i}.bin`,
      });
      expect(created.success).toBe(true);
      if (!created.success) return;
      finalizeArtifactUpload({
        id: created.artifact.id,
        size_bytes: 10 + i,
        sha256: String.fromCharCode(102 + i).repeat(64),
        storage_path: `/tmp/limit-${i}.bin`,
      });
      const attached = handleAttachTaskArtifact({
        task_id: task.task.id,
        artifact_id: created.artifact.id,
        agent_id: 'owner',
      });
      expect(attached.success).toBe(true);
    }

    const batch = handleCreateTaskArtifactDownloads({
      agent_id: 'worker',
      task_id: task.task.id,
      limit: 2,
    });
    expect(batch.success).toBe(true);
    if (!batch.success) return;
    expect(batch.downloads).toHaveLength(2);
    expect(batch.summary.total_attached).toBe(3);
    expect(batch.summary.considered).toBe(2);
    expect(batch.summary.skipped_limit).toBe(1);
  });

  it('share_artifact should optionally bind artifact to task and auto-share assignee', () => {
    const task = handleCreateTask({ title: 'bind via share', created_by: 'owner', assigned_to: 'worker' });
    expect(task.success).toBe(true);
    if (!task.success) return;

    const created = handleCreateArtifactUpload({
      agent_id: 'owner',
      name: 'bound.bin',
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    finalizeArtifactUpload({
      id: created.artifact.id,
      size_bytes: 32,
      sha256: 'e'.repeat(64),
      storage_path: '/tmp/bound.bin',
    });

    const shared = handleShareArtifact({
      from_agent: 'owner',
      artifact_id: created.artifact.id,
      to_agent: 'reviewer',
      task_id: task.task.id,
      notify: false,
    });
    expect(shared.success).toBe(true);
    if (!shared.success) return;
    expect(shared.task_binding?.task_id).toBe(task.task.id);
    expect(shared.task_binding?.attached).toBe(true);
    expect(shared.task_binding?.shared_to_assignee).toBe(true);

    const list = handleListTaskArtifacts({
      task_id: task.task.id,
      agent_id: 'worker',
      response_mode: 'tiny',
    });
    expect(list.success).toBe(true);
    if (!list.success) return;
    expect(list.artifacts).toHaveLength(1);
    expect(list.artifacts[0].artifact_id).toBe(created.artifact.id);
    expect(list.artifacts[0].has_access).toBe(true);
  });
});
