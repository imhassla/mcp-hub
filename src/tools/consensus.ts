import {
  heartbeat,
  logActivity,
  saveConsensusDecision,
  listConsensusDecisions,
  getAgentQuality,
  getProtocolBlob,
  putProtocolBlob,
  getContext,
  getContextById,
  getMessageForAgent,
} from '../db.js';
import {
  decodeLosslessBlobPayload,
  encodeLosslessBlobPayloadAuto,
  parseBlobRefEnvelope,
  sha256Hex,
} from '../utils.js';

type ConsensusDecision = 'accept' | 'reject' | 'abstain';
type ConsensusOutcome = 'accept' | 'reject' | 'escalate_verifier';
type ConsensusResponseMode = 'full' | 'compact' | 'tiny';
type EmitBlobRefPolicy = 'never' | 'always' | 'on_escalate' | 'on_conflict';
type QualityWeightingMode = 'on' | 'off';

interface ConsensusVote {
  agent_id: string;
  decision: ConsensusDecision;
  confidence?: number;
}

interface LoadedVotes {
  votes: ConsensusVote[];
  source_hash: string;
  source_codec: 'raw' | 'brotli-base64';
  source_chars: number;
}

interface ExtractedVotesSource {
  votes?: ConsensusVote[];
  votes_blob_hash?: string;
  source_kind: 'blob_ref' | 'blob_hash' | 'inline_votes' | 'inline_votes_object';
  source_format: 'blob_ref' | 'json' | 'metadata_json';
}

export interface ResolveConsensusArgs {
  requesting_agent: string;
  proposal_id: string;
  votes?: ConsensusVote[];
  votes_blob_hash?: string;
  votes_blob_ref?: string;
  disagreement_threshold?: number;
  min_non_abstain_votes?: number;
  token_budget_cap?: number;
  dedupe_by_agent?: boolean;
  response_mode?: ConsensusResponseMode;
  emit_blob_ref?: boolean;
  emit_blob_ref_policy?: EmitBlobRefPolicy;
  quality_weighting?: QualityWeightingMode;
}

const MAX_CONSENSUS_VOTES = Number.isFinite(Number(process.env.MCP_HUB_MAX_CONSENSUS_VOTES))
  ? Math.max(1, Math.floor(Number(process.env.MCP_HUB_MAX_CONSENSUS_VOTES)))
  : 1000;
const CONSENSUS_QUALITY_WEIGHTING_DEFAULT: QualityWeightingMode = String(process.env.MCP_HUB_CONSENSUS_QUALITY_WEIGHTING || 'on').toLowerCase() === 'off'
  ? 'off'
  : 'on';

function clampConfidence(value: number | undefined): number {
  const num = Number.isFinite(value) ? Number(value) : 0.5;
  return Math.max(0, Math.min(1, num));
}

function normalizeVote(raw: unknown): ConsensusVote | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const agentId = typeof row.agent_id === 'string' ? row.agent_id.trim() : '';
  const decision = typeof row.decision === 'string' ? row.decision : '';
  if (!agentId || (decision !== 'accept' && decision !== 'reject' && decision !== 'abstain')) {
    return null;
  }
  const confidence = Number.isFinite(row.confidence) ? Number(row.confidence) : undefined;
  return { agent_id: agentId, decision, confidence };
}

function normalizeVotes(rawVotes: unknown[]): { votes: ConsensusVote[]; invalid_count: number } {
  const votes: ConsensusVote[] = [];
  let invalidCount = 0;
  for (const row of rawVotes) {
    const vote = normalizeVote(row);
    if (!vote) {
      invalidCount += 1;
      continue;
    }
    votes.push(vote);
  }
  return { votes, invalid_count: invalidCount };
}

function resolveVotesBlobHash(votesBlobHash?: string, votesBlobRef?: string): string | null {
  const hash = typeof votesBlobHash === 'string' ? votesBlobHash.trim() : '';
  const ref = typeof votesBlobRef === 'string' ? votesBlobRef.trim() : '';
  const parsed = ref ? parseBlobRefEnvelope(ref) : null;
  const resolvedHash = hash || parsed?.hash || '';
  if (!resolvedHash) return null;
  if (!/^[a-fA-F0-9]{64}$/.test(resolvedHash)) return null;
  if (hash && parsed?.hash && hash !== parsed.hash) return null;
  return resolvedHash.toLowerCase();
}

