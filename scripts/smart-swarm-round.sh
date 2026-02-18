#!/usr/bin/env bash
set -euo pipefail

ENDPOINT="${ENDPOINT:-http://localhost:3000/mcp}"
HEALTH_URL="${ENDPOINT%/mcp}/health"
WORKERS="${WORKERS:-8}"
WORKER_BACKEND="${WORKER_BACKEND:-mixed}" # claude | codex | mixed
ALLOW_BACKEND_FALLBACK="${ALLOW_BACKEND_FALLBACK:-1}" # 1 to fallback when selected backend is unavailable
OUT_DIR="${OUT_DIR:-/tmp/smart-swarm}"
WORKER_TIMEOUT_SEC="${WORKER_TIMEOUT_SEC:-900}"
ENABLE_NAMESPACE="${ENABLE_NAMESPACE:-auto}" # auto | true | false
NAMESPACE="${NAMESPACE:-}"
USE_AUTH_TOKEN="${USE_AUTH_TOKEN:-auto}" # auto | true | false
SNAPSHOT_RESPONSE_MODE="${SNAPSHOT_RESPONSE_MODE:-auto}" # auto | tiny | nano
MCP_HTTP_CONNECT_TIMEOUT_SEC="${MCP_HTTP_CONNECT_TIMEOUT_SEC:-3}"
MCP_HTTP_TIMEOUT_SEC="${MCP_HTTP_TIMEOUT_SEC:-25}"
MCP_HTTP_RETRIES="${MCP_HTTP_RETRIES:-2}"
MCP_HTTP_RETRY_DELAY_SEC="${MCP_HTTP_RETRY_DELAY_SEC:-1}"
MCP_REINIT_ON_SESSION_ERROR="${MCP_REINIT_ON_SESSION_ERROR:-1}" # 1 to auto-reinit when session is expired/unknown
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
CODEX_BIN="${CODEX_BIN:-codex}"
CLAUDE_MODEL="${CLAUDE_MODEL:-}"
CODEX_MODEL="${CODEX_MODEL:-}"
SKIP_CLI_PREFLIGHT="${SKIP_CLI_PREFLIGHT:-0}" # 1 to skip local CLI MCP checks
FORCE_WORKER_ENDPOINT_CONFIG="${FORCE_WORKER_ENDPOINT_CONFIG:-1}" # 1 to force workers to use ENDPOINT

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_CONFIG_FILE="${MCP_CONFIG_FILE:-$ROOT_DIR/.mcp.json}"
WORKER_MCP_CONFIG_FILE="$MCP_CONFIG_FILE"
CODEX_MCP_OVERRIDE="mcp_servers.agent-hub.url=\"$ENDPOINT\""

mkdir -p "$OUT_DIR"

if [ -z "$NAMESPACE" ]; then
  NAMESPACE="SWARM-$(date +%s)"
fi

EXPERIMENT_TAG="$NAMESPACE"
ORCHESTRATOR_ID="orch-${EXPERIMENT_TAG}"
TASK_PREFIX="[${EXPERIMENT_TAG}]"
WORKER_PREFIX="sw-${EXPERIMENT_TAG}-"
BACKEND_MODE_REQUESTED="$WORKER_BACKEND"

CALL_SEQ=100
TOOL_RESULT=''
ORCHESTRATOR_AUTH_TOKEN=''
LAST_VALID_SID=''
CLAUDE_AVAILABLE=1
CODEX_AVAILABLE=1
CLAUDE_UNAVAILABLE_REASON=''
CODEX_UNAVAILABLE_REASON=''
PREFLIGHT_EXECUTED=0
SNAPSHOT_RESPONSE_MODE_EFFECTIVE='tiny'
SNAPSHOT_NANO_SUPPORTED='false'

require_cmd() {
  local bin="$1"
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "Missing required command: $bin" >&2
    exit 1
  fi
}

validate_boolish() {
  case "$1" in
    0|1|true|false) return 0 ;;
    *) return 1 ;;
  esac
}

normalize_boolish() {
  case "$1" in
    true) printf '1' ;;
    false) printf '0' ;;
    *) printf '%s' "$1" ;;
  esac
}

if ! validate_boolish "$ALLOW_BACKEND_FALLBACK"; then
  echo "Invalid ALLOW_BACKEND_FALLBACK=$ALLOW_BACKEND_FALLBACK. Use 0|1|true|false." >&2
  exit 1
fi
ALLOW_BACKEND_FALLBACK="$(normalize_boolish "$ALLOW_BACKEND_FALLBACK")"

if ! validate_boolish "$MCP_REINIT_ON_SESSION_ERROR"; then
  echo "Invalid MCP_REINIT_ON_SESSION_ERROR=$MCP_REINIT_ON_SESSION_ERROR. Use 0|1|true|false." >&2
  exit 1
fi
MCP_REINIT_ON_SESSION_ERROR="$(normalize_boolish "$MCP_REINIT_ON_SESSION_ERROR")"

if ! validate_boolish "$SKIP_CLI_PREFLIGHT"; then
  echo "Invalid SKIP_CLI_PREFLIGHT=$SKIP_CLI_PREFLIGHT. Use 0|1|true|false." >&2
  exit 1
fi
SKIP_CLI_PREFLIGHT="$(normalize_boolish "$SKIP_CLI_PREFLIGHT")"

if ! validate_boolish "$FORCE_WORKER_ENDPOINT_CONFIG"; then
  echo "Invalid FORCE_WORKER_ENDPOINT_CONFIG=$FORCE_WORKER_ENDPOINT_CONFIG. Use 0|1|true|false." >&2
  exit 1
fi
FORCE_WORKER_ENDPOINT_CONFIG="$(normalize_boolish "$FORCE_WORKER_ENDPOINT_CONFIG")"

