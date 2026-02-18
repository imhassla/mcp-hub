#!/usr/bin/env bash
set -euo pipefail

ENDPOINT="${ENDPOINT:-http://localhost:3300/mcp}"
ROUNDS="${ROUNDS:-20}"
WAIT_MS="${WAIT_MS:-1500}"
POLL_INTERVAL_MS="${POLL_INTERVAL_MS:-100}"
WAIT_MODES="${WAIT_MODES:-tiny,micro,nano}"
MCP_REINIT_ON_SESSION_ERROR="${MCP_REINIT_ON_SESSION_ERROR:-1}"
AGENT_ID="${AGENT_ID:-wait-ab-$(date +%s)-$$}"
AGENT_NAME="${AGENT_NAME:-Wait Mode AB}"
AGENT_TYPE="${AGENT_TYPE:-benchmark}"
OUT_FILE="${OUT_FILE:-/tmp/wait-mode-ab-$(date +%s).json}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for this script" >&2
  exit 1
fi

SID=""
LAST_VALID_SID=""
REQ_ID=1

next_id() {
  REQ_ID=$((REQ_ID + 1))
  printf '%s' "$REQ_ID"
}

now_ms() {
  local candidate
  candidate="$(date +%s%3N 2>/dev/null || true)"
  if [[ "$candidate" =~ ^[0-9]+$ ]]; then
    printf '%s' "$candidate"
    return
  fi
  perl -MTime::HiRes=time -e 'printf("%.0f\n", time()*1000)'
}

mcp_post() {
  local payload="$1"
  local response
  if [ -n "$SID" ]; then
    response="$(curl -sS -H "content-type: application/json" -H "mcp-session-id: $SID" -X POST "$ENDPOINT" -d "$payload")"
  else
    response="$(curl -sS -H "content-type: application/json" -X POST "$ENDPOINT" -d "$payload")"
  fi
  printf '%s' "$response"
}

is_reinitable_session_error() {
  local payload="$1"
  local code flag reason message
  code="$(printf '%s' "$payload" | jq -r '.error.code // empty' 2>/dev/null || true)"
  if [ "$code" != "-32000" ]; then
    return 1
  fi
  flag="$(printf '%s' "$payload" | jq -r '.error.data.reinitialize_required // empty' 2>/dev/null || true)"
  if [ "$flag" = "true" ] || [ "$flag" = "1" ]; then
    return 0
  fi
  reason="$(printf '%s' "$payload" | jq -r '.error.data.reason // empty' 2>/dev/null || true)"
  case "$reason" in
    unknown_or_expired_session|server_not_initialized|no_active_session)
      return 0
      ;;
  esac
  message="$(printf '%s' "$payload" | jq -r '.error.message // empty' 2>/dev/null || true)"
  case "$message" in
    *"Server not initialized"*|*"Unknown or expired MCP session"*|*"No active session"*)
      return 0
      ;;
  esac
  return 1
}

tool_call() {
  local tool_name="$1"
  local args_json="$2"
  local reinit_attempted=0
  while :; do
    local payload
    payload="$(jq -nc --argjson id "$(next_id)" --arg name "$tool_name" --argjson args "$args_json" \
      '{jsonrpc:"2.0",id:$id,method:"tools/call",params:{name:$name,arguments:$args}}')"
    local response
    response="$(mcp_post "$payload")"
    if [ "$(printf '%s' "$response" | jq -r '.error.code // empty' 2>/dev/null)" != "" ]; then
      if [ "$MCP_REINIT_ON_SESSION_ERROR" = "1" ] && [ "$reinit_attempted" -eq 0 ] && is_reinitable_session_error "$response"; then
        init_session
        reinit_attempted=1
        continue
      fi
      printf '%s\n' "$response" >&2
      echo "tool call failed: $tool_name" >&2
      exit 1
    fi
    local text
    text="$(printf '%s' "$response" | jq -r '.result.content[0].text // empty')"
    if [ -z "$text" ]; then
      printf '%s\n' "$response" >&2
      echo "missing MCP text payload for tool: $tool_name" >&2
      exit 1
    fi
    printf '%s' "$text"
    return
  done
}

init_session() {
  local init_payload
  init_payload="$(jq -nc --argjson id "$(next_id)" \
    '{jsonrpc:"2.0",id:$id,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"wait-mode-ab",version:"1.0"}}}')"

  local headers_file body_file
  headers_file="$(mktemp)"
  body_file="$(mktemp)"
  curl -sS -D "$headers_file" -o "$body_file" -H "content-type: application/json" -X POST "$ENDPOINT" -d "$init_payload" >/dev/null
  SID="$(awk '/^mcp-session-id:/ {print $2}' "$headers_file" | tr -d '\r')"
  rm -f "$headers_file"
  if [ -z "$SID" ]; then
    cat "$body_file" >&2 || true
    rm -f "$body_file"
    echo "failed to initialize MCP session" >&2
    exit 1
  fi
  rm -f "$body_file"

  local initialized_payload
  initialized_payload="$(jq -nc '{jsonrpc:"2.0",method:"notifications/initialized",params:{}}')"
  mcp_post "$initialized_payload" >/dev/null
  LAST_VALID_SID="$SID"
}

