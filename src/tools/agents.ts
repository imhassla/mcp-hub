import { registerAgent, listAgents, heartbeat, logActivity, getAgentToken, updateAgentRuntimeProfile } from '../db.js';
import type { AgentLifecycle, AgentRuntimeProfile, AgentWorkspaceMode } from '../types.js';

type OnboardingMode = 'full' | 'compact' | 'none';
type AgentRole = 'orchestrator' | 'reviewer' | 'assistant' | 'worker';
type ClientResponseMode = 'full' | 'compact' | 'tiny' | 'nano';
type PushTransport = 'wait_for_updates' | 'sse_events' | 'websocket';

interface ClientCapabilities {
  response_modes: ClientResponseMode[];
  blob_resolve: boolean;
  artifact_tickets: boolean;
  snapshot_reads: boolean;
  push_transports: PushTransport[];
}

interface NegotiatedContract {
  snapshot_tool: 'read_snapshot' | 'manual_reads';
  preferred_read_mode: 'nano' | 'tiny' | 'compact';
  wait_for_updates_mode: 'nano' | 'micro';
  blob_handoff_mode: 'hash_ref' | 'inline_compact';
  push_transport: PushTransport;
}

const MAX_MESSAGE_CONTENT_CHARS = Number(process.env.MCP_HUB_MAX_MESSAGE_CONTENT_CHARS || 1024);
const MAX_CONTEXT_VALUE_CHARS = Number(process.env.MCP_HUB_MAX_CONTEXT_VALUE_CHARS || 2048);
const DONE_EVIDENCE_MIN_REFS = Number.isFinite(Number(process.env.MCP_HUB_DONE_EVIDENCE_MIN_REFS))
  ? Math.max(0, Math.floor(Number(process.env.MCP_HUB_DONE_EVIDENCE_MIN_REFS)))
  : 1;

function normalizeOnboardingMode(mode: string | undefined, fallback: OnboardingMode): OnboardingMode {
  if (mode === 'full' || mode === 'compact' || mode === 'none') return mode;
  return fallback;
}

const DEFAULT_ONBOARDING_MODE = normalizeOnboardingMode(process.env.MCP_HUB_DEFAULT_ONBOARDING_MODE, 'full');
const DEFAULT_EPHEMERAL_ONBOARDING_MODE = normalizeOnboardingMode(process.env.MCP_HUB_EPHEMERAL_DEFAULT_ONBOARDING_MODE, 'compact');
const DEFAULT_REREGISTER_ONBOARDING_MODE = normalizeOnboardingMode(process.env.MCP_HUB_REREGISTER_ONBOARDING_MODE, 'none');

function normalizeClientResponseModes(input: unknown): ClientResponseMode[] {
  if (!Array.isArray(input)) return [];
  const normalized = input
    .map((mode) => String(mode || '').trim().toLowerCase())
    .filter((mode) => mode === 'full' || mode === 'compact' || mode === 'tiny' || mode === 'nano') as ClientResponseMode[];
  return [...new Set(normalized)];
}

function normalizePushTransports(input: unknown): PushTransport[] {
  if (!Array.isArray(input)) return [];
  const normalized = input
    .map((value) => String(value || '').trim().toLowerCase())
    .map((value) => {
      if (value === 'ws') return 'websocket';
      if (value === 'sse') return 'sse_events';
      return value;
    })
    .filter((value) => value === 'wait_for_updates' || value === 'sse_events' || value === 'websocket') as PushTransport[];
  return [...new Set(normalized)];
}

function normalizeClientCapabilities(input?: {
  response_modes?: unknown;
  blob_resolve?: unknown;
  artifact_tickets?: unknown;
  snapshot_reads?: unknown;
  push_transports?: unknown;
}): ClientCapabilities {
  const responseModes = normalizeClientResponseModes(input?.response_modes);
  const pushTransports = normalizePushTransports(input?.push_transports);
  return {
    response_modes: responseModes.length > 0 ? responseModes : ['compact'],
    blob_resolve: input?.blob_resolve === true,
    artifact_tickets: input?.artifact_tickets === true,
    snapshot_reads: input?.snapshot_reads === true,
    push_transports: pushTransports.length > 0 ? pushTransports : ['wait_for_updates'],
  };
}

function buildServerCapabilities() {
  return {
    response_modes: ['full', 'compact', 'tiny', 'nano'] as ClientResponseMode[],
    blob_resolve: true,
    artifact_tickets: true,
    snapshot_reads: true,
    push_transports: ['wait_for_updates', 'sse_events'] as PushTransport[],
  };
}

