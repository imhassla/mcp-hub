#!/usr/bin/env bash
set -euo pipefail

ENDPOINT="${ENDPOINT:-http://localhost:3000/mcp}"
WORKERS="${WORKERS:-10}"
OUT_DIR="${OUT_DIR:-/tmp/exp5}"
USE_AUTH_TOKEN="${USE_AUTH_TOKEN:-auto}" # auto | true | false
BLOB_COMPRESSION_MODE="${BLOB_COMPRESSION_MODE:-lossless_auto}" # none | json | whitespace | auto | lossless_auto
MCP_HTTP_CONNECT_TIMEOUT_SEC="${MCP_HTTP_CONNECT_TIMEOUT_SEC:-3}"
MCP_HTTP_TIMEOUT_SEC="${MCP_HTTP_TIMEOUT_SEC:-25}"
MCP_HTTP_RETRIES="${MCP_HTTP_RETRIES:-2}"
MCP_HTTP_RETRY_DELAY_SEC="${MCP_HTTP_RETRY_DELAY_SEC:-1}"
MCP_REINIT_ON_SESSION_ERROR="${MCP_REINIT_ON_SESSION_ERROR:-1}" # 1 to auto-reinit when session is expired/unknown
HEALTH_URL="${ENDPOINT%/mcp}/health"
mkdir -p "$OUT_DIR"

if printf 'QQ==' | base64 -d >/dev/null 2>&1; then
  BASE64_DEC_FLAG='-d'
else
  BASE64_DEC_FLAG='-D'
fi

