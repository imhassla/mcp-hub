#!/usr/bin/env bash
set -euo pipefail

ENDPOINT="${ENDPOINT:-http://localhost:3300/mcp}"
RUNS="${RUNS:-60}"
VOTES="${VOTES:-96}"
OUT_DIR="${OUT_DIR:-/tmp/consensus-ab}"
MCP_HTTP_CONNECT_TIMEOUT_SEC="${MCP_HTTP_CONNECT_TIMEOUT_SEC:-3}"
MCP_HTTP_TIMEOUT_SEC="${MCP_HTTP_TIMEOUT_SEC:-25}"
MCP_HTTP_RETRIES="${MCP_HTTP_RETRIES:-2}"
MCP_HTTP_RETRY_DELAY_SEC="${MCP_HTTP_RETRY_DELAY_SEC:-1}"
MCP_REINIT_ON_SESSION_ERROR="${MCP_REINIT_ON_SESSION_ERROR:-1}"
INLINE_RESPONSE_MODE="${INLINE_RESPONSE_MODE:-full}" # full | compact | tiny
BLOB_RESPONSE_MODE="${BLOB_RESPONSE_MODE:-tiny}"     # full | compact | tiny
BLOB_COMPRESSION_MODE="${BLOB_COMPRESSION_MODE:-auto}" # none | json | whitespace | auto
EMIT_BLOB_REF="${EMIT_BLOB_REF:-true}" # true | false
EMIT_BLOB_REF_POLICY="${EMIT_BLOB_REF_POLICY:-}" # never | always | on_escalate | on_conflict
BLOB_STORE_STRATEGY="${BLOB_STORE_STRATEGY:-per_run}" # per_run | preloaded
HEALTH_URL="${ENDPOINT%/mcp}/health"

mkdir -p "$OUT_DIR"
RUN_TAG="CONSAB-$(date +%s)-$$-$RANDOM"
REPORT_FILE="$OUT_DIR/${RUN_TAG}.json"

now_ms() {
  perl -MTime::HiRes=time -e 'printf("%.0f\n", time()*1000)'
}

estimate_tokens() {
  local chars="$1"
  echo $(( (chars + 3) / 4 ))
}

extract_payload() {
  local raw="$1"
  local data
  data=$(printf '%s\n' "$raw" | sed -n 's/^data: //p' | tail -n 1)
  if [ -n "$data" ]; then
    printf '%s' "$data"
  else
    printf '%s' "$raw"
  fi
}

wait_for_hub() {
  local attempts=20
  local i=1
  while [ "$i" -le "$attempts" ]; do
    if curl -sS --connect-timeout "$MCP_HTTP_CONNECT_TIMEOUT_SEC" --max-time "$MCP_HTTP_TIMEOUT_SEC" "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  echo "hub is not reachable at $HEALTH_URL" >&2
  return 1
}