function negotiateContract(client: ClientCapabilities): NegotiatedContract {
  const supportsNano = client.response_modes.includes('nano');
  const supportsTiny = client.response_modes.includes('tiny');
  const preferredReadMode: 'nano' | 'tiny' | 'compact' = supportsNano
    ? 'nano'
    : (supportsTiny ? 'tiny' : 'compact');
  const pushTransport: PushTransport = client.push_transports.includes('sse_events')
    ? 'sse_events'
    : (client.push_transports.includes('websocket') ? 'websocket' : 'wait_for_updates');
  return {
    snapshot_tool: client.snapshot_reads ? 'read_snapshot' : 'manual_reads',
    preferred_read_mode: preferredReadMode,
    wait_for_updates_mode: supportsNano ? 'nano' : 'micro',
    blob_handoff_mode: client.blob_resolve ? 'hash_ref' : 'inline_compact',
    push_transport: pushTransport,
  };
}

function buildOnboarding(mode: OnboardingMode = 'full') {
  const toolCatalog = {
    agents: [
      { name: 'register_agent', purpose: 'Register and receive protocol onboarding' },
      { name: 'update_runtime_profile', purpose: 'Update runtime profile (repo/isolated/unknown) after registration' },
      { name: 'list_agents', purpose: 'View online/offline agent roster' },
      { name: 'get_onboarding', purpose: 'Re-fetch protocol guide and capabilities' },
    ],
    messaging: [
      { name: 'send_message', purpose: 'Direct/broadcast messaging with compression and idempotency' },
      { name: 'send_blob_message', purpose: 'Store payload as blob and send compact hash-reference message (use compression_mode=lossless_auto for strict round-trip)' },
      { name: 'read_messages', purpose: 'Read inbox with full/compact/tiny/nano response modes' },
    ],
    tasks: [
      { name: 'create_task', purpose: 'Create tasks with optional dependencies and idempotency' },
      { name: 'update_task', purpose: 'Update task fields with done-gate confidence + evidence checks' },
      { name: 'list_tasks', purpose: 'List tasks with ready_only and compact/tiny/nano output' },
      { name: 'poll_and_claim', purpose: 'Claim next dependency-ready task with adaptive backoff' },
      { name: 'claim_task', purpose: 'Claim specific task with lease semantics' },
      { name: 'renew_task_claim', purpose: 'Renew task lease (stale-write guarded)' },
      { name: 'release_task_claim', purpose: 'Release lease and optionally mark done (confidence + evidence)' },
      { name: 'list_task_claims', purpose: 'Inspect active task leases' },
      { name: 'delete_task', purpose: 'Delete task safely (archives by default, denied when claimed)' },
      { name: 'attach_task_artifact', purpose: 'Attach artifact handoff to task and auto-share to assignee' },
      { name: 'list_task_artifacts', purpose: 'List task-bound artifacts with access/ready hints' },
      { name: 'get_task_handoff', purpose: 'Get consolidated task packet (deps + evidence refs + artifacts), optionally with download tickets' },
    ],
    context: [
      { name: 'share_context', purpose: 'Share key-value context with compression/idempotency options' },
      { name: 'share_blob_context', purpose: 'Store payload as blob and share compact hash-reference context value (lossless_auto supported)' },
      { name: 'get_context', purpose: 'Fetch context in full/compact/tiny/nano/summary modes' },
    ],
    consensus: [
      { name: 'resolve_consensus', purpose: 'Confidence-weighted consensus with inline/blob votes, tiny responses, and emit_blob_ref_policy' },
      { name: 'resolve_consensus_from_context', purpose: 'Resolve consensus directly from context source (no manual hash glue)' },
      { name: 'resolve_consensus_from_message', purpose: 'Resolve consensus directly from message source (no manual hash glue)' },
      { name: 'list_consensus_decisions', purpose: 'Inspect persisted consensus decisions (full/compact/tiny)' },
    ],
    compact_protocol: [
      { name: 'pack_protocol_message', purpose: 'Pack payload into compact CAEP-v1 packet with hash' },
      { name: 'unpack_protocol_message', purpose: 'Unpack CAEP-v1 packet and validate hash' },
      { name: 'hash_payload', purpose: 'Generate deterministic payload digest for references/dedup' },
      { name: 'store_protocol_blob', purpose: 'Store deduplicated payload blob by hash for reference exchange' },
      { name: 'get_protocol_blob', purpose: 'Resolve hash reference and fetch blob payload' },
      { name: 'list_protocol_blobs', purpose: 'Inspect recent protocol blobs and access counters' },
    ],
    artifacts: [
      { name: 'create_artifact_upload', purpose: 'Issue one-time upload ticket for binary artifact transfer without token-heavy MCP payloads' },
      { name: 'create_artifact_download', purpose: 'Issue one-time download ticket for shared artifact' },
      { name: 'create_task_artifact_downloads', purpose: 'Issue download tickets for task-attached artifacts in one call (supports limit)' },
      { name: 'list_artifacts', purpose: 'List artifacts visible to current agent with compact/tiny modes' },
      { name: 'share_artifact', purpose: 'Grant artifact access and optionally bind artifact to task (task_id) + notify via message' },
    ],
    observability: [
      { name: 'get_activity_log', purpose: 'Read coordination audit trail in full/compact/summary modes' },
      { name: 'get_kpi_snapshot', purpose: 'Read built-in KPI aggregates for 1m/5m/30m windows' },
      { name: 'get_transport_snapshot', purpose: 'Read lightweight wait/poll transport efficiency metrics over selectable window' },
      { name: 'wait_for_updates', purpose: 'Long-poll for updates to reduce busy polling loops' },
      { name: 'read_snapshot', purpose: 'Read tasks+messages+context in one cursorized call for polling loops' },
      { name: 'evaluate_slo_alerts', purpose: 'Evaluate pending-age / claim-churn / stale in-progress SLO rules' },
      { name: 'list_slo_alerts', purpose: 'Inspect open/resolved SLO alerts with pagination' },
      { name: 'get_auth_coverage', purpose: 'Inspect auth rollout coverage by window and tool' },
      { name: 'run_maintenance', purpose: 'Run housekeeping cleanup and retention tasks' },
    ],
  };

  const toolCount = Object.values(toolCatalog).reduce((sum, items) => sum + items.length, 0);

  const quickstart = [
    '1) initialize + notifications/initialized (MCP transport handshake)',
    '2) register_agent (prefer onboarding_mode=compact for recurring workers; include runtime_profile when available)',
    '3) Save auth.token and pass auth_token on all subsequent calls',
    '4) get_onboarding once and cache rules/tool names locally',
    '5) poll_and_claim or claim_task',
    '6) share_context + send_message',
    '7) release_task_claim (use confidence + verification + evidence_refs when done)',
  ];

  const protocolRules = {
    done_gate: {
      confidence_floor: 0.75,
      base_threshold: 0.9,
      required_fields_for_done: ['confidence', 'verification_passed', 'evidence_refs'],
      min_evidence_refs: DONE_EVIDENCE_MIN_REFS,
      verifier_rule: 'If confidence below required threshold, pass verified_by (independent agent)',
    },
    idempotency: {
      supported_tools: [
        'create_task', 'update_task', 'poll_and_claim', 'claim_task', 'renew_task_claim',
        'release_task_claim', 'send_message', 'send_blob_message', 'share_context', 'share_blob_context',
      ],
      recommendation: 'Use idempotency_key for all retryable mutating calls',
    },
    hash_blob_exchange: {
      recommendation: 'Prefer send_blob_message/share_blob_context with compression_mode=lossless_auto for strict no-loss hash-ref exchange',
    },
    namespace_isolation: {
      recommendation: 'Use create_task.namespace + poll_and_claim.namespace to isolate concurrent experiments/swarm rounds',
    },
    pagination: {
      recommendation: 'Use delta reads with cursor/since_ts + polling=true (or fallback limit+offset) to avoid repeated full scans',
      delta_tools: ['read_messages', 'list_tasks'],
    },
    event_driven: {
      recommendation: 'Use wait_for_updates(streams=["messages","tasks"], cursor=<prev_cursor>, response_mode=nano) before read_messages/list_tasks to cut empty-poll token usage; respect r (nano alias of retry_after_ms, adaptive by default)',
      server_defaults_env: {
        response_mode: 'MCP_HUB_WAIT_DEFAULT_RESPONSE_MODE',
        timeout_response: 'MCP_HUB_WAIT_DEFAULT_TIMEOUT_RESPONSE',
        log_hits: 'MCP_HUB_WAIT_LOG_HITS',
        log_timeouts: 'MCP_HUB_WAIT_LOG_TIMEOUTS',
      },
    },
    push_transport: {
      recommendation: 'For high-load swarms use SSE push channel GET /events?agent_id=...&auth_token=...&streams=messages,tasks&response_mode=nano to reduce long-poll churn.',
      endpoint: '/events',
      modes: ['compact', 'nano'],
    },
    batch_snapshot: {
      recommendation: 'Use read_snapshot in polling loops to fetch tasks+messages+context with one cursor and one transport round-trip.',
      cursor_shape: '<message>.<task>.<context>.<activity> (base36)',
    },
    capability_negotiation: {
      recommendation: 'Send register_agent.client_capabilities so server can negotiate preferred read mode, snapshot strategy, and push transport.',
      keys: ['response_modes', 'blob_resolve', 'artifact_tickets', 'snapshot_reads', 'push_transports'],
    },
    collective_accuracy: {
      recommendation: 'Use get_kpi_snapshot(response_mode=tiny for polling loops) to track reopen_rate_pct, done_with_evidence_rate_pct, consensus_escalation_pct, profile_mismatch_claims, artifact transfer activity, task-artifact handoff usage, and transport health (wait_hits/timeouts/retry_after) over 1m/5m/30m windows',
    },
    transport_monitoring: {
      recommendation: 'Use get_transport_snapshot(window_sec=300,response_mode=tiny) in tight monitor loops; switch to full mode for queue + latest_window detail',
    },
    retention: {
      recommendation: 'Automatic TTL cleanup runs in background; use run_maintenance for on-demand housekeeping',
      defaults: {
        agent_offline_after_ms: 30 * 60 * 1000,
        agent_retention_ms: 7 * 24 * 60 * 60 * 1000,
        message_ttl_ms: 24 * 60 * 60 * 1000,
        activity_log_ttl_ms: 24 * 60 * 60 * 1000,
        artifact_ttl_ms: 7 * 24 * 60 * 60 * 1000,
      },
    },
    dependency_scheduling: {
      recommendation: 'Use depends_on at task creation and ready_only in list/poll flows',
    },
    token_economy: {
      message_limit_chars: MAX_MESSAGE_CONTENT_CHARS,
      context_limit_chars: MAX_CONTEXT_VALUE_CHARS,
      recommendation: 'Use response_mode=nano|tiny with polling=true for polling/routing loops; full is forbidden in polling mode',
    },
    namespace_quotas: {
      recommendation: 'Use per-experiment namespaces and keep them explicit on task tools to enable fair-share quotas under load.',
      env: {
        mode: 'MCP_HUB_NAMESPACE_QUOTA_MODE=off|warn|enforce',
        rps: 'MCP_HUB_NAMESPACE_QUOTA_RPS',
        burst: 'MCP_HUB_NAMESPACE_QUOTA_BURST',
        token_budget_per_min: 'MCP_HUB_NAMESPACE_TOKEN_BUDGET_PER_MIN',
      },
    },
    compact_protocol: {
      name: 'CAEP-v1',
      recommendation: 'Use pack_protocol_message(mode=auto) for large payloads; dictionary packing activates only when adaptive lossless thresholds are met',
      auto_policy_env: {
        min_payload_chars: 'MCP_HUB_AUTO_PACK_MIN_PAYLOAD_CHARS',
        min_gain_pct: 'MCP_HUB_AUTO_PACK_MIN_GAIN_PCT',
      },
    },
    repo_isolated_execution: {
      recommendation: 'When workers have no repo access, exchange only structured proposals via blob/context and let orchestrator+reviewer apply code changes in-repo',
      proposal_schema: ['intent', 'evidence', 'patch_plan', 'verification_plan', 'risk_notes'],
      no_local_files_rule: 'Workers should avoid writing project files; use temporary in-memory or /tmp artifacts only.',
      consensus_flow: ['workers submit proposals', 'reviewer aggregates', 'resolve_consensus', 'orchestrator implements', 'reviewer verifies'],
      binary_transfer: 'Use create_artifact_upload/create_artifact_download/share_artifact for large file handoff without sending bytes via MCP JSON.',
      task_binding: 'Attach artifacts to tasks via attach_task_artifact; workers can fetch via get_task_handoff(include_downloads=true) or list_task_artifacts + create_artifact_download.',
    },
    consensus_handoff: {
      recommendation: 'For large rounds, prefer resolve_consensus_from_context/resolve_consensus_from_message or resolve_consensus with votes_blob_hash/votes_blob_ref + response_mode=tiny',
      vote_payload_shape: 'Either [ {agent_id,decision,confidence?} ] or { "votes": [...] }',
      dedupe_rule: 'dedupe_by_agent=true keeps latest vote per agent_id',
      decision_ref: 'Use emit_blob_ref_policy=never|always|on_escalate|on_conflict to control decision payload emission',
      quality_weighting: 'quality_weighting=on (default) applies bounded reliability weights from agent completion/rollback history',
    },
    auth: {
      recommendation: 'Each registered agent receives a token. Send auth_token on all calls to stay compatible with warn/enforce rollout.',
      mode_env: 'MCP_HUB_AUTH_MODE=observe|warn|enforce',
    },
    lifecycle: {
      recommendation: 'Use lifecycle=ephemeral for short-lived swarm workers to accelerate offline GC and stale-claim cleanup.',
      values: ['persistent', 'ephemeral'],
      env: {
        ephemeral_offline_after_ms: 'MCP_HUB_EPHEMERAL_OFFLINE_AFTER_MS',
        ephemeral_agent_retention_ms: 'MCP_HUB_EPHEMERAL_AGENT_RETENTION_MS',
        ephemeral_claim_reap_after_ms: 'MCP_HUB_EPHEMERAL_CLAIM_REAP_AFTER_MS',
      },
    },
    runtime_profile: {
      recommendation: 'Provide runtime_profile during register_agent (mode/cwd/has_git/file_count) so task routing can avoid repo-required tasks on isolated workers.',
      modes: ['repo', 'isolated', 'unknown'],
      create_task_execution_mode: 'Set create_task.execution_mode=repo|isolated|any to match worker runtime capabilities.',
    },
    adaptive_consistency: {
      recommendation: 'Use create_task.consistency_mode=auto|cheap|strict. Critical tasks auto-upgrade to strict; strict done-gate requires independent verifier + stronger evidence.',
      env: {
        default_mode: 'MCP_HUB_CONSISTENCY_DEFAULT=cheap|strict',
        strict_confidence_min: 'MCP_HUB_STRICT_DONE_CONFIDENCE_MIN',
        strict_evidence_min_refs: 'MCP_HUB_STRICT_DONE_EVIDENCE_MIN_REFS',
      },
    },
    role_launcher: {
      command: './hub --role orchestrator|reviewer|assistant --backend codex|claude',
      recommendation: 'Use role launcher to auto-detect runtime profile and bootstrap correct onboarding contract for each role.',
    },
    session_recovery: {
      error_code: -32000,
      server_flag_path: 'error.data.reinitialize_required',
      retryable_reasons: ['unknown_or_expired_session', 'server_not_initialized', 'no_active_session'],
      recovery_sequence: ['initialize', 'notifications/initialized', 'retry_original_request_once'],
      idempotency_rule: 'When retrying mutating calls after reinit, keep the same idempotency_key.',
    },
    bootstrap_contract: {
      startup_sequence: ['initialize', 'notifications/initialized', 'register_agent', 'get_onboarding'],
      token_source: 'register_agent -> auth.token',
      token_usage: 'attach auth_token to every tool call after register_agent',
    },
    namespace_governance: {
      recommendation: 'For swarm/experiment flows always set namespace on create_task/poll_and_claim/claim_task',
      mode_env: 'MCP_HUB_NAMESPACE_GOVERNANCE=off|warn|require',
    },
  };

  if (mode === 'none') {
    return {
      protocol_version: 'hub-protocol-2026.02',
      tool_count: toolCount,
      quickstart,
    };
  }

  if (mode === 'compact') {
    return {
      protocol_version: 'hub-protocol-2026.02',
      tool_count: toolCount,
      quickstart,
      rules: protocolRules,
      tool_names: Object.values(toolCatalog).flat().map((item) => item.name),
    };
  }

  return {
    protocol_version: 'hub-protocol-2026.02',
    tool_count: toolCount,
    quickstart,
    rules: protocolRules,
    tool_catalog: toolCatalog,
  };
}