now_ms() {
  perl -MTime::HiRes=time -e 'printf("%.0f\n", time()*1000)'
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

mcp_init() {
  local init_payload initialized_payload init_response session_id
  init_payload='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"exp-runner","version":"1.0.0"}}}'
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

CALLS=0
LATENCY_MS=0
TOOL_RESULT=''
LAST_VALID_SID=''

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

with_auth_token() {
  local args_json="$1"
  local token="${2:-}"
  if [ "$USE_AUTH_TOKEN" = "false" ]; then
    printf '%s' "$args_json"
    return 0
  fi
  if [ -z "$token" ]; then
    if [ "$USE_AUTH_TOKEN" = "true" ]; then
      echo "auth token is required but missing" >&2
      return 1
    fi
    printf '%s' "$args_json"
    return 0
  fi
  printf '%s' "$args_json" | jq -c --arg token "$token" '. + {auth_token:$token}'
}

mcp_tool_call() {
  local sid="$1"
  local tool="$2"
  local args_json="$3"
  local request_json response payload text t0 t1 elapsed effective_sid reinit_attempted=0

  request_json=$(jq -cn --arg name "$tool" --argjson args "$args_json" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$name,arguments:$args}}')

  while true; do
    effective_sid="${LAST_VALID_SID:-$sid}"

    t0=$(now_ms)
    if ! response=$(curl_post_json "$effective_sid" "$request_json"); then
      echo "tool call transport failure: $tool" >&2
      return 1
    fi
    t1=$(now_ms)

    elapsed=$((t1 - t0))
    CALLS=$((CALLS + 1))
    LATENCY_MS=$((LATENCY_MS + elapsed))

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

    TOOL_RESULT="$text"
    return 0
  done
}

mcp_tool_call_auth() {
  local sid="$1"
  local tool="$2"
  local args_json="$3"
  local auth_token="${4:-}"
  local with_auth
  with_auth=$(with_auth_token "$args_json" "$auth_token") || return 1
  mcp_tool_call "$sid" "$tool" "$with_auth"
}

assert_success() {
  local json="$1"
  local label="$2"
  local ok
  ok=$(printf '%s' "$json" | jq -r '.success // true')
  if [ "$ok" != "true" ]; then
    echo "tool returned success=false for $label" >&2
    printf '%s\n' "$json" | jq '.' >&2 || printf '%s\n' "$json" >&2
    return 1
  fi
}

payload_for_worker() {
  local tag="$1"
  local worker_id="$2"
  local task_id="$3"
  local evidence notes
  evidence=$(printf 'e%.0s' $(seq 1 180))
  notes=$(printf 'n%.0s' $(seq 1 420))
  jq -cn \
    --arg tag "$tag" \
    --arg wid "$worker_id" \
    --argjson tid "$task_id" \
    --arg ev "$evidence" \
    --arg notes "$notes" \
    '{experiment:$tag,agent_id:$wid,task_id:$tid,status:"in_progress",summary:"Protocol optimization handoff",evidence:[$ev,$ev],notes:$notes}'
}

hash_check_from_rows() {
  local rows="$1"
  local total=0
  local ok=0
  while IFS=$'\t' read -r expected b64; do
    [ -z "${expected:-}" ] && continue
    [ -z "${b64:-}" ] && continue
    local decoded actual
    decoded=$(printf '%s' "$b64" | base64 "$BASE64_DEC_FLAG")
    actual=$(printf '%s' "$decoded" | shasum -a 256 | awk '{print $1}')
    total=$((total + 1))
    if [ "$actual" = "$expected" ]; then
      ok=$((ok + 1))
    fi
  done <<< "$rows"

  jq -cn --argjson total "$total" --argjson ok "$ok" '{total:$total,ok:$ok}'
}

run_variant() {
  local mode="$1"
  local tag="$2"
  local namespace="$tag"
  local sid orchestrator worker_prefix
  local orchestrator_token=""
  local onboarding_ok=0
  local release_ok=0
  local created_tasks=0
  local worker_tokens_present=0
  local task_ids_json='[]'
  local raw_inbox resolved_inbox raw_context resolved_context
  local msg_transport_chars msg_effective_chars msg_count
  local ctx_transport_chars ctx_effective_chars ctx_count
  local hash_rows hash_stats hash_total hash_ok
  local done_count avg_latency
  local transport_json wait_calls wait_hits wait_timeouts wait_hit_rate_pct wait_retry_after_avg_ms wait_retry_after_p95_ms transport_polling_calls

  CALLS=0
  LATENCY_MS=0

  sid=$(mcp_init)
  orchestrator="orch-${tag}"
  worker_prefix="w-${tag}-"

  declare -a task_ids
  declare -a worker_tokens

  mcp_tool_call "$sid" register_agent "$(jq -cn --arg id "$orchestrator" '{id:$id,name:"Orchestrator",type:"codex",capabilities:"orchestration,kpi",onboarding_mode:"none",lifecycle:"persistent",runtime_profile:{mode:"repo",has_git:true,file_count:1,empty_dir:false,source:"client_declared"}}')"
  assert_success "$TOOL_RESULT" "register_orchestrator"
  orchestrator_token=$(printf '%s' "$TOOL_RESULT" | jq -r '.auth.token // empty')
  if [ "$USE_AUTH_TOKEN" = "true" ] && [ -z "$orchestrator_token" ]; then
    echo "orchestrator auth token missing in USE_AUTH_TOKEN=true mode" >&2
    return 1
  fi

  for i in $(seq 1 "$WORKERS"); do
    local wid tc
    wid="${worker_prefix}${i}"

    mcp_tool_call "$sid" register_agent "$(jq -cn --arg id "$wid" --arg n "Worker-$i" --arg m "$mode" '{id:$id,name:$n,type:"claude",capabilities:("round,"+$m),onboarding_mode:"none",lifecycle:"ephemeral",runtime_profile:{mode:"repo",has_git:true,file_count:1,empty_dir:false,source:"client_declared"}}')"
    assert_success "$TOOL_RESULT" "register_worker_$i"

    tc=$(printf '%s' "$TOOL_RESULT" | jq '.onboarding.tool_count // 0')
    if [ "$tc" -ge 25 ]; then
      onboarding_ok=$((onboarding_ok + 1))
    fi

    worker_tokens[$i]=$(printf '%s' "$TOOL_RESULT" | jq -r '.auth.token // empty')
    if [ -n "${worker_tokens[$i]}" ]; then
      worker_tokens_present=$((worker_tokens_present + 1))
    fi
    if [ "$USE_AUTH_TOKEN" = "true" ] && [ -z "${worker_tokens[$i]}" ]; then
      echo "worker auth token missing for $wid in USE_AUTH_TOKEN=true mode" >&2
      return 1
    fi

    mcp_tool_call_auth "$sid" create_task "$(jq -cn --arg t "${tag}-task-${i}" --arg d "experiment=$tag mode=$mode" --arg by "$orchestrator" --arg assigned "$wid" --arg ns "$namespace" '{title:$t,description:$d,created_by:$by,assigned_to:$assigned,priority:"high",namespace:$ns}')" "$orchestrator_token"
    assert_success "$TOOL_RESULT" "create_task_$i"
    task_ids[$i]=$(printf '%s' "$TOOL_RESULT" | jq -r '.task.id')
    task_ids_json=$(printf '%s' "$task_ids_json" | jq --argjson tid "${task_ids[$i]}" '. + [$tid]')
    created_tasks=$((created_tasks + 1))
  done

  for i in $(seq 1 "$WORKERS"); do
    local wid tid claim_id payload worker_token ctx_id msg_id
    wid="${worker_prefix}${i}"
    tid="${task_ids[$i]}"
    worker_token="${worker_tokens[$i]}"

    mcp_tool_call_auth "$sid" claim_task "$(jq -cn --argjson task "$tid" --arg aid "$wid" --arg ns "$namespace" '{task_id:$task,agent_id:$aid,lease_seconds:300,namespace:$ns}')" "$worker_token"
    assert_success "$TOOL_RESULT" "claim_task_$i"
    claim_id=$(printf '%s' "$TOOL_RESULT" | jq -r '.claim.claim_id // empty')
    if [ -z "$claim_id" ]; then
      echo "missing claim_id for worker $wid task $tid" >&2
      return 1
    fi

    payload=$(payload_for_worker "$tag" "$wid" "$tid")

    if [ "$mode" = "baseline" ]; then
      mcp_tool_call_auth "$sid" share_context "$(jq -cn --arg aid "$wid" --arg k "handoff-${tid}" --arg v "$payload" '{agent_id:$aid,key:$k,value:$v,compression_mode:"none"}')" "$worker_token"
      assert_success "$TOOL_RESULT" "share_context_$i"
      ctx_id=$(printf '%s' "$TOOL_RESULT" | jq -r '.context.id // empty')

      mcp_tool_call_auth "$sid" send_message "$(jq -cn --arg from "$wid" --arg to "$orchestrator" --arg c "$payload" '{from_agent:$from,to_agent:$to,content:$c,compression_mode:"none"}')" "$worker_token"
      assert_success "$TOOL_RESULT" "send_message_$i"
      msg_id=$(printf '%s' "$TOOL_RESULT" | jq -r '.message.id // empty')
    else
      mcp_tool_call_auth "$sid" share_blob_context "$(jq -cn --arg aid "$wid" --arg k "handoff-${tid}" --arg p "$payload" --arg cm "$BLOB_COMPRESSION_MODE" '{agent_id:$aid,key:$k,payload:$p,compression_mode:$cm}')" "$worker_token"
      assert_success "$TOOL_RESULT" "share_blob_context_$i"
      ctx_id=$(printf '%s' "$TOOL_RESULT" | jq -r '.context.id // empty')

      mcp_tool_call_auth "$sid" send_blob_message "$(jq -cn --arg from "$wid" --arg to "$orchestrator" --arg p "$payload" --arg cm "$BLOB_COMPRESSION_MODE" '{from_agent:$from,to_agent:$to,payload:$p,compression_mode:$cm}')" "$worker_token"
      assert_success "$TOOL_RESULT" "send_blob_message_$i"
      msg_id=$(printf '%s' "$TOOL_RESULT" | jq -r '.message.id // empty')
    fi

    mcp_tool_call_auth "$sid" release_task_claim "$(jq -cn --argjson task "$tid" --arg aid "$wid" --arg cid "$claim_id" --arg ctx "$ctx_id" --arg msg "$msg_id" \
      '{task_id:$task,agent_id:$aid,claim_id:$cid,next_status:"done",confidence:0.95,verification_passed:true,verified_by:"qa-auto",evidence_refs:([("task:"+($task|tostring)+":handoff"), (if $ctx != "" then ("context_id:"+$ctx) else empty end), (if $msg != "" then ("message_id:"+$msg) else empty end)])}')" "$worker_token"
    assert_success "$TOOL_RESULT" "release_task_$i"
    release_ok=$((release_ok + 1))
  done

  mcp_tool_call_auth "$sid" read_messages "$(jq -cn --arg aid "$orchestrator" '{agent_id:$aid,unread_only:true,limit:1000,response_mode:"full"}')" "$orchestrator_token"
  raw_inbox="$TOOL_RESULT"
  assert_success "$raw_inbox" "read_messages_raw_$mode"

  if [ "$mode" = "baseline" ]; then
    resolved_inbox="$raw_inbox"
  else
    mcp_tool_call_auth "$sid" read_messages "$(jq -cn --arg aid "$orchestrator" '{agent_id:$aid,limit:1000,response_mode:"full",resolve_blob_refs:true}')" "$orchestrator_token"
    resolved_inbox="$TOOL_RESULT"
    assert_success "$resolved_inbox" "read_messages_resolved_$mode"
  fi

  mcp_tool_call_auth "$sid" get_context "$(jq -cn --arg aid "$orchestrator" '{requesting_agent:$aid,limit:1000,response_mode:"full"}')" "$orchestrator_token"
  raw_context="$TOOL_RESULT"
  assert_success "$raw_context" "get_context_raw_$mode"

  if [ "$mode" = "baseline" ]; then
    resolved_context="$raw_context"
  else
    mcp_tool_call_auth "$sid" get_context "$(jq -cn --arg aid "$orchestrator" '{requesting_agent:$aid,limit:1000,response_mode:"full",resolve_blob_refs:true}')" "$orchestrator_token"
    resolved_context="$TOOL_RESULT"
    assert_success "$resolved_context" "get_context_resolved_$mode"
  fi

  msg_count=$(printf '%s' "$raw_inbox" | jq --arg p "$worker_prefix" '[((.messages // [])[]) | select(.from_agent | startswith($p))] | length')
  msg_transport_chars=$(printf '%s' "$raw_inbox" | jq --arg p "$worker_prefix" '[((.messages // [])[]) | select(.from_agent | startswith($p)) | (.content | length)] | add // 0')
  msg_effective_chars=$(printf '%s' "$resolved_inbox" | jq --arg p "$worker_prefix" '[((.messages // [])[]) | select(.from_agent | startswith($p)) | ((.resolved_content // .content) | length)] | add // 0')

  ctx_count=$(printf '%s' "$raw_context" | jq --arg p "$worker_prefix" '[((.contexts // [])[]) | select(.agent_id | startswith($p))] | length')
  ctx_transport_chars=$(printf '%s' "$raw_context" | jq --arg p "$worker_prefix" '[((.contexts // [])[]) | select(.agent_id | startswith($p)) | (.value | length)] | add // 0')
  ctx_effective_chars=$(printf '%s' "$resolved_context" | jq --arg p "$worker_prefix" '[((.contexts // [])[]) | select(.agent_id | startswith($p)) | ((.resolved_value // .value) | length)] | add // 0')

  if [ "$mode" = "baseline" ]; then
    hash_total=0
    hash_ok=0
  else
    local rows_msg rows_ctx
    rows_msg=$(printf '%s' "$resolved_inbox" | jq -r --arg p "$worker_prefix" '((.messages // [])[]) | select(.from_agent | startswith($p)) | select(.blob_ref.hash != null and .resolved_content != null) | "\(.blob_ref.hash)\t\(.resolved_content|@base64)"')
    rows_ctx=$(printf '%s' "$resolved_context" | jq -r --arg p "$worker_prefix" '((.contexts // [])[]) | select(.agent_id | startswith($p)) | select(.blob_ref.hash != null and .resolved_value != null) | "\(.blob_ref.hash)\t\(.resolved_value|@base64)"')
    hash_rows=$(printf '%s\n%s\n' "$rows_msg" "$rows_ctx")
    hash_stats=$(hash_check_from_rows "$hash_rows")
    hash_total=$(printf '%s' "$hash_stats" | jq '.total')
    hash_ok=$(printf '%s' "$hash_stats" | jq '.ok')
  fi

  mcp_tool_call_auth "$sid" list_tasks "$(jq -cn --arg aid "$orchestrator" '{agent_id:$aid,status:"done",limit:1000,response_mode:"compact"}')" "$orchestrator_token"
  assert_success "$TOOL_RESULT" "list_tasks_done_$mode"
  done_count=$(printf '%s' "$TOOL_RESULT" | jq --argjson ids "$task_ids_json" '[((.tasks // [])[]) | select(.id as $id | ($ids | index($id))) ] | length')

  mcp_tool_call_auth "$sid" get_transport_snapshot "$(jq -cn --arg aid "$orchestrator" '{requesting_agent:$aid,window_sec:300,response_mode:"tiny"}')" "$orchestrator_token"
  transport_json="$TOOL_RESULT"
  assert_success "$transport_json" "get_transport_snapshot_$mode"
  wait_calls=$(printf '%s' "$transport_json" | jq '.transport.wait_calls // 0')
  wait_hits=$(printf '%s' "$transport_json" | jq '.transport.wait_hits // 0')
  wait_timeouts=$(printf '%s' "$transport_json" | jq '.transport.wait_timeouts // 0')
  wait_hit_rate_pct=$(printf '%s' "$transport_json" | jq '.transport.wait_hit_rate_pct // 0')
  wait_retry_after_avg_ms=$(printf '%s' "$transport_json" | jq '.transport.wait_retry_after_avg_ms // null')
  wait_retry_after_p95_ms=$(printf '%s' "$transport_json" | jq '.transport.wait_retry_after_p95_ms // null')
  transport_polling_calls=$(printf '%s' "$transport_json" | jq '.transport.polling_calls // 0')

  avg_latency=$(jq -cn --argjson total "$LATENCY_MS" --argjson calls "$CALLS" 'if $calls == 0 then 0 else ($total / $calls) end')

  mcp_close

  jq -cn \
    --arg mode "$mode" \
    --arg tag "$tag" \
    --argjson workers "$WORKERS" \
    --argjson onboarding_ok "$onboarding_ok" \
    --argjson created_tasks "$created_tasks" \
    --argjson release_ok "$release_ok" \
    --argjson done_count "$done_count" \
    --argjson msg_count "$msg_count" \
    --argjson msg_transport_chars "$msg_transport_chars" \
    --argjson msg_effective_chars "$msg_effective_chars" \
    --argjson ctx_count "$ctx_count" \
    --argjson ctx_transport_chars "$ctx_transport_chars" \
    --argjson ctx_effective_chars "$ctx_effective_chars" \
    --argjson hash_total "$hash_total" \
    --argjson hash_ok "$hash_ok" \
    --argjson wait_calls "$wait_calls" \
    --argjson wait_hits "$wait_hits" \
    --argjson wait_timeouts "$wait_timeouts" \
    --argjson wait_hit_rate_pct "$wait_hit_rate_pct" \
    --argjson wait_retry_after_avg_ms "$wait_retry_after_avg_ms" \
    --argjson wait_retry_after_p95_ms "$wait_retry_after_p95_ms" \
    --argjson transport_polling_calls "$transport_polling_calls" \
    --argjson calls "$CALLS" \
    --argjson latency_total "$LATENCY_MS" \
    --argjson latency_avg "$avg_latency" \
    --arg auth_token_mode "$USE_AUTH_TOKEN" \
    --arg blob_compression_mode "$BLOB_COMPRESSION_MODE" \
    --arg namespace "$namespace" \
    --argjson orchestrator_token_present "$( [ -n "$orchestrator_token" ] && echo true || echo false )" \
    --argjson worker_tokens_present "$worker_tokens_present" \
    '{
      mode:$mode,
      tag:$tag,
      namespace:$namespace,
      workers:$workers,
      auth_token_mode:$auth_token_mode,
      blob_compression_mode:$blob_compression_mode,
      auth_token_coverage:{
        orchestrator_token_present:$orchestrator_token_present,
        worker_tokens_present:$worker_tokens_present,
        workers:$workers
      },
      onboarding_ok:$onboarding_ok,
      created_tasks:$created_tasks,
      release_ok:$release_ok,
      done_count:$done_count,
      accuracy_done_pct:(if $workers == 0 then 0 else (100 * $done_count / $workers) end),
      message_count:$msg_count,
      message_chars_transport:$msg_transport_chars,
      message_chars_effective:$msg_effective_chars,
      context_count:$ctx_count,
      context_chars_transport:$ctx_transport_chars,
      context_chars_effective:$ctx_effective_chars,
      token_est_transport:((($msg_transport_chars + $ctx_transport_chars) / 4) | floor),
      token_est_effective:((($msg_effective_chars + $ctx_effective_chars) / 4) | floor),
      hash_checks_total:$hash_total,
      hash_checks_ok:$hash_ok,
      hash_valid_rate_pct:(if $hash_total == 0 then null else (100 * $hash_ok / $hash_total) end),
      transport_wait_calls:$wait_calls,
      transport_wait_hits:$wait_hits,
      transport_wait_timeouts:$wait_timeouts,
      transport_wait_hit_rate_pct:$wait_hit_rate_pct,
      transport_wait_retry_after_avg_ms:$wait_retry_after_avg_ms,
      transport_wait_retry_after_p95_ms:$wait_retry_after_p95_ms,
      transport_polling_calls:$transport_polling_calls,
      tool_calls:$calls,
      latency_total_ms:$latency_total,
      latency_avg_ms:$latency_avg
    }'
}