main() {
  init_session

  local modes_raw mode_list=()
  IFS=',' read -r -a modes_raw <<< "$WAIT_MODES"
  for mode in "${modes_raw[@]}"; do
    mode="$(printf '%s' "$mode" | tr '[:upper:]' '[:lower:]' | xargs)"
    case "$mode" in
      tiny|micro|nano|default) mode_list+=("$mode") ;;
      *)
        echo "unsupported WAIT_MODES entry: $mode (allowed: default,tiny,micro,nano)" >&2
        exit 1
        ;;
    esac
  done
  if [ "${#mode_list[@]}" -eq 0 ]; then
    echo "WAIT_MODES must include at least one of: default,tiny,micro,nano" >&2
    exit 1
  fi

  local register_args register_resp auth_token
  register_args="$(jq -nc --arg id "$AGENT_ID" --arg name "$AGENT_NAME" --arg type "$AGENT_TYPE" \
    '{id:$id,name:$name,type:$type,onboarding_mode:"none"}')"
  register_resp="$(tool_call "register_agent" "$register_args")"
  auth_token="$(printf '%s' "$register_resp" | jq -r '.auth.token // empty')"

  if [ -z "$auth_token" ]; then
    echo "register_agent did not return auth token" >&2
    exit 1
  fi

  local mode
  local rows_json='[]'
  for mode in "${mode_list[@]}"; do
    local i total_bytes total_ms changed_hits
    total_bytes=0
    total_ms=0
    changed_hits=0

    for i in $(seq 1 "$ROUNDS"); do
      local wait_base_args wait_base cursor send_args wait_hit_args hit_json start_ms end_ms elapsed_ms bytes changed

      if [ "$mode" = "default" ]; then
        wait_base_args="$(jq -nc \
          --arg agent "$AGENT_ID" \
          --arg token "$auth_token" \
          --argjson wait 120 \
          --argjson poll "$POLL_INTERVAL_MS" \
          '{agent_id:$agent,auth_token:$token,streams:["messages"],timeout_response:"default",wait_ms:$wait,poll_interval_ms:$poll}')"
      else
        wait_base_args="$(jq -nc \
          --arg agent "$AGENT_ID" \
          --arg token "$auth_token" \
          --arg mode "$mode" \
          --argjson wait 120 \
          --argjson poll "$POLL_INTERVAL_MS" \
          '{agent_id:$agent,auth_token:$token,streams:["messages"],response_mode:$mode,timeout_response:"default",wait_ms:$wait,poll_interval_ms:$poll}')"
      fi
      wait_base="$(tool_call "wait_for_updates" "$wait_base_args")"
      cursor="$(printf '%s' "$wait_base" | jq -r '.cursor // .u // empty')"
      if [ -z "$cursor" ]; then
        echo "wait_for_updates did not return cursor for mode=$mode iteration=$i" >&2
        exit 1
      fi

      send_args="$(jq -nc \
        --arg from "$AGENT_ID" \
        --arg to "$AGENT_ID" \
        --arg token "$auth_token" \
        --arg content "ab-$mode-$i" \
        '{from_agent:$from,to_agent:$to,content:$content,auth_token:$token}')"
      tool_call "send_message" "$send_args" >/dev/null

      if [ "$mode" = "default" ]; then
        wait_hit_args="$(jq -nc \
          --arg agent "$AGENT_ID" \
          --arg token "$auth_token" \
          --arg cursor "$cursor" \
          --argjson wait "$WAIT_MS" \
          --argjson poll "$POLL_INTERVAL_MS" \
          '{agent_id:$agent,auth_token:$token,streams:["messages"],cursor:$cursor,timeout_response:"default",wait_ms:$wait,poll_interval_ms:$poll}')"
      else
        wait_hit_args="$(jq -nc \
          --arg agent "$AGENT_ID" \
          --arg token "$auth_token" \
          --arg mode "$mode" \
          --arg cursor "$cursor" \
          --argjson wait "$WAIT_MS" \
          --argjson poll "$POLL_INTERVAL_MS" \
          '{agent_id:$agent,auth_token:$token,streams:["messages"],cursor:$cursor,response_mode:$mode,timeout_response:"default",wait_ms:$wait,poll_interval_ms:$poll}')"
      fi

      start_ms="$(now_ms)"
      hit_json="$(tool_call "wait_for_updates" "$wait_hit_args")"
      end_ms="$(now_ms)"
      elapsed_ms=$((end_ms - start_ms))
      bytes="$(printf '%s' "$hit_json" | wc -c | tr -d ' ')"
      changed="$(printf '%s' "$hit_json" | jq -r 'if has("changed") then .changed else ((.c // 0) == 1) end')"

      total_ms=$((total_ms + elapsed_ms))
      total_bytes=$((total_bytes + bytes))
      if [ "$changed" = "true" ]; then
        changed_hits=$((changed_hits + 1))
      fi
    done

    local avg_bytes avg_ms
    avg_bytes="$(awk -v sum="$total_bytes" -v n="$ROUNDS" 'BEGIN { if (n==0) print 0; else printf "%.2f", sum/n }')"
    avg_ms="$(awk -v sum="$total_ms" -v n="$ROUNDS" 'BEGIN { if (n==0) print 0; else printf "%.2f", sum/n }')"

    local row
    row="$(jq -nc \
      --arg mode "$mode" \
      --argjson rounds "$ROUNDS" \
      --argjson changed_hits "$changed_hits" \
      --argjson total_bytes "$total_bytes" \
      --argjson total_ms "$total_ms" \
      --arg avg_bytes "$avg_bytes" \
      --arg avg_ms "$avg_ms" \
      '{mode:$mode,rounds:$rounds,changed_hits:$changed_hits,total_bytes:$total_bytes,total_ms:$total_ms,avg_bytes:($avg_bytes|tonumber),avg_ms:($avg_ms|tonumber)}')"
    rows_json="$(printf '%s' "$rows_json" | jq --argjson row "$row" '. + [$row]')"
  done

  local default_avg tiny_avg micro_avg nano_avg
  local bytes_delta_default_vs_tiny bytes_delta_default_vs_nano
  local bytes_delta_micro_vs_tiny bytes_delta_nano_vs_tiny bytes_delta_nano_vs_micro
  default_avg="$(printf '%s' "$rows_json" | jq -r '.[] | select(.mode=="default") | .avg_bytes // empty' | head -n 1)"
  tiny_avg="$(printf '%s' "$rows_json" | jq -r '.[] | select(.mode=="tiny") | .avg_bytes // empty' | head -n 1)"
  micro_avg="$(printf '%s' "$rows_json" | jq -r '.[] | select(.mode=="micro") | .avg_bytes // empty' | head -n 1)"
  nano_avg="$(printf '%s' "$rows_json" | jq -r '.[] | select(.mode=="nano") | .avg_bytes // empty' | head -n 1)"

  bytes_delta_default_vs_tiny="$(awk -v t="${tiny_avg:-0}" -v d="${default_avg:-0}" 'BEGIN { if (t<=0 || d<=0) print 0; else printf "%.2f", ((d-t)/t)*100 }')"
  bytes_delta_default_vs_nano="$(awk -v n="${nano_avg:-0}" -v d="${default_avg:-0}" 'BEGIN { if (n<=0 || d<=0) print 0; else printf "%.2f", ((d-n)/n)*100 }')"
  bytes_delta_micro_vs_tiny="$(awk -v t="${tiny_avg:-0}" -v m="${micro_avg:-0}" 'BEGIN { if (t<=0 || m<=0) print 0; else printf "%.2f", ((m-t)/t)*100 }')"
  bytes_delta_nano_vs_tiny="$(awk -v t="${tiny_avg:-0}" -v n="${nano_avg:-0}" 'BEGIN { if (t<=0 || n<=0) print 0; else printf "%.2f", ((n-t)/t)*100 }')"
  bytes_delta_nano_vs_micro="$(awk -v m="${micro_avg:-0}" -v n="${nano_avg:-0}" 'BEGIN { if (m<=0 || n<=0) print 0; else printf "%.2f", ((n-m)/m)*100 }')"

  local report
  report="$(jq -nc \
    --arg endpoint "$ENDPOINT" \
    --arg agent_id "$AGENT_ID" \
    --argjson rounds "$ROUNDS" \
    --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson results "$rows_json" \
    --arg default_vs_tiny "$bytes_delta_default_vs_tiny" \
    --arg default_vs_nano "$bytes_delta_default_vs_nano" \
    --arg micro_vs_tiny "$bytes_delta_micro_vs_tiny" \
    --arg nano_vs_tiny "$bytes_delta_nano_vs_tiny" \
    --arg nano_vs_micro "$bytes_delta_nano_vs_micro" \
    '{
      generated_at:$generated_at,
      endpoint:$endpoint,
      agent_id:$agent_id,
      rounds:$rounds,
      results:$results,
      deltas:{
        default_vs_tiny_avg_bytes_pct:($default_vs_tiny|tonumber),
        default_vs_nano_avg_bytes_pct:($default_vs_nano|tonumber),
        micro_vs_tiny_avg_bytes_pct:($micro_vs_tiny|tonumber),
        nano_vs_tiny_avg_bytes_pct:($nano_vs_tiny|tonumber),
        nano_vs_micro_avg_bytes_pct:($nano_vs_micro|tonumber)
      }
    }')"

  printf '%s\n' "$report" > "$OUT_FILE"
  echo "Wrote wait mode A/B report: $OUT_FILE"
  printf '%s\n' "$report"
}

main "$@"
