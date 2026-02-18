import { randomUUID } from 'crypto';
import {
  heartbeat,
  logActivity,
  createArtifactRecord,
  getArtifactById,
  listArtifacts,
  listTaskArtifacts,
  getTaskById,
  attachTaskArtifact,
  grantArtifactAccess,
  hasArtifactAccess,
  sendMessage,
} from '../db.js';
import { withIdempotency } from '../utils.js';

type ArtifactResponseMode = 'full' | 'compact' | 'tiny';
type ArtifactTicketKind = 'upload' | 'download';

type IssueArtifactTicketArgs = {
  kind: ArtifactTicketKind;
  artifact_id: string;
  agent_id: string;
  ttl_sec: number;
  max_bytes: number;
};

type IssuedArtifactTicket = {
  token: string;
  expires_at: number;
};

type TaskArtifactDownloadEntry = {
  artifact_id: string;
  name: string;
  size_bytes: number;
  sha256: string | null;
  ready: boolean;
  download: {
    method: 'GET';
    url: string;
    expires_at: number;
  };
};

type TaskArtifactDownloadsSuccess = {
  success: true;
  task_id: number;
  downloads: TaskArtifactDownloadEntry[];
  summary: {
    total_attached: number;
    considered: number;
    issued: number;
    skipped_limit: number;
    skipped_not_ready: number;
    skipped_no_access: number;
  };
};

type TaskArtifactDownloadsFailure = {
  success: false;
  error_code: string;
  error: string;
};

type TaskArtifactDownloadsResult = TaskArtifactDownloadsSuccess | TaskArtifactDownloadsFailure;

const DEFAULT_UPLOAD_TTL_SEC = Number.isFinite(Number(process.env.MCP_HUB_ARTIFACT_UPLOAD_TTL_SEC))
  ? Math.max(30, Math.floor(Number(process.env.MCP_HUB_ARTIFACT_UPLOAD_TTL_SEC)))
  : 300;
const DEFAULT_DOWNLOAD_TTL_SEC = Number.isFinite(Number(process.env.MCP_HUB_ARTIFACT_DOWNLOAD_TTL_SEC))
  ? Math.max(30, Math.floor(Number(process.env.MCP_HUB_ARTIFACT_DOWNLOAD_TTL_SEC)))
  : 180;
const DEFAULT_ARTIFACT_RETENTION_SEC = Number.isFinite(Number(process.env.MCP_HUB_ARTIFACT_RETENTION_SEC))
  ? Math.max(60, Math.floor(Number(process.env.MCP_HUB_ARTIFACT_RETENTION_SEC)))
  : 24 * 60 * 60;
const MAX_ARTIFACT_BYTES = Number.isFinite(Number(process.env.MCP_HUB_ARTIFACT_MAX_BYTES))
  ? Math.max(1024, Math.floor(Number(process.env.MCP_HUB_ARTIFACT_MAX_BYTES)))
  : 50 * 1024 * 1024;
const MAX_ARTIFACT_NAME_CHARS = Number.isFinite(Number(process.env.MCP_HUB_MAX_ARTIFACT_NAME_CHARS))
  ? Math.max(16, Math.floor(Number(process.env.MCP_HUB_MAX_ARTIFACT_NAME_CHARS)))
  : 180;
const MAX_ARTIFACT_SUMMARY_CHARS = Number.isFinite(Number(process.env.MCP_HUB_MAX_ARTIFACT_SUMMARY_CHARS))
  ? Math.max(32, Math.floor(Number(process.env.MCP_HUB_MAX_ARTIFACT_SUMMARY_CHARS)))
  : 400;
const DEFAULT_BASE_URL = process.env.MCP_HUB_PUBLIC_BASE_URL || `http://localhost:${process.env.MCP_HUB_PORT || '3000'}`;

let issueArtifactTicket: ((args: IssueArtifactTicketArgs) => IssuedArtifactTicket) | null = null;

function normalizeTtlSec(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(30, Math.min(24 * 60 * 60, Math.floor(Number(value))));
}

function normalizeMaxBytes(value: number | undefined): number {
  if (!Number.isFinite(value)) return MAX_ARTIFACT_BYTES;
  return Math.max(1024, Math.min(MAX_ARTIFACT_BYTES, Math.floor(Number(value))));
}

function normalizeName(value: string): string {
  const name = (value || '').trim();
  return name.length > MAX_ARTIFACT_NAME_CHARS ? name.slice(0, MAX_ARTIFACT_NAME_CHARS) : name;
}

function normalizeSummary(value?: string): string {
  const summary = (value || '').trim();
  return summary.length > MAX_ARTIFACT_SUMMARY_CHARS ? summary.slice(0, MAX_ARTIFACT_SUMMARY_CHARS) : summary;
}