function extractVotesSourceFromUnknown(raw: unknown, sourceFormat: ExtractedVotesSource['source_format']): ExtractedVotesSource | null {
  if (Array.isArray(raw)) {
    const normalized = normalizeVotes(raw);
    if (normalized.votes.length === 0) return null;
    return {
      votes: normalized.votes,
      source_kind: 'inline_votes',
      source_format: sourceFormat,
    };
  }
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;

  const resolvedHash = resolveVotesBlobHash(
    typeof row.votes_blob_hash === 'string' ? row.votes_blob_hash : undefined,
    typeof row.votes_blob_ref === 'string' ? row.votes_blob_ref : undefined,
  );
  if (resolvedHash) {
    return {
      votes_blob_hash: resolvedHash,
      source_kind: 'blob_hash',
      source_format: sourceFormat,
    };
  }

  if (Array.isArray(row.votes)) {
    const normalized = normalizeVotes(row.votes);
    if (normalized.votes.length === 0) return null;
    return {
      votes: normalized.votes,
      source_kind: 'inline_votes_object',
      source_format: sourceFormat,
    };
  }

  return null;
}

function extractVotesSourceFromText(value: string): ExtractedVotesSource | null {
  const blobRef = parseBlobRefEnvelope(value);
  if (blobRef) {
    return {
      votes_blob_hash: blobRef.hash,
      source_kind: 'blob_ref',
      source_format: 'blob_ref',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  return extractVotesSourceFromUnknown(parsed, 'json');
}

function resolveEmitBlobPolicy(args: ResolveConsensusArgs): EmitBlobRefPolicy {
  if (args.emit_blob_ref_policy) return args.emit_blob_ref_policy;
  return args.emit_blob_ref ? 'always' : 'never';
}

function resolveQualityWeightingMode(args: ResolveConsensusArgs): QualityWeightingMode {
  return args.quality_weighting || CONSENSUS_QUALITY_WEIGHTING_DEFAULT;
}

function computeAgentQualityWeight(agentId: string): number {
  const quality = getAgentQuality(agentId);
  if (quality.completed_count <= 0) return 1;
  const rollbackRate = quality.completed_count > 0 ? (quality.rollback_count / quality.completed_count) : 0;
  const stability = 1 - Math.min(0.35, rollbackRate * 0.7);
  const experienceBoost = Math.min(0.12, Math.log10(quality.completed_count + 1) * 0.06);
  const weight = stability + experienceBoost;
  return Math.round(Math.max(0.7, Math.min(1.2, weight)) * 1000) / 1000;
}

function loadVotesFromBlob(blobHash: string): { ok: true; data: LoadedVotes; invalid_count: number } | {
  ok: false;
  error_code: string;
  error: string;
} {
  const blob = getProtocolBlob(blobHash);
  if (!blob) {
    return {
      ok: false,
      error_code: 'VOTES_BLOB_NOT_FOUND',
      error: `Votes blob ${blobHash.slice(0, 12)} not found`,
    };
  }
  const decoded = decodeLosslessBlobPayload(blob.value);
  if (!decoded.integrity_ok) {
    return {
      ok: false,
      error_code: 'VOTES_BLOB_INTEGRITY_FAILED',
      error: `Votes blob ${blobHash.slice(0, 12)} failed integrity check`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.value);
  } catch {
    return {
      ok: false,
      error_code: 'VOTES_BLOB_INVALID_JSON',
      error: `Votes blob ${blobHash.slice(0, 12)} is not valid JSON`,
    };
  }
  const rawVotes = Array.isArray(parsed)
    ? parsed
    : ((parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).votes))
      ? (parsed as Record<string, unknown>).votes as unknown[]
      : null);
  if (!rawVotes) {
    return {
      ok: false,
      error_code: 'VOTES_BLOB_INVALID_FORMAT',
      error: 'Votes blob JSON must be either an array of votes or an object with "votes" array',
    };
  }
  const normalized = normalizeVotes(rawVotes);
  if (normalized.votes.length === 0) {
    return {
      ok: false,
      error_code: 'VOTES_EMPTY',
      error: 'No valid votes found in votes blob',
    };
  }
  return {
    ok: true,
    data: {
      votes: normalized.votes,
      source_hash: blobHash,
      source_codec: decoded.codec,
      source_chars: decoded.value.length,
    },
    invalid_count: normalized.invalid_count,
  };
}

