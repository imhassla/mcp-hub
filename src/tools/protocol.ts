import { heartbeat, logActivity, putProtocolBlob, getProtocolBlob, listProtocolBlobs } from '../db.js';
import { collapseWhitespace, sha256Hex, estimateTokens } from '../utils.js';

type PackMode = 'auto' | 'json' | 'dictionary';
type PayloadFormat = 'json' | 'text';

const DEFAULT_AUTO_PACK_MIN_PAYLOAD_CHARS = Number.isFinite(Number(process.env.MCP_HUB_AUTO_PACK_MIN_PAYLOAD_CHARS))
  ? Math.max(0, Math.floor(Number(process.env.MCP_HUB_AUTO_PACK_MIN_PAYLOAD_CHARS)))
  : 2048;
const DEFAULT_AUTO_PACK_MIN_GAIN_PCT = Number.isFinite(Number(process.env.MCP_HUB_AUTO_PACK_MIN_GAIN_PCT))
  ? Math.max(0, Math.min(100, Number(process.env.MCP_HUB_AUTO_PACK_MIN_GAIN_PCT)))
  : 3;

const KEY_TO_ALIAS: Record<string, string> = {
  experiment: 'e',
  experiment_id: 'e',
  agent: 'a',
  agent_id: 'a',
  task: 't',
  task_id: 't',
  status: 's',
  confidence: 'c',
  summary: 'm',
  metadata: 'md',
  timestamp: 'ts',
  created_at: 'ts',
  updated_at: 'tu',
  refs: 'r',
  references: 'r',
  depends_on: 'd',
  priority: 'p',
  outcome: 'o',
  uncertainty: 'u',
  evidence: 'ev',
  verifier: 'v',
  recommendations: 'recs',
  recommendation: 'rec',
  message: 'msg',
  content: 'x',
  text: 'x',
};

const ALIAS_TO_KEY: Record<string, string> = {
  e: 'experiment',
  a: 'agent_id',
  t: 'task_id',
  s: 'status',
  c: 'confidence',
  m: 'summary',
  md: 'metadata',
  ts: 'timestamp',
  tu: 'updated_at',
  r: 'refs',
  d: 'depends_on',
  p: 'priority',
  o: 'outcome',
  u: 'uncertainty',
  ev: 'evidence',
  v: 'verifier',
  recs: 'recommendations',
  rec: 'recommendation',
  msg: 'message',
  x: 'content',
};

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const sortedKeys = Object.keys(input).sort();
    const output: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      output[key] = sortKeysDeep(input[key]);
    }
    return output;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function toShortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toShortKeys);
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(input)) {
      const alias = KEY_TO_ALIAS[key] || key;
      output[alias] = toShortKeys(nested);
    }
    return output;
  }
  return value;
}

function toLongKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toLongKeys);
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(input)) {
      const expanded = ALIAS_TO_KEY[key] || key;
      output[expanded] = toLongKeys(nested);
    }
    return output;
  }
  return value;
}

function parsePayload(payload: string, format: PayloadFormat): unknown {
  if (format === 'json') return JSON.parse(payload);
  return { text: payload };
}

