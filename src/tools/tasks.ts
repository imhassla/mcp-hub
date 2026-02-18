import {
  createTask,
  updateTask,
  getTaskById,
  getTaskDependencies,
  getTaskWithDependencies,
  listTasks,
  pollAndClaim,
  claimTask,
  renewTaskClaim,
  releaseTaskClaim,
  listTaskClaims,
  deleteTask,
  addTaskEvidence,
  listTaskEvidence,
  recordTaskStatusTransition,
  getAgentQuality,
  recordTaskCompletion,
  recordTaskRollback,
  countActiveAgents,
  getAgentRuntimeProfile,
  getArtifactById,
  hasArtifactAccess,
  attachTaskArtifact,
  listTaskArtifacts,
  grantArtifactAccess,
  heartbeat,
  logActivity,
} from '../db.js';
import { withIdempotency } from '../utils.js';
import { buildTaskArtifactDownloads } from './artifacts.js';

const pollMissStreak = new Map<string, number>();
const DONE_CONFIDENCE_BASE = 0.9;
const DONE_CONFIDENCE_FLOOR = 0.75;
const DONE_CONFIDENCE_MAX_PENALTY = 0.07;
const DONE_EVIDENCE_MIN_REFS = Number.isFinite(Number(process.env.MCP_HUB_DONE_EVIDENCE_MIN_REFS))
  ? Math.max(0, Math.floor(Number(process.env.MCP_HUB_DONE_EVIDENCE_MIN_REFS)))
  : 1;
const MAX_EVIDENCE_REFS_PER_CALL = Number.isFinite(Number(process.env.MCP_HUB_MAX_EVIDENCE_REFS_PER_CALL))
  ? Math.max(1, Math.floor(Number(process.env.MCP_HUB_MAX_EVIDENCE_REFS_PER_CALL)))
  : 16;
const MAX_EVIDENCE_REF_CHARS = Number.isFinite(Number(process.env.MCP_HUB_MAX_EVIDENCE_REF_CHARS))
  ? Math.max(8, Math.floor(Number(process.env.MCP_HUB_MAX_EVIDENCE_REF_CHARS)))
  : 256;
const DEFAULT_TASK_LIST_LIMIT = 100;
const MAX_TASK_LIST_LIMIT = 500;
const DISALLOW_FULL_IN_POLLING = process.env.MCP_HUB_DISALLOW_FULL_IN_POLLING !== '0';
const NAMESPACE_GOVERNANCE = (process.env.MCP_HUB_NAMESPACE_GOVERNANCE || 'warn').toLowerCase(); // off | warn | require
const CONSISTENCY_DEFAULT = String(process.env.MCP_HUB_CONSISTENCY_DEFAULT || 'cheap').toLowerCase() === 'strict'
  ? 'strict'
  : 'cheap';
const STRICT_DONE_CONFIDENCE_MIN = Number.isFinite(Number(process.env.MCP_HUB_STRICT_DONE_CONFIDENCE_MIN))
  ? Math.max(DONE_CONFIDENCE_FLOOR, Math.min(1, Number(process.env.MCP_HUB_STRICT_DONE_CONFIDENCE_MIN)))
  : 0.95;
const STRICT_DONE_EVIDENCE_MIN_REFS = Number.isFinite(Number(process.env.MCP_HUB_STRICT_DONE_EVIDENCE_MIN_REFS))
  ? Math.max(DONE_EVIDENCE_MIN_REFS, Math.floor(Number(process.env.MCP_HUB_STRICT_DONE_EVIDENCE_MIN_REFS)))
  : Math.max(2, DONE_EVIDENCE_MIN_REFS);

interface TaskCursor {
  ts: number;
  id: number;
}
type TaskConsistencyMode = 'cheap' | 'strict';

function parseTaskCursor(cursor?: string): TaskCursor | null {
  if (!cursor || typeof cursor !== 'string') return null;
  const [tsRaw, idRaw] = cursor.split(':');
  const ts = Number(tsRaw);
  const id = Number(idRaw);
  if (!Number.isFinite(ts) || !Number.isFinite(id) || ts <= 0 || id <= 0) return null;
  return { ts: Math.floor(ts), id: Math.floor(id) };
}

function formatTaskCursor(task: { updated_at: number; id: number }): string {
  return `${task.updated_at}:${task.id}`;
}

function looksLikeSwarmOrExperiment(inputs: Array<string | undefined>): boolean {
  const pattern = /(swarm|experiment|exp-|exp\d|round|orchestrator|worker)/i;
  return inputs.some((input) => Boolean(input && pattern.test(input)));
}

function evaluateNamespaceGovernance(args: {
  action: string;
  namespace?: string;
  hints: Array<string | undefined>;
}): { ok: true; warning?: string } | { ok: false; error_code: 'NAMESPACE_REQUIRED'; error: string } {
  if (NAMESPACE_GOVERNANCE === 'off') return { ok: true };
  const hasNamespace = Boolean((args.namespace || '').trim());
  if (hasNamespace || !looksLikeSwarmOrExperiment(args.hints)) {
    return { ok: true };
  }
  const message = `Namespace is required for ${args.action} in swarm/experiment flows`;
  if (NAMESPACE_GOVERNANCE === 'require') {
    return { ok: false, error_code: 'NAMESPACE_REQUIRED', error: message };
  }
  return { ok: true, warning: message };
}

function getRequiredDoneConfidence(agentId: string): number {
  const quality = getAgentQuality(agentId);
  if (quality.completed_count <= 0) return DONE_CONFIDENCE_BASE;
  const rollbackRate = quality.rollback_count / quality.completed_count;
  const penalty = Math.min(DONE_CONFIDENCE_MAX_PENALTY, rollbackRate * 0.25);
  return Math.round((DONE_CONFIDENCE_BASE + penalty) * 1000) / 1000;
}

function normalizeTaskConsistencyMode(mode?: string): TaskConsistencyMode {
  return mode === 'strict' ? 'strict' : 'cheap';
}

function resolveTaskConsistencyMode(args: {
  requested?: string;
  existing?: string;
  priority?: string;
}): TaskConsistencyMode {
  if (args.requested === 'strict' || args.requested === 'cheap') {
    return args.requested;
  }
  if (args.existing === 'strict' || args.existing === 'cheap') {
    return args.existing;
  }
  if ((args.priority || '').toLowerCase() === 'critical') {
    return 'strict';
  }
  return CONSISTENCY_DEFAULT;
}

function normalizeEvidenceRefs(evidenceRefs?: string[]): string[] {
  if (!Array.isArray(evidenceRefs)) return [];
  const normalized = evidenceRefs
    .map((ref) => (typeof ref === 'string' ? ref.trim() : ''))
    .filter((ref) => ref.length > 0)
    .map((ref) => ref.length > MAX_EVIDENCE_REF_CHARS ? ref.slice(0, MAX_EVIDENCE_REF_CHARS) : ref);
  return [...new Set(normalized)];
}

