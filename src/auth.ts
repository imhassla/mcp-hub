import { timingSafeEqual } from 'crypto';

export type RegisterTokenValidation =
  | { ok: true; status: 'disabled' | 'valid' }
  | { ok: false; status: 'missing' | 'invalid'; error_code: 'REGISTER_TOKEN_REQUIRED' | 'REGISTER_TOKEN_INVALID'; error: string };

export type AuthMode = 'observe' | 'warn' | 'enforce';
export type OriginMode = 'warn' | 'enforce';

export function resolveAuthMode(value: unknown, requireAuth = false): AuthMode {
  const configured = String(value || '').toLowerCase().trim();
  if (!configured) return requireAuth ? 'enforce' : 'observe';
  if (configured === 'observe' || configured === 'warn' || configured === 'enforce') return configured;
  throw new Error(`Invalid MCP_HUB_AUTH_MODE "${configured}". Expected observe, warn, or enforce.`);
}

export function resolveOriginMode(value: unknown): OriginMode {
  const configured = String(value || 'warn').toLowerCase().trim();
  if (configured === 'warn' || configured === 'enforce') return configured;
  throw new Error(`Invalid MCP_HUB_ORIGIN_MODE "${configured}". Expected warn or enforce.`);
}

type AuthSubjectKey = 'id' | 'agent_id' | 'from_agent' | 'created_by' | 'requesting_agent';

const TOOL_AUTH_SUBJECT_KEYS: Readonly<Record<string, AuthSubjectKey>> = {
  register_agent: 'id',
  update_runtime_profile: 'agent_id',
  list_agents: 'agent_id',
  suggest_agents: 'requesting_agent',
  get_onboarding: 'agent_id',
  send_message: 'from_agent',
  send_blob_message: 'from_agent',
  read_messages: 'agent_id',
  start_thread: 'from_agent',
  reply_thread: 'from_agent',
  read_thread: 'agent_id',
  search_hub: 'agent_id',
  fetch_hub_refs: 'agent_id',
  save_filter: 'agent_id',
  list_filters: 'agent_id',
  read_filter_feed: 'agent_id',
  delete_filter: 'agent_id',
  read_signal_feed: 'agent_id',
  ack_feed_items: 'agent_id',
  get_hub_digest: 'agent_id',
  write_memory: 'agent_id',
  search_memory: 'agent_id',
  get_memory_digest: 'agent_id',
  get_trace_timeline: 'agent_id',
  create_task: 'created_by',
  update_task: 'agent_id',
  list_tasks: 'agent_id',
  suggest_task_agents: 'requesting_agent',
  poll_and_claim: 'agent_id',
  claim_task: 'agent_id',
  renew_task_claim: 'agent_id',
  release_task_claim: 'agent_id',
  list_task_claims: 'requesting_agent',
  delete_task: 'agent_id',
  attach_task_artifact: 'agent_id',
  list_task_artifacts: 'agent_id',
  get_task_handoff: 'agent_id',
  share_context: 'agent_id',
  share_blob_context: 'agent_id',
  get_context: 'requesting_agent',
  resolve_consensus: 'requesting_agent',
  resolve_consensus_from_context: 'requesting_agent',
  resolve_consensus_from_message: 'requesting_agent',
  list_consensus_decisions: 'requesting_agent',
  pack_protocol_message: 'agent_id',
  unpack_protocol_message: 'agent_id',
  hash_payload: 'agent_id',
  store_protocol_blob: 'agent_id',
  get_protocol_blob: 'agent_id',
  list_protocol_blobs: 'agent_id',
  create_artifact_upload: 'agent_id',
  create_artifact_download: 'agent_id',
  create_task_artifact_downloads: 'agent_id',
  share_artifact: 'from_agent',
  list_artifacts: 'agent_id',
  get_activity_log: 'requesting_agent',
  get_kpi_snapshot: 'requesting_agent',
  get_transport_snapshot: 'requesting_agent',
  wait_for_updates: 'requesting_agent',
  read_snapshot: 'requesting_agent',
  read_event_deltas: 'requesting_agent',
  evaluate_slo_alerts: 'requesting_agent',
  list_slo_alerts: 'requesting_agent',
  get_auth_coverage: 'requesting_agent',
  run_maintenance: 'requesting_agent',
};

// These are explicit compatibility fallbacks for tools whose legacy API used agent_id as both
// caller and target. The ordered policy still prevents a target/filter from overriding a supplied
// requesting_agent.
const TOOL_AUTH_SUBJECT_FALLBACK_KEYS: Readonly<Partial<Record<string, readonly AuthSubjectKey[]>>> = {
  get_context: ['agent_id'],
  list_task_claims: ['agent_id'],
  get_activity_log: ['agent_id'],
  wait_for_updates: ['agent_id'],
  read_snapshot: ['agent_id'],
  read_event_deltas: ['agent_id'],
};

export function extractAgentAuthPayload(
  toolName: string,
  args: Record<string, unknown>,
): { agentId: string | null; authToken: string | null; subjectKey: AuthSubjectKey | null } {
  const primarySubjectKey = TOOL_AUTH_SUBJECT_KEYS[toolName] || null;
  const subjectKeys = primarySubjectKey
    ? [primarySubjectKey, ...(TOOL_AUTH_SUBJECT_FALLBACK_KEYS[toolName] || [])]
    : [];
  let subjectKey = primarySubjectKey;
  let agentId: string | null = null;
  for (const candidateKey of subjectKeys) {
    const candidate = args[candidateKey];
    if (typeof candidate !== 'string' || candidate.trim().length === 0) continue;
    subjectKey = candidateKey;
    agentId = candidate.trim();
    break;
  }
  const tokenValue = args.auth_token;
  const authToken = typeof tokenValue === 'string' && tokenValue.trim().length > 0
    ? tokenValue.trim()
    : null;
  return { agentId, authToken, subjectKey };
}

export function extractRegisterToken(args: Record<string, unknown>): string | null {
  const value = args.register_token ?? args.registration_token;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function safeTokenEquals(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

export function validateRegisterToken(configuredToken: string, args: Record<string, unknown>): RegisterTokenValidation {
  const expected = String(configuredToken || '').trim();
  if (!expected) return { ok: true, status: 'disabled' };

  const provided = extractRegisterToken(args);
  if (!provided) {
    return {
      ok: false,
      status: 'missing',
      error_code: 'REGISTER_TOKEN_REQUIRED',
      error: 'register_token is required when MCP_HUB_REGISTER_TOKEN is configured',
    };
  }

  if (!safeTokenEquals(expected, provided)) {
    return {
      ok: false,
      status: 'invalid',
      error_code: 'REGISTER_TOKEN_INVALID',
      error: 'register_token is invalid',
    };
  }

  return { ok: true, status: 'valid' };
}