function maybeStoreDecisionBlob(payload: Record<string, unknown>): null | {
  hash: string;
  created: boolean;
  payload_chars: number;
  codec: 'raw' | 'brotli-base64';
  gain_pct: number;
} {
  const payloadJson = JSON.stringify(payload);
  const encoded = encodeLosslessBlobPayloadAuto(payloadJson);
  const fullHash = sha256Hex(encoded.stored_value);
  const { created } = putProtocolBlob(fullHash, encoded.stored_value);
  return {
    hash: fullHash,
    created,
    payload_chars: encoded.stored_value.length,
    codec: encoded.codec,
    gain_pct: encoded.gain_pct,
  };
}

export function handleResolveConsensus(args: ResolveConsensusArgs) {
  heartbeat(args.requesting_agent);
  const responseMode = args.response_mode || 'full';
  const emitBlobRefPolicy = resolveEmitBlobPolicy(args);
  const qualityWeightingMode = resolveQualityWeightingMode(args);
  const useQualityWeighting = qualityWeightingMode === 'on';
  const disagreementThreshold = Number.isFinite(args.disagreement_threshold)
    ? Math.max(0.1, Math.min(0.9, Number(args.disagreement_threshold)))
    : 0.35;
  const minNonAbstainVotes = Number.isFinite(args.min_non_abstain_votes)
    ? Math.max(1, Math.floor(Number(args.min_non_abstain_votes)))
    : 2;
  const tokenBudgetCap = Number.isFinite(args.token_budget_cap)
    ? Math.max(20, Math.floor(Number(args.token_budget_cap)))
    : null;
  const dedupeByAgent = args.dedupe_by_agent !== false;

  const normalizedDirectVotes = Array.isArray(args.votes) ? normalizeVotes(args.votes) : { votes: [], invalid_count: 0 };
  const directVotes = normalizedDirectVotes.votes;
  let invalidVotes = normalizedDirectVotes.invalid_count;
  const blobHash = resolveVotesBlobHash(args.votes_blob_hash, args.votes_blob_ref);
  let blobMeta: LoadedVotes | null = null;

  if ((args.votes_blob_hash || args.votes_blob_ref) && !blobHash) {
    const error = 'Invalid votes_blob_hash/votes_blob_ref (expected 64-char sha256 hash or valid blob-ref envelope)';
    logActivity(args.requesting_agent, 'resolve_consensus_rejected', error);
    return { success: false, error_code: 'INVALID_VOTES_BLOB_REF', error };
  }

  if (blobHash) {
    const loaded = loadVotesFromBlob(blobHash);
    if (!loaded.ok) {
      logActivity(args.requesting_agent, 'resolve_consensus_rejected', loaded.error);
      return { success: false, error_code: loaded.error_code, error: loaded.error };
    }
    blobMeta = loaded.data;
    invalidVotes += loaded.invalid_count;
  }

  const combinedVotes = [
    ...(blobMeta?.votes || []),
    ...directVotes,
  ];
  if (combinedVotes.length === 0) {
    const error = 'No votes provided. Pass votes[] or votes_blob_hash/votes_blob_ref.';
    logActivity(args.requesting_agent, 'resolve_consensus_rejected', error);
    return { success: false, error_code: 'VOTES_EMPTY', error };
  }
  if (combinedVotes.length > MAX_CONSENSUS_VOTES) {
    const error = `Too many votes (${combinedVotes.length}). Max is ${MAX_CONSENSUS_VOTES}.`;
    logActivity(args.requesting_agent, 'resolve_consensus_rejected', error);
    return { success: false, error_code: 'VOTES_TOO_LARGE', error, max_votes: MAX_CONSENSUS_VOTES };
  }

  const dedupedVotes = dedupeByAgent
    ? (() => {
      const latestByAgent = new Map<string, ConsensusVote>();
      for (const vote of combinedVotes) {
        latestByAgent.set(vote.agent_id, vote);
      }
      return [...latestByAgent.values()];
    })()
    : combinedVotes;
  const dedupedCount = combinedVotes.length - dedupedVotes.length;
  const estimatedTokenCost = 40 + (dedupedVotes.length * 5);

  let weightedAccept = 0;
  let weightedReject = 0;
  let abstainCount = 0;
  let nonAbstainCount = 0;
  let qualityWeightTotal = 0;
  let qualityWeightSamples = 0;
  let qualityWeightMin = Number.POSITIVE_INFINITY;
  let qualityWeightMax = 0;
  const qualityWeightCache = new Map<string, number>();

  for (const vote of dedupedVotes) {
    const confidence = clampConfidence(vote.confidence);
    const qualityWeight = useQualityWeighting
      ? (() => {
        const cached = qualityWeightCache.get(vote.agent_id);
        if (cached !== undefined) return cached;
        const computed = computeAgentQualityWeight(vote.agent_id);
        qualityWeightCache.set(vote.agent_id, computed);
        return computed;
      })()
      : 1;
    qualityWeightTotal += qualityWeight;
    qualityWeightSamples += 1;
    qualityWeightMin = Math.min(qualityWeightMin, qualityWeight);
    qualityWeightMax = Math.max(qualityWeightMax, qualityWeight);
    const effectiveWeight = confidence * qualityWeight;
    if (vote.decision === 'accept') {
      weightedAccept += effectiveWeight;
      nonAbstainCount += 1;
    } else if (vote.decision === 'reject') {
      weightedReject += effectiveWeight;
      nonAbstainCount += 1;
    } else {
      abstainCount += 1;
    }
  }

  const totalWeighted = weightedAccept + weightedReject;
  const disagreementRatio = totalWeighted > 0 ? Math.min(weightedAccept, weightedReject) / totalWeighted : 1;
  const uncertainty = totalWeighted > 0 ? 1 - (Math.abs(weightedAccept - weightedReject) / totalWeighted) : 1;

  const reasons: string[] = [];
  let outcome: ConsensusOutcome;
  if (tokenBudgetCap !== null && estimatedTokenCost > tokenBudgetCap) {
    outcome = 'escalate_verifier';
    reasons.push(`estimated_token_cost_exceeds_cap:${estimatedTokenCost}>${tokenBudgetCap}`);
  } else if (nonAbstainCount < minNonAbstainVotes) {
    outcome = 'escalate_verifier';
    reasons.push(`insufficient_non_abstain_votes:${nonAbstainCount}<${minNonAbstainVotes}`);
  } else if (disagreementRatio > disagreementThreshold) {
    outcome = 'escalate_verifier';
    reasons.push(`high_disagreement:${disagreementRatio.toFixed(3)}>${disagreementThreshold.toFixed(3)}`);
  } else {
    outcome = weightedAccept >= weightedReject ? 'accept' : 'reject';
  }

  logActivity(
    args.requesting_agent,
    'resolve_consensus',
    `proposal=${args.proposal_id} outcome=${outcome} weighted_accept=${weightedAccept.toFixed(3)} weighted_reject=${weightedReject.toFixed(3)} uncertainty=${uncertainty.toFixed(3)}`
  );

  const decision = saveConsensusDecision({
    proposal_id: args.proposal_id,
    requesting_agent: args.requesting_agent,
    outcome,
    stats: {
      weighted_accept: Math.round(weightedAccept * 1000) / 1000,
      weighted_reject: Math.round(weightedReject * 1000) / 1000,
      abstain_count: abstainCount,
      non_abstain_count: nonAbstainCount,
      disagreement_ratio: Math.round(disagreementRatio * 1000) / 1000,
      uncertainty: Math.round(uncertainty * 1000) / 1000,
      estimated_token_cost: estimatedTokenCost,
      input_vote_count: combinedVotes.length,
      evaluated_vote_count: dedupedVotes.length,
      deduped_vote_count: dedupedCount,
      invalid_vote_count: invalidVotes,
      quality_weighting: qualityWeightingMode,
      quality_weight_mean: qualityWeightSamples === 0 ? 1 : Math.round((qualityWeightTotal * 1000) / qualityWeightSamples) / 1000,
      quality_weight_min: qualityWeightSamples === 0 ? 1 : Math.round(qualityWeightMin * 1000) / 1000,
      quality_weight_max: qualityWeightSamples === 0 ? 1 : Math.round(qualityWeightMax * 1000) / 1000,
    },
    reasons,
  });

  const stats = {
    weighted_accept: Math.round(weightedAccept * 1000) / 1000,
    weighted_reject: Math.round(weightedReject * 1000) / 1000,
    abstain_count: abstainCount,
    non_abstain_count: nonAbstainCount,
    disagreement_ratio: Math.round(disagreementRatio * 1000) / 1000,
    uncertainty: Math.round(uncertainty * 1000) / 1000,
    estimated_token_cost: estimatedTokenCost,
    input_vote_count: combinedVotes.length,
    evaluated_vote_count: dedupedVotes.length,
    deduped_vote_count: dedupedCount,
    invalid_vote_count: invalidVotes,
    quality_weighting: qualityWeightingMode,
    quality_weight_mean: qualityWeightSamples === 0 ? 1 : Math.round((qualityWeightTotal * 1000) / qualityWeightSamples) / 1000,
    quality_weight_min: qualityWeightSamples === 0 ? 1 : Math.round(qualityWeightMin * 1000) / 1000,
    quality_weight_max: qualityWeightSamples === 0 ? 1 : Math.round(qualityWeightMax * 1000) / 1000,
  };
  const voteSource = {
    inline_votes: directVotes.length,
    blob_votes: blobMeta?.votes.length || 0,
    blob_hash: blobMeta?.source_hash || null,
    blob_codec: blobMeta?.source_codec || null,
    blob_payload_chars: blobMeta?.source_chars || null,
    dedupe_by_agent: dedupeByAgent,
    quality_weighting: qualityWeightingMode,
  };
  const hasConflict = weightedAccept > 0 && weightedReject > 0;
  const shouldEmitDecisionBlob = (() => {
    if (emitBlobRefPolicy === 'always') return true;
    if (emitBlobRefPolicy === 'on_escalate') return outcome === 'escalate_verifier';
    if (emitBlobRefPolicy === 'on_conflict') return hasConflict;
    return false;
  })();
  const decisionBlob = shouldEmitDecisionBlob
    ? maybeStoreDecisionBlob({
      proposal_id: args.proposal_id,
      outcome,
      reasons,
      stats,
      vote_source: voteSource,
      created_at: decision.created_at,
      decision_id: decision.id,
      emit_blob_ref_policy: emitBlobRefPolicy,
      conflict_detected: hasConflict,
    })
    : null;

  if (responseMode === 'tiny') {
    return {
      success: true,
      decision_id: decision.id,
      proposal_id: args.proposal_id,
      outcome,
      stats: {
        disagreement_ratio: stats.disagreement_ratio,
        uncertainty: stats.uncertainty,
        non_abstain_count: stats.non_abstain_count,
        estimated_token_cost: stats.estimated_token_cost,
      },
      reasons_count: reasons.length,
      vote_source: {
        inline_votes: voteSource.inline_votes,
        blob_votes: voteSource.blob_votes,
        dedupe_by_agent: voteSource.dedupe_by_agent,
      },
      emit_blob_ref_policy: emitBlobRefPolicy,
      decision_blob_emitted: Boolean(decisionBlob),
      decision_blob_ref: decisionBlob,
    };
  }

  const baseResponse = {
    success: true,
    decision_id: decision.id,
    proposal_id: args.proposal_id,
    outcome,
    stats,
    vote_source: voteSource,
    emit_blob_ref_policy: emitBlobRefPolicy,
    decision_blob_emitted: Boolean(decisionBlob),
    decision_blob_ref: decisionBlob,
  };

  if (responseMode === 'compact') {
    return {
      ...baseResponse,
      reasons_count: reasons.length,
      reasons: reasons.slice(0, 3),
    };
  }

  return {
    ...baseResponse,
    reasons,
  };
}