function validateEvidenceRefs(evidenceRefs: string[]) {
  if (evidenceRefs.length > MAX_EVIDENCE_REFS_PER_CALL) {
    return {
      ok: false as const,
      error_code: 'EVIDENCE_TOO_MANY',
      error: `Too many evidence_refs (${evidenceRefs.length}). Max is ${MAX_EVIDENCE_REFS_PER_CALL}.`,
    };
  }
  return { ok: true as const };
}

function validateDoneGate(args: {
  task_id: number;
  agent_id: string;
  consistency_mode?: TaskConsistencyMode;
  confidence?: number;
  verification_passed?: boolean;
  verified_by?: string;
  evidence_refs?: string[];
}) {
  const consistencyMode = normalizeTaskConsistencyMode(args.consistency_mode);
  const strictMode = consistencyMode === 'strict';
  const requiredConfidence = strictMode
    ? Math.max(getRequiredDoneConfidence(args.agent_id), STRICT_DONE_CONFIDENCE_MIN)
    : getRequiredDoneConfidence(args.agent_id);
  const confidenceFloor = strictMode ? STRICT_DONE_CONFIDENCE_MIN : DONE_CONFIDENCE_FLOOR;
  const requiredEvidenceRefs = strictMode ? STRICT_DONE_EVIDENCE_MIN_REFS : DONE_EVIDENCE_MIN_REFS;
  const evidenceRefs = normalizeEvidenceRefs(args.evidence_refs);
  const evidenceValidation = validateEvidenceRefs(evidenceRefs);
  if (!evidenceValidation.ok) {
    return {
      ok: false,
      error_code: evidenceValidation.error_code,
      error: evidenceValidation.error,
      required_confidence: requiredConfidence,
    };
  }
  const confidence = Number.isFinite(args.confidence) ? Number(args.confidence) : NaN;
  const verificationPassed = args.verification_passed === true;
  const verifiedBy = (args.verified_by || '').trim();
  const hasIndependentVerifier = verifiedBy.length > 0 && verifiedBy !== args.agent_id;

  if (!Number.isFinite(confidence)) {
    return {
      ok: false,
      error_code: 'DONE_GATE_FAILED',
      error: 'Missing confidence for done transition',
      required_confidence: requiredConfidence,
      consistency_mode: consistencyMode,
    };
  }
  if (confidence < confidenceFloor) {
    return {
      ok: false,
      error_code: 'DONE_GATE_FAILED',
      error: `Confidence ${confidence.toFixed(2)} below floor ${confidenceFloor.toFixed(2)} for ${consistencyMode} mode`,
      required_confidence: requiredConfidence,
      consistency_mode: consistencyMode,
    };
  }
  if (!verificationPassed) {
    return {
      ok: false,
      error_code: 'DONE_GATE_FAILED',
      error: 'verification_passed must be true for done transition',
      required_confidence: requiredConfidence,
      consistency_mode: consistencyMode,
    };
  }
  if (strictMode && !hasIndependentVerifier) {
    return {
      ok: false,
      error_code: 'VERIFIER_REQUIRED',
      error: 'Independent verifier is required for strict consistency done transition',
      required_confidence: requiredConfidence,
      consistency_mode: consistencyMode,
    };
  }
  if (confidence < requiredConfidence && !hasIndependentVerifier) {
    return {
      ok: false,
      error_code: 'VERIFIER_REQUIRED',
      error: `Independent verifier required when confidence (${confidence.toFixed(2)}) is below threshold ${requiredConfidence.toFixed(2)}`,
      required_confidence: requiredConfidence,
      consistency_mode: consistencyMode,
    };
  }

  if (requiredEvidenceRefs > 0) {
    const existingEvidence = listTaskEvidence(args.task_id, 1000);
    const allEvidence = new Set<string>(existingEvidence.map((row) => row.evidence_ref));
    for (const ref of evidenceRefs) allEvidence.add(ref);
    if (allEvidence.size < requiredEvidenceRefs) {
      return {
        ok: false,
        error_code: 'EVIDENCE_REQUIRED',
        error: `At least ${requiredEvidenceRefs} evidence_refs required for done transition (current ${allEvidence.size})`,
        required_confidence: requiredConfidence,
        required_evidence_refs: requiredEvidenceRefs,
        evidence_refs_total: allEvidence.size,
        consistency_mode: consistencyMode,
      };
    }
  }

  return {
    ok: true,
    consistency_mode: consistencyMode,
    required_confidence: requiredConfidence,
    required_evidence_refs: requiredEvidenceRefs,
    evidence_refs: evidenceRefs,
  };
}

function getPollingProfile(activeAgents: number): { minMs: number; baseMs: number; factor: number; capMs: number; jitterPct: number } {
  if (activeAgents <= 5) return { minMs: 200, baseMs: 800, factor: 1.30, capMs: 3000, jitterPct: 0.30 };
  if (activeAgents <= 10) return { minMs: 250, baseMs: 1200, factor: 1.45, capMs: 5000, jitterPct: 0.40 };
  if (activeAgents <= 20) return { minMs: 300, baseMs: 2000, factor: 1.60, capMs: 8000, jitterPct: 0.55 };
  return { minMs: 400, baseMs: 2600, factor: 1.70, capMs: 12000, jitterPct: 0.60 };
}

function getActiveAgentCount(): number {
  const cutoff = Date.now() - 5 * 60 * 1000;
  return countActiveAgents(cutoff);
}

function computeRetryAfterMs(agentId: string, hasActiveClaims: boolean): number {
  const misses = (pollMissStreak.get(agentId) ?? 0) + 1;
  pollMissStreak.set(agentId, misses);

  const profile = getPollingProfile(getActiveAgentCount());
  const backoffExponent = Math.max(0, Math.min(misses - 1, 6));
  const backedOff = Math.min(profile.baseMs * Math.pow(profile.factor, backoffExponent), profile.capMs);
  const claimAwareCap = hasActiveClaims ? Math.min(profile.capMs, 5000) : profile.capMs;
  const withCap = Math.max(profile.minMs, Math.min(backedOff, claimAwareCap));
  const jitterLow = Math.max(profile.minMs, Math.round(withCap * (1 - profile.jitterPct)));
  const jitterHigh = Math.min(claimAwareCap, Math.max(jitterLow, Math.round(withCap * (1 + profile.jitterPct))));
  return jitterLow + Math.round(Math.random() * (jitterHigh - jitterLow));
}

function resetPollBackoff(agentId: string) {
  pollMissStreak.delete(agentId);
}

function buildTaskArtifactHints(taskId: number, agentId: string) {
  return listTaskArtifacts(taskId).map((row) => ({
    artifact_id: row.artifact_id,
    ready: Boolean(row.artifact_sha256 && row.artifact_size_bytes > 0),
    has_access: hasArtifactAccess(agentId, row.artifact_id),
  }));
}