cli_preflight() {
  local need_claude=0
  local need_codex=0
  local claude_list codex_list auth_status logged_in

  CLAUDE_AVAILABLE=1
  CODEX_AVAILABLE=1
  CLAUDE_UNAVAILABLE_REASON=''
  CODEX_UNAVAILABLE_REASON=''

  if [ "$WORKER_BACKEND" != "codex" ]; then
    need_claude=1
  fi
  if [ "$WORKER_BACKEND" != "claude" ]; then
    need_codex=1
  fi

  if [ "$need_claude" -eq 1 ]; then
    if [ ! -f "$WORKER_MCP_CONFIG_FILE" ]; then
      CLAUDE_AVAILABLE=0
      CLAUDE_UNAVAILABLE_REASON='missing_mcp_config'
    elif ! jq -e '.mcpServers["agent-hub"].url | strings | length > 0' "$WORKER_MCP_CONFIG_FILE" >/dev/null 2>&1; then
      CLAUDE_AVAILABLE=0
      CLAUDE_UNAVAILABLE_REASON='invalid_mcp_config'
    elif ! claude_list=$("$CLAUDE_BIN" --mcp-config "$WORKER_MCP_CONFIG_FILE" --strict-mcp-config mcp list 2>&1); then
      CLAUDE_AVAILABLE=0
      CLAUDE_UNAVAILABLE_REASON='mcp_preflight_failed'
    elif ! printf '%s\n' "$claude_list" | grep -q 'agent-hub:'; then
      CLAUDE_AVAILABLE=0
      CLAUDE_UNAVAILABLE_REASON='agent_hub_not_listed'
    else
      auth_status=$("$CLAUDE_BIN" auth status 2>/dev/null || true)
      logged_in=$(printf '%s' "$auth_status" | jq -r '.loggedIn // false' 2>/dev/null || echo false)
      if [ "$logged_in" != "true" ]; then
        CLAUDE_AVAILABLE=0
        CLAUDE_UNAVAILABLE_REASON='not_authenticated'
      fi
    fi
  fi

  if [ "$need_codex" -eq 1 ]; then
    if ! codex_list=$("$CODEX_BIN" -c "$CODEX_MCP_OVERRIDE" mcp list 2>&1); then
      CODEX_AVAILABLE=0
      CODEX_UNAVAILABLE_REASON='mcp_preflight_failed'
    elif ! printf '%s\n' "$codex_list" | grep -Eq '^[[:space:]]*agent-hub[[:space:]]'; then
      CODEX_AVAILABLE=0
      CODEX_UNAVAILABLE_REASON='agent_hub_not_listed'
    fi
  fi

  case "$WORKER_BACKEND" in
    claude)
      if [ "$CLAUDE_AVAILABLE" -ne 1 ]; then
        if [ "$ALLOW_BACKEND_FALLBACK" = "1" ] && [ "$CODEX_AVAILABLE" -eq 1 ]; then
          if ! command -v "$CODEX_BIN" >/dev/null 2>&1; then
            echo "Fallback target codex is unavailable in PATH." >&2
            exit 1
          fi
          echo "Claude unavailable ($CLAUDE_UNAVAILABLE_REASON), fallback to codex." >&2
          WORKER_BACKEND='codex'
        else
          echo "Claude backend unavailable: $CLAUDE_UNAVAILABLE_REASON" >&2
          echo "Run 'claude auth login' or set WORKER_BACKEND=codex." >&2
          exit 1
        fi
      fi
      ;;
    codex)
      if [ "$CODEX_AVAILABLE" -ne 1 ]; then
        if [ "$ALLOW_BACKEND_FALLBACK" = "1" ] && [ "$CLAUDE_AVAILABLE" -eq 1 ]; then
          if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
            echo "Fallback target claude is unavailable in PATH." >&2
            exit 1
          fi
          echo "Codex unavailable ($CODEX_UNAVAILABLE_REASON), fallback to claude." >&2
          WORKER_BACKEND='claude'
        else
          echo "Codex backend unavailable: $CODEX_UNAVAILABLE_REASON" >&2
          exit 1
        fi
      fi
      ;;
    mixed)
      if [ "$CLAUDE_AVAILABLE" -ne 1 ] && [ "$CODEX_AVAILABLE" -ne 1 ]; then
        echo "No available backend for mixed mode. claude=$CLAUDE_UNAVAILABLE_REASON codex=$CODEX_UNAVAILABLE_REASON" >&2
        exit 1
      fi
      if [ "$CLAUDE_AVAILABLE" -ne 1 ]; then
        echo "Mixed mode degraded: claude unavailable ($CLAUDE_UNAVAILABLE_REASON), using codex-only workers." >&2
      fi
      if [ "$CODEX_AVAILABLE" -ne 1 ]; then
        echo "Mixed mode degraded: codex unavailable ($CODEX_UNAVAILABLE_REASON), using claude-only workers." >&2
      fi
      ;;
    *)
      echo "Invalid WORKER_BACKEND=$WORKER_BACKEND. Use claude|codex|mixed." >&2
      exit 1
      ;;
  esac
}

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
  local attempts=30
  local i=1
  while [ "$i" -le "$attempts" ]; do
    if curl -sS --connect-timeout "$MCP_HTTP_CONNECT_TIMEOUT_SEC" --max-time "$MCP_HTTP_TIMEOUT_SEC" "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  echo "Hub is not reachable at $HEALTH_URL" >&2
  return 1
}