function normalizeLifecycle(lifecycle?: string): AgentLifecycle {
  return lifecycle === 'ephemeral' ? 'ephemeral' : 'persistent';
}

function normalizeWorkspaceMode(mode?: string): AgentWorkspaceMode {
  if (mode === 'repo' || mode === 'isolated' || mode === 'unknown') return mode;
  return 'unknown';
}

function normalizeRole(role?: string): AgentRole {
  if (role === 'orchestrator' || role === 'reviewer' || role === 'assistant' || role === 'worker') return role;
  return 'worker';
}

function buildRoleGuidance(role: AgentRole) {
  if (role === 'orchestrator') {
    return {
      role,
      objective: 'Decompose and dispatch work with namespace-safe routing and measurable throughput.',
      primary_tools: ['create_task', 'list_tasks', 'poll_and_claim', 'send_message', 'get_kpi_snapshot', 'evaluate_slo_alerts'],
      playbook: [
        'Create tasks with namespace + execution_mode + depends_on',
        'Watch queue health via get_kpi_snapshot(response_mode=tiny)',
        'Use evaluate_slo_alerts/list_slo_alerts for stuck-task governance',
      ],
    };
  }
  if (role === 'reviewer') {
    return {
      role,
      objective: 'Converge agent outputs into correct, verifiable decisions with low token overhead.',
      primary_tools: ['get_task_handoff', 'resolve_consensus', 'resolve_consensus_from_context', 'resolve_consensus_from_message', 'send_message'],
      playbook: [
        'Fetch consolidated handoff via get_task_handoff',
        'Use resolve_consensus_from_context/message for large vote sets',
        'Escalate on conflict using emit_blob_ref_policy=on_conflict|on_escalate',
      ],
    };
  }
  if (role === 'assistant') {
    return {
      role,
      objective: 'Execute assigned tasks quickly and report structured progress.',
      primary_tools: ['poll_and_claim', 'get_task_handoff', 'share_context', 'send_message', 'release_task_claim'],
      playbook: [
        'Claim atomically with poll_and_claim',
        'Use tiny handoff/context reads in routing loops',
        'Release lease with evidence_refs + confidence when done',
      ],
    };
  }
  return {
    role: 'worker',
    objective: 'Complete scoped tasks with deterministic handoff output.',
    primary_tools: ['poll_and_claim', 'get_task_handoff', 'share_context', 'release_task_claim'],
    playbook: [
      'Prefer event-driven wait_for_updates before polling reads',
      'Use get_task_handoff(include_downloads=true) for isolated file intake',
      'Publish compact evidence refs before release_task_claim',
    ],
  };
}