export function handleCreateTask(args: {
  title: string;
  description?: string;
  created_by: string;
  assigned_to?: string;
  priority?: string;
  depends_on?: number[];
  namespace?: string;
  execution_mode?: 'any' | 'repo' | 'isolated';
  consistency_mode?: 'cheap' | 'strict' | 'auto';
  trace_id?: string;
  span_id?: string;
  idempotency_key?: string;
}) {
  heartbeat(args.created_by);
  return withIdempotency(args.created_by, 'create_task', args.idempotency_key, () => {
    const namespacePolicy = evaluateNamespaceGovernance({
      action: 'create_task',
      namespace: args.namespace,
      hints: [args.created_by, args.title, args.description],
    });
    if (!namespacePolicy.ok) {
      logActivity(args.created_by, 'create_task_namespace_rejected', namespacePolicy.error);
      return {
        success: false,
        error_code: namespacePolicy.error_code,
        error: namespacePolicy.error,
      };
    }

    const consistencyMode = resolveTaskConsistencyMode({
      requested: args.consistency_mode,
      priority: args.priority,
    });
    const { idempotency_key: _key, consistency_mode: _consistencyMode, ...taskArgs } = args;
    const task = createTask({ ...taskArgs, consistency_mode: consistencyMode });
    const depCount = taskArgs.depends_on?.length ?? 0;
    const namespace = task.namespace || 'default';
    if (namespacePolicy.warning) {
      logActivity(args.created_by, 'create_task_namespace_warning', `${namespacePolicy.warning}; fallback namespace=${namespace}`);
    }
    logActivity(
      args.created_by,
      'create_task',
      `Created task "${args.title}" [${args.priority || 'medium'}] ns=${namespace} mode=${task.execution_mode}/${consistencyMode} deps=${depCount}`
    );
    return {
      success: true,
      task,
      namespace_policy: namespacePolicy.warning ? { mode: NAMESPACE_GOVERNANCE, warning: namespacePolicy.warning } : { mode: NAMESPACE_GOVERNANCE },
    };
  });
}

export function handleUpdateTask(args: {
  id: number;
  status?: string;
  assigned_to?: string;
  title?: string;
  description?: string;
  priority?: string;
  namespace?: string;
  execution_mode?: 'any' | 'repo' | 'isolated';
  consistency_mode?: 'cheap' | 'strict';
  trace_id?: string;
  span_id?: string;
  depends_on?: number[];
  confidence?: number;
  verification_passed?: boolean;
  verified_by?: string;
  evidence_refs?: string[];
  idempotency_key?: string;
  agent_id: string;
}) {
  heartbeat(args.agent_id);
  return withIdempotency(args.agent_id, 'update_task', args.idempotency_key, () => {
    const previousTask = getTaskById(args.id);
    if (!previousTask) return { success: false, error: 'Task not found' };

    let requiredConfidence: number | undefined;
    let requiredEvidenceRefs: number | undefined;
    let evidenceRefsTotal: number | undefined;
    const effectiveConsistencyMode = resolveTaskConsistencyMode({
      requested: args.consistency_mode,
      existing: previousTask.consistency_mode,
      priority: args.priority || previousTask.priority,
    });
    const evidenceRefs = normalizeEvidenceRefs(args.evidence_refs);
    const evidenceValidation = validateEvidenceRefs(evidenceRefs);
    if (!evidenceValidation.ok) {
      logActivity(args.agent_id, 'update_task_evidence_failed', `Task #${args.id}: ${evidenceValidation.error}`);
      return {
        success: false,
        error_code: evidenceValidation.error_code,
        error: evidenceValidation.error,
        max_evidence_refs_per_call: MAX_EVIDENCE_REFS_PER_CALL,
      };
    }
    if (args.status === 'done') {
      const gate = validateDoneGate({
        task_id: args.id,
        agent_id: args.agent_id,
        consistency_mode: effectiveConsistencyMode,
        confidence: args.confidence,
        verification_passed: args.verification_passed,
        verified_by: args.verified_by,
        evidence_refs: evidenceRefs,
      });
      requiredConfidence = gate.required_confidence;
      if (!gate.ok) {
        logActivity(args.agent_id, 'update_task_done_gate_failed', `Task #${args.id}: ${gate.error}`);
        return {
          success: false,
          error_code: gate.error_code,
          error: gate.error,
          required_confidence: gate.required_confidence,
          required_evidence_refs: gate.required_evidence_refs,
          evidence_refs_total: gate.evidence_refs_total,
          consistency_mode: gate.consistency_mode,
        };
      }
      requiredEvidenceRefs = gate.required_evidence_refs;
    }

    const {
      id: _id,
      agent_id,
      confidence: _confidence,
      verification_passed: _verificationPassed,
      verified_by: _verifiedBy,
      evidence_refs: _evidenceRefs,
      idempotency_key: _key,
      ...updates
    } = args;
    const task = updateTask(args.id, updates);
    if (!task) return { success: false, error: 'Task not found' };

    const evidenceWrite = addTaskEvidence(task.id, agent_id, evidenceRefs);
    evidenceRefsTotal = evidenceWrite.total;

    if (previousTask.status !== task.status) {
      recordTaskStatusTransition({
        task_id: task.id,
        from_status: previousTask.status,
        to_status: task.status,
        changed_by: agent_id,
        source: 'update_task',
      });
    }

    if (previousTask.status !== 'done' && task.status === 'done') {
      recordTaskCompletion(agent_id);
    } else if (previousTask.status === 'done' && task.status !== 'done') {
      recordTaskRollback(previousTask.assigned_to || agent_id);
    }

    const confidenceMeta = requiredConfidence !== undefined ? ` required_confidence=${requiredConfidence.toFixed(2)}` : '';
    const evidenceMeta = ` evidence_added=${evidenceWrite.added} evidence_total=${evidenceWrite.total} consistency=${effectiveConsistencyMode}`;
    logActivity(agent_id, 'update_task', `Updated task #${args.id}: ${JSON.stringify(updates)}${confidenceMeta}${evidenceMeta}`);
    return {
      success: true,
      task,
      required_confidence: requiredConfidence,
      required_evidence_refs: requiredEvidenceRefs,
      evidence_refs_added: evidenceWrite.added,
      evidence_refs_total: evidenceRefsTotal,
    };
  });
}