mcp_init() {
  local init_payload initialized_payload init_response session_id
  init_payload='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smart-swarm-runner","version":"1.0.0"}}}'
  initialized_payload='{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'

  if ! init_response=$(curl_init_post "$init_payload"); then
    echo "Failed to reach MCP endpoint during initialize: $ENDPOINT" >&2
    return 1
  fi

  session_id=$(printf '%s\n' "$init_response" | awk '/^mcp-session-id:/ {print $2}' | tr -d '\r')
  if [ -z "$session_id" ]; then
    echo "Failed to initialize MCP session." >&2
    printf '%s\n' "$init_response" | sed -n '1,80p' >&2
    return 1
  fi

  if ! curl_post_json "$session_id" "$initialized_payload" >/dev/null; then
    echo "Failed to send initialized notification." >&2
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

mcp_tools_list() {
  local sid="$1"
  local req response payload effective_sid reinit_attempted=0
  req='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

  while true; do
    effective_sid="${LAST_VALID_SID:-$sid}"
    if ! response=$(curl_post_json "$effective_sid" "$req"); then
      echo "Failed to call tools/list due to transport error." >&2
      return 1
    fi

    payload=$(extract_payload "$response")
    if printf '%s' "$payload" | jq -e '.error' >/dev/null 2>&1; then
      if [ "$MCP_REINIT_ON_SESSION_ERROR" = "1" ] && [ "$reinit_attempted" -eq 0 ] && is_reinitable_session_error "$payload"; then
        reinit_attempted=1
        if mcp_reinit; then
          continue
        fi
      fi
      echo "tools/list failed." >&2
      printf '%s\n' "$payload" | jq '.' >&2 || printf '%s\n' "$payload" >&2
      return 1
    fi

    printf '%s' "$payload"
    return 0
  done
}

mcp_tool_call() {
  local sid="$1"
  local tool="$2"
  local args_json="$3"
  local req response payload text effective_sid reinit_attempted=0

  CALL_SEQ=$((CALL_SEQ + 1))
  req=$(jq -cn --argjson id "$CALL_SEQ" --arg name "$tool" --argjson args "$args_json" \
    '{jsonrpc:"2.0",id:$id,method:"tools/call",params:{name:$name,arguments:$args}}')

  while true; do
    effective_sid="${LAST_VALID_SID:-$sid}"
    if ! response=$(curl_post_json "$effective_sid" "$req"); then
      echo "Tool call transport failure for $tool" >&2
      return 1
    fi

    payload=$(extract_payload "$response")
    if printf '%s' "$payload" | jq -e '.error' >/dev/null 2>&1; then
      if [ "$MCP_REINIT_ON_SESSION_ERROR" = "1" ] && [ "$reinit_attempted" -eq 0 ] && is_reinitable_session_error "$payload"; then
        reinit_attempted=1
        if mcp_reinit; then
          continue
        fi
      fi
      echo "Tool call failed for $tool" >&2
      printf '%s\n' "$payload" | jq '.' >&2 || printf '%s\n' "$payload" >&2
      return 1
    fi

    text=$(printf '%s' "$payload" | jq -r '.result.content[0].text // empty')
    if [ -z "$text" ]; then
      echo "Unexpected tool response for $tool" >&2
      printf '%s\n' "$payload" >&2
      return 1
    fi

    TOOL_RESULT="$text"
    return 0
  done
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
    echo "Tool returned success=false for $label" >&2
    printf '%s\n' "$json" | jq '.' >&2 || printf '%s\n' "$json" >&2
    return 1
  fi
}

backend_for_worker() {
  local idx="$1"
  case "$WORKER_BACKEND" in
    claude)
      if [ "$CLAUDE_AVAILABLE" -ne 1 ]; then
        echo "Backend claude selected but unavailable: $CLAUDE_UNAVAILABLE_REASON" >&2
        exit 1
      fi
      printf 'claude'
      ;;
    codex)
      if [ "$CODEX_AVAILABLE" -ne 1 ]; then
        echo "Backend codex selected but unavailable: $CODEX_UNAVAILABLE_REASON" >&2
        exit 1
      fi
      printf 'codex'
      ;;
    mixed)
      if [ "$CLAUDE_AVAILABLE" -eq 1 ] && [ "$CODEX_AVAILABLE" -eq 1 ]; then
        if [ $((idx % 2)) -eq 1 ]; then
          printf 'claude'
        else
          printf 'codex'
        fi
      elif [ "$CLAUDE_AVAILABLE" -eq 1 ]; then
        printf 'claude'
      elif [ "$CODEX_AVAILABLE" -eq 1 ]; then
        printf 'codex'
      else
        echo "No available backend for mixed mode." >&2
        exit 1
      fi
      ;;
    *)
      echo "Invalid WORKER_BACKEND=$WORKER_BACKEND. Use claude|codex|mixed." >&2
      exit 1
      ;;
  esac
}

timeout_wrap() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "${seconds}s" "$@"
    return
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "${seconds}s" "$@"
    return
  fi
  "$@"
}

make_worker_prompt() {
  local worker_id="$1"
  local backend="$2"
  local task_id="$3"
  local prompt_file="$4"
  local auth_mode_hint="$5"
  local namespace_line=''

  if [ "${USE_NAMESPACE:-0}" -eq 1 ]; then
    namespace_line="- Work only in namespace '$NAMESPACE'."
  fi

  cat > "$prompt_file" <<EOF
You are $worker_id ($backend) participating in MCP protocol optimization experiment $EXPERIMENT_TAG.
Use MCP server agent-hub only. Do not edit repository files and do not run shell commands.

Execution contract:
1) register_agent with your id, onboarding_mode='none', lifecycle='ephemeral'.
   Include runtime_profile auto-detected from your local working directory:
   - mode: repo|isolated|unknown
   - cwd, has_git, file_count, empty_dir, source='client_auto'
2) Extract auth token from register response (.auth.token). Keep it in AUTH_TOKEN.
3) claim_task for task_id=$task_id with lease_seconds=600 (include auth_token=AUTH_TOKEN).
4) Produce one compact JSON proposal with exactly 3 hypotheses:
   - token_economy
   - latency
   - accuracy
   For each hypothesis include fields: idea, expected_kpi, validation.
5) share_context key='proposal' with that JSON string (include auth_token=AUTH_TOKEN).
6) send_blob_message to '$ORCHESTRATOR_ID' with the same JSON payload (include auth_token=AUTH_TOKEN).
7) Capture context/message ids from steps 5-6 and release_task_claim as done with confidence >= 0.90, verification_passed=true, evidence_refs=["context_id:<id>","message_id:<id>"] (include auth_token=AUTH_TOKEN).

Constraints:
- Use idempotency_key on all mutating calls.
$namespace_line
- Current server auth_mode is '$auth_mode_hint'. In warn/enforce modes, always pass auth_token after register_agent.
- Keep payload under 1200 chars.
- If a call fails, retry once with same idempotency_key.
- Final assistant text response must be one line summary only.
EOF
}