curl_post_json() {
  local sid="$1"
  local payload="$2"
  local attempt=1
  local response=''
  while [ "$attempt" -le $((MCP_HTTP_RETRIES + 1)) ]; do
    local -a args
    args=(
      -sS
      --connect-timeout "$MCP_HTTP_CONNECT_TIMEOUT_SEC"
      --max-time "$MCP_HTTP_TIMEOUT_SEC"
      -X POST "$ENDPOINT"
      -H 'Content-Type: application/json'
      -H 'Accept: application/json, text/event-stream'
    )
    if [ -n "$sid" ]; then
      args+=(-H "mcp-session-id: $sid")
    fi
    args+=(--data "$payload")

    if response=$(curl "${args[@]}"); then
      printf '%s' "$response"
      return 0
    fi
    if [ "$attempt" -le "$MCP_HTTP_RETRIES" ]; then
      sleep "$MCP_HTTP_RETRY_DELAY_SEC"
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

curl_init_post() {
  local payload="$1"
  local attempt=1
  local response=''
  while [ "$attempt" -le $((MCP_HTTP_RETRIES + 1)) ]; do
    if response=$(curl -i -sS \
      --connect-timeout "$MCP_HTTP_CONNECT_TIMEOUT_SEC" \
      --max-time "$MCP_HTTP_TIMEOUT_SEC" \
      -X POST "$ENDPOINT" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      --data "$payload"); then
      printf '%s' "$response"
      return 0
    fi
    if [ "$attempt" -le "$MCP_HTTP_RETRIES" ]; then
      sleep "$MCP_HTTP_RETRY_DELAY_SEC"
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

is_reinitable_session_error() {
  local payload="$1"
  local code msg flag reason
  code=$(printf '%s' "$payload" | jq -r '.error.code // empty' 2>/dev/null || true)
  if [ "$code" != "-32000" ]; then
    return 1
  fi
  flag=$(printf '%s' "$payload" | jq -r '.error.data.reinitialize_required // empty' 2>/dev/null || true)
  if [ "$flag" = "true" ]; then
    return 0
  fi
  reason=$(printf '%s' "$payload" | jq -r '.error.data.reason // empty' 2>/dev/null || true)
  case "$reason" in
    unknown_or_expired_session|server_not_initialized|no_active_session)
      return 0
      ;;
  esac
  msg=$(printf '%s' "$payload" | jq -r '.error.message // empty' 2>/dev/null || true)
  case "$msg" in
    *"Server not initialized"*|*"Unknown or expired MCP session"*|*"No active session"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

LAST_VALID_SID=''

mcp_init() {
  local init_payload initialized_payload init_response session_id
  init_payload='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"consensus-ab-runner","version":"1.0.0"}}}'
  initialized_payload='{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'

  if ! init_response=$(curl_init_post "$init_payload"); then
    echo "failed to reach MCP endpoint during initialize: $ENDPOINT" >&2
    return 1
  fi

  session_id=$(printf '%s\n' "$init_response" | awk '/^mcp-session-id:/ {print $2}' | tr -d '\r')
  if [ -z "$session_id" ]; then
    echo "failed to initialize MCP session" >&2
    printf '%s\n' "$init_response" | sed -n '1,80p' >&2
    return 1
  fi

  if ! curl_post_json "$session_id" "$initialized_payload" >/dev/null; then
    echo "failed to send initialized notification" >&2
    return 1
  fi

  LAST_VALID_SID="$session_id"
  printf '%s' "$session_id"
}

mcp_reinit() {
  local prev_sid="${LAST_VALID_SID:-}"
  local new_sid
  if ! new_sid=$(mcp_init); then
    return 1
  fi
  if [ -n "$prev_sid" ] && [ "$prev_sid" != "$new_sid" ]; then
    mcp_close "$prev_sid" || true
  fi
  LAST_VALID_SID="$new_sid"
  return 0
}

mcp_close() {
  local sid="${1:-${LAST_VALID_SID:-}}"
  if [ -z "$sid" ]; then
    return 0
  fi
  curl -sS \
    --connect-timeout "$MCP_HTTP_CONNECT_TIMEOUT_SEC" \
    --max-time "$MCP_HTTP_TIMEOUT_SEC" \
    -X DELETE "$ENDPOINT" \
    -H "mcp-session-id: $sid" >/dev/null || true
  if [ "${LAST_VALID_SID:-}" = "$sid" ]; then
    LAST_VALID_SID=''
  fi
}

CALL_REQ_CHARS=0
CALL_RESP_CHARS=0
CALL_LATENCY_MS=0
TOOL_RESULT=''

mcp_tool_call() {
  local sid="$1"
  local tool="$2"
  local args_json="$3"
  local request_json response payload text t0 t1 effective_sid reinit_attempted=0

  request_json=$(jq -cn --arg name "$tool" --argjson args "$args_json" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$name,arguments:$args}}')
  CALL_REQ_CHARS=${#request_json}

  while true; do
    effective_sid="${LAST_VALID_SID:-$sid}"
    t0=$(now_ms)
    if ! response=$(curl_post_json "$effective_sid" "$request_json"); then
      echo "tool call transport failure: $tool" >&2
      return 1
    fi
    t1=$(now_ms)
    CALL_LATENCY_MS=$((t1 - t0))

    payload=$(extract_payload "$response")
    if printf '%s' "$payload" | jq -e '.error' >/dev/null 2>&1; then
      if [ "$MCP_REINIT_ON_SESSION_ERROR" = "1" ] && [ "$reinit_attempted" -eq 0 ] && is_reinitable_session_error "$payload"; then
        reinit_attempted=1
        if mcp_reinit; then
          continue
        fi
      fi
      echo "tool call failed: $tool" >&2
      printf '%s' "$payload" | jq '.' >&2 || printf '%s\n' "$payload" >&2
      return 1
    fi

    text=$(printf '%s' "$payload" | jq -r '.result.content[0].text // empty')
    if [ -z "$text" ]; then
      echo "unexpected tool response (no text) for $tool" >&2
      printf '%s\n' "$payload" >&2
      return 1
    fi
    CALL_RESP_CHARS=${#text}
    TOOL_RESULT="$text"
    return 0
  done
}

generate_votes_payload() {
  local seed="$1"
  jq -cn --argjson n "$VOTES" --argjson seed "$seed" '
    ([range(0; $n) as $i |
      if (($i + $seed) % 11 == 0) then
        {agent_id:("agent-"+($i|tostring)), decision:"abstain"}
      elif (($i + $seed) % 5 == 0) then
        {agent_id:("agent-"+($i|tostring)), decision:"reject", confidence:(0.55 + ((($i + $seed) % 30)/100))}
      else
        {agent_id:("agent-"+($i|tostring)), decision:"accept", confidence:(0.65 + ((($i + $seed) % 30)/100))}
      end
    ]) + [
      {agent_id:"agent-dup-0", decision:"accept", confidence:(0.72 + (($seed % 10)/100))},
      {agent_id:"agent-dup-0", decision:"reject", confidence:0.31}
    ]
  '
}

wait_for_hub
SESSION_ID=$(mcp_init)
trap 'mcp_close "$SESSION_ID"' EXIT

AGENT_ID="consensus-ab-orchestrator"
mcp_tool_call "$SESSION_ID" register_agent "$(jq -cn --arg id "$AGENT_ID" '{id:$id,name:"Consensus AB Runner",type:"codex",capabilities:"benchmark,consensus",onboarding_mode:"none",lifecycle:"ephemeral",runtime_profile:{mode:"repo",has_git:true,file_count:1,empty_dir:false,source:"client_declared"}}')"

inline_req_total=0
inline_resp_total=0
inline_latency_total=0
inline_success=0

blob_store_req_total=0
blob_store_resp_total=0
blob_store_latency_total=0
blob_store_success=0
blob_store_created=0
blob_store_calls=0

blob_resolve_req_total=0
blob_resolve_resp_total=0
blob_resolve_latency_total=0
blob_resolve_success=0
blob_emit_ref_count=0

outcome_match=0
outcome_mismatch=0

preloaded_votes_payload=''
preloaded_blob_hash=''
if [ "$BLOB_STORE_STRATEGY" = "preloaded" ]; then
  preloaded_votes_payload=$(generate_votes_payload 1)
  store_args=$(jq -cn \
    --arg agent "$AGENT_ID" \
    --arg payload "$preloaded_votes_payload" \
    --arg mode "$BLOB_COMPRESSION_MODE" \
    '{agent_id:$agent,payload:$payload,compression_mode:$mode}')
  mcp_tool_call "$SESSION_ID" store_protocol_blob "$store_args"
  blob_store_calls=$((blob_store_calls + 1))
  blob_store_req_total=$((blob_store_req_total + CALL_REQ_CHARS))
  blob_store_resp_total=$((blob_store_resp_total + CALL_RESP_CHARS))
  blob_store_latency_total=$((blob_store_latency_total + CALL_LATENCY_MS))
  store_ok=$(printf '%s' "$TOOL_RESULT" | jq -r '.success // false')
  preloaded_blob_hash=$(printf '%s' "$TOOL_RESULT" | jq -r '.hash // empty')
  store_created=$(printf '%s' "$TOOL_RESULT" | jq -r '.created // false')
  if [ "$store_ok" = "true" ]; then
    blob_store_success=$((blob_store_success + 1))
  fi
  if [ "$store_created" = "true" ]; then
    blob_store_created=$((blob_store_created + 1))
  fi
fi

for i in $(seq 1 "$RUNS"); do
  proposal_inline="${RUN_TAG}-inline-${i}"
  proposal_blob="${RUN_TAG}-blob-${i}"
  votes_payload=$(if [ "$BLOB_STORE_STRATEGY" = "preloaded" ]; then printf '%s' "$preloaded_votes_payload"; else generate_votes_payload "$i"; fi)

  inline_args=$(jq -cn \
    --arg agent "$AGENT_ID" \
    --arg proposal "$proposal_inline" \
    --arg mode "$INLINE_RESPONSE_MODE" \
    --argjson votes "$votes_payload" \
    '{
      requesting_agent:$agent,
      proposal_id:$proposal,
      votes:$votes,
      response_mode:$mode
    }')
  mcp_tool_call "$SESSION_ID" resolve_consensus "$inline_args"
  inline_req_total=$((inline_req_total + CALL_REQ_CHARS))
  inline_resp_total=$((inline_resp_total + CALL_RESP_CHARS))
  inline_latency_total=$((inline_latency_total + CALL_LATENCY_MS))
  inline_ok=$(printf '%s' "$TOOL_RESULT" | jq -r '.success // false')
  inline_outcome=$(printf '%s' "$TOOL_RESULT" | jq -r '.outcome // empty')
  if [ "$inline_ok" = "true" ]; then
    inline_success=$((inline_success + 1))
  fi

  blob_hash=''
  if [ "$BLOB_STORE_STRATEGY" = "preloaded" ]; then
    blob_hash="$preloaded_blob_hash"
  else
    store_args=$(jq -cn \
      --arg agent "$AGENT_ID" \
      --arg payload "$votes_payload" \
      --arg mode "$BLOB_COMPRESSION_MODE" \
      '{agent_id:$agent,payload:$payload,compression_mode:$mode}')
    mcp_tool_call "$SESSION_ID" store_protocol_blob "$store_args"
    blob_store_calls=$((blob_store_calls + 1))
    blob_store_req_total=$((blob_store_req_total + CALL_REQ_CHARS))
    blob_store_resp_total=$((blob_store_resp_total + CALL_RESP_CHARS))
    blob_store_latency_total=$((blob_store_latency_total + CALL_LATENCY_MS))
    store_ok=$(printf '%s' "$TOOL_RESULT" | jq -r '.success // false')
    blob_hash=$(printf '%s' "$TOOL_RESULT" | jq -r '.hash // empty')
    store_created=$(printf '%s' "$TOOL_RESULT" | jq -r '.created // false')
    if [ "$store_ok" = "true" ]; then
      blob_store_success=$((blob_store_success + 1))
    fi
    if [ "$store_created" = "true" ]; then
      blob_store_created=$((blob_store_created + 1))
    fi
  fi

  resolve_blob_args=$(jq -cn \
    --arg agent "$AGENT_ID" \
    --arg proposal "$proposal_blob" \
    --arg hash "$blob_hash" \
    --arg mode "$BLOB_RESPONSE_MODE" \
    --arg policy "$EMIT_BLOB_REF_POLICY" \
    --argjson emit "$EMIT_BLOB_REF" \
    '{
      requesting_agent:$agent,
      proposal_id:$proposal,
      votes_blob_hash:$hash,
      response_mode:$mode
    }
    + (if ($policy|length) > 0 then {emit_blob_ref_policy:$policy} else {emit_blob_ref:$emit} end)')
  mcp_tool_call "$SESSION_ID" resolve_consensus "$resolve_blob_args"
  blob_resolve_req_total=$((blob_resolve_req_total + CALL_REQ_CHARS))
  blob_resolve_resp_total=$((blob_resolve_resp_total + CALL_RESP_CHARS))
  blob_resolve_latency_total=$((blob_resolve_latency_total + CALL_LATENCY_MS))
  blob_ok=$(printf '%s' "$TOOL_RESULT" | jq -r '.success // false')
  blob_outcome=$(printf '%s' "$TOOL_RESULT" | jq -r '.outcome // empty')
  decision_blob_hash=$(printf '%s' "$TOOL_RESULT" | jq -r '.decision_blob_ref.hash // empty')
  if [ "$blob_ok" = "true" ]; then
    blob_resolve_success=$((blob_resolve_success + 1))
  fi
  if [ -n "$decision_blob_hash" ]; then
    blob_emit_ref_count=$((blob_emit_ref_count + 1))
  fi

  if [ "$inline_outcome" = "$blob_outcome" ] && [ -n "$inline_outcome" ]; then
    outcome_match=$((outcome_match + 1))
  else
    outcome_mismatch=$((outcome_mismatch + 1))
  fi
done

inline_req_avg=$(awk -v a="$inline_req_total" -v b="$RUNS" 'BEGIN { if (b>0) printf("%.3f", a/b); else print "0.000" }')
inline_resp_avg=$(awk -v a="$inline_resp_total" -v b="$RUNS" 'BEGIN { if (b>0) printf("%.3f", a/b); else print "0.000" }')
inline_latency_avg=$(awk -v a="$inline_latency_total" -v b="$RUNS" 'BEGIN { if (b>0) printf("%.3f", a/b); else print "0.000" }')

blob_store_req_avg=$(awk -v a="$blob_store_req_total" -v b="$blob_store_calls" 'BEGIN { if (b>0) printf("%.3f", a/b); else print "0.000" }')
blob_store_resp_avg=$(awk -v a="$blob_store_resp_total" -v b="$blob_store_calls" 'BEGIN { if (b>0) printf("%.3f", a/b); else print "0.000" }')
blob_store_latency_avg=$(awk -v a="$blob_store_latency_total" -v b="$blob_store_calls" 'BEGIN { if (b>0) printf("%.3f", a/b); else print "0.000" }')

blob_resolve_req_avg=$(awk -v a="$blob_resolve_req_total" -v b="$RUNS" 'BEGIN { if (b>0) printf("%.3f", a/b); else print "0.000" }')
blob_resolve_resp_avg=$(awk -v a="$blob_resolve_resp_total" -v b="$RUNS" 'BEGIN { if (b>0) printf("%.3f", a/b); else print "0.000" }')
blob_resolve_latency_avg=$(awk -v a="$blob_resolve_latency_total" -v b="$RUNS" 'BEGIN { if (b>0) printf("%.3f", a/b); else print "0.000" }')

blob_e2e_req_total=$((blob_store_req_total + blob_resolve_req_total))
blob_e2e_resp_total=$((blob_store_resp_total + blob_resolve_resp_total))
blob_e2e_latency_total=$((blob_store_latency_total + blob_resolve_latency_total))
blob_e2e_req_avg=$(awk -v a="$blob_e2e_req_total" -v b="$RUNS" 'BEGIN { if (b>0) printf("%.3f", a/b); else print "0.000" }')
blob_e2e_resp_avg=$(awk -v a="$blob_e2e_resp_total" -v b="$RUNS" 'BEGIN { if (b>0) printf("%.3f", a/b); else print "0.000" }')
blob_e2e_latency_avg=$(awk -v a="$blob_e2e_latency_total" -v b="$RUNS" 'BEGIN { if (b>0) printf("%.3f", a/b); else print "0.000" }')

inline_tokens_total=$(estimate_tokens $((inline_req_total + inline_resp_total)))
blob_tokens_total=$(estimate_tokens $((blob_e2e_req_total + blob_e2e_resp_total)))

delta_blob_e2e_chars_pct=$(awk -v a="$inline_req_total" -v b="$inline_resp_total" -v c="$blob_e2e_req_total" -v d="$blob_e2e_resp_total" \
  'BEGIN { base=a+b; opt=c+d; if (base>0) printf("%.6f", ((opt-base)/base)*100); else print "0.000000" }')
delta_blob_e2e_tokens_pct=$(awk -v base="$inline_tokens_total" -v opt="$blob_tokens_total" \
  'BEGIN { if (base>0) printf("%.6f", ((opt-base)/base)*100); else print "0.000000" }')
delta_blob_e2e_latency_pct=$(awk -v base="$inline_latency_total" -v opt="$blob_e2e_latency_total" \
  'BEGIN { if (base>0) printf("%.6f", ((opt-base)/base)*100); else print "0.000000" }')

jq -n \
  --arg generated_at "$(date -u +%FT%TZ)" \
  --arg endpoint "$ENDPOINT" \
  --arg run_tag "$RUN_TAG" \
  --argjson runs "$RUNS" \
  --argjson votes "$VOTES" \
  --arg inline_mode "$INLINE_RESPONSE_MODE" \
  --arg blob_mode "$BLOB_RESPONSE_MODE" \
  --arg blob_compression_mode "$BLOB_COMPRESSION_MODE" \
  --arg emit_blob_ref_policy "$EMIT_BLOB_REF_POLICY" \
  --arg blob_store_strategy "$BLOB_STORE_STRATEGY" \
  --argjson emit_blob_ref "$EMIT_BLOB_REF" \
  --argjson inline_req_total "$inline_req_total" \
  --argjson inline_resp_total "$inline_resp_total" \
  --argjson inline_latency_total "$inline_latency_total" \
  --arg inline_req_avg "$inline_req_avg" \
  --arg inline_resp_avg "$inline_resp_avg" \
  --arg inline_latency_avg "$inline_latency_avg" \
  --argjson inline_success "$inline_success" \
  --argjson blob_store_req_total "$blob_store_req_total" \
  --argjson blob_store_resp_total "$blob_store_resp_total" \
  --argjson blob_store_latency_total "$blob_store_latency_total" \
  --arg blob_store_req_avg "$blob_store_req_avg" \
  --arg blob_store_resp_avg "$blob_store_resp_avg" \
  --arg blob_store_latency_avg "$blob_store_latency_avg" \
  --argjson blob_store_success "$blob_store_success" \
  --argjson blob_store_created "$blob_store_created" \
  --argjson blob_store_calls "$blob_store_calls" \
  --argjson blob_resolve_req_total "$blob_resolve_req_total" \
  --argjson blob_resolve_resp_total "$blob_resolve_resp_total" \
  --argjson blob_resolve_latency_total "$blob_resolve_latency_total" \
  --arg blob_resolve_req_avg "$blob_resolve_req_avg" \
  --arg blob_resolve_resp_avg "$blob_resolve_resp_avg" \
  --arg blob_resolve_latency_avg "$blob_resolve_latency_avg" \
  --argjson blob_resolve_success "$blob_resolve_success" \
  --argjson blob_emit_ref_count "$blob_emit_ref_count" \
  --argjson blob_e2e_req_total "$blob_e2e_req_total" \
  --argjson blob_e2e_resp_total "$blob_e2e_resp_total" \
  --argjson blob_e2e_latency_total "$blob_e2e_latency_total" \
  --arg blob_e2e_req_avg "$blob_e2e_req_avg" \
  --arg blob_e2e_resp_avg "$blob_e2e_resp_avg" \
  --arg blob_e2e_latency_avg "$blob_e2e_latency_avg" \
  --argjson inline_tokens_total "$inline_tokens_total" \
  --argjson blob_tokens_total "$blob_tokens_total" \
  --argjson outcome_match "$outcome_match" \
  --argjson outcome_mismatch "$outcome_mismatch" \
  --arg delta_blob_e2e_chars_pct "$delta_blob_e2e_chars_pct" \
  --arg delta_blob_e2e_tokens_pct "$delta_blob_e2e_tokens_pct" \
  --arg delta_blob_e2e_latency_pct "$delta_blob_e2e_latency_pct" \
  '
  {
    generated_at: $generated_at,
    endpoint: $endpoint,
    run_tag: $run_tag,
    config: {
      runs: $runs,
      votes_per_round: $votes,
      inline_response_mode: $inline_mode,
      blob_response_mode: $blob_mode,
      blob_compression_mode: $blob_compression_mode,
      emit_blob_ref_policy: (if ($emit_blob_ref_policy|length) > 0 then $emit_blob_ref_policy else null end),
      blob_store_strategy: $blob_store_strategy,
      emit_blob_ref: $emit_blob_ref
    },
    inline: {
      success: $inline_success,
      failure: ($runs - $inline_success),
      request_chars_total: $inline_req_total,
      response_chars_total: $inline_resp_total,
      chars_total: ($inline_req_total + $inline_resp_total),
      tokens_est_total: $inline_tokens_total,
      latency_total_ms: $inline_latency_total,
      request_chars_avg: ($inline_req_avg | tonumber),
      response_chars_avg: ($inline_resp_avg | tonumber),
      latency_avg_ms: ($inline_latency_avg | tonumber)
    },
    blob: {
      store: {
        calls: $blob_store_calls,
        success: $blob_store_success,
        failure: ($blob_store_calls - $blob_store_success),
        created: $blob_store_created,
        request_chars_total: $blob_store_req_total,
        response_chars_total: $blob_store_resp_total,
        latency_total_ms: $blob_store_latency_total,
        request_chars_avg: ($blob_store_req_avg | tonumber),
        response_chars_avg: ($blob_store_resp_avg | tonumber),
        latency_avg_ms: ($blob_store_latency_avg | tonumber)
      },
      resolve: {
        success: $blob_resolve_success,
        failure: ($runs - $blob_resolve_success),
        emitted_blob_ref: $blob_emit_ref_count,
        request_chars_total: $blob_resolve_req_total,
        response_chars_total: $blob_resolve_resp_total,
        latency_total_ms: $blob_resolve_latency_total,
        request_chars_avg: ($blob_resolve_req_avg | tonumber),
        response_chars_avg: ($blob_resolve_resp_avg | tonumber),
        latency_avg_ms: ($blob_resolve_latency_avg | tonumber)
      },
      e2e: {
        request_chars_total: $blob_e2e_req_total,
        response_chars_total: $blob_e2e_resp_total,
        chars_total: ($blob_e2e_req_total + $blob_e2e_resp_total),
        tokens_est_total: $blob_tokens_total,
        latency_total_ms: $blob_e2e_latency_total,
        request_chars_avg: ($blob_e2e_req_avg | tonumber),
        response_chars_avg: ($blob_e2e_resp_avg | tonumber),
        latency_avg_ms: ($blob_e2e_latency_avg | tonumber)
      }
    },
    correctness: {
      outcome_match: $outcome_match,
      outcome_mismatch: $outcome_mismatch,
      match_pct: (if $runs > 0 then ((($outcome_match / $runs) * 10000 | round) / 100) else 0 end)
    },
    deltas_pct: {
      blob_e2e_vs_inline_chars: ($delta_blob_e2e_chars_pct | tonumber),
      blob_e2e_vs_inline_tokens_est: ($delta_blob_e2e_tokens_pct | tonumber),
      blob_e2e_vs_inline_latency: ($delta_blob_e2e_latency_pct | tonumber)
    }
  }
  ' > "$REPORT_FILE"

echo "Wrote consensus A/B report: $REPORT_FILE"
jq '{config, inline, blob: .blob.e2e, correctness, deltas_pct}' "$REPORT_FILE"