function buildRuntimeGuidance(runtimeProfile: AgentRuntimeProfile) {
  if (runtimeProfile.mode === 'repo') {
    return {
      mode: 'repo',
      strategy: 'direct_repo_execution',
      recommendations: [
        'Claim tasks requiring execution_mode=repo or any',
        'Use get_task_handoff(response_mode=tiny) for fast dependency/evidence scan',
        'Switch to compact/full responses only when deeper payload is needed',
      ],
      suggested_calls: [
        { tool: 'poll_and_claim', args_template: { include_artifacts: true } },
        { tool: 'get_task_handoff', args_template: { response_mode: 'tiny' } },
      ],
      cautions: [],
    };
  }
  if (runtimeProfile.mode === 'isolated') {
    const cautions = [
      'Do not write project files; use context/messages/artifacts for handoff',
    ];
    if (runtimeProfile.empty_dir) cautions.push('empty_dir=true detected: request code/data through task artifacts or blob context only');
    return {
      mode: 'isolated',
      strategy: 'repo_isolated_handoff',
      recommendations: [
        'Use get_task_handoff(include_downloads=true) to fetch task + artifact links in one call',
        'Use share_blob_context/send_blob_message with compression_mode=lossless_auto for large structured payloads',
        'Prefer resolve_consensus_from_context/message to avoid manual hash glue',
      ],
      suggested_calls: [
        { tool: 'get_task_handoff', args_template: { response_mode: 'tiny', include_downloads: true } },
        { tool: 'create_task_artifact_downloads', args_template: { only_ready: true } },
      ],
      cautions,
    };
  }
  return {
    mode: 'unknown',
    strategy: 'runtime_discovery',
    recommendations: [
      'Provide update_runtime_profile as soon as runtime capabilities are known',
      'Claim only execution_mode=any tasks until runtime is declared',
    ],
    suggested_calls: [
      { tool: 'update_runtime_profile', args_template: { runtime_profile: { mode: 'repo|isolated|unknown' } } },
    ],
    cautions: ['Unknown runtime may reduce routing accuracy for execution_mode-specific tasks'],
  };
}

