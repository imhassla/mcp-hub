import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  Agent,
  AgentLifecycle,
  AgentRuntimeProfile,
  AgentWorkspaceMode,
  Message,
  MessageRead,
  Task,
  TaskExecutionMode,
  TaskConsistencyMode,
  TaskWithDependencies,
  TaskArtifact,
  TaskArtifactWithMeta,
  Context,
  ActivityLogEntry,
  TaskClaim,
  TaskClaimWithTask,
  AgentQuality,
  IdempotencyRecord,
  ProtocolBlob,
  ConsensusDecision,
  AgentToken,
  Artifact,
  KpiWindowSnapshot,
  SloAlert,
  AuthCoverageSnapshot,
} from './types.js';

let db: Database.Database;
const MIN_LEASE_SECONDS = 30;
const MAX_LEASE_SECONDS = 24 * 60 * 60;
const IDEMPOTENCY_TTL_MS = Number(process.env.MCP_HUB_IDEMPOTENCY_TTL_MS || 10 * 60 * 1000);
const CLAIM_CLEANUP_THROTTLE_MS = Number(process.env.MCP_HUB_CLAIM_CLEANUP_THROTTLE_MS || 5_000);
const AGENT_OFFLINE_AFTER_MS = Number(process.env.MCP_HUB_AGENT_OFFLINE_AFTER_MS || 30 * 60 * 1000);
const AGENT_RETENTION_MS = Number(process.env.MCP_HUB_AGENT_RETENTION_MS || 7 * 24 * 60 * 60 * 1000);
const EPHEMERAL_OFFLINE_AFTER_MS = Number(process.env.MCP_HUB_EPHEMERAL_OFFLINE_AFTER_MS || 5 * 60 * 1000);
const EPHEMERAL_AGENT_RETENTION_MS = Number(process.env.MCP_HUB_EPHEMERAL_AGENT_RETENTION_MS || 2 * 60 * 60 * 1000);
const EPHEMERAL_CLAIM_REAP_AFTER_MS = Number(process.env.MCP_HUB_EPHEMERAL_CLAIM_REAP_AFTER_MS || Math.max(60_000, EPHEMERAL_OFFLINE_AFTER_MS * 2));
const MESSAGE_TTL_MS = Number(process.env.MCP_HUB_MESSAGE_TTL_MS || 24 * 60 * 60 * 1000);
const ACTIVITY_LOG_TTL_MS = Number(process.env.MCP_HUB_ACTIVITY_LOG_TTL_MS || 24 * 60 * 60 * 1000);
const PROTOCOL_BLOB_TTL_MS = Number(process.env.MCP_HUB_PROTOCOL_BLOB_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const DONE_TASK_TTL_MS = Number(process.env.MCP_HUB_DONE_TASK_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const ARTIFACT_TTL_MS = Number(process.env.MCP_HUB_ARTIFACT_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const ARCHIVE_BATCH_LIMIT = Number(process.env.MCP_HUB_ARCHIVE_BATCH_LIMIT || 200);
const AUTH_EVENTS_TTL_MS = Number(process.env.MCP_HUB_AUTH_EVENTS_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const RESOLVED_SLO_TTL_MS = Number(process.env.MCP_HUB_RESOLVED_SLO_TTL_MS || 14 * 24 * 60 * 60 * 1000);
const SLO_PENDING_AGE_MS = Number(process.env.MCP_HUB_SLO_PENDING_AGE_MS || 30 * 60 * 1000);
const SLO_STALE_IN_PROGRESS_MS = Number(process.env.MCP_HUB_SLO_STALE_IN_PROGRESS_MS || 20 * 60 * 1000);
const SLO_CLAIM_CHURN_WINDOW_MS = Number(process.env.MCP_HUB_SLO_CLAIM_CHURN_WINDOW_MS || 10 * 60 * 1000);
const SLO_CLAIM_CHURN_THRESHOLD = Number(process.env.MCP_HUB_SLO_CLAIM_CHURN_THRESHOLD || 120);
const WATERMARK_CACHE_MS = Number.isFinite(Number(process.env.MCP_HUB_WATERMARK_CACHE_MS))
  ? Math.max(0, Math.min(5_000, Math.floor(Number(process.env.MCP_HUB_WATERMARK_CACHE_MS))))
  : 75;
const WATERMARK_AGENT_CACHE_MAX = Number.isFinite(Number(process.env.MCP_HUB_WATERMARK_AGENT_CACHE_MAX))
  ? Math.max(100, Math.min(50_000, Math.floor(Number(process.env.MCP_HUB_WATERMARK_AGENT_CACHE_MAX))))
  : 5_000;

let lastClaimCleanupAt = 0;
let watermarkCoreCache: {
  sampled_at: number;
  latest_task_ts: number;
  latest_context_ts: number;
  latest_activity_ts: number;
} | null = null;
let watermarkAllMessagesCache: {
  sampled_at: number;
  latest_message_ts: number;
} | null = null;
const watermarkAgentMessageCache = new Map<string, { sampled_at: number; latest_message_ts: number }>();

function resetWatermarkCaches() {
  watermarkCoreCache = null;
  watermarkAllMessagesCache = null;
  watermarkAgentMessageCache.clear();
}

function isWatermarkCacheFresh(sampledAt: number, now: number): boolean {
  return WATERMARK_CACHE_MS > 0 && (now - sampledAt) <= WATERMARK_CACHE_MS;
}

function pruneWatermarkAgentCache(now: number) {
  if (watermarkAgentMessageCache.size <= WATERMARK_AGENT_CACHE_MAX) return;
  const staleBefore = now - Math.max(1_000, WATERMARK_CACHE_MS * 20);
  for (const [agentId, entry] of watermarkAgentMessageCache.entries()) {
    if (entry.sampled_at >= staleBefore) continue;
    watermarkAgentMessageCache.delete(agentId);
    if (watermarkAgentMessageCache.size <= WATERMARK_AGENT_CACHE_MAX) return;
  }
  if (watermarkAgentMessageCache.size <= WATERMARK_AGENT_CACHE_MAX) return;
  const toDelete = watermarkAgentMessageCache.size - WATERMARK_AGENT_CACHE_MAX;
  let deleted = 0;
  for (const agentId of watermarkAgentMessageCache.keys()) {
    watermarkAgentMessageCache.delete(agentId);
    deleted += 1;
    if (deleted >= toDelete) break;
  }
}

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = process.env.MCP_HUB_DB || path.join(process.cwd(), 'mcp-hub.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
    resetWatermarkCaches();
  }
  return db;
}

export function initDb(dbPath?: string): Database.Database {
  const d = new Database(dbPath || ':memory:');
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  initSchema(d);
  db = d;
  resetWatermarkCaches();
  return d;
}

function initSchema(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '',
      lifecycle TEXT NOT NULL DEFAULT 'persistent',
      runtime_mode TEXT NOT NULL DEFAULT 'unknown',
      runtime_profile_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'online',
      last_seen INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent TEXT,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      trace_id TEXT,
      span_id TEXT,
      created_at INTEGER NOT NULL,
      read INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS message_reads (
      message_id INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      read_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, agent_id),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      namespace TEXT NOT NULL DEFAULT 'default',
      execution_mode TEXT NOT NULL DEFAULT 'any',
      consistency_mode TEXT NOT NULL DEFAULT 'cheap',
      status TEXT NOT NULL DEFAULT 'pending',
      assigned_to TEXT,
      created_by TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      trace_id TEXT,
      span_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_claims (
      task_id INTEGER PRIMARY KEY,
      agent_id TEXT NOT NULL,
      claim_id TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      lease_expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id INTEGER NOT NULL,
      depends_on_task_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, depends_on_task_id),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_evidence (
      task_id INTEGER NOT NULL,
      evidence_ref TEXT NOT NULL,
      added_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, evidence_ref),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS context (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      namespace TEXT NOT NULL DEFAULT 'default',
      trace_id TEXT,
      span_id TEXT,
      updated_at INTEGER NOT NULL,
      UNIQUE(agent_id, key)
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_quality (
      agent_id TEXT PRIMARY KEY,
      completed_count INTEGER NOT NULL DEFAULT 0,
      rollback_count INTEGER NOT NULL DEFAULT 0,
      last_updated INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      agent_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, tool_name, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS protocol_blobs (
      hash TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS consensus_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL,
      requesting_agent TEXT NOT NULL,
      outcome TEXT NOT NULL,
      stats_json TEXT NOT NULL,
      reasons_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_tokens (
      agent_id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks_archive (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      namespace TEXT NOT NULL,
      execution_mode TEXT NOT NULL DEFAULT 'any',
      consistency_mode TEXT NOT NULL DEFAULT 'cheap',
      status TEXT NOT NULL,
      assigned_to TEXT,
      created_by TEXT NOT NULL,
      priority TEXT NOT NULL,
      trace_id TEXT,
      span_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER NOT NULL,
      archive_reason TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS slo_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS auth_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT,
      storage_path TEXT,
      namespace TEXT NOT NULL DEFAULT 'default',
      summary TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      ttl_expires_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS artifact_shares (
      artifact_id TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (artifact_id, to_agent),
      FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_artifacts (
      task_id INTEGER NOT NULL,
      artifact_id TEXT NOT NULL,
      added_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, artifact_id),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
    );
  `);

  ensureColumn(d, 'tasks', 'namespace', "ALTER TABLE tasks ADD COLUMN namespace TEXT NOT NULL DEFAULT 'default'");
  ensureColumn(d, 'tasks', 'execution_mode', "ALTER TABLE tasks ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'any'");
  ensureColumn(d, 'tasks', 'consistency_mode', "ALTER TABLE tasks ADD COLUMN consistency_mode TEXT NOT NULL DEFAULT 'cheap'");
  ensureColumn(d, 'tasks', 'trace_id', "ALTER TABLE tasks ADD COLUMN trace_id TEXT");
  ensureColumn(d, 'tasks', 'span_id', "ALTER TABLE tasks ADD COLUMN span_id TEXT");
  ensureColumn(d, 'tasks_archive', 'execution_mode', "ALTER TABLE tasks_archive ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'any'");
  ensureColumn(d, 'tasks_archive', 'consistency_mode', "ALTER TABLE tasks_archive ADD COLUMN consistency_mode TEXT NOT NULL DEFAULT 'cheap'");
  ensureColumn(d, 'tasks_archive', 'trace_id', "ALTER TABLE tasks_archive ADD COLUMN trace_id TEXT");
  ensureColumn(d, 'tasks_archive', 'span_id', "ALTER TABLE tasks_archive ADD COLUMN span_id TEXT");
  ensureColumn(d, 'agents', 'lifecycle', "ALTER TABLE agents ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'persistent'");
  ensureColumn(d, 'agents', 'runtime_mode', "ALTER TABLE agents ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'unknown'");
  ensureColumn(d, 'agents', 'runtime_profile_json', "ALTER TABLE agents ADD COLUMN runtime_profile_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(d, 'messages', 'trace_id', "ALTER TABLE messages ADD COLUMN trace_id TEXT");
  ensureColumn(d, 'messages', 'span_id', "ALTER TABLE messages ADD COLUMN span_id TEXT");
  ensureColumn(d, 'context', 'namespace', "ALTER TABLE context ADD COLUMN namespace TEXT NOT NULL DEFAULT 'default'");
  ensureColumn(d, 'context', 'trace_id', "ALTER TABLE context ADD COLUMN trace_id TEXT");
  ensureColumn(d, 'context', 'span_id', "ALTER TABLE context ADD COLUMN span_id TEXT");

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_task_claims_agent_id ON task_claims(agent_id);
    CREATE INDEX IF NOT EXISTS idx_task_claims_lease_expires_at ON task_claims(lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_status_assigned_to ON tasks(status, assigned_to);
    CREATE INDEX IF NOT EXISTS idx_tasks_status_execution_mode_assigned_to ON tasks(status, execution_mode, assigned_to);
    CREATE INDEX IF NOT EXISTS idx_tasks_namespace_status_assigned_to ON tasks(namespace, status, assigned_to);
    CREATE INDEX IF NOT EXISTS idx_tasks_trace_updated_at ON tasks(trace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agents_runtime_mode_status ON agents(runtime_mode, status, last_seen DESC);
    CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on_task_id ON task_dependencies(depends_on_task_id);
    CREATE INDEX IF NOT EXISTS idx_task_evidence_task_id_created_at ON task_evidence(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_status_history_task_id_created_at ON task_status_history(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_status_history_created_at ON task_status_history(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_status_history_to_status_created_at ON task_status_history(to_status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_status_history_from_to_created_at ON task_status_history(from_status, to_status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_to_agent_created_at ON messages(to_agent, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_from_agent ON messages(from_agent);
    CREATE INDEX IF NOT EXISTS idx_messages_trace_created_at ON messages(trace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_message_reads_agent_id_read_at ON message_reads(agent_id, read_at DESC);
    CREATE INDEX IF NOT EXISTS idx_context_updated_at ON context(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_context_namespace_updated_at ON context(namespace, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_context_trace_updated_at ON context(trace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_log_agent_id_created_at ON activity_log(agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_protocol_blobs_updated_at ON protocol_blobs(updated_at);
    CREATE INDEX IF NOT EXISTS idx_consensus_decisions_proposal_created_at ON consensus_decisions(proposal_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_consensus_decisions_created_at ON consensus_decisions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_archive_archived_at ON tasks_archive(archived_at DESC);
    CREATE INDEX IF NOT EXISTS idx_slo_alerts_created_at ON slo_alerts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_slo_alerts_resolved_at ON slo_alerts(resolved_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_slo_alerts_open_code ON slo_alerts(code) WHERE resolved_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_auth_events_created_at ON auth_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_auth_events_tool_created_at ON auth_events(tool_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_auth_events_agent_created_at ON auth_events(agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_artifacts_namespace_created_at ON artifacts(namespace, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_artifacts_created_by_created_at ON artifacts(created_by, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_artifacts_ttl_expires_at ON artifacts(ttl_expires_at);
    CREATE INDEX IF NOT EXISTS idx_artifact_shares_to_agent_created_at ON artifact_shares(to_agent, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_artifacts_task_id_created_at ON task_artifacts(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_artifacts_artifact_id ON task_artifacts(artifact_id);
  `);
}

function ensureColumn(d: Database.Database, tableName: string, columnName: string, alterSql: string): void {
  const columns = d.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === columnName)) {
    d.exec(alterSql);
  }
}

function normalizeLeaseSeconds(leaseSeconds?: number): number {
  const fallback = 5 * 60;
  const value = Number.isFinite(leaseSeconds) ? Math.floor(leaseSeconds as number) : fallback;
  return Math.min(MAX_LEASE_SECONDS, Math.max(MIN_LEASE_SECONDS, value));
}

function normalizeAgentLifecycle(lifecycle?: string): AgentLifecycle {
  return lifecycle === 'ephemeral' ? 'ephemeral' : 'persistent';
}

function normalizeWorkspaceMode(mode?: string): AgentWorkspaceMode {
  if (mode === 'repo' || mode === 'isolated' || mode === 'unknown') return mode;
  return 'unknown';
}

function inferWorkspaceMode(profile: Partial<AgentRuntimeProfile>): AgentWorkspaceMode {
  if (profile.has_git === true) return 'repo';
  if (Number.isFinite(profile.file_count) && Number(profile.file_count) > 0) return 'repo';
  if (profile.empty_dir === true) return 'isolated';
  if (profile.has_git === false && Number.isFinite(profile.file_count) && Number(profile.file_count) === 0) return 'isolated';
  return 'unknown';
}

function normalizeRuntimeProfile(profile?: AgentRuntimeProfile): { mode: AgentWorkspaceMode; json: string } {
  const normalizedInput: AgentRuntimeProfile = profile && typeof profile === 'object'
    ? {
      mode: normalizeWorkspaceMode(profile.mode),
      cwd: typeof profile.cwd === 'string' ? profile.cwd.slice(0, 512) : undefined,
      has_git: typeof profile.has_git === 'boolean' ? profile.has_git : undefined,
      file_count: Number.isFinite(profile.file_count) ? Math.max(0, Math.floor(Number(profile.file_count))) : undefined,
      empty_dir: typeof profile.empty_dir === 'boolean' ? profile.empty_dir : undefined,
      source: profile.source,
      detected_at: Number.isFinite(profile.detected_at) ? Math.floor(Number(profile.detected_at)) : undefined,
      notes: typeof profile.notes === 'string' ? profile.notes.slice(0, 512) : undefined,
    }
    : { mode: 'unknown' };

  const inferred = normalizedInput.mode !== 'unknown' ? normalizedInput.mode : inferWorkspaceMode(normalizedInput);
  const normalized: AgentRuntimeProfile = {
    ...normalizedInput,
    mode: inferred,
    source: normalizedInput.source || 'server_inferred',
    detected_at: normalizedInput.detected_at || Date.now(),
  };
  return {
    mode: normalized.mode,
    json: JSON.stringify(normalized),
  };
}

function normalizeTaskExecutionMode(mode?: string): TaskExecutionMode {
  if (mode === 'repo' || mode === 'isolated' || mode === 'any') return mode;
  return 'any';
}

function normalizeTaskConsistencyMode(mode?: string): TaskConsistencyMode {
  return mode === 'strict' ? 'strict' : 'cheap';
}

function isTaskClaimUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed: task_claims.task_id');
}

function normalizeDependencyIds(taskId: number, dependencyIds?: number[]): number[] {
  if (!Array.isArray(dependencyIds)) return [];
  const cleaned = dependencyIds
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0 && id !== taskId);
  return [...new Set(cleaned)];
}

function assertDependenciesExist(dependencyIds: number[]): void {
  if (dependencyIds.length === 0) return;
  const d = getDb();
  const placeholders = dependencyIds.map(() => '?').join(',');
  const rows = d.prepare(`SELECT id FROM tasks WHERE id IN (${placeholders})`).all(...dependencyIds) as Array<{ id: number }>;
  if (rows.length !== dependencyIds.length) {
    throw new Error('INVALID_DEPENDENCY');
  }
}

export function cleanupExpiredTaskClaims(now = Date.now(), options: { force?: boolean } = {}): number {
  if (!options.force && now - lastClaimCleanupAt < CLAIM_CLEANUP_THROTTLE_MS) {
    return 0;
  }
  lastClaimCleanupAt = now;
  const d = getDb();
  const expired = d.prepare('SELECT task_id, agent_id FROM task_claims WHERE lease_expires_at <= ?').all(now) as Array<{ task_id: number; agent_id: string }>;
  if (expired.length === 0) return 0;

  const tx = d.transaction(() => {
    for (const row of expired) {
      d.prepare(`
        UPDATE tasks
        SET status = 'pending', assigned_to = NULL, updated_at = ?
        WHERE id = ? AND status = 'in_progress' AND assigned_to = ?
      `).run(now, row.task_id, row.agent_id);
    }
    d.prepare('DELETE FROM task_claims WHERE lease_expires_at <= ?').run(now);
  });

  tx();
  return expired.length;
}

// --- Agents ---

export function registerAgent(agent: {
  id: string;
  name: string;
  type: string;
  capabilities: string;
  lifecycle?: AgentLifecycle;
  runtime_profile?: AgentRuntimeProfile;
}): { agent: Agent; is_new: boolean } {
  const now = Date.now();
  const lifecycle = normalizeAgentLifecycle(agent.lifecycle);
  const runtimeProfile = normalizeRuntimeProfile(agent.runtime_profile);
  const d = getDb();
  const existing = d.prepare('SELECT id FROM agents WHERE id = ?').get(agent.id) as { id: string } | undefined;
  d.prepare(`
    INSERT INTO agents (id, name, type, capabilities, lifecycle, runtime_mode, runtime_profile_json, status, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'online', ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      capabilities = excluded.capabilities,
      lifecycle = excluded.lifecycle,
      runtime_mode = excluded.runtime_mode,
      runtime_profile_json = excluded.runtime_profile_json,
      status = 'online',
      last_seen = excluded.last_seen
  `).run(agent.id, agent.name, agent.type, agent.capabilities, lifecycle, runtimeProfile.mode, runtimeProfile.json, now);
  ensureAgentToken(agent.id);
  return {
    agent: {
      ...agent,
      lifecycle,
      runtime_mode: runtimeProfile.mode,
      runtime_profile_json: runtimeProfile.json,
      status: 'online',
      last_seen: now,
    },
    is_new: !existing,
  };
}

export function listAgents(options: { limit?: number; offset?: number } = {}): Agent[] {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(Number(options.limit))) : 100;
  const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(Number(options.offset))) : 0;
  return getDb()
    .prepare('SELECT * FROM agents ORDER BY last_seen DESC LIMIT ? OFFSET ?')
    .all(limit, offset) as Agent[];
}

export function heartbeat(agentId: string): void {
  getDb().prepare('UPDATE agents SET last_seen = ?, status = ? WHERE id = ?')
    .run(Date.now(), 'online', agentId);
}

export function updateAgentRuntimeProfile(agentId: string, runtimeProfile: AgentRuntimeProfile): Agent | null {
  const normalized = normalizeRuntimeProfile(runtimeProfile);
  const now = Date.now();
  const updated = getDb().prepare(`
    UPDATE agents
    SET runtime_mode = ?, runtime_profile_json = ?, status = 'online', last_seen = ?
    WHERE id = ?
  `).run(normalized.mode, normalized.json, now, agentId);
  if (updated.changes !== 1) return null;
  const row = getDb().prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Agent | undefined;
  return row || null;
}

export function countActiveAgents(sinceMs: number): number {
  const row = getDb().prepare('SELECT COUNT(*) AS cnt FROM agents WHERE last_seen >= ?').get(sinceMs) as { cnt: number } | undefined;
  return row?.cnt || 0;
}

export function getAgentRuntimeProfile(agentId: string): AgentRuntimeProfile {
  const row = getDb().prepare('SELECT runtime_profile_json, runtime_mode FROM agents WHERE id = ?').get(agentId) as {
    runtime_profile_json?: string;
    runtime_mode?: string;
  } | undefined;
  if (!row) return { mode: 'unknown', source: 'server_inferred' };

  let parsed: Partial<AgentRuntimeProfile> = {};
  if (row.runtime_profile_json) {
    try {
      const decoded = JSON.parse(row.runtime_profile_json) as Record<string, unknown>;
      parsed = decoded as Partial<AgentRuntimeProfile>;
    } catch {
      parsed = {};
    }
  }
  const mode = normalizeWorkspaceMode(typeof parsed.mode === 'string' ? parsed.mode : row.runtime_mode);
  return {
    mode,
    cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
    has_git: typeof parsed.has_git === 'boolean' ? parsed.has_git : undefined,
    file_count: Number.isFinite(parsed.file_count) ? Number(parsed.file_count) : undefined,
    empty_dir: typeof parsed.empty_dir === 'boolean' ? parsed.empty_dir : undefined,
    source: typeof parsed.source === 'string' ? parsed.source as AgentRuntimeProfile['source'] : 'server_inferred',
    detected_at: Number.isFinite(parsed.detected_at) ? Number(parsed.detected_at) : undefined,
    notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
  };
}

export function getAgentRuntimeMode(agentId: string): AgentWorkspaceMode {
  return getAgentRuntimeProfile(agentId).mode;
}

function ensureAgentToken(agentId: string): AgentToken {
  const existing = getDb().prepare('SELECT * FROM agent_tokens WHERE agent_id = ?').get(agentId) as AgentToken | undefined;
  if (existing) return existing;
  return issueAgentToken(agentId);
}

export function issueAgentToken(agentId: string): AgentToken {
  const now = Date.now();
  const token = `${randomUUID()}-${randomUUID()}`;
  getDb().prepare(`
    INSERT INTO agent_tokens (agent_id, token, created_at, last_used_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      token = excluded.token,
      created_at = excluded.created_at,
      last_used_at = excluded.last_used_at
  `).run(agentId, token, now, now);
  return getDb().prepare('SELECT * FROM agent_tokens WHERE agent_id = ?').get(agentId) as AgentToken;
}

export function getAgentToken(agentId: string): AgentToken | null {
  const row = getDb().prepare('SELECT * FROM agent_tokens WHERE agent_id = ?').get(agentId) as AgentToken | undefined;
  return row || null;
}

export function validateAgentToken(agentId: string, token: string): boolean {
  if (!token) return false;
  const now = Date.now();
  const result = getDb().prepare(`
    UPDATE agent_tokens
    SET last_used_at = ?
    WHERE agent_id = ? AND token = ?
  `).run(now, agentId, token);
  return result.changes === 1;
}

// --- Messages ---

export function sendMessage(
  fromAgent: string,
  toAgent: string | null,
  content: string,
  metadata: string = '{}',
  traceId?: string,
  spanId?: string,
): Message {
  const now = Date.now();
  const d = getDb();
  const result = d.prepare(`
    INSERT INTO messages (from_agent, to_agent, content, metadata, trace_id, span_id, created_at, read)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(fromAgent, toAgent, content, metadata, traceId || null, spanId || null, now);
  return {
    id: result.lastInsertRowid as number,
    from_agent: fromAgent,
    to_agent: toAgent,
    content,
    metadata,
    trace_id: traceId || null,
    span_id: spanId || null,
    created_at: now,
    read: 0,
  };
}

export function readMessages(agentId: string, options: {
  from?: string;
  unread_only?: boolean;
  limit?: number;
  offset?: number;
  since_ts?: number;
  cursor?: { ts: number; id: number };
} = {}): Message[] {
  const d = getDb();
  let query = `
    SELECT
      m.*,
      CASE WHEN mr.message_id IS NULL THEN 0 ELSE 1 END AS read
    FROM messages m
    LEFT JOIN message_reads mr
      ON mr.message_id = m.id AND mr.agent_id = ?
    WHERE (m.to_agent = ? OR m.to_agent IS NULL)
  `;
  const params: unknown[] = [agentId, agentId];

  if (options.from) {
    query += ' AND m.from_agent = ?';
    params.push(options.from);
  }
  if (options.unread_only) {
    query += ' AND mr.message_id IS NULL';
  }

  const hasCursor = Boolean(options.cursor && Number.isFinite(options.cursor.ts) && Number.isFinite(options.cursor.id));
  const hasSinceTs = Number.isFinite(options.since_ts);
  if (hasCursor) {
    query += ' AND (m.created_at > ? OR (m.created_at = ? AND m.id > ?))';
    params.push(options.cursor!.ts, options.cursor!.ts, options.cursor!.id);
    query += ' ORDER BY m.created_at ASC, m.id ASC';
  } else if (hasSinceTs) {
    query += ' AND m.created_at > ?';
    params.push(options.since_ts as number);
    query += ' ORDER BY m.created_at ASC, m.id ASC';
  } else {
    query += ' ORDER BY m.created_at DESC, m.id DESC';
  }

  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(Number(options.limit))) : 50;
  const offset = hasCursor || hasSinceTs ? 0 : (Number.isFinite(options.offset) ? Math.max(0, Math.floor(Number(options.offset))) : 0);
  query += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const messages = d.prepare(query).all(...params) as Message[];

  // Mark as read per-agent
  const ids = messages.filter((m) => m.read === 0).map((m) => m.id);
  if (ids.length > 0) {
    const now = Date.now();
    const tx = d.transaction((messageIds: number[]) => {
      const insert = d.prepare('INSERT OR IGNORE INTO message_reads (message_id, agent_id, read_at) VALUES (?, ?, ?)');
      for (const messageId of messageIds) {
        insert.run(messageId, agentId, now);
      }
    });
    tx(ids);
  }

  return messages;
}

export function getMessageForAgent(agentId: string, messageId: number): Message | null {
  const normalizedMessageId = Number.isFinite(messageId) ? Math.floor(Number(messageId)) : 0;
  if (normalizedMessageId <= 0) return null;
  const d = getDb();
  const row = d.prepare(`
    SELECT
      m.*,
      CASE WHEN mr.message_id IS NULL THEN 0 ELSE 1 END AS read
    FROM messages m
    LEFT JOIN message_reads mr
      ON mr.message_id = m.id AND mr.agent_id = ?
    WHERE
      m.id = ?
      AND (m.to_agent = ? OR m.to_agent IS NULL)
    LIMIT 1
  `).get(agentId, normalizedMessageId, agentId) as Message | undefined;
  if (!row) return null;
  if (row.read === 0) {
    d.prepare('INSERT OR IGNORE INTO message_reads (message_id, agent_id, read_at) VALUES (?, ?, ?)')
      .run(row.id, agentId, Date.now());
  }
  return row;
}

// --- Tasks ---

export function createTask(task: {
  title: string;
  description?: string;
  created_by: string;
  assigned_to?: string;
  priority?: string;
  depends_on?: number[];
  namespace?: string;
  execution_mode?: TaskExecutionMode;
  consistency_mode?: TaskConsistencyMode;
  trace_id?: string;
  span_id?: string;
}): Task {
  const now = Date.now();
  const d = getDb();
  const namespace = (task.namespace || 'default').trim() || 'default';
  const executionMode = normalizeTaskExecutionMode(task.execution_mode);
  const consistencyMode = normalizeTaskConsistencyMode(task.consistency_mode);
  const tx = d.transaction(() => {
    const result = d.prepare(`
      INSERT INTO tasks (
        title, description, namespace, execution_mode, consistency_mode,
        status, assigned_to, created_by, priority, trace_id, span_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.title,
      task.description || '',
      namespace,
      executionMode,
      consistencyMode,
      task.assigned_to || null,
      task.created_by,
      task.priority || 'medium',
      task.trace_id || null,
      task.span_id || null,
      now,
      now,
    );
    const taskId = result.lastInsertRowid as number;
    const deps = normalizeDependencyIds(taskId, task.depends_on);
    assertDependenciesExist(deps);
    if (deps.length > 0) {
      const insertDep = d.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)');
      for (const depId of deps) {
        insertDep.run(taskId, depId, now);
      }
    }
    return taskId;
  });

  const taskId = tx();
  return {
    id: taskId,
    title: task.title,
    description: task.description || '',
    namespace,
    execution_mode: executionMode,
    consistency_mode: consistencyMode,
    status: 'pending',
    assigned_to: task.assigned_to || null,
    created_by: task.created_by,
    priority: task.priority || 'medium',
    trace_id: task.trace_id || null,
    span_id: task.span_id || null,
    created_at: now,
    updated_at: now,
  } as Task;
}