function normalizeLimit(value: number | undefined): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.max(1, Math.min(500, Math.floor(Number(value))));
}

function buildUploadUrl(artifactId: string, token: string): string {
  return `${DEFAULT_BASE_URL}/artifacts/upload/${artifactId}?token=${encodeURIComponent(token)}`;
}

function buildDownloadUrl(artifactId: string, token: string): string {
  return `${DEFAULT_BASE_URL}/artifacts/download/${artifactId}?token=${encodeURIComponent(token)}`;
}

export function configureArtifactTicketIssuer(issuer: (args: IssueArtifactTicketArgs) => IssuedArtifactTicket) {
  issueArtifactTicket = issuer;
}

export function handleCreateArtifactUpload(args: {
  agent_id: string;
  name: string;
  mime_type?: string;
  namespace?: string;
  summary?: string;
  ttl_sec?: number;
  retention_sec?: number;
  max_bytes?: number;
  idempotency_key?: string;
}) {
  heartbeat(args.agent_id);
  return withIdempotency(args.agent_id, 'create_artifact_upload', args.idempotency_key, () => {
    if (!issueArtifactTicket) {
      return {
        success: false,
        error_code: 'ARTIFACT_TICKET_ISSUER_NOT_READY',
        error: 'Artifact ticket issuer is not configured on server',
      };
    }

    const name = normalizeName(args.name || 'artifact.bin');
    if (!name) {
      return {
        success: false,
        error_code: 'ARTIFACT_NAME_REQUIRED',
        error: 'name is required',
      };
    }

    const maxBytes = normalizeMaxBytes(args.max_bytes);
    const uploadTtl = normalizeTtlSec(args.ttl_sec, DEFAULT_UPLOAD_TTL_SEC);
    const retentionSec = normalizeTtlSec(args.retention_sec, DEFAULT_ARTIFACT_RETENTION_SEC);
    const artifactId = randomUUID();

    const artifact = createArtifactRecord({
      id: artifactId,
      created_by: args.agent_id,
      name,
      mime_type: args.mime_type,
      namespace: args.namespace,
      summary: normalizeSummary(args.summary),
      ttl_expires_at: Date.now() + (retentionSec * 1000),
    });

    const ticket = issueArtifactTicket({
      kind: 'upload',
      artifact_id: artifactId,
      agent_id: args.agent_id,
      ttl_sec: uploadTtl,
      max_bytes: maxBytes,
    });

    logActivity(args.agent_id, 'create_artifact_upload', `artifact_id=${artifactId} name=${name} max_bytes=${maxBytes}`);

    return {
      success: true,
      artifact,
      upload: {
        method: 'POST',
        url: buildUploadUrl(artifactId, ticket.token),
        expires_at: ticket.expires_at,
        max_bytes: maxBytes,
      },
    };
  });
}

export function handleCreateArtifactDownload(args: {
  agent_id: string;
  artifact_id: string;
  ttl_sec?: number;
  idempotency_key?: string;
}) {
  heartbeat(args.agent_id);
  return withIdempotency(args.agent_id, 'create_artifact_download', args.idempotency_key, () => {
    if (!issueArtifactTicket) {
      return {
        success: false,
        error_code: 'ARTIFACT_TICKET_ISSUER_NOT_READY',
        error: 'Artifact ticket issuer is not configured on server',
      };
    }

    const artifactId = (args.artifact_id || '').trim();
    if (!artifactId) {
      return {
        success: false,
        error_code: 'ARTIFACT_ID_REQUIRED',
        error: 'artifact_id is required',
      };
    }

    const artifact = getArtifactById(artifactId);
    if (!artifact) {
      return {
        success: false,
        error_code: 'ARTIFACT_NOT_FOUND',
        error: 'Artifact not found',
      };
    }
    if (!artifact.storage_path || !artifact.sha256) {
      return {
        success: false,
        error_code: 'ARTIFACT_NOT_UPLOADED',
        error: 'Artifact upload not completed yet',
      };
    }
    if (!hasArtifactAccess(args.agent_id, artifactId)) {
      return {
        success: false,
        error_code: 'ARTIFACT_ACCESS_DENIED',
        error: 'Agent has no access to this artifact',
      };
    }

    const ttlSec = normalizeTtlSec(args.ttl_sec, DEFAULT_DOWNLOAD_TTL_SEC);
    const ticket = issueArtifactTicket({
      kind: 'download',
      artifact_id: artifactId,
      agent_id: args.agent_id,
      ttl_sec: ttlSec,
      max_bytes: Math.max(1024, artifact.size_bytes),
    });

    logActivity(args.agent_id, 'create_artifact_download', `artifact_id=${artifactId}`);

    return {
      success: true,
      artifact,
      download: {
        method: 'GET',
        url: buildDownloadUrl(artifactId, ticket.token),
        expires_at: ticket.expires_at,
      },
    };
  });
}