function parseRuntimeProfileJson(raw: string | undefined): AgentRuntimeProfile {
  if (!raw) return { mode: 'unknown', source: 'server_inferred' };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      mode: normalizeWorkspaceMode(typeof parsed.mode === 'string' ? parsed.mode : undefined),
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
      has_git: typeof parsed.has_git === 'boolean' ? parsed.has_git : undefined,
      file_count: Number.isFinite(parsed.file_count) ? Number(parsed.file_count) : undefined,
      empty_dir: typeof parsed.empty_dir === 'boolean' ? parsed.empty_dir : undefined,
      source: typeof parsed.source === 'string' ? parsed.source as AgentRuntimeProfile['source'] : 'server_inferred',
      detected_at: Number.isFinite(parsed.detected_at) ? Number(parsed.detected_at) : undefined,
      notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
    };
  } catch {
    return { mode: 'unknown', source: 'server_inferred' };
  }
}

export function handleRegisterAgent(args: {
  id: string;
  name: string;
  type: string;
  capabilities?: string;
  client_capabilities?: {
    response_modes?: unknown;
    blob_resolve?: unknown;
    artifact_tickets?: unknown;
    snapshot_reads?: unknown;
    push_transports?: unknown;
  };
  onboarding_mode?: OnboardingMode;
  lifecycle?: AgentLifecycle;
  runtime_profile?: AgentRuntimeProfile;
  role?: AgentRole;
}) {
  const lifecycle = normalizeLifecycle(args.lifecycle);
  const role = normalizeRole(args.role);
  const registrationResult = registerAgent({
    id: args.id,
    name: args.name,
    type: args.type,
    capabilities: args.capabilities || '',
    lifecycle,
    runtime_profile: args.runtime_profile,
  });
  const agent = registrationResult.agent;
  const inferredOnboardingMode: OnboardingMode = registrationResult.is_new
    ? (lifecycle === 'ephemeral' ? DEFAULT_EPHEMERAL_ONBOARDING_MODE : DEFAULT_ONBOARDING_MODE)
    : DEFAULT_REREGISTER_ONBOARDING_MODE;
  const onboardingMode = args.onboarding_mode || inferredOnboardingMode;
  const runtimeProfile = parseRuntimeProfileJson(agent.runtime_profile_json);
  const clientCapabilities = normalizeClientCapabilities(args.client_capabilities);
  const serverCapabilities = buildServerCapabilities();
  const negotiated = negotiateContract(clientCapabilities);
  const runtimeHint = runtimeProfile.mode === 'isolated'
    ? 'isolated_runtime_detected: worker has no repo context; use artifact/context handoff tools'
    : runtimeProfile.mode === 'unknown'
      ? 'runtime_mode_unknown: provide runtime_profile for better task routing'
      : null;
  logActivity(
    args.id,
    'register_agent',
    `Agent "${args.name}" registered as ${args.type} role=${role} lifecycle=${lifecycle} runtime_mode=${runtimeProfile.mode} is_new=${registrationResult.is_new ? 1 : 0} onboarding_mode=${onboardingMode}`
  );
  const onboarding = buildOnboarding(onboardingMode);
  const auth = getAgentToken(args.id);
  const roleGuidance = buildRoleGuidance(role);
  const runtimeGuidance = buildRuntimeGuidance(runtimeProfile);
  return {
    success: true,
    agent,
    runtime_profile: runtimeProfile,
    role_guidance: roleGuidance,
    runtime_guidance: runtimeGuidance,
    onboarding,
    capability_negotiation: {
      client: clientCapabilities,
      server: serverCapabilities,
      negotiated,
    },
    auth: auth ? {
      token: auth.token,
      note: 'Keep token private. It is used by MCP_HUB_AUTH_MODE=warn|enforce.',
    } : null,
    client_runtime: {
      session_recovery: {
        error_code: -32000,
        reinitialize_required_path: 'error.data.reinitialize_required',
        recovery_sequence: ['initialize', 'notifications/initialized', 'retry_original_request_once'],
      },
      bootstrap_sequence: ['initialize', 'notifications/initialized', 'register_agent', 'get_onboarding'],
    },
    registration: {
      role,
      lifecycle,
      onboarding_mode: onboardingMode,
      is_new: registrationResult.is_new,
      contract_profile: negotiated,
    },
    warnings: runtimeHint ? [runtimeHint] : [],
  };
}