type ResolveConsensusSourceBaseArgs = Omit<ResolveConsensusArgs, 'votes' | 'votes_blob_hash' | 'votes_blob_ref'>;

export function handleResolveConsensusFromContext(args: ResolveConsensusSourceBaseArgs & {
  context_id?: number;
  context_agent_id?: string;
  context_key?: string;
}) {
  const hasContextId = Number.isFinite(args.context_id);
  const contextAgentId = typeof args.context_agent_id === 'string' ? args.context_agent_id.trim() : '';
  const contextKey = typeof args.context_key === 'string' ? args.context_key.trim() : '';

  let sourceContext = hasContextId ? getContextById(Number(args.context_id)) : null;
  if (!sourceContext) {
    if (!contextAgentId || !contextKey) {
      const error = 'Provide context_id OR context_agent_id + context_key to resolve consensus source.';
      logActivity(args.requesting_agent, 'resolve_consensus_from_context_rejected', error);
      return { success: false, error_code: 'CONTEXT_SOURCE_REQUIRED', error };
    }
    sourceContext = getContext({ agent_id: contextAgentId, key: contextKey, limit: 1, offset: 0 })[0] || null;
  }
  if (!sourceContext) {
    const error = 'Context source not found';
    logActivity(args.requesting_agent, 'resolve_consensus_from_context_rejected', error);
    return { success: false, error_code: 'CONTEXT_NOT_FOUND', error };
  }
  if (contextAgentId && sourceContext.agent_id !== contextAgentId) {
    const error = `Context source agent mismatch: expected "${contextAgentId}", got "${sourceContext.agent_id}"`;
    logActivity(args.requesting_agent, 'resolve_consensus_from_context_rejected', error);
    return { success: false, error_code: 'CONTEXT_AGENT_MISMATCH', error };
  }
  if (contextKey && sourceContext.key !== contextKey) {
    const error = `Context source key mismatch: expected "${contextKey}", got "${sourceContext.key}"`;
    logActivity(args.requesting_agent, 'resolve_consensus_from_context_rejected', error);
    return { success: false, error_code: 'CONTEXT_KEY_MISMATCH', error };
  }

  const extracted = extractVotesSourceFromText(sourceContext.value);
  if (!extracted) {
    const error = 'Context value must be blob-ref envelope or JSON votes payload';
    logActivity(args.requesting_agent, 'resolve_consensus_from_context_rejected', error);
    return { success: false, error_code: 'UNSUPPORTED_CONTEXT_VOTES_SOURCE', error };
  }

  const resolved = handleResolveConsensus({
    requesting_agent: args.requesting_agent,
    proposal_id: args.proposal_id,
    disagreement_threshold: args.disagreement_threshold,
    min_non_abstain_votes: args.min_non_abstain_votes,
    token_budget_cap: args.token_budget_cap,
    dedupe_by_agent: args.dedupe_by_agent,
    response_mode: args.response_mode,
    emit_blob_ref: args.emit_blob_ref,
    emit_blob_ref_policy: args.emit_blob_ref_policy,
    votes: extracted.votes,
    votes_blob_hash: extracted.votes_blob_hash,
  });

  logActivity(
    args.requesting_agent,
    'resolve_consensus_from_context',
    `proposal=${args.proposal_id} context_id=${sourceContext.id} source_kind=${extracted.source_kind} source_format=${extracted.source_format}`
  );

  return {
    ...(resolved as Record<string, unknown>),
    source_binding: {
      kind: 'context',
      context_id: sourceContext.id,
      context_agent_id: sourceContext.agent_id,
      context_key: sourceContext.key,
      source_kind: extracted.source_kind,
      source_format: extracted.source_format,
    },
  };
}