export function handleListTasks(args: {
  status?: string;
  assigned_to?: string;
  namespace?: string;
  execution_mode?: 'any' | 'repo' | 'isolated';
  agent_id?: string;
  ready_only?: boolean;
  include_dependencies?: boolean;
  limit?: number;
  offset?: number;
  updated_after?: number;
  cursor?: string;
  response_mode?: 'full' | 'compact' | 'tiny' | 'nano';
  polling?: boolean;
}) {
  if (args.agent_id) heartbeat(args.agent_id);
  const limit = Math.max(1, Math.min(MAX_TASK_LIST_LIMIT, Math.floor(args.limit ?? DEFAULT_TASK_LIST_LIMIT)));
  const cursor = parseTaskCursor(args.cursor);
  const responseMode = args.response_mode || 'full';
  const updatedAfter = Number.isFinite(args.updated_after) ? Math.floor(Number(args.updated_after)) : undefined;
  const useDeltaOrdering = cursor !== null || updatedAfter !== undefined;
  const pollingCycle = args.polling === true || useDeltaOrdering;
  if (pollingCycle && responseMode === 'full' && DISALLOW_FULL_IN_POLLING) {
    return {
      success: false,
      error_code: 'FULL_MODE_FORBIDDEN_IN_POLLING',
      error: 'response_mode=full is forbidden in polling cycles; use nano, tiny, or compact',
      allowed_response_modes: ['nano', 'tiny', 'compact'],
    };
  }
  const queryLimit = useDeltaOrdering ? Math.min(MAX_TASK_LIST_LIMIT + 1, limit + 1) : limit;
  const offset = Math.max(0, Math.floor(args.offset ?? 0));
  const tasks = listTasks({
    status: args.status,
    assigned_to: args.assigned_to,
    namespace: args.namespace,
    execution_mode: args.execution_mode,
    ready_only: args.ready_only,
    limit: queryLimit,
    offset,
    updated_after: updatedAfter,
    cursor: cursor || undefined,
  });
  const hasMore = useDeltaOrdering ? tasks.length > limit : false;
  const slicedTasks = hasMore ? tasks.slice(0, limit) : tasks;
  const nextCursor = slicedTasks.length > 0 ? formatTaskCursor(slicedTasks[slicedTasks.length - 1]) : args.cursor || null;
  const withDependencies = args.include_dependencies
    ? slicedTasks.map((task) => ({ ...task, depends_on: getTaskDependencies(task.id) }))
    : slicedTasks;
  const compactTasks = withDependencies.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    assigned_to: task.assigned_to,
    priority: task.priority,
    namespace: task.namespace,
    execution_mode: task.execution_mode,
    consistency_mode: task.consistency_mode,
    trace_id: task.trace_id,
    span_id: task.span_id,
    updated_at: task.updated_at,
    depends_on: 'depends_on' in task ? (task as { depends_on?: number[] }).depends_on || [] : undefined,
  }));
  const tinyTasks = withDependencies.map((task) => ({
    id: task.id,
    status: task.status,
    assigned_to: task.assigned_to,
    priority: task.priority,
    namespace: task.namespace,
    execution_mode: task.execution_mode,
    consistency_mode: task.consistency_mode,
    trace_id: task.trace_id ? task.trace_id.slice(0, 12) : null,
    span_id: task.span_id ? task.span_id.slice(0, 12) : null,
    updated_at: task.updated_at,
    title_preview: task.title.slice(0, 72),
    title_chars: task.title.length,
    depends_on_count: 'depends_on' in task ? (((task as { depends_on?: number[] }).depends_on || []).length) : undefined,
  }));
  const nanoTasks = withDependencies.map((task) => ({
    i: task.id,
    s: task.status,
    a: task.assigned_to,
    p: task.priority,
    n: task.namespace,
    e: task.execution_mode,
    cm: task.consistency_mode === 'strict' ? 's' : 'c',
    x: task.trace_id ? task.trace_id.slice(0, 12) : undefined,
    y: task.span_id ? task.span_id.slice(0, 12) : undefined,
    u: task.updated_at,
    tc: task.title.length,
    t: task.title.slice(0, 40),
    dc: 'depends_on' in task ? (((task as { depends_on?: number[] }).depends_on || []).length) : undefined,
  }));

  logActivity(
    args.agent_id || 'system',
    'list_tasks',
    `Listed ${slicedTasks.length} tasks (ns=${args.namespace || '*'}, offset=${offset}, limit=${limit}, updated_after=${updatedAfter ?? '-'}, cursor=${args.cursor || '-'})`
  );
  if (responseMode === 'compact') {
    return { tasks: compactTasks, has_more: hasMore, next_cursor: nextCursor };
  }
  if (responseMode === 'tiny') {
    return { tasks: tinyTasks, has_more: hasMore, next_cursor: nextCursor };
  }
  if (responseMode === 'nano') {
    return { t: nanoTasks, h: hasMore ? 1 : 0, n: nextCursor };
  }
  return { tasks: withDependencies, has_more: hasMore, next_cursor: nextCursor };
}

export function handlePollAndClaim(args: {
  agent_id: string;
  lease_seconds?: number;
  namespace?: string;
  include_artifacts?: boolean;
  idempotency_key?: string;
}) {
  heartbeat(args.agent_id);
  return withIdempotency(args.agent_id, 'poll_and_claim', args.idempotency_key, () => {
    const namespacePolicy = evaluateNamespaceGovernance({
      action: 'poll_and_claim',
      namespace: args.namespace,
      hints: [args.agent_id],
    });
    if (!namespacePolicy.ok) {
      logActivity(args.agent_id, 'poll_and_claim_namespace_rejected', namespacePolicy.error);
      return {
        success: false,
        error_code: namespacePolicy.error_code,
        error: namespacePolicy.error,
      };
    }

    const runtimeProfile = getAgentRuntimeProfile(args.agent_id);
    const claimed = pollAndClaim(args.agent_id, args.lease_seconds, args.namespace);
    if (!claimed) {
      const hasActiveClaims = listTaskClaims({}).length > 0;
      const retryAfterMs = computeRetryAfterMs(args.agent_id, hasActiveClaims);
      logActivity(
        args.agent_id,
        'poll_and_claim',
        `No dependency-ready tasks available ns=${args.namespace || '*'} include_artifacts=${args.include_artifacts ? 1 : 0} (retry_after_ms=${retryAfterMs})`
      );
      return {
        success: true,
        task: null,
        message: 'No dependency-ready pending tasks available',
        retry_after_ms: retryAfterMs,
        runtime_mode: runtimeProfile.mode,
        warning: namespacePolicy.warning,
      };
    }
    resetPollBackoff(args.agent_id);
    const dependsOn = getTaskDependencies(claimed.task.id);
    logActivity(
      args.agent_id,
      'poll_and_claim',
      `Claimed task #${claimed.task.id}: "${claimed.task.title}" [${claimed.task.priority}] ns=${claimed.task.namespace} mode=${claimed.task.execution_mode} deps=${dependsOn.length} include_artifacts=${args.include_artifacts ? 1 : 0} until ${new Date(claimed.claim.lease_expires_at).toISOString()}`
    );
    return {
      success: true,
      task: claimed.task,
      claim: claimed.claim,
      depends_on: dependsOn,
      task_artifacts: args.include_artifacts ? buildTaskArtifactHints(claimed.task.id, args.agent_id) : undefined,
      runtime_mode: runtimeProfile.mode,
      warning: namespacePolicy.warning,
    };
  });
}

