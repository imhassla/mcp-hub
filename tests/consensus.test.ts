import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initDb,
  closeDb,
  registerAgent,
  putProtocolBlob,
  getProtocolBlob,
  sendMessage,
  shareContext,
} from '../src/db.js';
import {
  handleListConsensusDecisions,
  handleResolveConsensus,
  handleResolveConsensusFromContext,
  handleResolveConsensusFromMessage,
} from '../src/tools/consensus.js';
import { decodeLosslessBlobPayload, makeBlobRefEnvelope, sha256Hex } from '../src/utils.js';

beforeEach(() => {
  initDb(':memory:');
  registerAgent({ id: 'arbiter', name: 'Arbiter', type: 'codex', capabilities: 'consensus' });
});

afterEach(() => {
  closeDb();
});

describe('consensus tools', () => {
  it('should accept when weighted accept dominates', () => {
    const result = handleResolveConsensus({
      requesting_agent: 'arbiter',
      proposal_id: 'p1',
      votes: [
        { agent_id: 'a1', decision: 'accept', confidence: 0.9 },
        { agent_id: 'a2', decision: 'accept', confidence: 0.8 },
        { agent_id: 'a3', decision: 'reject', confidence: 0.2 },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.outcome).toBe('accept');
    expect(result.stats.disagreement_ratio).toBeLessThanOrEqual(0.35);
  });

  it('should escalate verifier on high disagreement', () => {
    const result = handleResolveConsensus({
      requesting_agent: 'arbiter',
      proposal_id: 'p2',
      votes: [
        { agent_id: 'a1', decision: 'accept', confidence: 0.9 },
        { agent_id: 'a2', decision: 'reject', confidence: 0.9 },
      ],
      disagreement_threshold: 0.2,
    });

    expect(result.success).toBe(true);
    expect(result.outcome).toBe('escalate_verifier');
    expect(result.reasons.some((reason) => reason.startsWith('high_disagreement:'))).toBe(true);
  });

  it('should escalate verifier with mostly abstain votes', () => {
    const result = handleResolveConsensus({
      requesting_agent: 'arbiter',
      proposal_id: 'p3',
      votes: [
        { agent_id: 'a1', decision: 'abstain' },
        { agent_id: 'a2', decision: 'accept', confidence: 0.8 },
      ],
      min_non_abstain_votes: 2,
    });

    expect(result.success).toBe(true);
    expect(result.outcome).toBe('escalate_verifier');
    expect(result.reasons.some((reason) => reason.startsWith('insufficient_non_abstain_votes:'))).toBe(true);
  });

  it('list_consensus_decisions compact mode should omit heavy payloads', () => {
    handleResolveConsensus({
      requesting_agent: 'arbiter',
      proposal_id: 'pc',
      votes: [
        { agent_id: 'a1', decision: 'accept', confidence: 0.9 },
        { agent_id: 'a2', decision: 'reject', confidence: 0.2 },
      ],
    });

    const listed = handleListConsensusDecisions({ requesting_agent: 'arbiter', response_mode: 'compact' });
    expect(listed.decisions).toHaveLength(1);
    expect(listed.decisions[0].proposal_id).toBe('pc');
    expect(listed.decisions[0].reasons_count).toBeTypeOf('number');
    expect((listed.decisions[0] as Record<string, unknown>).stats_json).toBeUndefined();
  });

  it('should resolve consensus from votes blob and emit tiny response + decision blob ref', () => {
    const votesPayload = JSON.stringify({
      votes: [
        { agent_id: 'a1', decision: 'accept', confidence: 0.9 },
        { agent_id: 'a1', decision: 'reject', confidence: 0.1 },
        { agent_id: 'a2', decision: 'accept', confidence: 0.8 },
      ],
    });
    const votesHash = sha256Hex(votesPayload);
    putProtocolBlob(votesHash, votesPayload);

    const result = handleResolveConsensus({
      requesting_agent: 'arbiter',
      proposal_id: 'p-blob',
      votes_blob_hash: votesHash,
      response_mode: 'tiny',
      emit_blob_ref: true,
    });

    expect(result.success).toBe(true);
    expect(result.outcome).toBe('accept');
    expect(result.vote_source.blob_votes).toBe(3);
    expect(result.vote_source.dedupe_by_agent).toBe(true);
    expect(result.reasons_count).toBe(0);
    expect(result.decision_blob_ref).toBeTruthy();
    if (!result.decision_blob_ref) return;

    const decisionBlob = getProtocolBlob(result.decision_blob_ref.hash);
    expect(decisionBlob).toBeTruthy();
    if (!decisionBlob) return;

    const decoded = decodeLosslessBlobPayload(decisionBlob.value);
    expect(decoded.integrity_ok).toBe(true);
    const payload = JSON.parse(decoded.value) as Record<string, unknown>;
    expect(payload.proposal_id).toBe('p-blob');
    expect(payload.outcome).toBe('accept');
  });

  it('should reject malformed votes blob with integrity failure', () => {
    const malformedEnvelope = JSON.stringify({
      v: 'caep-blobz-1',
      alg: 'brotli-base64',
      raw_chars: 24,
      raw_sha256: '0'.repeat(64),
      data: 'not-valid-brotli',
    });
    const hash = sha256Hex(malformedEnvelope);
    putProtocolBlob(hash, malformedEnvelope);

    const result = handleResolveConsensus({
      requesting_agent: 'arbiter',
      proposal_id: 'p-corrupt',
      votes_blob_hash: hash,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error_code).toBe('VOTES_BLOB_INTEGRITY_FAILED');
  });

  it('list_consensus_decisions tiny mode should return only minimal fields', () => {
    handleResolveConsensus({
      requesting_agent: 'arbiter',
      proposal_id: 'pt',
      votes: [
        { agent_id: 'a1', decision: 'accept', confidence: 0.9 },
        { agent_id: 'a2', decision: 'accept', confidence: 0.9 },
      ],
    });
    const listed = handleListConsensusDecisions({ requesting_agent: 'arbiter', response_mode: 'tiny' });
    expect(listed.decisions).toHaveLength(1);
    expect(listed.decisions[0].proposal_id).toBe('pt');
    expect((listed.decisions[0] as Record<string, unknown>).requesting_agent).toBeUndefined();
    expect((listed.decisions[0] as Record<string, unknown>).stats_json).toBeUndefined();
  });

  it('emit_blob_ref_policy on_escalate should emit only for escalated outcome', () => {
    const escalated = handleResolveConsensus({
      requesting_agent: 'arbiter',
      proposal_id: 'p-policy-escalate',
      votes: [
        { agent_id: 'a1', decision: 'accept', confidence: 0.9 },
        { agent_id: 'a2', decision: 'reject', confidence: 0.9 },
      ],
      disagreement_threshold: 0.2,
      emit_blob_ref_policy: 'on_escalate',
    });
    expect(escalated.success).toBe(true);
    expect(escalated.outcome).toBe('escalate_verifier');
    expect(escalated.decision_blob_emitted).toBe(true);
    expect(escalated.decision_blob_ref).toBeTruthy();

    const accepted = handleResolveConsensus({
      requesting_agent: 'arbiter',
      proposal_id: 'p-policy-accepted',
      votes: [
        { agent_id: 'a1', decision: 'accept', confidence: 0.9 },
        { agent_id: 'a2', decision: 'accept', confidence: 0.8 },
      ],
      emit_blob_ref_policy: 'on_escalate',
    });
    expect(accepted.success).toBe(true);
    expect(accepted.outcome).toBe('accept');
    expect(accepted.decision_blob_emitted).toBe(false);
    expect(accepted.decision_blob_ref).toBeNull();
  });

  it('emit_blob_ref_policy on_conflict should emit only when both sides voted', () => {
    const conflict = handleResolveConsensus({
      requesting_agent: 'arbiter',
      proposal_id: 'p-policy-conflict',
      votes: [
        { agent_id: 'a1', decision: 'accept', confidence: 0.9 },
        { agent_id: 'a2', decision: 'reject', confidence: 0.1 },
      ],
      disagreement_threshold: 0.8,
      emit_blob_ref_policy: 'on_conflict',
    });
    expect(conflict.success).toBe(true);
    expect(conflict.decision_blob_emitted).toBe(true);
    expect(conflict.decision_blob_ref).toBeTruthy();

    const noConflict = handleResolveConsensus({
      requesting_agent: 'arbiter',
      proposal_id: 'p-policy-no-conflict',
      votes: [
        { agent_id: 'a1', decision: 'accept', confidence: 0.9 },
        { agent_id: 'a2', decision: 'accept', confidence: 0.8 },
      ],
      emit_blob_ref_policy: 'on_conflict',
    });
    expect(noConflict.success).toBe(true);
    expect(noConflict.decision_blob_emitted).toBe(false);
    expect(noConflict.decision_blob_ref).toBeNull();
  });

  it('resolve_consensus_from_context should resolve blob-ref source without manual hash glue', () => {
    const votesPayload = JSON.stringify({
      votes: [
        { agent_id: 'a1', decision: 'accept', confidence: 0.8 },
        { agent_id: 'a2', decision: 'accept', confidence: 0.7 },
      ],
    });
    const hash = sha256Hex(votesPayload);
    putProtocolBlob(hash, votesPayload);
    const ref = makeBlobRefEnvelope(hash, votesPayload.length);
    const ctx = shareContext('worker-1', 'votes-payload', ref);

    const result = handleResolveConsensusFromContext({
      requesting_agent: 'arbiter',
      proposal_id: 'p-from-context',
      context_id: ctx.id,
      response_mode: 'tiny',
    });

    expect(result.success).toBe(true);
    expect(result.outcome).toBe('accept');
    expect(result.source_binding.kind).toBe('context');
    expect(result.source_binding.context_id).toBe(ctx.id);
    expect(result.source_binding.source_kind).toBe('blob_ref');
  });

  it('resolve_consensus_from_message should resolve source from message content/metadata', () => {
    const votesPayload = JSON.stringify([
      { agent_id: 'a1', decision: 'accept', confidence: 0.8 },
      { agent_id: 'a2', decision: 'accept', confidence: 0.7 },
    ]);
    const hash = sha256Hex(votesPayload);
    putProtocolBlob(hash, votesPayload);
    const ref = makeBlobRefEnvelope(hash, votesPayload.length);
    const msg = sendMessage('worker-1', 'arbiter', ref, '{}');

    const fromContent = handleResolveConsensusFromMessage({
      requesting_agent: 'arbiter',
      proposal_id: 'p-from-message-content',
      message_id: msg.id,
      response_mode: 'tiny',
    });
    expect(fromContent.success).toBe(true);
    expect(fromContent.outcome).toBe('accept');
    expect(fromContent.source_binding.kind).toBe('message');
    expect(fromContent.source_binding.message_id).toBe(msg.id);
    expect(fromContent.source_binding.source_kind).toBe('blob_ref');

    const metaMsg = sendMessage('worker-2', 'arbiter', 'votes-in-metadata', JSON.stringify({
      votes: [
        { agent_id: 'a3', decision: 'accept', confidence: 0.9 },
        { agent_id: 'a4', decision: 'accept', confidence: 0.8 },
      ],
    }));
    const fromMetadata = handleResolveConsensusFromMessage({
      requesting_agent: 'arbiter',
      proposal_id: 'p-from-message-metadata',
      message_id: metaMsg.id,
      from_agent: 'worker-2',
      response_mode: 'tiny',
    });
    expect(fromMetadata.success).toBe(true);
    expect(fromMetadata.outcome).toBe('accept');
    expect(fromMetadata.source_binding.source_format).toBe('metadata_json');
  });
});