export function updateTask(id: number, updates: {
  status?: string;
  assigned_to?: string;
  title?: string;
  description?: string;
  priority?: string;
  namespace?: string;
  execution_mode?: TaskExecutionMode;
  consistency_mode?: TaskConsistencyMode;
  trace_id?: string;
  span_id?: string;
  depends_on?: number[];
}): Task | null {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
  if (!existing) return null;

  const fields: string[] = [];
  const params: unknown[] = [];

  if (updates.status !== undefined) { fields.push('status = ?'); params.push(updates.status); }
  if (updates.assigned_to !== undefined) { fields.push('assigned_to = ?'); params.push(updates.assigned_to); }
  if (updates.title !== undefined) { fields.push('title = ?'); params.push(updates.title); }
  if (updates.description !== undefined) { fields.push('description = ?'); params.push(updates.description); }
  if (updates.priority !== undefined) { fields.push('priority = ?'); params.push(updates.priority); }
  if (updates.namespace !== undefined) { fields.push('namespace = ?'); params.push((updates.namespace || 'default').trim() || 'default'); }
  if (updates.execution_mode !== undefined) { fields.push('execution_mode = ?'); params.push(normalizeTaskExecutionMode(updates.execution_mode)); }
  if (updates.consistency_mode !== undefined) { fields.push('consistency_mode = ?'); params.push(normalizeTaskConsistencyMode(updates.consistency_mode)); }
  if (updates.trace_id !== undefined) { fields.push('trace_id = ?'); params.push(updates.trace_id || null); }
  if (updates.span_id !== undefined) { fields.push('span_id = ?'); params.push(updates.span_id || null); }
  const hasDependencyUpdate = updates.depends_on !== undefined;

  if (fields.length === 0 && !hasDependencyUpdate) return existing;

  const now = Date.now();
  if (fields.length > 0) {
    fields.push('updated_at = ?');
    params.push(now);
    params.push(id);
  }

  const tx = d.transaction(() => {
    if (fields.length > 0) {
      d.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    }
    if (hasDependencyUpdate) {
      const deps = normalizeDependencyIds(id, updates.depends_on);
      assertDependenciesExist(deps);
      d.prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(id);
      if (deps.length > 0) {
        const insertDep = d.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)');
        for (const depId of deps) {
          insertDep.run(id, depId, now);
        }
      }
    }
  });

  tx();
  return d.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task;
}