export function handleClaimTask(args: {
  task_id: number;
  agent_id: string;
  lease_seconds?: number;
  namespace?: string;
  include_artifacts?: boolean;
  idempotency_key?: string;
}) {
  heartbeat(args.agent_id);
  return withIdempotency(args.agent_id, 'claim_task', args.idempotency_key, () => {
    const namespacePolicy = evaluateNamespaceGovernance({
      action: 'claim_task',
      namespace: args.namespace,
      hints: [args.agent_id],
    });
    if (!namespacePolicy.ok) {
      logActivity(args.agent_id, 'claim_task_namespace_rejected', namespacePolicy.error);
      return {
        success: false,
        error_code: namespacePolicy.error_code,
        error: namespacePolicy.error,
      };
    }

    const result = claimTask(args.task_id, args.agent_id, args.lease_seconds, args.namespace);
    if (!result.success) {
      logActivity(args.agent_id, 'claim_task_failed', `Task #${args.task_id}: ${result.error} (${result.error_code})`);
      return result;
    }
    const withDeps = getTaskWithDependencies(args.task_id);
    logActivity(
      args.agent_id,
      'claim_task',
      `Claimed task #${args.task_id} claim_id=${result.claim.claim_id} deps=${withDeps?.depends_on.length || 0} include_artifacts=${args.include_artifacts ? 1 : 0} until ${new Date(result.claim.lease_expires_at).toISOString()}`
    );
    return {
      ...result,
      depends_on: withDeps?.depends_on || [],
      task_artifacts: args.include_artifacts ? buildTaskArtifactHints(args.task_id, args.agent_id) : undefined,
      warning: namespacePolicy.warning,
    };
  });
}

export function handleRenewTaskClaim(args: { task_id: number; agent_id: string; lease_seconds?: number; claim_id?: string; idempotency_key?: string }) {
  heartbeat(args.agent_id);
  return withIdempotency(args.agent_id, 'renew_task_claim', args.idempotency_key, () => {
    const result = renewTaskClaim(args.task_id, args.agent_id, args.lease_seconds, args.claim_id);
    if (!result.success) {
      logActivity(args.agent_id, 'renew_task_claim_failed', `Task #${args.task_id}: ${result.error} (${result.error_code})`);
      return result;
    }
    logActivity(
      args.agent_id,
      'renew_task_claim',
      `Renewed task #${args.task_id} claim_id=${result.claim.claim_id} until ${new Date(result.claim.lease_expires_at).toISOString()}`
    );
    return result;
  });
}

export function handleReleaseTaskClaim(args: {
  task_id: number;
  agent_id: string;
  next_status?: string;
  claim_id?: string;
  consistency_mode?: 'cheap' | 'strict';
  confidence?: number;
  verification_passed?: boolean;
  verified_by?: string;
  evidence_refs?: string[];
  idempotency_key?: string;
}) {
  heartbeat(args.agent_id);
  return withIdempotency(args.agent_id, 'release_task_claim', args.idempotency_key, () => {
    let requiredConfidence: number | undefined;
    let requiredEvidenceRefs: number | undefined;
    let evidenceRefsTotal: number | undefined;
    const previousTask = getTaskById(args.task_id);
    const effectiveConsistencyMode = resolveTaskConsistencyMode({
      requested: args.consistency_mode,
      existing: previousTask?.consistency_mode,
      priority: previousTask?.priority,
    });
    const evidenceRefs = normalizeEvidenceRefs(args.evidence_refs);
    const evidenceValidation = validateEvidenceRefs(evidenceRefs);
    if (!evidenceValidation.ok) {
      logActivity(args.agent_id, 'release_task_claim_evidence_failed', `Task #${args.task_id}: ${evidenceValidation.error}`);
      return {
        success: false,
        error_code: evidenceValidation.error_code,
        error: evidenceValidation.error,
        max_evidence_refs_per_call: MAX_EVIDENCE_REFS_PER_CALL,
      };
    }
    if (args.next_status === 'done') {
      const gate = validateDoneGate({
        task_id: args.task_id,
        agent_id: args.agent_id,
        consistency_mode: effectiveConsistencyMode,
        confidence: args.confidence,
        verification_passed: args.verification_passed,
        verified_by: args.verified_by,
        evidence_refs: evidenceRefs,
      });
      requiredConfidence = gate.required_confidence;
      if (!gate.ok) {
        logActivity(args.agent_id, 'release_task_claim_done_gate_failed', `Task #${args.task_id}: ${gate.error}`);
        return {
          success: false,
          error_code: gate.error_code,
          error: gate.error,
          required_confidence: gate.required_confidence,
          required_evidence_refs: gate.required_evidence_refs,
          evidence_refs_total: gate.evidence_refs_total,
          consistency_mode: gate.consistency_mode,
        };
      }
      requiredEvidenceRefs = gate.required_evidence_refs;
    }

    const result = releaseTaskClaim(args.task_id, args.agent_id, args.next_status, args.claim_id);
    if (!result.success) {
      logActivity(args.agent_id, 'release_task_claim_failed', `Task #${args.task_id}: ${result.error} (${result.error_code})`);
      return result;
    }
    const evidenceWrite = addTaskEvidence(result.task.id, args.agent_id, evidenceRefs);
    evidenceRefsTotal = evidenceWrite.total;
    if (previousTask && previousTask.status !== result.task.status) {
      recordTaskStatusTransition({
        task_id: result.task.id,
        from_status: previousTask.status,
        to_status: result.task.status,
        changed_by: args.agent_id,
        source: 'release_task_claim',
      });
    }
    if (previousTask && previousTask.status !== 'done' && result.task.status === 'done') {
      recordTaskCompletion(args.agent_id);
    } else if (previousTask && previousTask.status === 'done' && result.task.status !== 'done') {
      recordTaskRollback(previousTask.assigned_to || args.agent_id);
    }

    const claimLabel = args.claim_id || 'server-current';
    const confidenceMeta = requiredConfidence !== undefined ? ` required_confidence=${requiredConfidence.toFixed(2)}` : '';
    const evidenceMeta = ` evidence_added=${evidenceWrite.added} evidence_total=${evidenceWrite.total} consistency=${effectiveConsistencyMode}`;
    logActivity(args.agent_id, 'release_task_claim', `Released task #${args.task_id} claim_id=${claimLabel} with status ${result.task.status}${confidenceMeta}${evidenceMeta}`);
    return {
      ...result,
      required_confidence: requiredConfidence,
      required_evidence_refs: requiredEvidenceRefs,
      evidence_refs_added: evidenceWrite.added,
      evidence_refs_total: evidenceRefsTotal,
    };
  });
}