execute_worker_backend() {
  local backend="$1"
  local prompt="$2"
  local log_file="$3"
  local exit_code

  set +e
  if [ "$backend" = 'claude' ]; then
    if [ -n "$CLAUDE_MODEL" ]; then
      timeout_wrap "$WORKER_TIMEOUT_SEC" "$CLAUDE_BIN" -p \
        --permission-mode bypassPermissions \
        --mcp-config "$WORKER_MCP_CONFIG_FILE" \
        --strict-mcp-config \
        --model "$CLAUDE_MODEL" \
        "$prompt" >"$log_file" 2>&1
    else
      timeout_wrap "$WORKER_TIMEOUT_SEC" "$CLAUDE_BIN" -p \
        --permission-mode bypassPermissions \
        --mcp-config "$WORKER_MCP_CONFIG_FILE" \
        --strict-mcp-config \
        "$prompt" >"$log_file" 2>&1
    fi
    exit_code=$?
  else
    if [ -n "$CODEX_MODEL" ]; then
      timeout_wrap "$WORKER_TIMEOUT_SEC" "$CODEX_BIN" -c "$CODEX_MCP_OVERRIDE" exec \
        --full-auto \
        --skip-git-repo-check \
        --sandbox workspace-write \
        --model "$CODEX_MODEL" \
        "$prompt" >"$log_file" 2>&1
    else
      timeout_wrap "$WORKER_TIMEOUT_SEC" "$CODEX_BIN" -c "$CODEX_MCP_OVERRIDE" exec \
        --full-auto \
        --skip-git-repo-check \
        --sandbox workspace-write \
        "$prompt" >"$log_file" 2>&1
    fi
    exit_code=$?
  fi
  set -e

  printf '%s' "$exit_code"
}

run_single_worker() {
  local worker_id="$1"
  local backend="$2"
  local task_id="$3"
  local log_file="$4"
  local prompt_file="$5"
  local result_file="$6"
  local started ended exit_code prompt
  local log_bytes=0
  local effective_backend="$backend"
  local fallback_used=0
  local fallback_reason=''

  started=$(now_ms)
  prompt=$(cat "$prompt_file")

  exit_code=$(execute_worker_backend "$backend" "$prompt" "$log_file")
  if [ -f "$log_file" ]; then
    log_bytes=$(wc -c < "$log_file" | tr -d ' ')
  fi

  if [ "$backend" = 'claude' ] && [ "$ALLOW_BACKEND_FALLBACK" = "1" ] && [ "$CODEX_AVAILABLE" -eq 1 ] && { [ "$exit_code" -ne 0 ] || [ "$log_bytes" -eq 0 ]; }; then
    fallback_used=1
    effective_backend='codex'
    if [ "$exit_code" -ne 0 ]; then
      fallback_reason="claude_exit_${exit_code}"
    else
      fallback_reason='claude_empty_output'
    fi
    exit_code=$(execute_worker_backend 'codex' "$prompt" "$log_file")
    if [ -f "$log_file" ]; then
      log_bytes=$(wc -c < "$log_file" | tr -d ' ')
    else
      log_bytes=0
    fi
  fi

  ended=$(now_ms)
  jq -cn \
    --arg worker_id "$worker_id" \
    --arg requested_backend "$backend" \
    --arg backend "$effective_backend" \
    --arg log_file "$log_file" \
    --arg fallback_reason "$fallback_reason" \
    --argjson fallback_used "$( [ "$fallback_used" -eq 1 ] && echo true || echo false )" \
    --argjson task_id "$task_id" \
    --argjson exit_code "$exit_code" \
    --argjson log_bytes "$log_bytes" \
    --argjson duration_ms "$((ended - started))" \
    '{
      worker_id:$worker_id,
      requested_backend:$requested_backend,
      backend:$backend,
      task_id:$task_id,
      exit_code:$exit_code,
      ok:(($exit_code == 0) and ($log_bytes > 0)),
      fallback_used:$fallback_used,
      fallback_reason:(if $fallback_used then $fallback_reason else null end),
      log_bytes:$log_bytes,
      duration_ms:$duration_ms,
      log_file:$log_file
    }' > "$result_file"
}

require_cmd jq
require_cmd curl
if [ "$WORKER_BACKEND" != "codex" ]; then
  require_cmd "$CLAUDE_BIN"
fi
if [ "$WORKER_BACKEND" != "claude" ]; then
  require_cmd "$CODEX_BIN"
fi

if [ "$FORCE_WORKER_ENDPOINT_CONFIG" = "1" ]; then
  WORKER_MCP_CONFIG_FILE="$OUT_DIR/mcp-workers.json"
  jq -cn --arg endpoint "$ENDPOINT" '{
    mcpServers: {
      "agent-hub": {
        url: $endpoint
      }
    }
  }' > "$WORKER_MCP_CONFIG_FILE"
fi

case "$USE_AUTH_TOKEN" in
  auto|true|false) ;;
  *)
    echo "Invalid USE_AUTH_TOKEN=$USE_AUTH_TOKEN. Use auto|true|false." >&2
    exit 1
    ;;
esac

case "$SNAPSHOT_RESPONSE_MODE" in
  auto|tiny|nano) ;;
  *)
    echo "Invalid SNAPSHOT_RESPONSE_MODE=$SNAPSHOT_RESPONSE_MODE. Use auto|tiny|nano." >&2
    exit 1
    ;;
esac

wait_for_hub
if [ "$SKIP_CLI_PREFLIGHT" != "1" ]; then
  cli_preflight
  PREFLIGHT_EXECUTED=1
fi

RUN_STARTED_MS=$(now_ms)
SESSION_ID="$(mcp_init)"
trap 'mcp_close' EXIT