wait_for_hub
case "$USE_AUTH_TOKEN" in
  auto|true|false) ;;
  *)
    echo "Invalid USE_AUTH_TOKEN=$USE_AUTH_TOKEN. Use auto|true|false." >&2
    exit 1
    ;;
esac

case "$BLOB_COMPRESSION_MODE" in
  none|json|whitespace|auto|lossless_auto) ;;
  *)
    echo "Invalid BLOB_COMPRESSION_MODE=$BLOB_COMPRESSION_MODE. Use none|json|whitespace|auto|lossless_auto." >&2
    exit 1
    ;;
esac
TS=$(date +%s)
BASE_TAG="EXP5-${TS}"

baseline_json=$(run_variant baseline "${BASE_TAG}-B")
blob_json=$(run_variant blob "${BASE_TAG}-O")

report=$(jq -cn \
  --arg generated_at "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
  --argjson baseline "$baseline_json" \
  --argjson optimized "$blob_json" \
  '
  def pct(old; new): if old == 0 then null else ((new - old) / old * 100) end;
  {
    generated_at:$generated_at,
    baseline:$baseline,
    optimized:$optimized,
    deltas:{
      message_chars_transport_pct:pct($baseline.message_chars_transport; $optimized.message_chars_transport),
      context_chars_transport_pct:pct($baseline.context_chars_transport; $optimized.context_chars_transport),
      token_est_transport_pct:pct($baseline.token_est_transport; $optimized.token_est_transport),
      transport_wait_calls_pct:pct($baseline.transport_wait_calls; $optimized.transport_wait_calls),
      transport_wait_timeouts_pct:pct($baseline.transport_wait_timeouts; $optimized.transport_wait_timeouts),
      transport_polling_calls_pct:pct($baseline.transport_polling_calls; $optimized.transport_polling_calls),
      transport_wait_hit_rate_pct_delta:($optimized.transport_wait_hit_rate_pct - $baseline.transport_wait_hit_rate_pct),
      transport_wait_retry_after_avg_ms_pct:pct(($baseline.transport_wait_retry_after_avg_ms // 0); ($optimized.transport_wait_retry_after_avg_ms // 0)),
      latency_avg_ms_pct:pct($baseline.latency_avg_ms; $optimized.latency_avg_ms),
      accuracy_done_pct_delta:($optimized.accuracy_done_pct - $baseline.accuracy_done_pct)
    }
  }')

REPORT_FILE="$OUT_DIR/exp5-kpi.json"
printf '%s\n' "$report" > "$REPORT_FILE"

printf 'Wrote KPI report: %s\n' "$REPORT_FILE"
printf '%s\n' "$report" | jq '.'