export function getTaskById(id: number): Task | null {
  return (getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined) || null;
}

export function getTaskDependencies(taskId: number): number[] {
  const rows = getDb()
    .prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id ASC')
    .all(taskId) as Array<{ depends_on_task_id: number }>;
  return rows.map((row) => row.depends_on_task_id);
}

export function getTaskWithDependencies(taskId: number): TaskWithDependencies | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  return {
    ...task,
    depends_on: getTaskDependencies(taskId),
  };
}

export function addTaskEvidence(taskId: number, addedBy: string, evidenceRefs: string[]): {
  added: number;
  total: number;
} {
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) {
    return { added: 0, total: countTaskEvidence(taskId) };
  }
  const now = Date.now();
  const d = getDb();
  let added = 0;
  const tx = d.transaction((refs: string[]) => {
    const insert = d.prepare(`
      INSERT OR IGNORE INTO task_evidence (task_id, evidence_ref, added_by, created_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const ref of refs) {
      const result = insert.run(taskId, ref, addedBy, now);
      added += result.changes;
    }
  });
  tx(evidenceRefs);
  return { added, total: countTaskEvidence(taskId) };
}

export function listTaskEvidence(taskId: number, limit = 200): Array<{ evidence_ref: string; added_by: string; created_at: number }> {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(Number(limit))) : 200;
  return getDb().prepare(`
    SELECT evidence_ref, added_by, created_at
    FROM task_evidence
    WHERE task_id = ?
    ORDER BY created_at DESC, evidence_ref ASC
    LIMIT ?
  `).all(taskId, normalizedLimit) as Array<{ evidence_ref: string; added_by: string; created_at: number }>;
}

export function countTaskEvidence(taskId: number): number {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM task_evidence WHERE task_id = ?').get(taskId) as { c: number } | undefined;
  return row?.c || 0;
}

export function recordTaskStatusTransition(args: {
  task_id: number;
  from_status: string;
  to_status: string;
  changed_by: string;
  source: string;
  created_at?: number;
}): void {
  if (!args.from_status || !args.to_status || args.from_status === args.to_status) return;
  const now = Number.isFinite(args.created_at) ? Math.floor(Number(args.created_at)) : Date.now();
  getDb().prepare(`
    INSERT INTO task_status_history (task_id, from_status, to_status, changed_by, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(args.task_id, args.from_status, args.to_status, args.changed_by, args.source, now);
}

export function listTasks(options: {
  status?: string;
  assigned_to?: string;
  namespace?: string;
  execution_mode?: TaskExecutionMode;
  ready_only?: boolean;
  limit?: number;
  offset?: number;
  updated_after?: number;
  cursor?: { ts: number; id: number };
} = {}): Task[] {
  const d = getDb();
  let query = 'SELECT * FROM tasks WHERE 1=1';
  const params: unknown[] = [];

  if (options.status) {
    query += ' AND status = ?';
    params.push(options.status);
  }
  if (options.assigned_to) {
    query += ' AND assigned_to = ?';
    params.push(options.assigned_to);
  }
  if (options.namespace) {
    query += ' AND namespace = ?';
    params.push(options.namespace);
  }
  if (options.execution_mode) {
    query += ' AND execution_mode = ?';
    params.push(normalizeTaskExecutionMode(options.execution_mode));
  }
  if (options.ready_only) {
    query += `
      AND NOT EXISTS (
        SELECT 1
        FROM task_dependencies td
        JOIN tasks dep ON dep.id = td.depends_on_task_id
        WHERE td.task_id = tasks.id AND dep.status != 'done'
      )
    `;
  }

  const hasCursor = Boolean(options.cursor && Number.isFinite(options.cursor.ts) && Number.isFinite(options.cursor.id));
  const hasUpdatedAfter = Number.isFinite(options.updated_after);
  if (hasCursor) {
    query += ' AND (updated_at > ? OR (updated_at = ? AND id > ?))';
    params.push(options.cursor!.ts, options.cursor!.ts, options.cursor!.id);
    query += ' ORDER BY updated_at ASC, id ASC';
  } else if (hasUpdatedAfter) {
    query += ' AND updated_at > ?';
    params.push(options.updated_after as number);
    query += ' ORDER BY updated_at ASC, id ASC';
  } else {
    query += ' ORDER BY created_at DESC, id DESC';
  }

  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(Number(options.limit))) : 100;
  const offset = hasCursor || hasUpdatedAfter ? 0 : (Number.isFinite(options.offset) ? Math.max(0, Math.floor(Number(options.offset))) : 0);
  query += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return d.prepare(query).all(...params) as Task[];
}

function isTaskExecutionCompatible(taskMode: TaskExecutionMode, agentMode: AgentWorkspaceMode): boolean {
  if (taskMode === 'any') return true;
  if (agentMode === 'unknown') return false;
  return taskMode === agentMode;
}

export function claimTask(taskId: number, agentId: string, leaseSeconds?: number, namespace?: string): {
  success: true;
  task: Task;
  claim: TaskClaim;
} | {
  success: false;
  error_code: 'TASK_NOT_FOUND' | 'TASK_ALREADY_DONE' | 'ALREADY_CLAIMED' | 'DEPENDENCIES_NOT_MET' | 'NAMESPACE_MISMATCH' | 'PROFILE_MISMATCH';
  error: string;
  task?: Task;
  current_claim?: TaskClaim;
  unmet_dependencies?: number[];
  agent_runtime_mode?: AgentWorkspaceMode;
  task_execution_mode?: TaskExecutionMode;
} {
  const d = getDb();
  const now = Date.now();
  cleanupExpiredTaskClaims(now);

  const task = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
  if (!task) return { success: false, error_code: 'TASK_NOT_FOUND', error: 'Task not found' };
  if (task.status === 'done') return { success: false, error_code: 'TASK_ALREADY_DONE', error: 'Task already done', task };
  if (namespace && task.namespace !== namespace) {
    return {
      success: false,
      error_code: 'NAMESPACE_MISMATCH',
      error: `Task namespace "${task.namespace}" does not match requested "${namespace}"`,
      task,
    };
  }
  const agentRuntimeMode = getAgentRuntimeMode(agentId);
  const taskExecutionMode = normalizeTaskExecutionMode(task.execution_mode);
  if (!isTaskExecutionCompatible(taskExecutionMode, agentRuntimeMode)) {
    return {
      success: false,
      error_code: 'PROFILE_MISMATCH',
      error: `Task execution_mode "${taskExecutionMode}" incompatible with agent runtime_mode "${agentRuntimeMode}"`,
      task,
      agent_runtime_mode: agentRuntimeMode,
      task_execution_mode: taskExecutionMode,
    };
  }

  const unmetDependencies = d.prepare(`
    SELECT td.depends_on_task_id AS id
    FROM task_dependencies td
    JOIN tasks dep ON dep.id = td.depends_on_task_id
    WHERE td.task_id = ? AND dep.status != 'done'
    ORDER BY td.depends_on_task_id ASC
  `).all(taskId) as Array<{ id: number }>;
  if (unmetDependencies.length > 0) {
    return {
      success: false,
      error_code: 'DEPENDENCIES_NOT_MET',
      error: 'Task dependencies are not completed',
      task,
      unmet_dependencies: unmetDependencies.map((row) => row.id),
    };
  }

  const existing = d.prepare('SELECT * FROM task_claims WHERE task_id = ?').get(taskId) as TaskClaim | undefined;
  if (existing && existing.agent_id !== agentId && existing.lease_expires_at > now) {
    return { success: false, error_code: 'ALREADY_CLAIMED', error: 'Task already claimed by another agent', task, current_claim: existing };
  }

  const normalizedLease = normalizeLeaseSeconds(leaseSeconds);
  const leaseExpiresAt = now + normalizedLease * 1000;

  const tx = d.transaction(() => {
    if (existing?.agent_id === agentId) {
      const nextClaimId = randomUUID();
      const updatedClaim = d.prepare(`
        UPDATE task_claims
        SET claim_id = ?, claimed_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE task_id = ? AND agent_id = ? AND claim_id = ?
      `).run(nextClaimId, now, leaseExpiresAt, now, taskId, agentId, existing.claim_id);
      if (updatedClaim.changes !== 1) {
        throw new Error('CLAIM_STOLEN');
      }
    } else {
      d.prepare(`
        INSERT INTO task_claims (task_id, agent_id, claim_id, claimed_at, lease_expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(taskId, agentId, randomUUID(), now, leaseExpiresAt, now);
    }

    const updatedTask = d.prepare('UPDATE tasks SET status = ?, assigned_to = ?, updated_at = ? WHERE id = ?')
      .run('in_progress', agentId, now, taskId);
    if (updatedTask.changes !== 1) {
      throw new Error('TASK_UPDATE_FAILED');
    }
  });

  try {
    tx();
  } catch (error) {
    if (isTaskClaimUniqueConstraint(error) || (error instanceof Error && error.message === 'CLAIM_STOLEN')) {
      const currentTask = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
      const currentClaim = d.prepare('SELECT * FROM task_claims WHERE task_id = ?').get(taskId) as TaskClaim | undefined;
      return {
        success: false,
        error_code: 'ALREADY_CLAIMED',
        error: 'Task already claimed by another agent',
        task: currentTask,
        current_claim: currentClaim,
      };
    }
    throw error;
  }
  const claim = d.prepare('SELECT * FROM task_claims WHERE task_id = ?').get(taskId) as TaskClaim;
  const updatedTask = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task;
  return { success: true, task: updatedTask, claim };
}

export function renewTaskClaim(taskId: number, agentId: string, leaseSeconds?: number, claimId?: string): {
  success: true;
  task: Task;
  claim: TaskClaim;
} | {
  success: false;
  error_code: 'CLAIM_EXPIRED' | 'NOT_CLAIM_OWNER' | 'CLAIM_ID_MISMATCH' | 'CLAIM_STOLEN';
  error: string;
  current_claim?: TaskClaim;
} {
  const d = getDb();
  const now = Date.now();
  cleanupExpiredTaskClaims(now);

  const existing = d.prepare('SELECT * FROM task_claims WHERE task_id = ?').get(taskId) as TaskClaim | undefined;
  if (!existing) return { success: false, error_code: 'CLAIM_EXPIRED', error: 'Task has no active claim' };
  if (existing.agent_id !== agentId) {
    return { success: false, error_code: 'NOT_CLAIM_OWNER', error: 'Task claim owned by another agent', current_claim: existing };
  }
  if (claimId && existing.claim_id !== claimId) {
    return { success: false, error_code: 'CLAIM_ID_MISMATCH', error: 'Claim ID does not match active claim', current_claim: existing };
  }
  const expectedClaimId = claimId || existing.claim_id;

  const normalizedLease = normalizeLeaseSeconds(leaseSeconds);
  const leaseExpiresAt = now + normalizedLease * 1000;

  const tx = d.transaction(() => {
    const updatedClaim = d.prepare(`
      UPDATE task_claims
      SET lease_expires_at = ?, updated_at = ?
      WHERE task_id = ? AND agent_id = ? AND claim_id = ?
    `).run(leaseExpiresAt, now, taskId, agentId, expectedClaimId);
    if (updatedClaim.changes !== 1) {
      throw new Error('CLAIM_STOLEN');
    }
    d.prepare('UPDATE tasks SET status = ?, assigned_to = ?, updated_at = ? WHERE id = ?')
      .run('in_progress', agentId, now, taskId);
  });

  try {
    tx();
  } catch (error) {
    if (error instanceof Error && error.message === 'CLAIM_STOLEN') {
      const current = d.prepare('SELECT * FROM task_claims WHERE task_id = ?').get(taskId) as TaskClaim | undefined;
      return {
        success: false,
        error_code: 'CLAIM_STOLEN',
        error: 'Claim changed during renew; retry with fresh claim state',
        current_claim: current,
      };
    }
    throw error;
  }
  const claim = d.prepare('SELECT * FROM task_claims WHERE task_id = ?').get(taskId) as TaskClaim;
  const task = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task;
  return { success: true, task, claim };
}

export function releaseTaskClaim(taskId: number, agentId: string, nextStatus?: string, claimId?: string): {
  success: true;
  task: Task;
} | {
  success: false;
  error_code: 'CLAIM_EXPIRED' | 'NOT_CLAIM_OWNER' | 'CLAIM_ID_MISMATCH' | 'CLAIM_STOLEN';
  error: string;
  current_claim?: TaskClaim;
} {
  const d = getDb();
  const now = Date.now();
  cleanupExpiredTaskClaims(now);

  const existing = d.prepare('SELECT * FROM task_claims WHERE task_id = ?').get(taskId) as TaskClaim | undefined;
  if (!existing) return { success: false, error_code: 'CLAIM_EXPIRED', error: 'Task has no active claim' };
  if (existing.agent_id !== agentId) {
    return { success: false, error_code: 'NOT_CLAIM_OWNER', error: 'Task claim owned by another agent', current_claim: existing };
  }
  if (claimId && existing.claim_id !== claimId) {
    return { success: false, error_code: 'CLAIM_ID_MISMATCH', error: 'Claim ID does not match active claim', current_claim: existing };
  }
  const expectedClaimId = claimId || existing.claim_id;

  const effectiveStatus = nextStatus || 'pending';
  const assignedTo = effectiveStatus === 'done' ? agentId : null;

  const tx = d.transaction(() => {
    const removed = d.prepare(`
      DELETE FROM task_claims
      WHERE task_id = ? AND agent_id = ? AND claim_id = ?
    `).run(taskId, agentId, expectedClaimId);
    if (removed.changes !== 1) {
      throw new Error('CLAIM_STOLEN');
    }
    d.prepare('UPDATE tasks SET status = ?, assigned_to = ?, updated_at = ? WHERE id = ?')
      .run(effectiveStatus, assignedTo, now, taskId);
  });

  try {
    tx();
  } catch (error) {
    if (error instanceof Error && error.message === 'CLAIM_STOLEN') {
      const current = d.prepare('SELECT * FROM task_claims WHERE task_id = ?').get(taskId) as TaskClaim | undefined;
      return {
        success: false,
        error_code: 'CLAIM_STOLEN',
        error: 'Claim changed during release; retry with fresh claim state',
        current_claim: current,
      };
    }
    throw error;
  }
  const task = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task;
  return { success: true, task };
}

export function listTaskClaims(options: { agent_id?: string } = {}): TaskClaimWithTask[] {
  const d = getDb();
  cleanupExpiredTaskClaims();

  let query = `
    SELECT
      c.task_id,
      c.agent_id,
      c.claim_id,
      c.claimed_at,
      c.lease_expires_at,
      c.updated_at,
      t.title AS task_title,
      t.status AS task_status,
      t.priority AS task_priority
    FROM task_claims c
    JOIN tasks t ON t.id = c.task_id
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (options.agent_id) {
    query += ' AND c.agent_id = ?';
    params.push(options.agent_id);
  }

  query += ' ORDER BY c.lease_expires_at ASC';
  return d.prepare(query).all(...params) as TaskClaimWithTask[];
}

// --- Poll and Claim ---

export function pollAndClaim(agentId: string, leaseSeconds?: number, namespace?: string): { task: Task; claim: TaskClaim } | null {
  const d = getDb();
  const now = Date.now();
  const leaseExpiresAt = now + normalizeLeaseSeconds(leaseSeconds) * 1000;
  cleanupExpiredTaskClaims(now);
  const agentRuntimeMode = getAgentRuntimeMode(agentId);
  const executionClause = (() => {
    if (agentRuntimeMode === 'repo') return `AND execution_mode IN ('any', 'repo')`;
    if (agentRuntimeMode === 'isolated') return `AND execution_mode IN ('any', 'isolated')`;
    return `AND execution_mode = 'any'`;
  })();

  const txn = d.transaction(() => {
    const namespaceClause = namespace ? 'AND namespace = ?' : '';
    const taskParams: unknown[] = namespace ? [namespace] : [];
    // Find highest-priority pending task that is dependency-ready.
    // Tie-break with unblock_count to favor tasks that unlock more downstream work.
    const task = d.prepare(`
      SELECT * FROM tasks
      WHERE status = 'pending' AND assigned_to IS NULL
        ${namespaceClause}
        ${executionClause}
        AND NOT EXISTS (
          SELECT 1
          FROM task_dependencies td
          JOIN tasks dep ON dep.id = td.depends_on_task_id
          WHERE td.task_id = tasks.id AND dep.status != 'done'
        )
      ORDER BY
        CASE priority
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
        END ASC,
        (
          SELECT COUNT(*)
          FROM task_dependencies rev
          JOIN tasks child ON child.id = rev.task_id
          WHERE rev.depends_on_task_id = tasks.id AND child.status != 'done'
        ) DESC,
        created_at ASC
      LIMIT 1
    `).get(...taskParams) as Task | undefined;

    if (!task) return null;

    // Atomically assign and set in_progress
    const updated = d.prepare(`
      UPDATE tasks SET assigned_to = ?, status = 'in_progress', updated_at = ?
      WHERE id = ? AND status = 'pending' AND assigned_to IS NULL
    `).run(agentId, now, task.id);

    if (updated.changes === 0) return null;

    d.prepare(`
      INSERT INTO task_claims (task_id, agent_id, claim_id, claimed_at, lease_expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(task.id, agentId, randomUUID(), now, leaseExpiresAt, now);

    const updatedTask = d.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Task;
    const claim = d.prepare('SELECT * FROM task_claims WHERE task_id = ?').get(task.id) as TaskClaim;
    return { task: updatedTask, claim };
  });

  try {
    return txn();
  } catch (error) {
    if (isTaskClaimUniqueConstraint(error)) {
      return null;
    }
    throw error;
  }
}

// --- Context ---

export function shareContext(
  agentId: string,
  key: string,
  value: string,
  traceId?: string,
  spanId?: string,
  namespace?: string,
): Context {
  const now = Date.now();
  const contextNamespace = (namespace || 'default').trim() || 'default';
  const d = getDb();
  d.prepare(`
    INSERT INTO context (agent_id, key, value, namespace, trace_id, span_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, key) DO UPDATE SET
      value = excluded.value,
      namespace = excluded.namespace,
      trace_id = excluded.trace_id,
      span_id = excluded.span_id,
      updated_at = excluded.updated_at
  `).run(agentId, key, value, contextNamespace, traceId || null, spanId || null, now);
  const row = d.prepare('SELECT * FROM context WHERE agent_id = ? AND key = ?').get(agentId, key) as Context;
  return row;
}

export function getContext(options: {
  agent_id?: string;
  key?: string;
  namespace?: string;
  limit?: number;
  offset?: number;
  updated_after?: number;
} = {}): Context[] {
  const d = getDb();
  let query = 'SELECT * FROM context WHERE 1=1';
  const params: unknown[] = [];

  if (options.agent_id) {
    query += ' AND agent_id = ?';
    params.push(options.agent_id);
  }
  if (options.key) {
    query += ' AND key = ?';
    params.push(options.key);
  }
  if (options.namespace) {
    query += ' AND namespace = ?';
    params.push(options.namespace);
  }
  if (Number.isFinite(options.updated_after)) {
    query += ' AND updated_at > ?';
    params.push(Math.floor(Number(options.updated_after)));
  }
  query += ' ORDER BY updated_at DESC';
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(Number(options.limit))) : 100;
  const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(Number(options.offset))) : 0;
  query += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return d.prepare(query).all(...params) as Context[];
}

export function getContextById(contextId: number): Context | null {
  const normalizedContextId = Number.isFinite(contextId) ? Math.floor(Number(contextId)) : 0;
  if (normalizedContextId <= 0) return null;
  const row = getDb().prepare('SELECT * FROM context WHERE id = ?').get(normalizedContextId) as Context | undefined;
  return row || null;
}

// --- Agent Quality ---

export function getAgentQuality(agentId: string): AgentQuality {
  const row = getDb().prepare('SELECT * FROM agent_quality WHERE agent_id = ?').get(agentId) as AgentQuality | undefined;
  if (row) return row;
  return {
    agent_id: agentId,
    completed_count: 0,
    rollback_count: 0,
    last_updated: 0,
  };
}

export function recordTaskCompletion(agentId: string): AgentQuality {
  const now = Date.now();
  const d = getDb();
  d.prepare(`
    INSERT INTO agent_quality (agent_id, completed_count, rollback_count, last_updated)
    VALUES (?, 1, 0, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      completed_count = agent_quality.completed_count + 1,
      last_updated = excluded.last_updated
  `).run(agentId, now);
  return getAgentQuality(agentId);
}

export function recordTaskRollback(agentId: string): AgentQuality {
  const now = Date.now();
  const d = getDb();
  d.prepare(`
    INSERT INTO agent_quality (agent_id, completed_count, rollback_count, last_updated)
    VALUES (?, 0, 1, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      rollback_count = agent_quality.rollback_count + 1,
      last_updated = excluded.last_updated
  `).run(agentId, now);
  return getAgentQuality(agentId);
}

// --- Idempotency ---

export function cleanupIdempotencyKeys(now = Date.now()): number {
  if (IDEMPOTENCY_TTL_MS <= 0) return 0;
  const cutoff = now - IDEMPOTENCY_TTL_MS;
  const result = getDb().prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(cutoff);
  return result.changes;
}

export function getIdempotencyRecord(agentId: string, toolName: string, idempotencyKey: string): IdempotencyRecord | null {
  cleanupIdempotencyKeys();
  const row = getDb()
    .prepare(`
      SELECT *
      FROM idempotency_keys
      WHERE agent_id = ? AND tool_name = ? AND idempotency_key = ?
    `)
    .get(agentId, toolName, idempotencyKey) as IdempotencyRecord | undefined;
  return row || null;
}

export function saveIdempotencyRecord(agentId: string, toolName: string, idempotencyKey: string, response: unknown): void {
  const now = Date.now();
  const responseJson = JSON.stringify(response);
  getDb().prepare(`
    INSERT OR IGNORE INTO idempotency_keys (agent_id, tool_name, idempotency_key, response_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(agentId, toolName, idempotencyKey, responseJson, now);
}

// --- Protocol Blobs ---

export function putProtocolBlob(hash: string, value: string): { blob: ProtocolBlob; created: boolean } {
  const d = getDb();
  const now = Date.now();
  const inserted = d.prepare(`
    INSERT OR IGNORE INTO protocol_blobs (hash, value, created_at, updated_at, access_count)
    VALUES (?, ?, ?, ?, 0)
  `).run(hash, value, now, now);

  if (inserted.changes === 0) {
    d.prepare('UPDATE protocol_blobs SET updated_at = ? WHERE hash = ?').run(now, hash);
  }

  const blob = d.prepare('SELECT * FROM protocol_blobs WHERE hash = ?').get(hash) as ProtocolBlob;
  return { blob, created: inserted.changes > 0 };
}

export function getProtocolBlob(hash: string): ProtocolBlob | null {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM protocol_blobs WHERE hash = ?').get(hash) as ProtocolBlob | undefined;
  if (!existing) return null;

  d.prepare('UPDATE protocol_blobs SET access_count = access_count + 1, updated_at = ? WHERE hash = ?').run(Date.now(), hash);
  return d.prepare('SELECT * FROM protocol_blobs WHERE hash = ?').get(hash) as ProtocolBlob;
}

export function listProtocolBlobs(limit = 100, offset = 0): ProtocolBlob[] {
  const capped = Math.max(1, Math.min(1000, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  return getDb()
    .prepare('SELECT * FROM protocol_blobs ORDER BY updated_at DESC LIMIT ? OFFSET ?')
    .all(capped, safeOffset) as ProtocolBlob[];
}

// --- Consensus Decisions ---

export function saveConsensusDecision(args: {
  proposal_id: string;
  requesting_agent: string;
  outcome: string;
  stats: unknown;
  reasons?: string[];
}): ConsensusDecision {
  const now = Date.now();
  const result = getDb().prepare(`
    INSERT INTO consensus_decisions (proposal_id, requesting_agent, outcome, stats_json, reasons_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    args.proposal_id,
    args.requesting_agent,
    args.outcome,
    JSON.stringify(args.stats ?? {}),
    JSON.stringify(args.reasons ?? []),
    now
  );
  return getDb().prepare('SELECT * FROM consensus_decisions WHERE id = ?').get(result.lastInsertRowid) as ConsensusDecision;
}

export function listConsensusDecisions(options: { proposal_id?: string; limit?: number; offset?: number } = {}): ConsensusDecision[] {
  let query = 'SELECT * FROM consensus_decisions WHERE 1=1';
  const params: unknown[] = [];
  if (options.proposal_id) {
    query += ' AND proposal_id = ?';
    params.push(options.proposal_id);
  }
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(Number(options.limit))) : 100;
  const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(Number(options.offset))) : 0;
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return getDb().prepare(query).all(...params) as ConsensusDecision[];
}

// --- Auth Coverage ---

export function recordAuthEvent(agentId: string | null, toolName: string, status: 'valid' | 'missing' | 'invalid' | 'skipped'): void {
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO auth_events (agent_id, tool_name, status, created_at)
    VALUES (?, ?, ?, ?)
  `).run(agentId, toolName, status, now);
}

export function getAuthCoverageSnapshot(windowMs = 24 * 60 * 60 * 1000, now = Date.now()): AuthCoverageSnapshot & {
  by_tool: Array<{ tool_name: string; total: number; valid: number; missing: number; invalid: number; skipped: number; valid_coverage_pct: number }>;
} {
  const fromTs = now - Math.max(1, Math.floor(windowMs));
  const d = getDb();
  const counts = d.prepare(`
    SELECT status, COUNT(*) AS c
    FROM auth_events
    WHERE created_at >= ?
    GROUP BY status
  `).all(fromTs) as Array<{ status: string; c: number }>;
  const tally = new Map<string, number>();
  for (const row of counts) tally.set(row.status, row.c);

  const valid = tally.get('valid') || 0;
  const missing = tally.get('missing') || 0;
  const invalid = tally.get('invalid') || 0;
  const skipped = tally.get('skipped') || 0;
  const total = valid + missing + invalid + skipped;
  const denominator = valid + missing + invalid;
  const coverage = denominator === 0 ? 100 : Math.round((10000 * valid) / denominator) / 100;

  const byToolRaw = d.prepare(`
    SELECT
      tool_name,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'valid' THEN 1 ELSE 0 END) AS valid,
      SUM(CASE WHEN status = 'missing' THEN 1 ELSE 0 END) AS missing,
      SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) AS invalid,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
    FROM auth_events
    WHERE created_at >= ?
    GROUP BY tool_name
    ORDER BY total DESC
    LIMIT 20
  `).all(fromTs) as Array<{ tool_name: string; total: number; valid: number; missing: number; invalid: number; skipped: number }>;

  const byTool = byToolRaw.map((row) => {
    const denom = row.valid + row.missing + row.invalid;
    return {
      ...row,
      valid_coverage_pct: denom === 0 ? 100 : Math.round((10000 * row.valid) / denom) / 100,
    };
  });

  return {
    window_ms: windowMs,
    from_ts: fromTs,
    to_ts: now,
    total_events: total,
    valid_events: valid,
    missing_events: missing,
    invalid_events: invalid,
    skipped_events: skipped,
    valid_coverage_pct: coverage,
    by_tool: byTool,
  };
}

export function cleanupAuthEvents(now = Date.now(), ttlMs = AUTH_EVENTS_TTL_MS): number {
  if (ttlMs <= 0) return 0;
  const cutoff = now - ttlMs;
  const result = getDb().prepare('DELETE FROM auth_events WHERE created_at < ?').run(cutoff);
  return result.changes;
}

// --- Artifacts ---

export function createArtifactRecord(args: {
  id: string;
  created_by: string;
  name: string;
  mime_type?: string;
  namespace?: string;
  summary?: string;
  ttl_expires_at?: number | null;
}): Artifact {
  const now = Date.now();
  const namespace = (args.namespace || 'default').trim() || 'default';
  const mimeType = (args.mime_type || 'application/octet-stream').trim() || 'application/octet-stream';
  const summary = (args.summary || '').trim();
  const ttlExpiresAt = Number.isFinite(args.ttl_expires_at) ? Math.floor(Number(args.ttl_expires_at)) : null;
  getDb().prepare(`
    INSERT INTO artifacts (
      id, created_by, name, mime_type, size_bytes, sha256, storage_path, namespace, summary,
      created_at, updated_at, access_count, ttl_expires_at
    ) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?, ?, 0, ?)
  `).run(args.id, args.created_by, args.name, mimeType, namespace, summary, now, now, ttlExpiresAt);
  return getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(args.id) as Artifact;
}

export function finalizeArtifactUpload(args: {
  id: string;
  size_bytes: number;
  sha256: string;
  storage_path: string;
  mime_type?: string;
}): Artifact | null {
  const now = Date.now();
  const updated = getDb().prepare(`
    UPDATE artifacts
    SET size_bytes = ?, sha256 = ?, storage_path = ?, mime_type = COALESCE(?, mime_type), updated_at = ?
    WHERE id = ?
  `).run(
    Math.max(0, Math.floor(args.size_bytes)),
    args.sha256,
    args.storage_path,
    args.mime_type || null,
    now,
    args.id,
  );
  if (updated.changes !== 1) return null;
  return getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(args.id) as Artifact;
}

export function getArtifactById(artifactId: string): Artifact | null {
  const row = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId) as Artifact | undefined;
  return row || null;
}

export function listArtifacts(options: {
  requesting_agent?: string;
  created_by?: string;
  namespace?: string;
  limit?: number;
  offset?: number;
} = {}): Artifact[] {
  let query = 'SELECT * FROM artifacts WHERE 1=1';
  const params: unknown[] = [];
  if (options.created_by) {
    query += ' AND created_by = ?';
    params.push(options.created_by);
  }
  if (options.namespace) {
    query += ' AND namespace = ?';
    params.push(options.namespace);
  }
  if (options.requesting_agent) {
    query += `
      AND (
        created_by = ?
        OR EXISTS (
          SELECT 1 FROM artifact_shares s
          WHERE s.artifact_id = artifacts.id AND s.to_agent IN (?, '*')
        )
      )
    `;
    params.push(options.requesting_agent, options.requesting_agent);
  }
  query += ' ORDER BY created_at DESC, id DESC';
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(Number(options.limit))) : 100;
  const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(Number(options.offset))) : 0;
  query += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return getDb().prepare(query).all(...params) as Artifact[];
}

export function grantArtifactAccess(args: {
  artifact_id: string;
  to_agent: string;
  granted_by: string;
}): void {
  const now = Date.now();
  getDb().prepare(`
    INSERT OR REPLACE INTO artifact_shares (artifact_id, to_agent, granted_by, created_at)
    VALUES (?, ?, ?, ?)
  `).run(args.artifact_id, args.to_agent, args.granted_by, now);
}

export function hasArtifactAccess(agentId: string, artifactId: string): boolean {
  const row = getDb().prepare(`
    SELECT 1 AS ok
    FROM artifacts a
    WHERE a.id = ?
      AND (
        a.created_by = ?
        OR EXISTS (
          SELECT 1 FROM artifact_shares s
          WHERE s.artifact_id = a.id AND s.to_agent IN (?, '*')
        )
      )
    LIMIT 1
  `).get(artifactId, agentId, agentId) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

export function attachTaskArtifact(taskId: number, artifactId: string, addedBy: string): { created: boolean; row: TaskArtifact | null } {
  const now = Date.now();
  const insertResult = getDb().prepare(`
    INSERT OR IGNORE INTO task_artifacts (task_id, artifact_id, added_by, created_at)
    VALUES (?, ?, ?, ?)
  `).run(taskId, artifactId, addedBy, now);
  const row = getDb().prepare(`
    SELECT task_id, artifact_id, added_by, created_at
    FROM task_artifacts
    WHERE task_id = ? AND artifact_id = ?
  `).get(taskId, artifactId) as TaskArtifact | undefined;
  return {
    created: insertResult.changes === 1,
    row: row || null,
  };
}

export function listTaskArtifacts(taskId: number, options: { limit?: number; offset?: number } = {}): TaskArtifactWithMeta[] {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(5000, Math.floor(Number(options.limit)))) : 1000;
  const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(Number(options.offset))) : 0;
  return getDb().prepare(`
    SELECT
      ta.task_id,
      ta.artifact_id,
      ta.added_by,
      ta.created_at,
      a.name AS artifact_name,
      a.mime_type AS artifact_mime_type,
      a.size_bytes AS artifact_size_bytes,
      a.sha256 AS artifact_sha256,
      a.namespace AS artifact_namespace,
      a.updated_at AS artifact_updated_at
    FROM task_artifacts ta
    JOIN artifacts a ON a.id = ta.artifact_id
    WHERE ta.task_id = ?
    ORDER BY ta.created_at DESC, ta.artifact_id DESC
    LIMIT ? OFFSET ?
  `).all(taskId, limit, offset) as TaskArtifactWithMeta[];
}

export function incrementArtifactAccess(artifactId: string): void {
  getDb().prepare(`
    UPDATE artifacts
    SET access_count = access_count + 1, updated_at = ?
    WHERE id = ?
  `).run(Date.now(), artifactId);
}

export function cleanupArtifacts(now = Date.now(), ttlMs = ARTIFACT_TTL_MS): { deleted: number; paths: string[] } {
  const d = getDb();
  const cutoff = now - Math.max(1, ttlMs);
  const rows = d.prepare(`
    SELECT id, storage_path
    FROM artifacts
    WHERE
      (ttl_expires_at IS NOT NULL AND ttl_expires_at < ?)
      OR (ttl_expires_at IS NULL AND updated_at < ?)
  `).all(now, cutoff) as Array<{ id: string; storage_path: string | null }>;
  if (rows.length === 0) return { deleted: 0, paths: [] };

  const tx = d.transaction((ids: string[]) => {
    const delShares = d.prepare('DELETE FROM artifact_shares WHERE artifact_id = ?');
    const delArtifact = d.prepare('DELETE FROM artifacts WHERE id = ?');
    for (const id of ids) {
      delShares.run(id);
      delArtifact.run(id);
    }
  });
  tx(rows.map((row) => row.id));
  const paths = rows
    .map((row) => row.storage_path)
    .filter((value): value is string => Boolean(value));
  for (const filePath of paths) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Best-effort cleanup for expired artifacts.
    }
  }
  return {
    deleted: rows.length,
    paths,
  };
}

// --- Update Watermark + KPI ---

export function getUpdateWatermark(
  agentId?: string,
  options: {
    streams?: Array<'messages' | 'tasks' | 'context' | 'activity'>;
    fallback?: {
      latest_message_ts?: number;
      latest_task_ts?: number;
      latest_context_ts?: number;
      latest_activity_ts?: number;
    };
  } = {},
): {
  now: number;
  latest_message_ts: number;
  latest_task_ts: number;
  latest_context_ts: number;
  latest_activity_ts: number;
} {
  const d = getDb();
  const now = Date.now();
  const streams = new Set(options.streams && options.streams.length > 0
    ? options.streams
    : ['messages', 'tasks', 'context', 'activity']);
  const fallback = options.fallback || {};

  const needsCore = streams.has('tasks') || streams.has('context') || streams.has('activity');
  let core = watermarkCoreCache;
  if (needsCore && (!core || !isWatermarkCacheFresh(core.sampled_at, now))) {
    const row = d.prepare(`
      SELECT
        (SELECT COALESCE(MAX(updated_at), 0) FROM tasks) AS latest_task_ts,
        (SELECT COALESCE(MAX(updated_at), 0) FROM context) AS latest_context_ts,
        (SELECT COALESCE(MAX(created_at), 0) FROM activity_log) AS latest_activity_ts
    `).get() as {
      latest_task_ts: number;
      latest_context_ts: number;
      latest_activity_ts: number;
    };
    core = {
      sampled_at: now,
      latest_task_ts: row.latest_task_ts || 0,
      latest_context_ts: row.latest_context_ts || 0,
      latest_activity_ts: row.latest_activity_ts || 0,
    };
    watermarkCoreCache = core;
  }

  const latestTask = streams.has('tasks')
    ? (core?.latest_task_ts ?? 0)
    : (Number.isFinite(fallback.latest_task_ts) ? Math.floor(Number(fallback.latest_task_ts)) : 0);
  const latestContext = streams.has('context')
    ? (core?.latest_context_ts ?? 0)
    : (Number.isFinite(fallback.latest_context_ts) ? Math.floor(Number(fallback.latest_context_ts)) : 0);
  const latestActivity = streams.has('activity')
    ? (core?.latest_activity_ts ?? 0)
    : (Number.isFinite(fallback.latest_activity_ts) ? Math.floor(Number(fallback.latest_activity_ts)) : 0);

  let latestMessage = Number.isFinite(fallback.latest_message_ts) ? Math.floor(Number(fallback.latest_message_ts)) : 0;
  if (streams.has('messages') && agentId) {
    const cached = watermarkAgentMessageCache.get(agentId);
    if (cached && isWatermarkCacheFresh(cached.sampled_at, now)) {
      latestMessage = cached.latest_message_ts;
    } else {
      latestMessage = ((d.prepare(`
        SELECT COALESCE(MAX(created_at), 0) AS ts
        FROM messages
        WHERE to_agent = ? OR to_agent IS NULL
      `).get(agentId) as { ts: number }).ts) || 0;
      watermarkAgentMessageCache.set(agentId, {
        sampled_at: now,
        latest_message_ts: latestMessage,
      });
      pruneWatermarkAgentCache(now);
    }
  } else if (streams.has('messages')) {
    if (watermarkAllMessagesCache && isWatermarkCacheFresh(watermarkAllMessagesCache.sampled_at, now)) {
      latestMessage = watermarkAllMessagesCache.latest_message_ts;
    } else {
      latestMessage = ((d.prepare('SELECT COALESCE(MAX(created_at), 0) AS ts FROM messages').get() as { ts: number }).ts) || 0;
      watermarkAllMessagesCache = {
        sampled_at: now,
        latest_message_ts: latestMessage,
      };
    }
  }

  return {
    now,
    latest_message_ts: latestMessage,
    latest_task_ts: latestTask || 0,
    latest_context_ts: latestContext || 0,
    latest_activity_ts: latestActivity || 0,
  };
}

export function getKpiWindows(windowsMs: number[], now = Date.now()): {
  at: number;
  queue: {
    tasks_pending: number;
    tasks_in_progress: number;
    tasks_done: number;
    claims_active: number;
    agents_online_5m: number;
  };
  windows: KpiWindowSnapshot[];
  collective_accuracy: {
    window_ms: number;
    reopen_rate_pct: number;
    done_with_evidence_rate_pct: number;
    consensus_escalation_pct: number;
    consensus_estimated_tokens_per_finalized_decision: number | null;
  };
  top_actions_5m: Array<{ action: string; count: number }>;
  namespace_backlog: Array<{ namespace: string; pending: number; in_progress: number; total: number }>;
  execution_backlog: Array<{ execution_mode: string; pending: number; in_progress: number; total: number }>;
} {
  const d = getDb();
  const uniqueWindows = [...new Set(windowsMs.map((value) => Math.max(1, Math.floor(value))))];
  const queue = {
    tasks_pending: (d.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE status = 'pending'`).get() as { c: number }).c,
    tasks_in_progress: (d.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE status = 'in_progress'`).get() as { c: number }).c,
    tasks_done: (d.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE status = 'done'`).get() as { c: number }).c,
    claims_active: (d.prepare(`SELECT COUNT(*) AS c FROM task_claims WHERE lease_expires_at > ?`).get(now) as { c: number }).c,
    agents_online_5m: (d.prepare('SELECT COUNT(*) AS c FROM agents WHERE last_seen >= ?').get(now - 5 * 60 * 1000) as { c: number }).c,
  };

  const windows = uniqueWindows.map((windowMs) => {
    const cutoff = now - windowMs;
    const activityEvents = (d.prepare('SELECT COUNT(*) AS c FROM activity_log WHERE created_at >= ?').get(cutoff) as { c: number }).c;
    const messagesCreated = (d.prepare('SELECT COUNT(*) AS c FROM messages WHERE created_at >= ?').get(cutoff) as { c: number }).c;
    const tasksUpdated = (d.prepare('SELECT COUNT(*) AS c FROM tasks WHERE updated_at >= ?').get(cutoff) as { c: number }).c;
    const doneTasksUpdated = (d.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE status = 'done' AND updated_at >= ?`).get(cutoff) as { c: number }).c;
    const statusTransitions = (d.prepare('SELECT COUNT(*) AS c FROM task_status_history WHERE created_at >= ?').get(cutoff) as { c: number }).c;
    const doneTransitions = (d.prepare(`SELECT COUNT(*) AS c FROM task_status_history WHERE created_at >= ? AND to_status = 'done'`).get(cutoff) as { c: number }).c;
    const reopenTransitions = (d.prepare(`SELECT COUNT(*) AS c FROM task_status_history WHERE created_at >= ? AND from_status = 'done' AND to_status != 'done'`).get(cutoff) as { c: number }).c;
    const doneWithEvidence = (d.prepare(`
      SELECT COUNT(DISTINCT h.task_id) AS c
      FROM task_status_history h
      WHERE h.created_at >= ?
        AND h.to_status = 'done'
        AND EXISTS (SELECT 1 FROM task_evidence e WHERE e.task_id = h.task_id)
    `).get(cutoff) as { c: number }).c;

    const consensusRows = d.prepare(`
      SELECT outcome, stats_json
      FROM consensus_decisions
      WHERE created_at >= ?
    `).all(cutoff) as Array<{ outcome: string; stats_json: string }>;
    const consensusDecisions = consensusRows.length;
    const consensusEscalations = consensusRows.filter((row) => row.outcome === 'escalate_verifier').length;
    const consensusFinalized = consensusRows.filter((row) => row.outcome === 'accept' || row.outcome === 'reject').length;
    const consensusEstimatedTokensTotal = consensusRows.reduce((sum, row) => {
      try {
        const parsed = JSON.parse(row.stats_json || '{}') as Record<string, unknown>;
        const value = Number(parsed.estimated_token_cost);
        return sum + (Number.isFinite(value) ? value : 0);
      } catch {
        return sum;
      }
    }, 0);

    const pollingCalls = (d.prepare(`
      SELECT COUNT(*) AS c
      FROM activity_log
      WHERE created_at >= ?
        AND action IN ('list_tasks', 'read_messages', 'poll_and_claim')
    `).get(cutoff) as { c: number }).c;
    const profileMismatchClaims = (d.prepare(`
      SELECT COUNT(*) AS c
      FROM activity_log
      WHERE created_at >= ?
        AND action = 'claim_task_failed'
        AND details LIKE '%(PROFILE_MISMATCH)%'
    `).get(cutoff) as { c: number }).c;
    const artifactUploads = (d.prepare(`
      SELECT COUNT(*) AS c
      FROM activity_log
      WHERE created_at >= ?
        AND action IN ('create_artifact_upload', 'artifact_upload_http')
    `).get(cutoff) as { c: number }).c;
    const artifactDownloads = (d.prepare(`
      SELECT COUNT(*) AS c
      FROM activity_log
      WHERE created_at >= ?
        AND action IN ('create_artifact_download', 'create_task_artifact_downloads', 'artifact_download_http')
    `).get(cutoff) as { c: number }).c;
    const artifactShares = (d.prepare(`
      SELECT COUNT(*) AS c
      FROM activity_log
      WHERE created_at >= ?
        AND action = 'share_artifact'
    `).get(cutoff) as { c: number }).c;
    const taskArtifactAttaches = (d.prepare(`
      SELECT COUNT(*) AS c
      FROM activity_log
      WHERE created_at >= ?
        AND action = 'attach_task_artifact'
    `).get(cutoff) as { c: number }).c;
    const taskArtifactQueries = (d.prepare(`
      SELECT COUNT(*) AS c
      FROM activity_log
      WHERE created_at >= ?
        AND action = 'list_task_artifacts'
    `).get(cutoff) as { c: number }).c;
    const claimWithArtifactHints = (d.prepare(`
      SELECT COUNT(*) AS c
      FROM activity_log
      WHERE created_at >= ?
        AND action IN ('poll_and_claim', 'claim_task')
        AND details LIKE '%include_artifacts=1%'
    `).get(cutoff) as { c: number }).c;
    const waitHits = (d.prepare(`
      SELECT COUNT(*) AS c
      FROM activity_log
      WHERE created_at >= ?
        AND action = 'wait_for_updates_hit'
    `).get(cutoff) as { c: number }).c;
    const waitCalls = (d.prepare(`
      SELECT COUNT(*) AS c
      FROM auth_events
      WHERE created_at >= ?
        AND tool_name = 'wait_for_updates'
    `).get(cutoff) as { c: number }).c;
    const waitTimeoutRows = d.prepare(`
      SELECT details
      FROM activity_log
      WHERE created_at >= ?
        AND action = 'wait_for_updates_timeout'
    `).all(cutoff) as Array<{ details: string }>;
    const loggedWaitTimeouts = waitTimeoutRows.length;
    const waitTimeouts = Math.max(loggedWaitTimeouts, Math.max(0, waitCalls - waitHits));
    const waitRetryValues = waitTimeoutRows
      .map((row) => {
        const match = /retry_after_ms=(\d+)/.exec(row.details || '');
        if (!match) return null;
        const value = Number(match[1]);
        return Number.isFinite(value) ? value : null;
      })
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    const waitRetryAvg = waitRetryValues.length === 0
      ? null
      : Math.round(waitRetryValues.reduce((sum, value) => sum + value, 0) / waitRetryValues.length);
    const waitRetryP95 = waitRetryValues.length === 0
      ? null
      : waitRetryValues[Math.max(0, Math.min(waitRetryValues.length - 1, Math.ceil(waitRetryValues.length * 0.95) - 1))];
    const avgChars = (d.prepare('SELECT COALESCE(AVG(LENGTH(content)), 0) AS v FROM messages WHERE created_at >= ?').get(cutoff) as { v: number }).v;

    return {
      window_ms: windowMs,
      activity_events: activityEvents,
      messages_created: messagesCreated,
      tasks_updated: tasksUpdated,
      done_tasks_updated: doneTasksUpdated,
      polling_calls: pollingCalls,
      avg_message_chars: Math.round(avgChars || 0),
      profile_mismatch_claims: profileMismatchClaims,
      artifact_uploads: artifactUploads,
      artifact_downloads: artifactDownloads,
      artifact_shares: artifactShares,
      task_artifact_attaches: taskArtifactAttaches,
      task_artifact_queries: taskArtifactQueries,
      claim_with_artifact_hints: claimWithArtifactHints,
      wait_calls: waitCalls,
      wait_hits: waitHits,
      wait_timeouts: waitTimeouts,
      wait_hit_rate_pct: (waitHits + waitTimeouts) === 0 ? 0 : Math.round((waitHits * 10000) / (waitHits + waitTimeouts)) / 100,
      wait_retry_after_avg_ms: waitRetryAvg,
      wait_retry_after_p95_ms: waitRetryP95,
      status_transitions: statusTransitions,
      done_transitions: doneTransitions,
      reopen_transitions: reopenTransitions,
      reopen_rate_pct: doneTransitions === 0 ? 0 : Math.round((reopenTransitions * 10000) / doneTransitions) / 100,
      done_with_evidence: doneWithEvidence,
      done_with_evidence_rate_pct: doneTransitions === 0 ? 100 : Math.round((doneWithEvidence * 10000) / doneTransitions) / 100,
      consensus_decisions: consensusDecisions,
      consensus_escalations: consensusEscalations,
      consensus_escalation_pct: consensusDecisions === 0 ? 0 : Math.round((consensusEscalations * 10000) / consensusDecisions) / 100,
      consensus_estimated_tokens_total: consensusEstimatedTokensTotal,
      consensus_estimated_tokens_per_decision: consensusDecisions === 0 ? null : Math.round((consensusEstimatedTokensTotal * 100) / consensusDecisions) / 100,
      consensus_estimated_tokens_per_finalized_decision: consensusFinalized === 0 ? null : Math.round((consensusEstimatedTokensTotal * 100) / consensusFinalized) / 100,
    } as KpiWindowSnapshot;
  });

  const collectiveSource = [...windows].sort((a, b) => b.window_ms - a.window_ms)[0] || {
    window_ms: 0,
    reopen_rate_pct: 0,
    done_with_evidence_rate_pct: 100,
    consensus_escalation_pct: 0,
    consensus_estimated_tokens_per_finalized_decision: null as number | null,
  };

  const topActions = d.prepare(`
    SELECT action, COUNT(*) AS count
    FROM activity_log
    WHERE created_at >= ?
    GROUP BY action
    ORDER BY count DESC, action ASC
    LIMIT 12
  `).all(now - 5 * 60 * 1000) as Array<{ action: string; count: number }>;

  const namespaceBacklog = d.prepare(`
    SELECT
      namespace,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress
    FROM tasks
    GROUP BY namespace
    ORDER BY total DESC
    LIMIT 20
  `).all() as Array<{ namespace: string; total: number; pending: number; in_progress: number }>;

  const executionBacklog = d.prepare(`
    SELECT
      execution_mode,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress
    FROM tasks
    GROUP BY execution_mode
    ORDER BY total DESC
    LIMIT 10
  `).all() as Array<{ execution_mode: string; total: number; pending: number; in_progress: number }>;

  return {
    at: now,
    queue,
    windows,
    collective_accuracy: {
      window_ms: collectiveSource.window_ms,
      reopen_rate_pct: collectiveSource.reopen_rate_pct,
      done_with_evidence_rate_pct: collectiveSource.done_with_evidence_rate_pct,
      consensus_escalation_pct: collectiveSource.consensus_escalation_pct,
      consensus_estimated_tokens_per_finalized_decision: collectiveSource.consensus_estimated_tokens_per_finalized_decision,
    },
    top_actions_5m: topActions,
    namespace_backlog: namespaceBacklog.map((row) => ({
      namespace: row.namespace || 'default',
      total: row.total,
      pending: row.pending || 0,
      in_progress: row.in_progress || 0,
    })),
    execution_backlog: executionBacklog.map((row) => ({
      execution_mode: row.execution_mode || 'any',
      total: row.total,
      pending: row.pending || 0,
      in_progress: row.in_progress || 0,
    })),
  };
}

// --- SLO Alerts ---

function upsertOpenSloAlert(args: {
  code: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  details: Record<string, unknown>;
  now: number;
}): { alert: SloAlert; created: boolean } {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM slo_alerts WHERE code = ? AND resolved_at IS NULL').get(args.code) as SloAlert | undefined;
  if (existing) {
    d.prepare(`
      UPDATE slo_alerts
      SET severity = ?, message = ?, details_json = ?, updated_at = ?
      WHERE id = ?
    `).run(args.severity, args.message, JSON.stringify(args.details), args.now, existing.id);
    const alert = d.prepare('SELECT * FROM slo_alerts WHERE id = ?').get(existing.id) as SloAlert;
    return { alert, created: false };
  }
  const result = d.prepare(`
    INSERT INTO slo_alerts (code, severity, message, details_json, created_at, updated_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(args.code, args.severity, args.message, JSON.stringify(args.details), args.now, args.now);
  const alert = d.prepare('SELECT * FROM slo_alerts WHERE id = ?').get(result.lastInsertRowid) as SloAlert;
  return { alert, created: true };
}

function resolveOpenSloAlert(code: string, now: number): number {
  const result = getDb().prepare(`
    UPDATE slo_alerts
    SET resolved_at = ?, updated_at = ?
    WHERE code = ? AND resolved_at IS NULL
  `).run(now, now, code);
  return result.changes;
}

export function listSloAlerts(options: { open_only?: boolean; limit?: number; offset?: number; code?: string } = {}): SloAlert[] {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(Number(options.limit))) : 100;
  const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(Number(options.offset))) : 0;
  let query = 'SELECT * FROM slo_alerts WHERE 1=1';
  const params: unknown[] = [];
  if (options.code) {
    query += ' AND code = ?';
    params.push(options.code);
  }
  if (options.open_only) {
    query += ' AND resolved_at IS NULL';
  }
  query += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return getDb().prepare(query).all(...params) as SloAlert[];
}

export function evaluateSloAlerts(now = Date.now()): {
  evaluated_at: number;
  triggered: number;
  resolved: number;
  open_alerts: SloAlert[];
  events: Array<{ code: string; state: 'triggered' | 'updated' | 'resolved'; severity: string; message: string }>;
} {
  const d = getDb();
  const events: Array<{ code: string; state: 'triggered' | 'updated' | 'resolved'; severity: string; message: string }> = [];
  let triggered = 0;
  let resolved = 0;

  // SLO 1: old pending tasks
  const pendingRow = d.prepare(`
    SELECT COUNT(*) AS pending_count, MIN(created_at) AS oldest_created_at
    FROM tasks
    WHERE status = 'pending'
  `).get() as { pending_count: number; oldest_created_at: number | null };
  const pendingAgeMs = pendingRow.oldest_created_at ? now - pendingRow.oldest_created_at : 0;
  if (pendingRow.pending_count > 0 && pendingAgeMs >= SLO_PENDING_AGE_MS) {
    const message = `Oldest pending task age ${Math.floor(pendingAgeMs / 1000)}s exceeded threshold ${Math.floor(SLO_PENDING_AGE_MS / 1000)}s`;
    const result = upsertOpenSloAlert({
      code: 'high_pending_age',
      severity: 'high',
      message,
      details: {
        pending_count: pendingRow.pending_count,
        oldest_pending_age_ms: pendingAgeMs,
        threshold_ms: SLO_PENDING_AGE_MS,
      },
      now,
    });
    triggered += result.created ? 1 : 0;
    events.push({ code: 'high_pending_age', state: result.created ? 'triggered' : 'updated', severity: result.alert.severity, message });
  } else {
    const changed = resolveOpenSloAlert('high_pending_age', now);
    if (changed > 0) {
      resolved += changed;
      events.push({ code: 'high_pending_age', state: 'resolved', severity: 'low', message: 'Pending age back within SLO' });
    }
  }

  // SLO 2: stale in-progress without active claim
  const staleRow = d.prepare(`
    SELECT
      COUNT(*) AS stale_count,
      MIN(t.updated_at) AS oldest_updated_at
    FROM tasks t
    LEFT JOIN task_claims tc
      ON tc.task_id = t.id AND tc.lease_expires_at > ?
    WHERE t.status = 'in_progress'
      AND t.updated_at < ?
      AND tc.task_id IS NULL
  `).get(now, now - SLO_STALE_IN_PROGRESS_MS) as { stale_count: number; oldest_updated_at: number | null };
  if (staleRow.stale_count > 0) {
    const oldestAge = staleRow.oldest_updated_at ? now - staleRow.oldest_updated_at : 0;
    const message = `${staleRow.stale_count} in_progress tasks stale without active claim`;
    const result = upsertOpenSloAlert({
      code: 'stale_in_progress',
      severity: 'critical',
      message,
      details: {
        stale_count: staleRow.stale_count,
        oldest_stale_age_ms: oldestAge,
        threshold_ms: SLO_STALE_IN_PROGRESS_MS,
      },
      now,
    });
    triggered += result.created ? 1 : 0;
    events.push({ code: 'stale_in_progress', state: result.created ? 'triggered' : 'updated', severity: result.alert.severity, message });
  } else {
    const changed = resolveOpenSloAlert('stale_in_progress', now);
    if (changed > 0) {
      resolved += changed;
      events.push({ code: 'stale_in_progress', state: 'resolved', severity: 'low', message: 'No stale in_progress tasks' });
    }
  }

  // SLO 3: excessive claim churn
  const claimCutoff = now - SLO_CLAIM_CHURN_WINDOW_MS;
  const churnRow = d.prepare(`
    SELECT COUNT(*) AS c
    FROM activity_log
    WHERE created_at >= ?
      AND action IN ('claim_task', 'renew_task_claim', 'release_task_claim', 'poll_and_claim')
  `).get(claimCutoff) as { c: number };
  if (churnRow.c >= SLO_CLAIM_CHURN_THRESHOLD) {
    const message = `Claim churn ${churnRow.c} exceeded threshold ${SLO_CLAIM_CHURN_THRESHOLD} in ${Math.floor(SLO_CLAIM_CHURN_WINDOW_MS / 1000)}s window`;
    const result = upsertOpenSloAlert({
      code: 'claim_churn',
      severity: 'medium',
      message,
      details: {
        claim_events: churnRow.c,
        threshold: SLO_CLAIM_CHURN_THRESHOLD,
        window_ms: SLO_CLAIM_CHURN_WINDOW_MS,
      },
      now,
    });
    triggered += result.created ? 1 : 0;
    events.push({ code: 'claim_churn', state: result.created ? 'triggered' : 'updated', severity: result.alert.severity, message });
  } else {
    const changed = resolveOpenSloAlert('claim_churn', now);
    if (changed > 0) {
      resolved += changed;
      events.push({ code: 'claim_churn', state: 'resolved', severity: 'low', message: 'Claim churn back within SLO' });
    }
  }

  return {
    evaluated_at: now,
    triggered,
    resolved,
    open_alerts: listSloAlerts({ open_only: true, limit: 100 }),
    events,
  };
}

export function cleanupResolvedSloAlerts(now = Date.now(), ttlMs = RESOLVED_SLO_TTL_MS): number {
  if (ttlMs <= 0) return 0;
  const cutoff = now - ttlMs;
  const result = getDb().prepare(`
    DELETE FROM slo_alerts
    WHERE resolved_at IS NOT NULL
      AND resolved_at < ?
  `).run(cutoff);
  return result.changes;
}

// --- Retention and Maintenance ---

export function markInactiveAgentsOffline(
  now = Date.now(),
  inactiveAfterMs = AGENT_OFFLINE_AFTER_MS,
  ephemeralInactiveAfterMs = EPHEMERAL_OFFLINE_AFTER_MS
): number {
  if (inactiveAfterMs <= 0 && ephemeralInactiveAfterMs <= 0) return 0;
  const persistentCutoff = now - (inactiveAfterMs <= 0 ? Number.MAX_SAFE_INTEGER : inactiveAfterMs);
  const ephemeralCutoff = now - (ephemeralInactiveAfterMs <= 0 ? Number.MAX_SAFE_INTEGER : Math.max(1_000, ephemeralInactiveAfterMs));
  const result = getDb()
    .prepare(`
      UPDATE agents
      SET status = 'offline'
      WHERE status != 'offline'
        AND (
          (lifecycle = 'ephemeral' AND last_seen < ?)
          OR (lifecycle != 'ephemeral' AND last_seen < ?)
        )
    `)
    .run(ephemeralCutoff, persistentCutoff);
  return result.changes;
}

export function cleanupStaleOfflineAgents(
  now = Date.now(),
  retentionMs = AGENT_RETENTION_MS,
  ephemeralRetentionMs = EPHEMERAL_AGENT_RETENTION_MS
): number {
  if (retentionMs <= 0 && ephemeralRetentionMs <= 0) return 0;
  const persistentCutoff = now - (retentionMs <= 0 ? Number.MAX_SAFE_INTEGER : retentionMs);
  const ephemeralCutoff = now - (ephemeralRetentionMs <= 0 ? Number.MAX_SAFE_INTEGER : Math.max(60_000, ephemeralRetentionMs));
  const d = getDb();

  const deletedRows = d.prepare(`
    SELECT id
    FROM agents
    WHERE status = 'offline'
      AND (
        (lifecycle = 'ephemeral' AND last_seen < ?)
        OR (lifecycle != 'ephemeral' AND last_seen < ?)
      )
  `).all(ephemeralCutoff, persistentCutoff) as Array<{ id: string }>;
  if (deletedRows.length === 0) return 0;

  const tx = d.transaction((ids: string[]) => {
    const clearClaims = d.prepare('DELETE FROM task_claims WHERE agent_id = ?');
    const releaseAssignedTasks = d.prepare(`
      UPDATE tasks
      SET status = CASE WHEN status = 'in_progress' THEN 'pending' ELSE status END,
          assigned_to = NULL,
          updated_at = ?
      WHERE assigned_to = ?
        AND status IN ('pending', 'in_progress')
    `);
    const deleteAgent = d.prepare('DELETE FROM agents WHERE id = ?');

    for (const id of ids) {
      clearClaims.run(id);
      releaseAssignedTasks.run(now, id);
      deleteAgent.run(id);
    }

    // Keep token table in sync when stale agents are purged.
    d.prepare(`
      DELETE FROM agent_tokens
      WHERE agent_id NOT IN (SELECT id FROM agents)
    `).run();
  });

  tx(deletedRows.map((row) => row.id));
  return deletedRows.length;
}

export function reapOfflineEphemeralClaims(now = Date.now(), reapAfterMs = EPHEMERAL_CLAIM_REAP_AFTER_MS): number {
  if (reapAfterMs <= 0) return 0;
  const cutoff = now - Math.max(1_000, reapAfterMs);
  const d = getDb();
  const rows = d.prepare(`
    SELECT tc.task_id AS task_id
    FROM task_claims tc
    JOIN agents a ON a.id = tc.agent_id
    WHERE a.lifecycle = 'ephemeral'
      AND a.status = 'offline'
      AND tc.updated_at < ?
  `).all(cutoff) as Array<{ task_id: number }>;

  if (rows.length === 0) return 0;
  const taskIds = [...new Set(rows.map((row) => row.task_id))];

  const tx = d.transaction((ids: number[]) => {
    const releaseTask = d.prepare(`
      UPDATE tasks
      SET status = 'pending', assigned_to = NULL, updated_at = ?
      WHERE id = ? AND status = 'in_progress'
    `);
    const deleteClaim = d.prepare('DELETE FROM task_claims WHERE task_id = ?');
    for (const taskId of ids) {
      releaseTask.run(now, taskId);
      deleteClaim.run(taskId);
    }
  });

  tx(taskIds);
  return taskIds.length;
}

export function requeueOrphanedAssignments(now = Date.now()): number {
  const result = getDb().prepare(`
    UPDATE tasks
    SET status = CASE WHEN status = 'in_progress' THEN 'pending' ELSE status END,
        assigned_to = NULL,
        updated_at = ?
    WHERE assigned_to IS NOT NULL
      AND status IN ('pending', 'in_progress')
      AND (
        assigned_to NOT IN (SELECT id FROM agents)
        OR assigned_to IN (
          SELECT id
          FROM agents
          WHERE lifecycle = 'ephemeral' AND status = 'offline'
        )
      )
  `).run(now);
  return result.changes;
}

export function cleanupMessages(now = Date.now(), ttlMs = MESSAGE_TTL_MS): number {
  if (ttlMs <= 0) return 0;
  const cutoff = now - ttlMs;
  const result = getDb().prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff);
  return result.changes;
}

export function cleanupActivityLog(now = Date.now(), ttlMs = ACTIVITY_LOG_TTL_MS): number {
  if (ttlMs <= 0) return 0;
  const cutoff = now - ttlMs;
  const result = getDb().prepare('DELETE FROM activity_log WHERE created_at < ?').run(cutoff);
  return result.changes;
}

export function cleanupProtocolBlobs(now = Date.now(), ttlMs = PROTOCOL_BLOB_TTL_MS): number {
  if (ttlMs <= 0) return 0;
  const cutoff = now - ttlMs;
  const result = getDb().prepare(`
    DELETE FROM protocol_blobs
    WHERE updated_at < ?
      AND NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m.content LIKE ('%"h":"' || protocol_blobs.hash || '"%')
      )
      AND NOT EXISTS (
        SELECT 1 FROM context c
        WHERE c.value LIKE ('%"h":"' || protocol_blobs.hash || '"%')
      )
  `).run(cutoff);
  return result.changes;
}

export function archiveDoneTasks(now = Date.now(), ttlMs = DONE_TASK_TTL_MS, limit = ARCHIVE_BATCH_LIMIT): number {
  if (ttlMs <= 0) return 0;
  const cutoff = now - ttlMs;
  const capped = Math.max(1, Math.min(1000, Math.floor(limit)));
  const d = getDb();
  const rows = d.prepare(`
    SELECT *
    FROM tasks t
    WHERE t.status = 'done'
      AND t.updated_at < ?
      AND NOT EXISTS (
        SELECT 1
        FROM task_dependencies td
        WHERE td.depends_on_task_id = t.id
      )
    ORDER BY t.updated_at ASC
    LIMIT ?
  `).all(cutoff, capped) as Task[];

  if (rows.length === 0) return 0;

  const tx = d.transaction((tasksToArchive: Task[]) => {
    const insert = d.prepare(`
      INSERT OR REPLACE INTO tasks_archive (
        id, title, description, namespace, execution_mode, consistency_mode, status, assigned_to, created_by, priority,
        trace_id, span_id,
        created_at, updated_at, archived_at, archive_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const del = d.prepare('DELETE FROM tasks WHERE id = ?');
    for (const task of tasksToArchive) {
      insert.run(
        task.id,
        task.title,
        task.description,
        task.namespace,
        task.execution_mode,
        task.consistency_mode,
        task.status,
        task.assigned_to,
        task.created_by,
        task.priority,
        task.trace_id,
        task.span_id,
        task.created_at,
        task.updated_at,
        now,
        'ttl_cleanup'
      );
      del.run(task.id);
    }
  });

  tx(rows);
  return rows.length;
}

export function deleteTask(taskId: number, options: { archive?: boolean; reason?: string } = {}): {
  success: true;
  archived: boolean;
} | {
  success: false;
  error_code: 'TASK_NOT_FOUND' | 'TASK_CLAIMED';
  error: string;
} {
  const d = getDb();
  const task = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
  if (!task) {
    return { success: false, error_code: 'TASK_NOT_FOUND', error: 'Task not found' };
  }
  const activeClaim = d.prepare('SELECT 1 FROM task_claims WHERE task_id = ?').get(taskId);
  if (activeClaim) {
    return { success: false, error_code: 'TASK_CLAIMED', error: 'Task has an active claim' };
  }

  const archive = options.archive !== false;
  const now = Date.now();
  const tx = d.transaction(() => {
    if (archive) {
      d.prepare(`
        INSERT OR REPLACE INTO tasks_archive (
          id, title, description, namespace, execution_mode, consistency_mode, status, assigned_to, created_by, priority,
          trace_id, span_id,
          created_at, updated_at, archived_at, archive_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.title,
        task.description,
        task.namespace,
        task.execution_mode,
        task.consistency_mode,
        task.status,
        task.assigned_to,
        task.created_by,
        task.priority,
        task.trace_id,
        task.span_id,
        task.created_at,
        task.updated_at,
        now,
        options.reason || 'manual_delete'
      );
    }
    d.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  });
  tx();
  return { success: true, archived: archive };
}

export function runMaintenance(now = Date.now()): {
  claims_cleaned: number;
  agents_marked_offline: number;
  ephemeral_claims_reaped: number;
  agents_deleted: number;
  orphaned_assignments_requeued: number;
  idempotency_cleaned: number;
  messages_cleaned: number;
  activity_log_cleaned: number;
  protocol_blobs_cleaned: number;
  artifacts_cleaned: number;
  tasks_archived: number;
  auth_events_cleaned: number;
  resolved_slo_cleaned: number;
  slo: {
    evaluated_at: number;
    triggered: number;
    resolved: number;
    open_alerts: number;
  };
} {
  const slo = evaluateSloAlerts(now);
  const artifacts = cleanupArtifacts(now);
  return {
    claims_cleaned: cleanupExpiredTaskClaims(now, { force: true }),
    agents_marked_offline: markInactiveAgentsOffline(now),
    ephemeral_claims_reaped: reapOfflineEphemeralClaims(now),
    agents_deleted: cleanupStaleOfflineAgents(now),
    orphaned_assignments_requeued: requeueOrphanedAssignments(now),
    idempotency_cleaned: cleanupIdempotencyKeys(now),
    messages_cleaned: cleanupMessages(now),
    activity_log_cleaned: cleanupActivityLog(now),
    protocol_blobs_cleaned: cleanupProtocolBlobs(now),
    artifacts_cleaned: artifacts.deleted,
    tasks_archived: archiveDoneTasks(now),
    auth_events_cleaned: cleanupAuthEvents(now),
    resolved_slo_cleaned: cleanupResolvedSloAlerts(now),
    slo: {
      evaluated_at: slo.evaluated_at,
      triggered: slo.triggered,
      resolved: slo.resolved,
      open_alerts: slo.open_alerts.length,
    },
  };
}

// --- Activity Log ---

export function logActivity(agentId: string, action: string, details: string = ''): ActivityLogEntry {
  const now = Date.now();
  const d = getDb();
  const result = d.prepare(`
    INSERT INTO activity_log (agent_id, action, details, created_at)
    VALUES (?, ?, ?, ?)
  `).run(agentId, action, details, now);
  return {
    id: result.lastInsertRowid as number,
    agent_id: agentId,
    action,
    details,
    created_at: now,
  };
}

export function getActivityLog(options: { agent_id?: string; limit?: number; offset?: number } = {}): ActivityLogEntry[] {
  const d = getDb();
  let query = 'SELECT * FROM activity_log WHERE 1=1';
  const params: unknown[] = [];

  if (options.agent_id) {
    query += ' AND agent_id = ?';
    params.push(options.agent_id);
  }
  query += ' ORDER BY created_at DESC';
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(Number(options.limit))) : 50;
  const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(Number(options.offset))) : 0;
  query += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return d.prepare(query).all(...params) as ActivityLogEntry[];
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined!;
    resetWatermarkCaches();
  }
}