TOOLS_JSON=$(mcp_tools_list "$SESSION_ID")
NAMESPACE_SUPPORTED=$(printf '%s' "$TOOLS_JSON" | jq -r '
  [
    (.result.tools[]? | select(.name=="create_task") | (.inputSchema.properties | has("namespace"))),
    (.result.tools[]? | select(.name=="poll_and_claim") | (.inputSchema.properties | has("namespace")))
  ] | all
')
SNAPSHOT_NANO_SUPPORTED=$(printf '%s' "$TOOLS_JSON" | jq -r '
  [
    ((.result.tools[]? | select(.name=="list_tasks") | .inputSchema.properties.response_mode.enum // []) | index("nano") != null),
    ((.result.tools[]? | select(.name=="read_messages") | .inputSchema.properties.response_mode.enum // []) | index("nano") != null),
    ((.result.tools[]? | select(.name=="get_context") | .inputSchema.properties.response_mode.enum // []) | index("nano") != null)
  ] | all
')
SNAPSHOT_BATCH_SUPPORTED=$(printf '%s' "$TOOLS_JSON" | jq -r '
  [(.result.tools[]?.name)] | index("read_snapshot") != null
')
SNAPSHOT_BATCH_USED=0
case "$SNAPSHOT_RESPONSE_MODE" in
  auto)
    if [ "$SNAPSHOT_NANO_SUPPORTED" = "true" ]; then
      SNAPSHOT_RESPONSE_MODE_EFFECTIVE='nano'
    else
      SNAPSHOT_RESPONSE_MODE_EFFECTIVE='tiny'
    fi
    ;;
  tiny)
    SNAPSHOT_RESPONSE_MODE_EFFECTIVE='tiny'
    ;;
  nano)
    if [ "$SNAPSHOT_NANO_SUPPORTED" = "true" ]; then
      SNAPSHOT_RESPONSE_MODE_EFFECTIVE='nano'
    else
      echo "SNAPSHOT_RESPONSE_MODE=nano requested, but server does not support nano for all snapshot tools; fallback to tiny." >&2
      SNAPSHOT_RESPONSE_MODE_EFFECTIVE='tiny'
    fi
    ;;
esac

USE_NAMESPACE=0
case "$ENABLE_NAMESPACE" in
  auto)
    if [ "$NAMESPACE_SUPPORTED" = "true" ]; then
      USE_NAMESPACE=1
    fi
    ;;
  true)
    if [ "$NAMESPACE_SUPPORTED" != "true" ]; then
      echo "Namespace isolation requested but server does not advertise namespace support." >&2
      exit 1
    fi
    USE_NAMESPACE=1
    ;;
  false)
    USE_NAMESPACE=0
    ;;
  *)
    echo "Invalid ENABLE_NAMESPACE=$ENABLE_NAMESPACE. Use auto|true|false." >&2
    exit 1
    ;;
esac

mcp_tool_call "$SESSION_ID" register_agent "$(jq -cn --arg id "$ORCHESTRATOR_ID" --arg n "Smart Swarm Orchestrator" '{id:$id,name:$n,type:"codex",capabilities:"orchestration,experiment",onboarding_mode:"none",lifecycle:"persistent",runtime_profile:{mode:"repo",has_git:true,file_count:1,empty_dir:false,source:"client_declared"}}')"
assert_success "$TOOL_RESULT" "register_orchestrator"
ORCHESTRATOR_AUTH_TOKEN=$(printf '%s' "$TOOL_RESULT" | jq -r '.auth.token // empty')
if [ "$USE_AUTH_TOKEN" = "true" ] && [ -z "$ORCHESTRATOR_AUTH_TOKEN" ]; then
  echo "orchestrator auth token missing in USE_AUTH_TOKEN=true mode" >&2
  exit 1
fi
AUTH_MODE_HINT=$(curl -sS --connect-timeout "$MCP_HTTP_CONNECT_TIMEOUT_SEC" --max-time "$MCP_HTTP_TIMEOUT_SEC" "$HEALTH_URL" 2>/dev/null | jq -r '.auth_mode // "unknown"' 2>/dev/null || echo "unknown")

declare -a WORKER_IDS
declare -a WORKER_BACKENDS
declare -a TASK_IDS
declare -a RESULT_FILES
declare -a PIDS

for i in $(seq 1 "$WORKERS"); do
  worker_id="${WORKER_PREFIX}${i}"
  backend="$(backend_for_worker "$i")"
  title="${TASK_PREFIX} worker-${i} protocol optimization"
  description="Experiment=$EXPERIMENT_TAG backend=$backend objective=propose token/latency/accuracy improvements"

  if [ "$USE_NAMESPACE" -eq 1 ]; then
    create_args=$(jq -cn \
      --arg title "$title" \
      --arg description "$description" \
      --arg created_by "$ORCHESTRATOR_ID" \
      --arg assigned_to "$worker_id" \
      --arg namespace "$NAMESPACE" \
      '{title:$title,description:$description,created_by:$created_by,assigned_to:$assigned_to,priority:"high",namespace:$namespace}')
  else
    create_args=$(jq -cn \
      --arg title "$title" \
      --arg description "$description" \
      --arg created_by "$ORCHESTRATOR_ID" \
      --arg assigned_to "$worker_id" \
      '{title:$title,description:$description,created_by:$created_by,assigned_to:$assigned_to,priority:"high"}')
  fi

  mcp_tool_call_auth "$SESSION_ID" create_task "$create_args" "$ORCHESTRATOR_AUTH_TOKEN"
  assert_success "$TOOL_RESULT" "create_task_$i"

  task_id=$(printf '%s' "$TOOL_RESULT" | jq -r '.task.id')
  if [ -z "$task_id" ] || [ "$task_id" = "null" ]; then
    echo "Failed to parse task id for worker $worker_id" >&2
    exit 1
  fi

  WORKER_IDS+=("$worker_id")
  WORKER_BACKENDS+=("$backend")
  TASK_IDS+=("$task_id")
done

for idx in "${!WORKER_IDS[@]}"; do
  worker_id="${WORKER_IDS[$idx]}"
  backend="${WORKER_BACKENDS[$idx]}"
  task_id="${TASK_IDS[$idx]}"
  prompt_file="$OUT_DIR/${worker_id}.prompt.txt"
  log_file="$OUT_DIR/${worker_id}.log"
  result_file="$OUT_DIR/${worker_id}.result.json"
  RESULT_FILES+=("$result_file")

  make_worker_prompt "$worker_id" "$backend" "$task_id" "$prompt_file" "$AUTH_MODE_HINT"
  run_single_worker "$worker_id" "$backend" "$task_id" "$log_file" "$prompt_file" "$result_file" &
  PIDS+=("$!")
done

for pid in "${PIDS[@]}"; do
  wait "$pid"
done

if [ "$SNAPSHOT_BATCH_SUPPORTED" = "true" ]; then
  SNAPSHOT_BATCH_USED=1
  if [ "$USE_NAMESPACE" -eq 1 ]; then
    SNAPSHOT_ARGS=$(jq -cn \
      --arg aid "$ORCHESTRATOR_ID" \
      --arg mode "$SNAPSHOT_RESPONSE_MODE_EFFECTIVE" \
      --arg ns "$NAMESPACE" \
      --argjson limit 500 \
      '{agent_id:$aid,response_mode:$mode,message_limit:$limit,task_limit:$limit,context_limit:$limit,task_namespace:$ns,context_namespace:$ns}')
  else
    SNAPSHOT_ARGS=$(jq -cn \
      --arg aid "$ORCHESTRATOR_ID" \
      --arg mode "$SNAPSHOT_RESPONSE_MODE_EFFECTIVE" \
      --argjson limit 500 \
      '{agent_id:$aid,response_mode:$mode,message_limit:$limit,task_limit:$limit,context_limit:$limit}')
  fi
  mcp_tool_call_auth "$SESSION_ID" read_snapshot "$SNAPSHOT_ARGS" "$ORCHESTRATOR_AUTH_TOKEN"
  SNAPSHOT_JSON="$TOOL_RESULT"
  assert_success "$SNAPSHOT_JSON" "read_snapshot_batch"
  TASK_SNAPSHOT="$SNAPSHOT_JSON"
  INBOX_JSON="$SNAPSHOT_JSON"
  CTX_JSON="$SNAPSHOT_JSON"
  TASK_SNAPSHOT_BYTES=$(printf '%s' "$SNAPSHOT_JSON" | jq -c '.s.t // .snapshot.tasks.t // .snapshot.tasks.tasks // .tasks // .t // []' | wc -c | tr -d ' ')
  INBOX_SNAPSHOT_BYTES=$(printf '%s' "$SNAPSHOT_JSON" | jq -c '.s.m // .snapshot.messages.m // .snapshot.messages.messages // .messages // .m // []' | wc -c | tr -d ' ')
  CTX_SNAPSHOT_BYTES=$(printf '%s' "$SNAPSHOT_JSON" | jq -c '.s.c // .snapshot.context.c // .snapshot.context.contexts // .contexts // .c // []' | wc -c | tr -d ' ')
else
  mcp_tool_call_auth "$SESSION_ID" list_tasks "$(jq -cn --arg aid "$ORCHESTRATOR_ID" --arg mode "$SNAPSHOT_RESPONSE_MODE_EFFECTIVE" --argjson limit 500 '{agent_id:$aid,limit:$limit,response_mode:$mode,polling:true}')" "$ORCHESTRATOR_AUTH_TOKEN"
  TASK_SNAPSHOT="$TOOL_RESULT"
  assert_success "$TASK_SNAPSHOT" "list_tasks_snapshot"
  TASK_SNAPSHOT_BYTES=$(printf '%s' "$TASK_SNAPSHOT" | wc -c | tr -d ' ')

  mcp_tool_call_auth "$SESSION_ID" read_messages "$(jq -cn --arg aid "$ORCHESTRATOR_ID" --arg mode "$SNAPSHOT_RESPONSE_MODE_EFFECTIVE" '{agent_id:$aid,limit:500,response_mode:$mode,polling:true}')" "$ORCHESTRATOR_AUTH_TOKEN"
  INBOX_JSON="$TOOL_RESULT"
  assert_success "$INBOX_JSON" "read_messages_snapshot"
  INBOX_SNAPSHOT_BYTES=$(printf '%s' "$INBOX_JSON" | wc -c | tr -d ' ')

  if [ "$USE_NAMESPACE" -eq 1 ]; then
    CONTEXT_ARGS=$(jq -cn --arg rid "$ORCHESTRATOR_ID" --arg mode "$SNAPSHOT_RESPONSE_MODE_EFFECTIVE" --arg ns "$NAMESPACE" '{requesting_agent:$rid,limit:500,response_mode:$mode,polling:true,namespace:$ns}')
  else
    CONTEXT_ARGS=$(jq -cn --arg rid "$ORCHESTRATOR_ID" --arg mode "$SNAPSHOT_RESPONSE_MODE_EFFECTIVE" '{requesting_agent:$rid,limit:500,response_mode:$mode,polling:true}')
  fi
  mcp_tool_call_auth "$SESSION_ID" get_context "$CONTEXT_ARGS" "$ORCHESTRATOR_AUTH_TOKEN"
  CTX_JSON="$TOOL_RESULT"
  assert_success "$CTX_JSON" "get_context_snapshot"
  CTX_SNAPSHOT_BYTES=$(printf '%s' "$CTX_JSON" | wc -c | tr -d ' ')
fi

DONE_COUNT=$(printf '%s' "$TASK_SNAPSHOT" | jq --arg p "$TASK_PREFIX" '
  if (.s.t? | type) == "array" then
    [(.s.t // [])[] | select((.t // "") | startswith($p)) | select((.s // "")=="done")] | length
  elif (.t? | type) == "array" then
    [(.t // [])[] | select((.t // "") | startswith($p)) | select((.s // "")=="done")] | length
  elif (.snapshot.tasks.t? | type) == "array" then
    [(.snapshot.tasks.t // [])[] | select((.t // "") | startswith($p)) | select((.s // "")=="done")] | length
  else
    [(.tasks // .snapshot.tasks.tasks // [])[] | select((.title // .title_preview // "") | startswith($p)) | select((.status // "")=="done")] | length
  end
')
IN_PROGRESS_COUNT=$(printf '%s' "$TASK_SNAPSHOT" | jq --arg p "$TASK_PREFIX" '
  if (.s.t? | type) == "array" then
    [(.s.t // [])[] | select((.t // "") | startswith($p)) | select((.s // "")=="in_progress")] | length
  elif (.t? | type) == "array" then
    [(.t // [])[] | select((.t // "") | startswith($p)) | select((.s // "")=="in_progress")] | length
  elif (.snapshot.tasks.t? | type) == "array" then
    [(.snapshot.tasks.t // [])[] | select((.t // "") | startswith($p)) | select((.s // "")=="in_progress")] | length
  else
    [(.tasks // .snapshot.tasks.tasks // [])[] | select((.title // .title_preview // "") | startswith($p)) | select((.status // "")=="in_progress")] | length
  end
')
PENDING_COUNT=$(printf '%s' "$TASK_SNAPSHOT" | jq --arg p "$TASK_PREFIX" '
  if (.s.t? | type) == "array" then
    [(.s.t // [])[] | select((.t // "") | startswith($p)) | select((.s // "")=="pending")] | length
  elif (.t? | type) == "array" then
    [(.t // [])[] | select((.t // "") | startswith($p)) | select((.s // "")=="pending")] | length
  elif (.snapshot.tasks.t? | type) == "array" then
    [(.snapshot.tasks.t // [])[] | select((.t // "") | startswith($p)) | select((.s // "")=="pending")] | length
  else
    [(.tasks // .snapshot.tasks.tasks // [])[] | select((.title // .title_preview // "") | startswith($p)) | select((.status // "")=="pending")] | length
  end
')

INBOX_COUNT=$(printf '%s' "$INBOX_JSON" | jq --arg p "$WORKER_PREFIX" '
  if (.s.m? | type) == "array" then
    [(.s.m // [])[] | select((.f // "") | startswith($p))] | length
  elif (.m? | type) == "array" then
    [(.m // [])[] | select((.f // "") | startswith($p))] | length
  elif (.snapshot.messages.m? | type) == "array" then
    [(.snapshot.messages.m // [])[] | select((.f // "") | startswith($p))] | length
  else
    [(.messages // .snapshot.messages.messages // [])[] | select((.from_agent // "") | startswith($p))] | length
  end
')
INBOX_CHARS=$(printf '%s' "$INBOX_JSON" | jq --arg p "$WORKER_PREFIX" '
  if (.s.m? | type) == "array" then
    [(.s.m // [])[] | select((.f // "") | startswith($p)) | (.c // 0)] | add // 0
  elif (.m? | type) == "array" then
    [(.m // [])[] | select((.f // "") | startswith($p)) | (.c // 0)] | add // 0
  elif (.snapshot.messages.m? | type) == "array" then
    [(.snapshot.messages.m // [])[] | select((.f // "") | startswith($p)) | (.c // 0)] | add // 0
  else
    [(.messages // .snapshot.messages.messages // [])[] | select((.from_agent // "") | startswith($p)) | (.content_chars // ((.content // "") | length) // 0)] | add // 0
  end
')

CTX_COUNT=$(printf '%s' "$CTX_JSON" | jq --arg p "$WORKER_PREFIX" '
  if (.s.c? | type) == "array" then
    [(.s.c // [])[] | select((.a // "") | startswith($p))] | length
  elif (.c? | type) == "array" then
    [(.c // [])[] | select((.a // "") | startswith($p))] | length
  elif (.snapshot.context.c? | type) == "array" then
    [(.snapshot.context.c // [])[] | select((.a // "") | startswith($p))] | length
  else
    [(.contexts // .snapshot.context.contexts // [])[] | select((.agent_id // "") | startswith($p))] | length
  end
')
CTX_CHARS=$(printf '%s' "$CTX_JSON" | jq --arg p "$WORKER_PREFIX" '
  if (.s.c? | type) == "array" then
    [(.s.c // [])[] | select((.a // "") | startswith($p)) | (.c // 0)] | add // 0
  elif (.c? | type) == "array" then
    [(.c // [])[] | select((.a // "") | startswith($p)) | (.c // 0)] | add // 0
  elif (.snapshot.context.c? | type) == "array" then
    [(.snapshot.context.c // [])[] | select((.a // "") | startswith($p)) | (.c // 0)] | add // 0
  else
    [(.contexts // .snapshot.context.contexts // [])[] | select((.agent_id // "") | startswith($p)) | (.value_chars // ((.value // "") | length) // 0)] | add // 0
  end
')

WORKER_RESULTS=$(jq -s '.' "${RESULT_FILES[@]}")
RUN_ENDED_MS=$(now_ms)
RUN_DURATION_MS=$((RUN_ENDED_MS - RUN_STARTED_MS))
SNAPSHOT_TOTAL_BYTES=$((TASK_SNAPSHOT_BYTES + INBOX_SNAPSHOT_BYTES + CTX_SNAPSHOT_BYTES))

REPORT_FILE="$OUT_DIR/smart-swarm-${EXPERIMENT_TAG}.json"
jq -cn \
  --arg experiment "$EXPERIMENT_TAG" \
  --arg endpoint "$ENDPOINT" \
  --arg orchestrator "$ORCHESTRATOR_ID" \
  --arg backend_mode_requested "$BACKEND_MODE_REQUESTED" \
  --arg backend_mode_effective "$WORKER_BACKEND" \
  --arg snapshot_mode_requested "$SNAPSHOT_RESPONSE_MODE" \
  --arg snapshot_mode_effective "$SNAPSHOT_RESPONSE_MODE_EFFECTIVE" \
  --argjson workers "$WORKERS" \
  --argjson snapshot_nano_supported "$( [ "$SNAPSHOT_NANO_SUPPORTED" = "true" ] && echo true || echo false )" \
  --argjson snapshot_batch_supported "$( [ "$SNAPSHOT_BATCH_SUPPORTED" = "true" ] && echo true || echo false )" \
  --argjson snapshot_batch_used "$( [ "$SNAPSHOT_BATCH_USED" -eq 1 ] && echo true || echo false )" \
  --argjson preflight_executed "$( [ "$PREFLIGHT_EXECUTED" -eq 1 ] && echo true || echo false )" \
  --argjson claude_available "$( [ "$CLAUDE_AVAILABLE" -eq 1 ] && echo true || echo false )" \
  --argjson codex_available "$( [ "$CODEX_AVAILABLE" -eq 1 ] && echo true || echo false )" \
  --arg claude_unavailable_reason "$CLAUDE_UNAVAILABLE_REASON" \
  --arg codex_unavailable_reason "$CODEX_UNAVAILABLE_REASON" \
  --argjson namespace_supported "$( [ "$NAMESPACE_SUPPORTED" = "true" ] && echo true || echo false )" \
  --argjson namespace_used "$( [ "$USE_NAMESPACE" -eq 1 ] && echo true || echo false )" \
  --arg namespace "$NAMESPACE" \
  --arg auth_token_mode "$USE_AUTH_TOKEN" \
  --arg auth_mode_hint "$AUTH_MODE_HINT" \
  --argjson orchestrator_token_present "$( [ -n "$ORCHESTRATOR_AUTH_TOKEN" ] && echo true || echo false )" \
  --argjson duration_ms "$RUN_DURATION_MS" \
  --argjson worker_results "$WORKER_RESULTS" \
  --argjson done_count "$DONE_COUNT" \
  --argjson in_progress_count "$IN_PROGRESS_COUNT" \
  --argjson pending_count "$PENDING_COUNT" \
  --argjson inbox_count "$INBOX_COUNT" \
  --argjson inbox_chars "$INBOX_CHARS" \
  --argjson context_count "$CTX_COUNT" \
  --argjson context_chars "$CTX_CHARS" \
  --argjson snapshot_list_tasks_bytes "$TASK_SNAPSHOT_BYTES" \
  --argjson snapshot_read_messages_bytes "$INBOX_SNAPSHOT_BYTES" \
  --argjson snapshot_get_context_bytes "$CTX_SNAPSHOT_BYTES" \
  --argjson snapshot_total_bytes "$SNAPSHOT_TOTAL_BYTES" \
  '{
    generated_at: now | todate,
    experiment: $experiment,
    endpoint: $endpoint,
    orchestrator: $orchestrator,
    backend_mode: $backend_mode_effective,
    backend_mode_requested: $backend_mode_requested,
    backend_mode_effective: $backend_mode_effective,
    snapshots: {
      mode_requested: $snapshot_mode_requested,
      mode_effective: $snapshot_mode_effective,
      nano_supported: $snapshot_nano_supported,
      batch_supported: $snapshot_batch_supported,
      batch_used: $snapshot_batch_used,
      list_tasks_bytes: $snapshot_list_tasks_bytes,
      read_messages_bytes: $snapshot_read_messages_bytes,
      get_context_bytes: $snapshot_get_context_bytes,
      total_bytes: $snapshot_total_bytes,
      total_tokens_est: (($snapshot_total_bytes / 4) | floor)
    },
    workers: $workers,
    backend_health: {
      preflight_executed: $preflight_executed,
      claude_available: (if $preflight_executed then $claude_available else null end),
      codex_available: (if $preflight_executed then $codex_available else null end),
      claude_unavailable_reason: (if $preflight_executed and ($claude_available | not) then $claude_unavailable_reason else null end),
      codex_unavailable_reason: (if $preflight_executed and ($codex_available | not) then $codex_unavailable_reason else null end)
    },
    backend_runtime_health: {
      claude_requested_workers: ($worker_results | map(select(.requested_backend=="claude")) | length),
      codex_requested_workers: ($worker_results | map(select(.requested_backend=="codex")) | length),
      claude_fallback_used: ($worker_results | map(select(.requested_backend=="claude" and .fallback_used==true)) | length),
      codex_fallback_used: ($worker_results | map(select(.requested_backend=="codex" and .fallback_used==true)) | length)
    },
    namespace: {
      supported: $namespace_supported,
      used: $namespace_used,
      value: $namespace
    },
    auth: {
      token_mode: $auth_token_mode,
      server_auth_mode: $auth_mode_hint,
      orchestrator_token_present: $orchestrator_token_present
    },
    kpi: {
      duration_ms: $duration_ms,
      done_count: $done_count,
      in_progress_count: $in_progress_count,
      pending_count: $pending_count,
      done_rate_pct: (if $workers == 0 then 0 else (100 * $done_count / $workers) end),
      inbox_messages: $inbox_count,
      inbox_chars: $inbox_chars,
      context_entries: $context_count,
      context_chars: $context_chars,
      token_est_transport: ((($inbox_chars + $context_chars) / 4) | floor)
    },
    workers_result: {
      total: ($worker_results | length),
      ok: ($worker_results | map(select(.ok == true)) | length),
      failed: ($worker_results | map(select(.ok != true)) | length),
      requested_claude_workers: ($worker_results | map(select(.requested_backend=="claude")) | length),
      requested_codex_workers: ($worker_results | map(select(.requested_backend=="codex")) | length),
      claude_workers: ($worker_results | map(select(.backend=="claude")) | length),
      codex_workers: ($worker_results | map(select(.backend=="codex")) | length),
      fallback_used: ($worker_results | map(select(.fallback_used==true)) | length),
      claude_ok: ($worker_results | map(select(.backend=="claude" and .ok==true)) | length),
      codex_ok: ($worker_results | map(select(.backend=="codex" and .ok==true)) | length)
    },
    worker_runs: $worker_results
  }' > "$REPORT_FILE"

printf 'Smart swarm round finished.\n'
printf 'Experiment: %s\n' "$EXPERIMENT_TAG"
printf 'Report: %s\n' "$REPORT_FILE"
jq '.auth, .snapshots, .backend_health, .backend_runtime_health, .kpi, .workers_result, .namespace' "$REPORT_FILE"