export function handleListTaskClaims(args: { agent_id?: string; requesting_agent?: string }) {
  if (args.requesting_agent) heartbeat(args.requesting_agent);
  const claims = listTaskClaims({ agent_id: args.agent_id });
  logActivity(args.requesting_agent || 'system', 'list_task_claims', `Listed ${claims.length} task claims`);
  return { claims };
}

export function handleDeleteTask(args: {
  id: number;
  agent_id: string;
  archive?: boolean;
  reason?: string;
  idempotency_key?: string;
}) {
  heartbeat(args.agent_id);
  return withIdempotency(args.agent_id, 'delete_task', args.idempotency_key, () => {
    const result = deleteTask(args.id, { archive: args.archive, reason: args.reason });
    if (!result.success) {
      logActivity(args.agent_id, 'delete_task_failed', `Task #${args.id}: ${result.error} (${result.error_code})`);
      return result;
    }
    logActivity(args.agent_id, 'delete_task', `Deleted task #${args.id} archived=${result.archived}`);
    return result;
  });
}

export function handleAttachTaskArtifact(args: {
  task_id: number;
  artifact_id: string;
  agent_id: string;
  auto_share_assignee?: boolean;
  idempotency_key?: string;
}) {
  heartbeat(args.agent_id);
  return withIdempotency(args.agent_id, 'attach_task_artifact', args.idempotency_key, () => {
    const task = getTaskById(args.task_id);
    if (!task) {
      return {
        success: false,
        error_code: 'TASK_NOT_FOUND',
        error: 'Task not found',
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
    if (!hasArtifactAccess(args.agent_id, artifactId)) {
      return {
        success: false,
        error_code: 'ARTIFACT_ACCESS_DENIED',
        error: 'Agent has no access to this artifact',
      };
    }

    const linked = attachTaskArtifact(task.id, artifactId, args.agent_id);
    const autoShareAssignee = args.auto_share_assignee !== false;
    let sharedToAssignee = false;
    if (autoShareAssignee && task.assigned_to && !hasArtifactAccess(task.assigned_to, artifactId)) {
      grantArtifactAccess({
        artifact_id: artifactId,
        to_agent: task.assigned_to,
        granted_by: args.agent_id,
      });
      sharedToAssignee = true;
    }
    logActivity(
      args.agent_id,
      'attach_task_artifact',
      `task_id=${task.id} artifact_id=${artifactId} created=${linked.created ? 1 : 0} shared_to_assignee=${sharedToAssignee ? 1 : 0}`
    );
    return {
      success: true,
      task_id: task.id,
      artifact_id: artifactId,
      attached: linked.created,
      already_attached: !linked.created,
      assignee: task.assigned_to,
      shared_to_assignee: sharedToAssignee,
    };
  });
}

export function handleListTaskArtifacts(args: {
  task_id: number;
  agent_id: string;
  limit?: number;
  offset?: number;
  response_mode?: 'full' | 'compact' | 'tiny';
}) {
  heartbeat(args.agent_id);
  const task = getTaskById(args.task_id);
  if (!task) {
    return {
      success: false,
      error_code: 'TASK_NOT_FOUND',
      error: 'Task not found',
    };
  }
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(500, Math.floor(Number(args.limit)))) : 100;
  const offset = Number.isFinite(args.offset) ? Math.max(0, Math.floor(Number(args.offset))) : 0;
  const rows = listTaskArtifacts(args.task_id, { limit: limit + 1, offset });
  const hasMore = rows.length > limit;
  const slicedRows = hasMore ? rows.slice(0, limit) : rows;
  const nextOffset = hasMore ? offset + slicedRows.length : null;
  const mapped = slicedRows.map((row) => {
    const hasAccess = hasArtifactAccess(args.agent_id, row.artifact_id);
    const ready = Boolean(row.artifact_sha256 && row.artifact_size_bytes > 0);
    return {
      task_id: row.task_id,
      artifact_id: row.artifact_id,
      added_by: row.added_by,
      created_at: row.created_at,
      namespace: row.artifact_namespace,
      updated_at: row.artifact_updated_at,
      ready,
      has_access: hasAccess,
      name: hasAccess ? row.artifact_name : undefined,
      mime_type: hasAccess ? row.artifact_mime_type : undefined,
      size_bytes: hasAccess ? row.artifact_size_bytes : undefined,
      sha256: hasAccess ? row.artifact_sha256 : undefined,
    };
  });
  logActivity(args.agent_id, 'list_task_artifacts', `task_id=${args.task_id} count=${mapped.length} offset=${offset} limit=${limit}`);
  if (args.response_mode === 'tiny') {
    return {
      success: true,
      artifacts: mapped.map((row) => ({
        artifact_id: row.artifact_id,
        ready: row.ready,
        has_access: row.has_access,
      })),
      has_more: hasMore,
      next_offset: nextOffset,
    };
  }
  if (args.response_mode === 'compact') {
    return {
      success: true,
      artifacts: mapped.map((row) => ({
        artifact_id: row.artifact_id,
        ready: row.ready,
        has_access: row.has_access,
        name: row.name,
        size_bytes: row.size_bytes,
        updated_at: row.updated_at,
      })),
      has_more: hasMore,
      next_offset: nextOffset,
    };
  }
  return { success: true, artifacts: mapped, has_more: hasMore, next_offset: nextOffset };
}

export function handleGetTaskHandoff(args: {
  task_id: number;
  agent_id: string;
  response_mode?: 'full' | 'compact' | 'tiny';
  evidence_limit?: number;
  artifact_limit?: number;
  include_downloads?: boolean;
  download_ttl_sec?: number;
  only_ready_downloads?: boolean;
}) {
  heartbeat(args.agent_id);
  const task = getTaskWithDependencies(args.task_id);
  if (!task) {
    return {
      success: false,
      error_code: 'TASK_NOT_FOUND',
      error: 'Task not found',
    };
  }
  const evidenceLimit = Number.isFinite(args.evidence_limit) ? Math.max(1, Math.min(100, Math.floor(Number(args.evidence_limit)))) : 16;
  const artifactLimit = Number.isFinite(args.artifact_limit) ? Math.max(1, Math.min(200, Math.floor(Number(args.artifact_limit)))) : 32;
  const evidence = listTaskEvidence(task.id, evidenceLimit);
  const artifacts = listTaskArtifacts(task.id, { limit: artifactLimit, offset: 0 }).map((row) => {
    const hasAccess = hasArtifactAccess(args.agent_id, row.artifact_id);
    return {
      artifact_id: row.artifact_id,
      ready: Boolean(row.artifact_sha256 && row.artifact_size_bytes > 0),
      has_access: hasAccess,
      name: hasAccess ? row.artifact_name : undefined,
      size_bytes: hasAccess ? row.artifact_size_bytes : undefined,
      mime_type: hasAccess ? row.artifact_mime_type : undefined,
      sha256: hasAccess ? row.artifact_sha256 : undefined,
      updated_at: row.artifact_updated_at,
      namespace: row.artifact_namespace,
    };
  });
  const downloads = args.include_downloads
    ? buildTaskArtifactDownloads({
      agent_id: args.agent_id,
      task_id: task.id,
      ttl_sec: args.download_ttl_sec,
      only_ready: args.only_ready_downloads,
      limit: artifactLimit,
    })
    : null;
  const evidenceRefs = evidence.map((row) => row.evidence_ref);
  const downloadMeta = downloads
    ? (downloads.success ? `downloads=${downloads.downloads.length}` : `downloads_error=${downloads.error_code}`)
    : 'downloads=off';
  logActivity(
    args.agent_id,
    'get_task_handoff',
    `task_id=${task.id} mode=${args.response_mode || 'full'} deps=${task.depends_on.length} evidence=${evidenceRefs.length} artifacts=${artifacts.length} ${downloadMeta}`
  );

  if (args.response_mode === 'tiny') {
    return {
      success: true,
      task: {
        id: task.id,
        status: task.status,
        assigned_to: task.assigned_to,
        priority: task.priority,
        namespace: task.namespace,
        execution_mode: task.execution_mode,
        consistency_mode: task.consistency_mode,
        trace_id: task.trace_id ? task.trace_id.slice(0, 12) : null,
        span_id: task.span_id ? task.span_id.slice(0, 12) : null,
        updated_at: task.updated_at,
        title_preview: task.title.slice(0, 72),
        title_chars: task.title.length,
      },
      depends_on: task.depends_on,
      evidence_refs: evidenceRefs,
      artifacts: artifacts.map((row) => ({
        artifact_id: row.artifact_id,
        ready: row.ready,
        has_access: row.has_access,
      })),
      artifact_downloads: downloads?.success ? downloads.downloads.map((row) => ({
        artifact_id: row.artifact_id,
        url: row.download.url,
        expires_at: row.download.expires_at,
      })) : undefined,
      artifact_downloads_summary: downloads?.success ? downloads.summary : undefined,
      artifact_downloads_error: downloads && !downloads.success ? {
        error_code: downloads.error_code,
        error: downloads.error,
      } : undefined,
    };
  }

  if (args.response_mode === 'compact') {
    return {
      success: true,
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        assigned_to: task.assigned_to,
        priority: task.priority,
        namespace: task.namespace,
        execution_mode: task.execution_mode,
        consistency_mode: task.consistency_mode,
        trace_id: task.trace_id,
        span_id: task.span_id,
        updated_at: task.updated_at,
      },
      depends_on: task.depends_on,
      evidence_refs: evidenceRefs,
      artifacts: artifacts.map((row) => ({
        artifact_id: row.artifact_id,
        ready: row.ready,
        has_access: row.has_access,
        name: row.name,
        size_bytes: row.size_bytes,
        updated_at: row.updated_at,
      })),
      artifact_downloads: downloads?.success ? downloads.downloads.map((row) => ({
        artifact_id: row.artifact_id,
        name: row.name,
        size_bytes: row.size_bytes,
        sha256: row.sha256,
        download: row.download,
      })) : undefined,
      artifact_downloads_summary: downloads?.success ? downloads.summary : undefined,
      artifact_downloads_error: downloads && !downloads.success ? {
        error_code: downloads.error_code,
        error: downloads.error,
      } : undefined,
    };
  }

  return {
    success: true,
    task,
    depends_on: task.depends_on,
    evidence_refs: evidenceRefs,
    evidence,
    artifacts,
    artifact_downloads: downloads?.success ? downloads.downloads : undefined,
    artifact_downloads_summary: downloads?.success ? downloads.summary : undefined,
    artifact_downloads_error: downloads && !downloads.success ? {
      error_code: downloads.error_code,
      error: downloads.error,
    } : undefined,
  };
}