export function handleCreateTaskArtifactDownloads(args: {
  agent_id: string;
  task_id: number;
  ttl_sec?: number;
  only_ready?: boolean;
  limit?: number;
  idempotency_key?: string;
}) {
  heartbeat(args.agent_id);
  return withIdempotency(args.agent_id, 'create_task_artifact_downloads', args.idempotency_key, () => {
    const result = buildTaskArtifactDownloads({
      agent_id: args.agent_id,
      task_id: args.task_id,
      ttl_sec: args.ttl_sec,
      only_ready: args.only_ready,
      limit: args.limit,
    });
    if (result.success) {
      logActivity(
        args.agent_id,
        'create_task_artifact_downloads',
        `task_id=${result.task_id} issued=${result.downloads.length} skipped_limit=${result.summary.skipped_limit} skipped_not_ready=${result.summary.skipped_not_ready} skipped_no_access=${result.summary.skipped_no_access}`
      );
    }
    return result;
  });
}

export function buildTaskArtifactDownloads(args: {
  agent_id: string;
  task_id: number;
  ttl_sec?: number;
  only_ready?: boolean;
  limit?: number;
}): TaskArtifactDownloadsResult {
  if (!issueArtifactTicket) {
    return {
      success: false,
      error_code: 'ARTIFACT_TICKET_ISSUER_NOT_READY',
      error: 'Artifact ticket issuer is not configured on server',
    };
  }

  const taskId = Math.floor(Number(args.task_id));
  if (!Number.isFinite(taskId) || taskId <= 0) {
    return {
      success: false,
      error_code: 'TASK_ID_REQUIRED',
      error: 'task_id must be a positive integer',
    };
  }

  const onlyReady = args.only_ready !== false;
  const ttlSec = normalizeTtlSec(args.ttl_sec, DEFAULT_DOWNLOAD_TTL_SEC);
  const rows = listTaskArtifacts(taskId);
  const limit = normalizeLimit(args.limit);
  const consideredRows = limit === null ? rows : rows.slice(0, limit);
  const skippedLimit = Math.max(0, rows.length - consideredRows.length);
  const downloads: TaskArtifactDownloadEntry[] = [];
  let skippedNotReady = 0;
  let skippedNoAccess = 0;

  for (const row of consideredRows) {
    const ready = Boolean(row.artifact_sha256 && row.artifact_size_bytes > 0);
    if (onlyReady && !ready) {
      skippedNotReady += 1;
      continue;
    }
    if (!hasArtifactAccess(args.agent_id, row.artifact_id)) {
      skippedNoAccess += 1;
      continue;
    }
    const ticket = issueArtifactTicket({
      kind: 'download',
      artifact_id: row.artifact_id,
      agent_id: args.agent_id,
      ttl_sec: ttlSec,
      max_bytes: Math.max(1024, row.artifact_size_bytes),
    });
    downloads.push({
      artifact_id: row.artifact_id,
      name: row.artifact_name,
      size_bytes: row.artifact_size_bytes,
      sha256: row.artifact_sha256,
      ready,
      download: {
        method: 'GET',
        url: buildDownloadUrl(row.artifact_id, ticket.token),
        expires_at: ticket.expires_at,
      },
    });
  }

  return {
    success: true,
    task_id: taskId,
    downloads,
    summary: {
      total_attached: rows.length,
      considered: consideredRows.length,
      issued: downloads.length,
      skipped_limit: skippedLimit,
      skipped_not_ready: skippedNotReady,
      skipped_no_access: skippedNoAccess,
    },
  };
}