export function handleGetOnboarding(args: {
  agent_id: string;
  mode?: OnboardingMode;
  role?: AgentRole;
  runtime_mode?: AgentWorkspaceMode;
  empty_dir?: boolean;
}) {
  heartbeat(args.agent_id);
  const role = normalizeRole(args.role);
  const runtimeProfile: AgentRuntimeProfile = {
    mode: normalizeWorkspaceMode(args.runtime_mode),
    empty_dir: typeof args.empty_dir === 'boolean' ? args.empty_dir : undefined,
    source: 'client_declared',
  };
  logActivity(args.agent_id, 'get_onboarding', `Requested onboarding mode=${args.mode || 'full'} role=${role} runtime_mode=${runtimeProfile.mode}`);
  return {
    success: true,
    onboarding: buildOnboarding(args.mode || 'full'),
    role_guidance: buildRoleGuidance(role),
    runtime_guidance: buildRuntimeGuidance(runtimeProfile),
  };
}

export function handleUpdateRuntimeProfile(args: {
  agent_id: string;
  runtime_profile: AgentRuntimeProfile;
}) {
  heartbeat(args.agent_id);
  const updated = updateAgentRuntimeProfile(args.agent_id, args.runtime_profile);
  if (!updated) {
    return {
      success: false,
      error_code: 'AGENT_NOT_FOUND',
      error: 'Agent not found. Register first.',
    };
  }
  const runtimeProfile = parseRuntimeProfileJson(updated.runtime_profile_json);
  logActivity(args.agent_id, 'update_runtime_profile', `runtime_mode=${runtimeProfile.mode}`);
  return {
    success: true,
    agent: updated,
    runtime_profile: runtimeProfile,
    runtime_guidance: buildRuntimeGuidance(runtimeProfile),
  };
}