export function handlePackProtocolMessage(args: {
  agent_id: string;
  payload: string;
  payload_format?: PayloadFormat;
  mode?: PackMode;
  auto_min_payload_chars?: number;
  auto_min_gain_pct?: number;
}) {
  heartbeat(args.agent_id);
  const payloadFormat = args.payload_format || 'json';
  const requestedMode = args.mode || 'auto';
  const minPayloadChars = Number.isFinite(args.auto_min_payload_chars)
    ? Math.max(0, Math.floor(Number(args.auto_min_payload_chars)))
    : DEFAULT_AUTO_PACK_MIN_PAYLOAD_CHARS;
  const minGainPct = Number.isFinite(args.auto_min_gain_pct)
    ? Math.max(0, Math.min(100, Number(args.auto_min_gain_pct)))
    : DEFAULT_AUTO_PACK_MIN_GAIN_PCT;

  let parsedPayload: unknown;
  try {
    parsedPayload = parsePayload(args.payload, payloadFormat);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid payload';
    logActivity(args.agent_id, 'pack_protocol_message_failed', `Payload parse failed: ${message}`);
    return { success: false, error_code: 'INVALID_PAYLOAD', error: message };
  }

  const normalized = sortKeysDeep(parsedPayload);
  const jsonEncoded = normalized;
  const dictEncoded = toShortKeys(normalized);
  const jsonEncodedStr = canonicalJson(jsonEncoded);
  const dictEncodedStr = canonicalJson(dictEncoded);
  const dictionaryGainPctRaw = jsonEncodedStr.length > 0
    ? ((jsonEncodedStr.length - dictEncodedStr.length) / jsonEncodedStr.length) * 100
    : 0;
  const dictionaryGainPct = Math.round(dictionaryGainPctRaw * 100) / 100;
  let decisionReason = 'forced_mode';

  const selected = (() => {
    if (requestedMode === 'json') {
      decisionReason = 'forced_json';
      return { encoding: 'json' as const, data: jsonEncoded, dataStr: jsonEncodedStr };
    }
    if (requestedMode === 'dictionary') {
      decisionReason = 'forced_dictionary';
      return { encoding: 'dictionary' as const, data: dictEncoded, dataStr: dictEncodedStr };
    }
    // auto
    if (args.payload.length < minPayloadChars) {
      decisionReason = 'below_min_payload_chars';
      return { encoding: 'json' as const, data: jsonEncoded, dataStr: jsonEncodedStr };
    }
    if (dictionaryGainPct < minGainPct) {
      decisionReason = 'below_min_gain_pct';
      return { encoding: 'json' as const, data: jsonEncoded, dataStr: jsonEncodedStr };
    }
    decisionReason = 'gain_threshold_met';
    if (dictEncodedStr.length <= jsonEncodedStr.length) {
      return { encoding: 'dictionary' as const, data: dictEncoded, dataStr: dictEncodedStr };
    }
    decisionReason = 'dictionary_not_smaller';
    return { encoding: 'json' as const, data: jsonEncoded, dataStr: jsonEncodedStr };
  })();

  const packetBody = {
    v: 'caep-1',
    fmt: payloadFormat,
    enc: selected.encoding,
    ts: Date.now(),
    d: selected.data,
  };
  const packetCanonicalForHash = canonicalJson(packetBody);
  const hash = sha256Hex(packetCanonicalForHash);
  const packet = {
    ...packetBody,
    h: hash,
  };
  const packetJson = JSON.stringify(packet);

  const originalChars = args.payload.length;
  const packedChars = packetJson.length;
  const savingsChars = originalChars - packedChars;
  const savingsPct = originalChars > 0 ? Math.round((savingsChars / originalChars) * 10000) / 100 : 0;

  logActivity(
    args.agent_id,
    'pack_protocol_message',
    `Packed payload fmt=${payloadFormat} mode=${requestedMode}->${selected.encoding} reason=${decisionReason} gain=${dictionaryGainPct.toFixed(2)}% chars=${originalChars}->${packedChars} hash=${hash.slice(0, 12)}`
  );

  return {
    success: true,
    packet_json: packetJson,
    packet,
    policy: {
      mode: requestedMode,
      min_payload_chars: minPayloadChars,
      min_gain_pct: minGainPct,
      decision: decisionReason,
      dictionary_candidate_gain_pct: dictionaryGainPct,
      dictionary_applied: selected.encoding === 'dictionary',
    },
    metrics: {
      original_chars: originalChars,
      packed_chars: packedChars,
      savings_chars: savingsChars,
      savings_pct: savingsPct,
      original_tokens_est: estimateTokens(originalChars),
      packed_tokens_est: estimateTokens(packedChars),
      payload_json_chars: jsonEncodedStr.length,
      payload_dictionary_chars: dictEncodedStr.length,
      dictionary_candidate_gain_pct: dictionaryGainPct,
    },
  };
}

export function handleUnpackProtocolMessage(args: {
  agent_id: string;
  packet_json: string;
  response_mode?: 'full' | 'compact';
}) {
  heartbeat(args.agent_id);

  let packet: {
    v: string;
    fmt: PayloadFormat;
    enc: 'json' | 'dictionary';
    ts: number;
    d: unknown;
    h: string;
  };
  try {
    packet = JSON.parse(args.packet_json);
  } catch {
    return { success: false, error_code: 'INVALID_PACKET', error: 'packet_json is not valid JSON' };
  }

  if (!packet || packet.v !== 'caep-1') {
    return { success: false, error_code: 'UNSUPPORTED_PACKET', error: 'Unsupported packet version' };
  }
  if (packet.enc !== 'json' && packet.enc !== 'dictionary') {
    return { success: false, error_code: 'UNSUPPORTED_ENCODING', error: 'Unsupported packet encoding' };
  }

  const canonicalWithoutHash = canonicalJson({
    v: packet.v,
    fmt: packet.fmt,
    enc: packet.enc,
    ts: packet.ts,
    d: packet.d,
  });
  const computedHash = sha256Hex(canonicalWithoutHash);
  const hashValid = computedHash === packet.h;

  const decoded = packet.enc === 'dictionary' ? toLongKeys(packet.d) : packet.d;
  const payloadObject = decoded;
  const payloadText = packet.fmt === 'text'
    ? String((payloadObject as Record<string, unknown>).text ?? '')
    : canonicalJson(payloadObject);

  logActivity(args.agent_id, 'unpack_protocol_message', `Unpacked packet hash_valid=${hashValid} hash=${packet.h.slice(0, 12)}`);

  if (args.response_mode === 'compact') {
    return {
      success: true,
      hash_valid: hashValid,
      format: packet.fmt,
      encoding: packet.enc,
      hash: packet.h,
      payload_chars: payloadText.length,
    };
  }

  return {
    success: true,
    hash_valid: hashValid,
    format: packet.fmt,
    encoding: packet.enc,
    hash: packet.h,
    decoded_payload: packet.fmt === 'text' ? payloadText : payloadObject,
  };
}