export function handleResolveConsensusFromMessage(args: ResolveConsensusSourceBaseArgs & {
  message_id: number;
  from_agent?: string;
}) {
  const messageId = Number.isFinite(args.message_id) ? Math.floor(Number(args.message_id)) : 0;
  if (messageId <= 0) {
    const error = 'message_id must be a positive integer';
    logActivity(args.requesting_agent, 'resolve_consensus_from_message_rejected', error);
    return { success: false, error_code: 'INVALID_MESSAGE_ID', error };
  }

  const sourceMessage = getMessageForAgent(args.requesting_agent, messageId);
  if (!sourceMessage) {
    const error = 'Message not found or not accessible for requesting_agent';
    logActivity(args.requesting_agent, 'resolve_consensus_from_message_rejected', error);
    return { success: false, error_code: 'MESSAGE_NOT_FOUND_OR_FORBIDDEN', error };
  }

  const expectedFromAgent = typeof args.from_agent === 'string' ? args.from_agent.trim() : '';
  if (expectedFromAgent && sourceMessage.from_agent !== expectedFromAgent) {
    const error = `Message sender mismatch: expected "${expectedFromAgent}", got "${sourceMessage.from_agent}"`;
    logActivity(args.requesting_agent, 'resolve_consensus_from_message_rejected', error);
    return { success: false, error_code: 'MESSAGE_SENDER_MISMATCH', error };
  }

  let extracted = extractVotesSourceFromText(sourceMessage.content);
  if (!extracted) {
    let parsedMetadata: unknown;
    try {
      parsedMetadata = JSON.parse(sourceMessage.metadata || '{}');
    } catch {
      parsedMetadata = null;
    }
    extracted = extractVotesSourceFromUnknown(parsedMetadata, 'metadata_json');
  }
  if (!extracted) {
    const error = 'Message must contain blob-ref envelope or JSON votes payload (content or metadata)';
    logActivity(args.requesting_agent, 'resolve_consensus_from_message_rejected', error);
    return { success: false, error_code: 'UNSUPPORTED_MESSAGE_VOTES_SOURCE', error };
  }

  const resolved = handleResolveConsensus({
    requesting_agent: args.requesting_agent,
    proposal_id: args.proposal_id,
    disagreement_threshold: args.disagreement_threshold,
    min_non_abstain_votes: args.min_non_abstain_votes,
    token_budget_cap: args.token_budget_cap,
    dedupe_by_agent: args.dedupe_by_agent,
    response_mode: args.response_mode,
    emit_blob_ref: args.emit_blob_ref,
    emit_blob_ref_policy: args.emit_blob_ref_policy,
    votes: extracted.votes,
    votes_blob_hash: extracted.votes_blob_hash,
  });

  logActivity(
    args.requesting_agent,
    'resolve_consensus_from_message',
    `proposal=${args.proposal_id} message_id=${sourceMessage.id} source_kind=${extracted.source_kind} source_format=${extracted.source_format}`
  );

  return {
    ...(resolved as Record<string, unknown>),
    source_binding: {
      kind: 'message',
      message_id: sourceMessage.id,
      from_agent: sourceMessage.from_agent,
      to_agent: sourceMessage.to_agent,
      created_at: sourceMessage.created_at,
      source_kind: extracted.source_kind,
      source_format: extracted.source_format,
    },
  };
}

