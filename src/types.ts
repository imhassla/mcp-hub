export type AgentLifecycle = 'persistent' | 'ephemeral';
export type AgentWorkspaceMode = 'repo' | 'isolated' | 'unknown';
export type TaskExecutionMode = 'any' | 'repo' | 'isolated';
export type TaskConsistencyMode = 'cheap' | 'strict';

export interface AgentRuntimeProfile {
  mode: AgentWorkspaceMode;
  cwd?: string;
  has_git?: boolean;
  file_count?: number;
  empty_dir?: boolean;
  source?: 'client_auto' | 'client_declared' | 'server_inferred';
  detected_at?: number;
  notes?: string;
}

export interface Agent {
  id: string;
  name: string;
  type: string;
  capabilities: string;
  lifecycle: AgentLifecycle;
  runtime_mode: AgentWorkspaceMode;
  runtime_profile_json: string;
  status: string;
  last_seen: number;
}

export interface Message {
  id: number;
  from_agent: string;
  to_agent: string | null;
  content: string;
  metadata: string;
  trace_id: string | null;
  span_id: string | null;
  created_at: number;
  read: number;
}

export interface MessageRead {
  message_id: number;
  agent_id: string;
  read_at: number;
}

export interface Task {
  id: number;
  title: string;
  description: string;
  namespace: string;
  execution_mode: TaskExecutionMode;
  consistency_mode: TaskConsistencyMode;
  status: string;
  assigned_to: string | null;
  created_by: string;
  priority: string;
  trace_id: string | null;
  span_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface TaskWithDependencies extends Task {
  depends_on: number[];
}

export interface TaskArtifact {
  task_id: number;
  artifact_id: string;
  added_by: string;
  created_at: number;
}

export interface TaskArtifactWithMeta extends TaskArtifact {
  artifact_name: string;
  artifact_mime_type: string;
  artifact_size_bytes: number;
  artifact_sha256: string | null;
  artifact_namespace: string;
  artifact_updated_at: number;
}

export interface TaskClaim {
  task_id: number;
  agent_id: string;
  claim_id: string;
  claimed_at: number;
  lease_expires_at: number;
  updated_at: number;
}

export interface TaskClaimWithTask extends TaskClaim {
  task_title: string;
  task_status: string;
  task_priority: string;
}

export interface Context {
  id: number;
  agent_id: string;
  key: string;
  value: string;
  namespace: string;
  trace_id: string | null;
  span_id: string | null;
  updated_at: number;
}

export interface ActivityLogEntry {
  id: number;
  agent_id: string;
  action: string;
  details: string;
  created_at: number;
}

export interface AgentQuality {
  agent_id: string;
  completed_count: number;
  rollback_count: number;
  last_updated: number;
}

export interface IdempotencyRecord {
  agent_id: string;
  tool_name: string;
  idempotency_key: string;
  response_json: string;
  created_at: number;
}

export interface ProtocolBlob {
  hash: string;
  value: string;
  created_at: number;
  updated_at: number;
  access_count: number;
}

export interface ConsensusDecision {
  id: number;
  proposal_id: string;
  requesting_agent: string;
  outcome: string;
  stats_json: string;
  reasons_json: string;
  created_at: number;
}

export interface AgentToken {
  agent_id: string;
  token: string;
  created_at: number;
  last_used_at: number;
}

export interface Artifact {
  id: string;
  created_by: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string | null;
  storage_path: string | null;
  namespace: string;
  summary: string;
  created_at: number;
  updated_at: number;
  access_count: number;
  ttl_expires_at: number | null;
}

export interface KpiWindowSnapshot {
  window_ms: number;
  activity_events: number;
  messages_created: number;
  tasks_updated: number;
  done_tasks_updated: number;
  polling_calls: number;
  avg_message_chars: number;
  profile_mismatch_claims: number;
  artifact_uploads: number;
  artifact_downloads: number;
  artifact_shares: number;
  task_artifact_attaches: number;
  task_artifact_queries: number;
  claim_with_artifact_hints: number;
  wait_calls: number;
  wait_hits: number;
  wait_timeouts: number;
  wait_hit_rate_pct: number;
  wait_retry_after_avg_ms: number | null;
  wait_retry_after_p95_ms: number | null;
  status_transitions: number;
  done_transitions: number;
  reopen_transitions: number;
  reopen_rate_pct: number;
  done_with_evidence: number;
  done_with_evidence_rate_pct: number;
  consensus_decisions: number;
  consensus_escalations: number;
  consensus_escalation_pct: number;
  consensus_estimated_tokens_total: number;
  consensus_estimated_tokens_per_decision: number | null;
  consensus_estimated_tokens_per_finalized_decision: number | null;
}

export interface SloAlert {
  id: number;
  code: string;
  severity: string;
  message: string;
  details_json: string;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

export interface AuthCoverageSnapshot {
  window_ms: number;
  from_ts: number;
  to_ts: number;
  total_events: number;
  valid_events: number;
  missing_events: number;
  invalid_events: number;
  skipped_events: number;
  valid_coverage_pct: number;
}