export const taskTools = {
  create_task: {
    description: 'Create a new task on the shared task board.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Task description' },
        created_by: { type: 'string', description: 'Your agent ID' },
        assigned_to: { type: 'string', description: 'Agent ID to assign to' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Task priority' },
        namespace: { type: 'string', description: 'Task namespace/tag for isolation (default "default")' },
        execution_mode: { type: 'string', enum: ['any', 'repo', 'isolated'], description: 'Execution profile required by this task (default any)' },
        consistency_mode: { type: 'string', enum: ['auto', 'cheap', 'strict'], description: 'Consistency mode for completion gates (auto=critical->strict, otherwise default)' },
        trace_id: { type: 'string', description: 'Optional trace identifier for cross-tool diagnostics' },
        span_id: { type: 'string', description: 'Optional span identifier for task creation event' },
        depends_on: { type: 'array', items: { type: 'number' }, description: 'Optional dependency task IDs that must be done first' },
        idempotency_key: { type: 'string', description: 'Optional idempotency key for safe retries' },
      },
      required: ['title', 'created_by'],
    },
    handler: handleCreateTask,
  },
  update_task: {
    description: 'Update a task (status, assignment, details).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Task ID' },
        agent_id: { type: 'string', description: 'Your agent ID' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'], description: 'New status' },
        assigned_to: { type: 'string', description: 'Reassign to agent ID' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'New priority' },
        namespace: { type: 'string', description: 'Namespace/tag for the task' },
        execution_mode: { type: 'string', enum: ['any', 'repo', 'isolated'], description: 'Update required execution profile for this task' },
        consistency_mode: { type: 'string', enum: ['cheap', 'strict'], description: 'Override task consistency mode for done gates' },
        trace_id: { type: 'string', description: 'Optional trace identifier for cross-tool diagnostics' },
        span_id: { type: 'string', description: 'Optional span identifier for this task update event' },
        depends_on: { type: 'array', items: { type: 'number' }, description: 'Optional replacement dependency task IDs' },
        confidence: { type: 'number', description: 'Confidence score (0..1), required for done transitions' },
        verification_passed: { type: 'boolean', description: 'Whether verify-before-done checks passed (required for done)' },
        verified_by: { type: 'string', description: 'Independent verifier agent ID (recommended when confidence below threshold)' },
        evidence_refs: { type: 'array', items: { type: 'string' }, description: `Optional evidence references persisted with task updates (required count for done transitions: ${DONE_EVIDENCE_MIN_REFS})` },
        idempotency_key: { type: 'string', description: 'Optional idempotency key for safe retries' },
      },
      required: ['id', 'agent_id'],
    },
    handler: handleUpdateTask,
  },
  list_tasks: {
    description: 'List tasks from the shared task board with optional filters.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID (for heartbeat)' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'], description: 'Filter by status' },
        assigned_to: { type: 'string', description: 'Filter by assigned agent' },
        namespace: { type: 'string', description: 'Filter by task namespace/tag' },
        execution_mode: { type: 'string', enum: ['any', 'repo', 'isolated'], description: 'Filter by required execution profile' },
        ready_only: { type: 'boolean', description: 'Only return tasks whose dependencies are fully done' },
        include_dependencies: { type: 'boolean', description: 'Include depends_on IDs per task' },
        limit: { type: 'number', description: `Max rows to return (default ${DEFAULT_TASK_LIST_LIMIT}, max ${MAX_TASK_LIST_LIMIT})` },
        offset: { type: 'number', description: 'Row offset for pagination (default 0)' },
        updated_after: { type: 'number', description: 'Delta mode: return tasks with updated_at > updated_after (ms epoch)' },
        cursor: { type: 'string', description: 'Delta cursor "<updated_at>:<id>" returned by previous list_tasks call' },
        response_mode: { type: 'string', enum: ['full', 'compact', 'tiny', 'nano'], description: 'compact keeps titles, tiny returns minimal routing fields, nano uses short keys for routing loops' },
        polling: { type: 'boolean', description: 'Mark this call as polling-cycle read; full mode is forbidden when polling=true' },
      },
    },
    handler: handleListTasks,
  },
  poll_and_claim: {
    description: 'Atomically find a dependency-ready pending task and claim it. Prioritizes criticality and downstream unblocking impact; returns retry_after_ms when queue is empty.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        lease_seconds: { type: 'number', description: 'Optional lease duration in seconds (default 300)' },
        namespace: { type: 'string', description: 'Optional namespace/tag filter for task isolation' },
        include_artifacts: { type: 'boolean', description: 'Include tiny task artifact refs in claim response' },
        idempotency_key: { type: 'string', description: 'Optional idempotency key for safe retries' },
      },
      required: ['agent_id'],
    },
    handler: handlePollAndClaim,
  },
  claim_task: {
    description: 'Claim a specific task with a renewable lease (prevents duplicate work by multiple agents).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'number', description: 'Task ID to claim' },
        agent_id: { type: 'string', description: 'Your agent ID' },
        lease_seconds: { type: 'number', description: 'Lease duration in seconds (30..86400, default 300)' },
        namespace: { type: 'string', description: 'Optional namespace/tag guard for this task claim' },
        include_artifacts: { type: 'boolean', description: 'Include tiny task artifact refs in claim response' },
        idempotency_key: { type: 'string', description: 'Optional idempotency key for safe retries' },
      },
      required: ['task_id', 'agent_id'],
    },
    handler: handleClaimTask,
  },
  renew_task_claim: {
    description: 'Renew an existing task lease if you own the claim.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        agent_id: { type: 'string', description: 'Your agent ID' },
        lease_seconds: { type: 'number', description: 'New lease duration in seconds (30..86400, default 300)' },
        claim_id: { type: 'string', description: 'Optional expected claim ID (recommended for stale-write protection)' },
        idempotency_key: { type: 'string', description: 'Optional idempotency key for safe retries' },
      },
      required: ['task_id', 'agent_id'],
    },
    handler: handleRenewTaskClaim,
  },
  release_task_claim: {
    description: 'Release your task lease and optionally set final task status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        agent_id: { type: 'string', description: 'Your agent ID' },
        next_status: { type: 'string', enum: ['pending', 'done', 'blocked'], description: 'Final status after release (default pending)' },
        claim_id: { type: 'string', description: 'Optional expected claim ID (recommended for stale-write protection)' },
        consistency_mode: { type: 'string', enum: ['cheap', 'strict'], description: 'Override task consistency mode for done gate evaluation in this release call' },
        confidence: { type: 'number', description: 'Confidence score (0..1), required when next_status=done' },
        verification_passed: { type: 'boolean', description: 'Whether verify-before-done checks passed (required when next_status=done)' },
        verified_by: { type: 'string', description: 'Independent verifier agent ID (recommended when confidence below threshold)' },
        evidence_refs: { type: 'array', items: { type: 'string' }, description: `Optional evidence references persisted with task release (required count for done transitions: ${DONE_EVIDENCE_MIN_REFS})` },
        idempotency_key: { type: 'string', description: 'Optional idempotency key for safe retries' },
      },
      required: ['task_id', 'agent_id'],
    },
    handler: handleReleaseTaskClaim,
  },
  list_task_claims: {
    description: 'List active task leases with owner and expiration.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        requesting_agent: { type: 'string', description: 'Your agent ID (for heartbeat)' },
        agent_id: { type: 'string', description: 'Filter by owner agent ID' },
      },
    },
    handler: handleListTaskClaims,
  },
  delete_task: {
    description: 'Delete a task without active claim; archives by default.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Task ID' },
        agent_id: { type: 'string', description: 'Your agent ID' },
        archive: { type: 'boolean', description: 'Archive before delete (default true)' },
        reason: { type: 'string', description: 'Optional archive/delete reason' },
        idempotency_key: { type: 'string', description: 'Optional idempotency key for safe retries' },
      },
      required: ['id', 'agent_id'],
    },
    handler: handleDeleteTask,
  },
  attach_task_artifact: {
    description: 'Attach an existing artifact to a task and optionally auto-share it to current assignee.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        artifact_id: { type: 'string', description: 'Artifact ID to attach' },
        agent_id: { type: 'string', description: 'Your agent ID' },
        auto_share_assignee: { type: 'boolean', description: 'If true (default), grant attached artifact access to task assignee' },
        idempotency_key: { type: 'string', description: 'Optional idempotency key for safe retries' },
      },
      required: ['task_id', 'artifact_id', 'agent_id'],
    },
    handler: handleAttachTaskArtifact,
  },
  list_task_artifacts: {
    description: 'List artifacts attached to a task with access hints for requesting agent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        agent_id: { type: 'string', description: 'Your agent ID' },
        limit: { type: 'number', description: 'Max artifacts to return (default 100, max 500)' },
        offset: { type: 'number', description: 'Row offset for pagination (default 0)' },
        response_mode: { type: 'string', enum: ['full', 'compact', 'tiny'], description: 'compact/tiny reduce payload size' },
      },
      required: ['task_id', 'agent_id'],
    },
    handler: handleListTaskArtifacts,
  },
  get_task_handoff: {
    description: 'Get consolidated task handoff packet: task + dependencies + evidence refs + artifact hints; optional artifact download tickets.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        agent_id: { type: 'string', description: 'Your agent ID' },
        response_mode: { type: 'string', enum: ['full', 'compact', 'tiny'], description: 'compact/tiny reduce payload size' },
        evidence_limit: { type: 'number', description: 'Max evidence refs to include (default 16, max 100)' },
        artifact_limit: { type: 'number', description: 'Max artifacts to include (default 32, max 200)' },
        include_downloads: { type: 'boolean', description: 'Include one-time artifact download tickets in handoff response (default false)' },
        download_ttl_sec: { type: 'number', description: 'Optional download ticket TTL in seconds' },
        only_ready_downloads: { type: 'boolean', description: 'If true (default), emit tickets only for ready/uploaded artifacts' },
      },
      required: ['task_id', 'agent_id'],
    },
    handler: handleGetTaskHandoff,
  },
};