export function handleListConsensusDecisions(args: {
  requesting_agent?: string;
  proposal_id?: string;
  limit?: number;
  offset?: number;
  response_mode?: 'full' | 'compact' | 'tiny';
}) {
  if (args.requesting_agent) heartbeat(args.requesting_agent);
  const decisions = listConsensusDecisions({
    proposal_id: args.proposal_id,
    limit: args.limit,
    offset: args.offset,
  });
  if (args.requesting_agent) {
    logActivity(args.requesting_agent, 'list_consensus_decisions', `Listed ${decisions.length} consensus decisions`);
  }
  if (args.response_mode === 'compact') {
    return {
      decisions: decisions.map((row) => {
        let uncertainty: number | null = null;
        let disagreementRatio: number | null = null;
        try {
          const stats = JSON.parse(row.stats_json || '{}') as Record<string, unknown>;
          const parsedUncertainty = Number(stats.uncertainty);
          const parsedDisagreement = Number(stats.disagreement_ratio);
          uncertainty = Number.isFinite(parsedUncertainty) ? parsedUncertainty : null;
          disagreementRatio = Number.isFinite(parsedDisagreement) ? parsedDisagreement : null;
        } catch {
          // Keep nulls for malformed stats payloads.
        }
        return {
          id: row.id,
          proposal_id: row.proposal_id,
          requesting_agent: row.requesting_agent,
          outcome: row.outcome,
          created_at: row.created_at,
          uncertainty,
          disagreement_ratio: disagreementRatio,
          reasons_count: (() => {
            try {
              const reasons = JSON.parse(row.reasons_json || '[]');
              return Array.isArray(reasons) ? reasons.length : 0;
            } catch {
              return 0;
            }
          })(),
        };
      }),
    };
  }
  if (args.response_mode === 'tiny') {
    return {
      decisions: decisions.map((row) => ({
        id: row.id,
        proposal_id: row.proposal_id,
        outcome: row.outcome,
        created_at: row.created_at,
      })),
    };
  }
  return { decisions };
}

export const consensusTools = {
  resolve_consensus: {
    description: 'Resolve conflicting outputs via confidence-weighted voting with optional agent-quality weighting. Supports inline votes or blob-backed votes hash/ref and emit_blob_ref_policy for conditional decision payload emission.',
  },
  resolve_consensus_from_context: {
    description: 'Resolve consensus using votes source from context entry (blob-ref or JSON votes), avoiding manual hash extraction.',
  },
  resolve_consensus_from_message: {
    description: 'Resolve consensus using votes source from message content/metadata (blob-ref or JSON votes), avoiding manual glue code.',
  },
  list_consensus_decisions: {
    description: 'List persisted consensus decisions (full/compact/tiny response modes).',
  },
};