export function handleListAgents(args: {
  agent_id?: string;
  limit?: number;
  offset?: number;
  response_mode?: 'full' | 'compact' | 'summary';
}) {
  if (args.agent_id) heartbeat(args.agent_id);
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.floor(Number(args.limit))) : 100;
  const offset = Number.isFinite(args.offset) ? Math.max(0, Math.floor(Number(args.offset))) : 0;
  const agents = listAgents({ limit, offset });
  logActivity(args.agent_id || 'system', 'list_agents', `Listed ${agents.length} agents (offset=${offset}, limit=${limit})`);
  if (args.response_mode === 'summary') {
    const now = Date.now();
    const onlineCutoff = now - (5 * 60 * 1000);
    return {
      agents: [],
      summary: {
        total: agents.length,
        online: agents.filter((agent) => agent.status === 'online').length,
        offline: agents.filter((agent) => agent.status !== 'online').length,
        online_5m: agents.filter((agent) => agent.last_seen >= onlineCutoff).length,
        persistent: agents.filter((agent) => agent.lifecycle === 'persistent').length,
        ephemeral: agents.filter((agent) => agent.lifecycle === 'ephemeral').length,
        runtime_repo: agents.filter((agent) => agent.runtime_mode === 'repo').length,
        runtime_isolated: agents.filter((agent) => agent.runtime_mode === 'isolated').length,
        runtime_unknown: agents.filter((agent) => agent.runtime_mode === 'unknown').length,
      },
    };
  }
  if (args.response_mode === 'compact') {
    return {
      agents: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        type: agent.type,
        lifecycle: agent.lifecycle,
        runtime_mode: agent.runtime_mode,
        status: agent.status,
        last_seen: agent.last_seen,
      })),
    };
  }
  return { agents };
}

