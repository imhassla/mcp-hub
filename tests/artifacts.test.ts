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
import {
  ArtifactDownloadTicketCapacityError,
  ArtifactUploadTicketCapacityError,
} from '../src/artifact-ticket-limits.js';

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

  it('should return a stable retryable error when upload ticket capacity is exhausted', () => {
    configureArtifactTicketIssuer(() => {
      throw new ArtifactUploadTicketCapacityError('agent');
    });

    const result = handleCreateArtifactUpload({
      agent_id: 'owner',
      name: 'capacity.bin',
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error_code: 'ARTIFACT_UPLOAD_TICKET_AGENT_LIMIT_EXCEEDED',
      retryable: true,
    }));
    expect(handleListArtifacts({ agent_id: 'owner' }).artifacts).toHaveLength(0);
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

  it('returns a retryable error when download ticket capacity is exhausted', () => {
    const created = handleCreateArtifactUpload({ agent_id: 'owner', name: 'download-capacity.bin' });
    expect(created.success).toBe(true);
    if (!created.success) return;
    finalizeArtifactUpload({
      id: created.artifact.id,
      size_bytes: 8,
      sha256: 'd'.repeat(64),
      storage_path: '/tmp/download-capacity.bin',
    });
    configureArtifactTicketIssuer(() => {
      throw new ArtifactDownloadTicketCapacityError('global');
    });

    expect(handleCreateArtifactDownload({
      agent_id: 'owner',
      artifact_id: created.artifact.id,
    })).toMatchObject({
      success: false,
      error_code: 'ARTIFACT_DOWNLOAD_TICKET_CAPACITY_EXCEEDED',
      retryable: true,
    });
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

  it('only the owner can re-share, and a blank target is rejected (T78-F2)', () => {
    const created = handleCreateArtifactUpload({ agent_id: 'owner', name: 'secret.bin', namespace: 'EXP-C' });
    expect(created.success).toBe(true);
    if (!created.success) return;
    finalizeArtifactUpload({ id: created.artifact.id, size_bytes: 16, sha256: 'b'.repeat(64), storage_path: '/tmp/secret.bin' });

    // Owner shares to worker (worker now has read access).
    expect(handleShareArtifact({ from_agent: 'owner', artifact_id: created.artifact.id, to_agent: 'worker', notify: false }).success).toBe(true);

    // A non-owner with access cannot re-share to a third party.
    const reShare = handleShareArtifact({ from_agent: 'worker', artifact_id: created.artifact.id, to_agent: 'evil', notify: false });
    expect(reShare.success).toBe(false);
    if (!reShare.success) expect(reShare.error_code).toBe('ARTIFACT_NOT_OWNER');

    // A blank to_agent no longer silently publishes to '*'.
    const blank = handleShareArtifact({ from_agent: 'owner', artifact_id: created.artifact.id, to_agent: '', notify: false });
    expect(blank.success).toBe(false);
    if (!blank.success) expect(blank.error_code).toBe('SHARE_TARGET_REQUIRED');

    // 'evil' never gained access via the rejected re-share.
    const evilDownload = handleCreateArtifactDownload({ agent_id: 'evil', artifact_id: created.artifact.id });
    expect(evilDownload.success).toBe(false);
  });

  it('does not let an artifact grantee widen access through task attachment', () => {
    registerAgent({ id: 'reviewer', name: 'Reviewer', type: 'codex', capabilities: 'review' });
    const task = handleCreateTask({ title: 'private review', created_by: 'owner', assigned_to: 'reviewer' });
    expect(task.success).toBe(true);
    if (!task.success) return;

    const created = handleCreateArtifactUpload({ agent_id: 'owner', name: 'owner-only.bin' });
    expect(created.success).toBe(true);
    if (!created.success) return;
    finalizeArtifactUpload({
      id: created.artifact.id,
      size_bytes: 16,
      sha256: 'f'.repeat(64),
      storage_path: '/tmp/owner-only.bin',
    });
    expect(handleShareArtifact({
      from_agent: 'owner',
      artifact_id: created.artifact.id,
      to_agent: 'worker',
      notify: false,
    }).success).toBe(true);

    const wideningAttach = handleAttachTaskArtifact({
      task_id: task.task.id,
      artifact_id: created.artifact.id,
      agent_id: 'worker',
    });
    expect(wideningAttach).toMatchObject({ success: false, error_code: 'ARTIFACT_NOT_OWNER' });
    expect(handleListTaskArtifacts({
      task_id: task.task.id,
      agent_id: 'reviewer',
    }).artifacts).toHaveLength(0);
    expect(handleCreateArtifactDownload({
      agent_id: 'reviewer',
      artifact_id: created.artifact.id,
    })).toMatchObject({ success: false, error_code: 'ARTIFACT_ACCESS_DENIED' });

    const nonSharingAttach = handleAttachTaskArtifact({
      task_id: task.task.id,
      artifact_id: created.artifact.id,
      agent_id: 'worker',
      auto_share_assignee: false,
    });
    expect(nonSharingAttach).toMatchObject({ success: true, shared_to_assignee: false });
    const reviewerView = handleListTaskArtifacts({
      task_id: task.task.id,
      agent_id: 'reviewer',
    });
    expect(reviewerView.artifacts).toMatchObject([{ has_access: false }]);
  });

  it('does not grant access when the requested task binding is invalid', () => {
    const created = handleCreateArtifactUpload({ agent_id: 'owner', name: 'atomic-share.bin' });
    expect(created.success).toBe(true);
    if (!created.success) return;
    finalizeArtifactUpload({
      id: created.artifact.id,
      size_bytes: 16,
      sha256: 'c'.repeat(64),
      storage_path: '/tmp/atomic-share.bin',
    });

    const shared = handleShareArtifact({
      from_agent: 'owner',
      artifact_id: created.artifact.id,
      to_agent: 'worker',
      task_id: 999_999,
      notify: false,
    });
    expect(shared).toMatchObject({ success: false, error_code: 'TASK_NOT_FOUND' });

    const download = handleCreateArtifactDownload({
      agent_id: 'worker',
      artifact_id: created.artifact.id,
    });
    expect(download).toMatchObject({ success: false, error_code: 'ARTIFACT_ACCESS_DENIED' });
  });
});