export function handleShareArtifact(args: {
  from_agent: string;
  artifact_id: string;
  to_agent?: string;
  task_id?: number;
  auto_share_assignee?: boolean;
  note?: string;
  notify?: boolean;
  idempotency_key?: string;
}) {
  heartbeat(args.from_agent);
  return withIdempotency(args.from_agent, 'share_artifact', args.idempotency_key, () => {
    const artifactId = (args.artifact_id || '').trim();
    if (!artifactId) {
      return {
        success: false,
        error_code: 'ARTIFACT_ID_REQUIRED',
        error: 'artifact_id is required',
      };
    }
    const artifact = getArtifactById(artifactId);
    if (!artifact) {
      return {
        success: false,
        error_code: 'ARTIFACT_NOT_FOUND',
        error: 'Artifact not found',
      };
    }
    if (!hasArtifactAccess(args.from_agent, artifactId)) {
      return {
        success: false,
        error_code: 'ARTIFACT_ACCESS_DENIED',
        error: 'Sender has no access to this artifact',
      };
    }

    const toAgent = typeof args.to_agent === 'string' ? args.to_agent.trim() : '';
    const target = toAgent || '*';
    grantArtifactAccess({ artifact_id: artifactId, to_agent: target, granted_by: args.from_agent });
    let taskBinding:
      | {
          task_id: number;
          attached: boolean;
          already_attached: boolean;
          shared_to_assignee: boolean;
          assignee: string | null;
        }
      | undefined;
    if (Number.isFinite(args.task_id)) {
      const taskId = Math.floor(Number(args.task_id));
      const task = getTaskById(taskId);
      if (!task) {
        return {
          success: false,
          error_code: 'TASK_NOT_FOUND',
          error: 'Task not found',
        };
      }
      const linked = attachTaskArtifact(taskId, artifactId, args.from_agent);
      const autoShareAssignee = args.auto_share_assignee !== false;
      let sharedToAssignee = false;
      if (autoShareAssignee && task.assigned_to && !hasArtifactAccess(task.assigned_to, artifactId)) {
        grantArtifactAccess({
          artifact_id: artifactId,
          to_agent: task.assigned_to,
          granted_by: args.from_agent,
        });
        sharedToAssignee = true;
      }
      taskBinding = {
        task_id: taskId,
        attached: linked.created,
        already_attached: !linked.created,
        shared_to_assignee: sharedToAssignee,
        assignee: task.assigned_to,
      };
    }

    const note = normalizeSummary(args.note);
    if (args.notify !== false) {
      const content = note
        ? `[artifact:${artifactId}] ${artifact.name} | ${note}`
        : `[artifact:${artifactId}] ${artifact.name}`;
      sendMessage(
        args.from_agent,
        toAgent || null,
        content,
        JSON.stringify({
          type: 'artifact_ref',
          artifact_id: artifactId,
          artifact_name: artifact.name,
          artifact_sha256: artifact.sha256,
          namespace: artifact.namespace,
          task_id: taskBinding?.task_id,
        }),
      );
    }

    const taskDetails = taskBinding
      ? ` task_id=${taskBinding.task_id} attached=${taskBinding.attached ? 1 : 0} shared_to_assignee=${taskBinding.shared_to_assignee ? 1 : 0}`
      : '';
    logActivity(args.from_agent, 'share_artifact', `artifact_id=${artifactId} to=${target}${taskDetails}`);

    return {
      success: true,
      artifact_id: artifactId,
      shared_to: target,
      notified: args.notify !== false,
      task_binding: taskBinding,
    };
  });
}

export function handleListArtifacts(args: {
  agent_id: string;
  created_by?: string;
  namespace?: string;
  limit?: number;
  offset?: number;
  response_mode?: ArtifactResponseMode;
}) {
  heartbeat(args.agent_id);
  const rows = listArtifacts({
    requesting_agent: args.agent_id,
    created_by: args.created_by,
    namespace: args.namespace,
    limit: args.limit,
    offset: args.offset,
  });

  if (args.response_mode === 'tiny') {
    return {
      success: true,
      artifacts: rows.map((row) => ({
        id: row.id,
        name: row.name,
        size_bytes: row.size_bytes,
        namespace: row.namespace,
        ready: Boolean(row.sha256 && row.storage_path),
      })),
    };
  }

  if (args.response_mode === 'compact') {
    return {
      success: true,
      artifacts: rows.map((row) => ({
        id: row.id,
        name: row.name,
        mime_type: row.mime_type,
        size_bytes: row.size_bytes,
        sha256: row.sha256,
        namespace: row.namespace,
        created_by: row.created_by,
        created_at: row.created_at,
        ready: Boolean(row.sha256 && row.storage_path),
      })),
    };
  }

  return { success: true, artifacts: rows };
}

export const artifactTools = {
  create_artifact_upload: {
    description: 'Create server-side upload ticket for binary artifact handoff (non-token side-channel).',
  },
  create_artifact_download: {
    description: 'Create server-side download ticket for shared artifact (non-token side-channel).',
  },
  create_task_artifact_downloads: {
    description: 'Create download tickets for task-attached artifacts visible to requester (bulk mode, optional limit).',
  },
  share_artifact: {
    description: 'Grant artifact access to agent(s), optionally bind artifact to task, and optionally notify via message metadata.',
  },
  list_artifacts: {
    description: 'List artifacts visible to requesting agent (full/compact/tiny response modes).',
  },
};