export const agentTools = {
  register_agent: {
    description: 'Register an agent with the hub. Call this first before using other tools.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Unique agent identifier' },
        name: { type: 'string', description: 'Human-readable agent name' },
        type: { type: 'string', description: 'Agent type (e.g. claude, codex, custom)' },
        capabilities: { type: 'string', description: 'Comma-separated list of capabilities' },
        client_capabilities: {
          type: 'object',
          description: 'Client feature declaration for capability negotiation',
          properties: {
            response_modes: {
              type: 'array',
              items: { type: 'string', enum: ['full', 'compact', 'tiny', 'nano'] },
              description: 'Response modes client can parse',
            },
            blob_resolve: { type: 'boolean', description: 'Client supports blob-ref resolve flow' },
            artifact_tickets: { type: 'boolean', description: 'Client supports artifact upload/download tickets' },
            snapshot_reads: { type: 'boolean', description: 'Client supports read_snapshot batch tool' },
            push_transports: {
              type: 'array',
              items: { type: 'string', enum: ['wait_for_updates', 'sse_events', 'websocket'] },
              description: 'Push/event transport options supported by the client',
            },
          },
        },
        onboarding_mode: { type: 'string', enum: ['full', 'compact', 'none'], description: 'Optional onboarding detail override. Server default: new persistent=full, new ephemeral=compact, re-register=none (all configurable via env).' },
        role: { type: 'string', enum: ['orchestrator', 'reviewer', 'assistant', 'worker'], description: 'Coordination role for tailored onboarding guidance (default worker)' },
        lifecycle: { type: 'string', enum: ['persistent', 'ephemeral'], description: 'Agent lifecycle class (default persistent; ephemeral recommended for short-lived swarm workers)' },
        runtime_profile: {
          type: 'object',
          description: 'Optional runtime profile (auto-detected by launcher) to improve task routing',
          properties: {
            mode: { type: 'string', enum: ['repo', 'isolated', 'unknown'] },
            cwd: { type: 'string' },
            has_git: { type: 'boolean' },
            file_count: { type: 'number' },
            empty_dir: { type: 'boolean' },
            source: { type: 'string', enum: ['client_auto', 'client_declared', 'server_inferred'] },
            detected_at: { type: 'number' },
            notes: { type: 'string' },
          },
        },
      },
      required: ['id', 'name', 'type'],
    },
    handler: handleRegisterAgent,
  },
  update_runtime_profile: {
    description: 'Update runtime profile for existing agent (repo/isolated/unknown) to improve task routing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        runtime_profile: {
          type: 'object',
          description: 'Current runtime profile',
          properties: {
            mode: { type: 'string', enum: ['repo', 'isolated', 'unknown'] },
            cwd: { type: 'string' },
            has_git: { type: 'boolean' },
            file_count: { type: 'number' },
            empty_dir: { type: 'boolean' },
            source: { type: 'string', enum: ['client_auto', 'client_declared', 'server_inferred'] },
            detected_at: { type: 'number' },
            notes: { type: 'string' },
          },
        },
      },
      required: ['agent_id', 'runtime_profile'],
    },
    handler: handleUpdateRuntimeProfile,
  },
  list_agents: {
    description: 'List all registered agents and their status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID (for heartbeat)' },
        limit: { type: 'number', description: 'Max rows to return (default 100)' },
        offset: { type: 'number', description: 'Row offset for pagination (default 0)' },
        response_mode: { type: 'string', enum: ['full', 'compact', 'summary'], description: 'compact trims agent fields; summary returns counts only' },
      },
    },
    handler: handleListAgents,
  },
  get_onboarding: {
    description: 'Get protocol onboarding and feature guide after registration.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        mode: { type: 'string', enum: ['full', 'compact', 'none'], description: 'Onboarding detail level (default full)' },
        role: { type: 'string', enum: ['orchestrator', 'reviewer', 'assistant', 'worker'], description: 'Optional role for tailored guidance (default worker)' },
        runtime_mode: { type: 'string', enum: ['repo', 'isolated', 'unknown'], description: 'Optional runtime mode for tailored guidance' },
        empty_dir: { type: 'boolean', description: 'Optional workspace-empty flag for isolated/runtime guidance' },
      },
      required: ['agent_id'],
    },
    handler: handleGetOnboarding,
  },
};