export function handleHashPayload(args: {
  agent_id: string;
  payload: string;
  normalize_json?: boolean;
  truncate?: number;
}) {
  heartbeat(args.agent_id);
  let source = args.payload;
  if (args.normalize_json) {
    try {
      source = canonicalJson(JSON.parse(args.payload));
    } catch {
      return { success: false, error_code: 'INVALID_JSON', error: 'normalize_json=true requires valid JSON payload' };
    }
  }
  const full = sha256Hex(source);
  const truncateTo = Number.isFinite(args.truncate) ? Math.max(8, Math.min(64, Math.floor(Number(args.truncate)))) : 16;
  const short = full.slice(0, truncateTo);
  logActivity(args.agent_id, 'hash_payload', `Hashed payload chars=${source.length} short=${short}`);
  return {
    success: true,
    hash: full,
    short_hash: short,
    payload_chars: source.length,
  };
}

function compressForBlob(value: string, mode: 'none' | 'json' | 'whitespace' | 'auto'): string {
  const canonicalizeMaybeJson = (input: string): string => {
    try {
      return canonicalJson(JSON.parse(input));
    } catch {
      return input;
    }
  };

  if (mode === 'none') return value;
  if (mode === 'json') return canonicalizeMaybeJson(value);
  if (mode === 'whitespace') return collapseWhitespace(value);
  const normalized = canonicalizeMaybeJson(value);
  const collapsed = collapseWhitespace(value);
  return [value, normalized, collapsed].reduce((best, candidate) => candidate.length < best.length ? candidate : best, value);
}

export function handleStoreProtocolBlob(args: {
  agent_id: string;
  payload: string;
  compression_mode?: 'none' | 'json' | 'whitespace' | 'auto';
  hash_truncate?: number;
}) {
  heartbeat(args.agent_id);
  const mode = args.compression_mode || 'auto';
  const storedValue = compressForBlob(args.payload, mode);
  const fullHash = sha256Hex(storedValue);
  const shortLen = Number.isFinite(args.hash_truncate) ? Math.max(8, Math.min(64, Math.floor(Number(args.hash_truncate)))) : 16;
  const { blob, created } = putProtocolBlob(fullHash, storedValue);

  logActivity(
    args.agent_id,
    'store_protocol_blob',
    `Stored protocol blob hash=${fullHash.slice(0, 12)} created=${created} chars=${storedValue.length} mode=${mode}`
  );

  return {
    success: true,
    created,
    hash: fullHash,
    short_hash: fullHash.slice(0, shortLen),
    blob_chars: storedValue.length,
    compression_mode: mode,
    blob: {
      hash: blob.hash,
      created_at: blob.created_at,
      updated_at: blob.updated_at,
      access_count: blob.access_count,
    },
  };
}

export function handleGetProtocolBlob(args: {
  agent_id: string;
  hash: string;
  response_mode?: 'full' | 'compact';
}) {
  heartbeat(args.agent_id);
  const blob = getProtocolBlob(args.hash);
  if (!blob) {
    return { success: false, error_code: 'BLOB_NOT_FOUND', error: 'Blob hash not found' };
  }

  logActivity(args.agent_id, 'get_protocol_blob', `Read protocol blob hash=${args.hash.slice(0, 12)} chars=${blob.value.length}`);

  if (args.response_mode === 'compact') {
    return {
      success: true,
      blob: {
        hash: blob.hash,
        value_preview: blob.value.slice(0, 180),
        value_chars: blob.value.length,
        access_count: blob.access_count,
        updated_at: blob.updated_at,
      },
    };
  }

  return { success: true, blob };
}

export function handleListProtocolBlobs(args: {
  agent_id: string;
  limit?: number;
  offset?: number;
}) {
  heartbeat(args.agent_id);
  const blobs = listProtocolBlobs(args.limit, args.offset);
  logActivity(args.agent_id, 'list_protocol_blobs', `Listed ${blobs.length} protocol blobs`);
  return {
    success: true,
    blobs: blobs.map((blob) => ({
      hash: blob.hash,
      value_chars: blob.value.length,
      created_at: blob.created_at,
      updated_at: blob.updated_at,
      access_count: blob.access_count,
    })),
  };
}

export const protocolTools = {
  pack_protocol_message: {
    description: 'Pack payload into compact CAEP-v1 packet with adaptive lossless policy in auto mode (dictionary only when payload and gain thresholds are met).',
  },
  unpack_protocol_message: {
    description: 'Unpack CAEP-v1 packet, validate hash integrity, and restore payload.',
  },
  hash_payload: {
    description: 'Compute deterministic SHA-256 payload hash (optionally JSON-normalized) for references and dedup.',
  },
  store_protocol_blob: {
    description: 'Store payload blob by hash (deduplicated) for hash-reference exchange between agents.',
  },
  get_protocol_blob: {
    description: 'Get payload blob by hash for resolving hash references.',
  },
  list_protocol_blobs: {
    description: 'List recently used protocol blobs and access counters.',
  },
};
