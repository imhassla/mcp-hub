#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ENV_FILE="$ROOT_DIR/deploy/hub.production.env"
DEFAULT_LOCAL_ENV_FILE="$ROOT_DIR/deploy/hub.local.env"
ENV_FILE="${MCP_HUB_ENV_FILE:-}"
LOCAL_ENV_FILE="${MCP_HUB_LOCAL_ENV_FILE:-$DEFAULT_LOCAL_ENV_FILE}"

ENV_SOURCES=()
CLI_ENV_OVERRIDES=()

while IFS='=' read -r env_name env_value; do
  case "$env_name" in
    MCP_HUB_*)
      CLI_ENV_OVERRIDES+=("$env_name=$env_value")
      ;;
  esac
done < <(env)

load_env_file() {
  local file="$1"
  local label="$2"
  if [ ! -f "$file" ]; then
    echo "Environment file not found: $file" >&2
    exit 1
  fi
  if [ "$label" = "local" ]; then
    local mode
    mode="$(stat -f '%Lp' "$file" 2>/dev/null || true)"
    case "$mode" in
      ""|*[!0-7]*) mode="$(stat -c '%a' "$file" 2>/dev/null || true)" ;;
    esac
    case "$mode" in
      ""|*[!0-7]*)
        echo "Cannot determine permissions for local environment file: $file" >&2
        exit 1
        ;;
    esac
    if (( (8#$mode & 8#077) != 0 )); then
      echo "Local environment file must not be accessible by group or others: $file (mode $mode)" >&2
      echo "Run: chmod 600 \"$file\"" >&2
      exit 1
    fi
  fi
  # shellcheck disable=SC1090
  . "$file"
  ENV_SOURCES+=("${label}:${file}")
}

if [ -z "$ENV_FILE" ] && [ -f "$DEFAULT_ENV_FILE" ]; then
  ENV_FILE="$DEFAULT_ENV_FILE"
fi
if [ -n "$ENV_FILE" ]; then
  load_env_file "$ENV_FILE" "base"
fi
if [ -n "${MCP_HUB_LOCAL_ENV_FILE:-}" ] && [ ! -f "$LOCAL_ENV_FILE" ]; then
  echo "Local environment file not found: $LOCAL_ENV_FILE" >&2
  exit 1
fi
if [ -f "$LOCAL_ENV_FILE" ] && [ "$LOCAL_ENV_FILE" != "$ENV_FILE" ]; then
  load_env_file "$LOCAL_ENV_FILE" "local"
fi

# Re-apply external MCP_HUB_* environment overrides after file-based config.
for override in "${CLI_ENV_OVERRIDES[@]}"; do
  export "$override"
done

IMAGE="${MCP_HUB_IMAGE:-mcp-agent-hub}"
CONTAINER="${MCP_HUB_CONTAINER:-mcp-hub}"
DB_DIR="${MCP_HUB_DATA:-$HOME/.mcp-hub}"
PORT="${MCP_HUB_PORT:-3000}"
LOCAL_BIND_HOST="127.0.0.1"
EXTRA_BIND_HOSTS_RAW="${MCP_HUB_EXTRA_BIND_HOSTS:-${MCP_HUB_EXTRA_BIND_HOST:-}}"

trim_ws() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

PUBLISH_BIND_HOSTS=("$LOCAL_BIND_HOST")
if [ -n "$EXTRA_BIND_HOSTS_RAW" ]; then
  IFS=',' read -r -a EXTRA_BIND_HOSTS <<< "$EXTRA_BIND_HOSTS_RAW"
  for raw_host in "${EXTRA_BIND_HOSTS[@]}"; do
    host="$(trim_ws "$raw_host")"
    if [ -z "$host" ] || [ "$host" = "$LOCAL_BIND_HOST" ]; then
      continue
    fi
    if [ "$host" = "0.0.0.0" ] \
      || [ "$host" = "::" ] \
      || [ "$host" = "[::]" ] \
      || [ "$host" = "0:0:0:0:0:0:0:0" ]; then
      echo "MCP_HUB_EXTRA_BIND_HOSTS must contain explicit interface addresses, not wildcard binds" >&2
      exit 1
    fi
    duplicate=0
    for existing_host in "${PUBLISH_BIND_HOSTS[@]}"; do
      if [ "$existing_host" = "$host" ]; then
        duplicate=1
        break
      fi
    done
    if [ "$duplicate" -eq 0 ]; then
      PUBLISH_BIND_HOSTS+=("$host")
    fi
  done
fi

FORWARDED_ENV_VARS=(
  MCP_HUB_AUTH_MODE
  MCP_HUB_REQUIRE_AUTH
  MCP_HUB_REGISTER_TOKEN
  MCP_HUB_ALLOW_LEGACY_AGENT_CLAIM
  MCP_HUB_REGISTER_RATE_LIMIT_RPS
  MCP_HUB_REGISTER_RATE_LIMIT_BURST
  MCP_HUB_ORIGIN_MODE
  MCP_HUB_ALLOWED_ORIGINS
  MCP_HUB_STRICT_SESSION_STATUS
  MCP_HUB_UNKNOWN_SESSION_POLICY
  MCP_HUB_NAMESPACE_GOVERNANCE
  MCP_HUB_NAMESPACE_QUOTA_MODE
  MCP_HUB_NAMESPACE_QUOTA_RPS
  MCP_HUB_NAMESPACE_QUOTA_BURST
  MCP_HUB_NAMESPACE_TOKEN_BUDGET_PER_MIN
  MCP_HUB_NAMESPACE_QUOTA_FALLBACK
  MCP_HUB_MAINTENANCE_INTERVAL_MS
  MCP_HUB_SESSION_IDLE_TIMEOUT_MS
  MCP_HUB_SESSION_PROVISIONAL_TTL_MS
  MCP_HUB_SESSION_GC_INTERVAL_MS
  MCP_HUB_MAX_SESSIONS
  MCP_HUB_MAX_SESSIONS_PER_SOURCE
  MCP_HUB_SESSION_INITIALIZE_RPS
  MCP_HUB_SESSION_INITIALIZE_BURST
  MCP_HUB_RATE_LIMIT_RPS
  MCP_HUB_RATE_LIMIT_BURST
  MCP_HUB_RATE_LIMIT_BUCKET_IDLE_TTL_MS
  MCP_HUB_EVENT_STREAM_INTERVAL_MS
  MCP_HUB_EVENT_STREAM_HEARTBEAT_MS
  MCP_HUB_EVENT_STREAM_MAX_CONNECTIONS
  MCP_HUB_EVENT_STREAM_MAX_PER_AGENT
  MCP_HUB_EVENT_STREAM_MAX_BUFFER_BYTES
  MCP_HUB_EVENT_STREAM_DRAIN_TIMEOUT_MS
  MCP_HUB_AGENT_OFFLINE_AFTER_MS
  MCP_HUB_AGENT_RETENTION_MS
  MCP_HUB_EPHEMERAL_OFFLINE_AFTER_MS
  MCP_HUB_EPHEMERAL_AGENT_RETENTION_MS
  MCP_HUB_EPHEMERAL_CLAIM_REAP_AFTER_MS
  MCP_HUB_IDEMPOTENCY_TTL_MS
  MCP_HUB_CLAIM_CLEANUP_THROTTLE_MS
  MCP_HUB_ARCHIVE_BATCH_LIMIT
  MCP_HUB_MESSAGE_TTL_MS
  MCP_HUB_ACTIVITY_LOG_TTL_MS
  MCP_HUB_PROTOCOL_BLOB_TTL_MS
  MCP_HUB_ARTIFACT_TTL_MS
  MCP_HUB_STREAM_EVENT_TTL_MS
  MCP_HUB_WATERMARK_CACHE_MS
  MCP_HUB_WATERMARK_AGENT_CACHE_MAX
  MCP_HUB_AUTO_PACK_MIN_PAYLOAD_CHARS
  MCP_HUB_AUTO_PACK_MIN_GAIN_PCT
  MCP_HUB_LOSSLESS_AUTO_MIN_PAYLOAD_CHARS
  MCP_HUB_LOSSLESS_AUTO_MIN_GAIN_PCT
  MCP_HUB_CONSISTENCY_DEFAULT
  MCP_HUB_DISALLOW_FULL_IN_POLLING
  MCP_HUB_STRICT_DONE_CONFIDENCE_MIN
  MCP_HUB_STRICT_DONE_EVIDENCE_MIN_REFS
  MCP_HUB_WAIT_MAX_MS
  MCP_HUB_WAIT_DEFAULT_MS
  MCP_HUB_WAIT_RETRY_FACTOR
  MCP_HUB_WAIT_RETRY_CAP_MS
  MCP_HUB_WAIT_RETRY_JITTER_PCT
  MCP_HUB_WAIT_DEFAULT_RESPONSE_MODE
  MCP_HUB_WAIT_DEFAULT_TIMEOUT_RESPONSE
  MCP_HUB_WAIT_LOG_HITS
  MCP_HUB_WAIT_LOG_TIMEOUTS
  MCP_HUB_DEFAULT_ONBOARDING_MODE
  MCP_HUB_EPHEMERAL_DEFAULT_ONBOARDING_MODE
  MCP_HUB_REREGISTER_ONBOARDING_MODE
  MCP_HUB_MAX_CONSENSUS_VOTES
  MCP_HUB_CONSENSUS_QUALITY_WEIGHTING
  MCP_HUB_DONE_EVIDENCE_MIN_REFS
  MCP_HUB_MAX_EVIDENCE_REFS_PER_CALL
  MCP_HUB_MAX_EVIDENCE_REF_CHARS
  MCP_HUB_MAX_MESSAGE_CONTENT_CHARS
  MCP_HUB_MAX_MESSAGE_METADATA_CHARS
  MCP_HUB_MAX_CONTEXT_VALUE_CHARS
  MCP_HUB_MAX_PROTOCOL_BLOB_CHARS
  MCP_HUB_DONE_TASK_TTL_MS
  MCP_HUB_AUTH_EVENTS_TTL_MS
  MCP_HUB_RESOLVED_SLO_TTL_MS
  MCP_HUB_SLO_PENDING_AGE_MS
  MCP_HUB_SLO_STALE_IN_PROGRESS_MS
  MCP_HUB_SLO_CLAIM_CHURN_WINDOW_MS
  MCP_HUB_SLO_CLAIM_CHURN_THRESHOLD
  MCP_HUB_PUBLIC_BASE_URL
  MCP_HUB_ARTIFACTS_DIR
  MCP_HUB_ARTIFACT_MAX_BYTES
  MCP_HUB_ARTIFACT_TICKET_TTL_SEC
  MCP_HUB_ARTIFACT_UPLOAD_TICKET_MAX_ACTIVE
  MCP_HUB_ARTIFACT_UPLOAD_TICKET_MAX_PER_AGENT
  MCP_HUB_ARTIFACT_UPLOAD_RESERVATION_TTL_MS
  MCP_HUB_ARTIFACT_DOWNLOAD_TICKET_MAX_ACTIVE
  MCP_HUB_ARTIFACT_DOWNLOAD_TICKET_MAX_PER_AGENT
  MCP_HUB_ARTIFACT_UPLOAD_TTL_SEC
  MCP_HUB_ARTIFACT_DOWNLOAD_TTL_SEC
  MCP_HUB_ARTIFACT_RETENTION_SEC
  MCP_HUB_MAX_ARTIFACT_NAME_CHARS
  MCP_HUB_MAX_ARTIFACT_SUMMARY_CHARS
)

usage() {
  echo "Usage: $0 {build|test|start|stop|restart|status|smoke|logs|db|clean}"
  echo ""
  echo "Config precedence: CLI env > MCP_HUB_LOCAL_ENV_FILE > MCP_HUB_ENV_FILE > $DEFAULT_ENV_FILE"
  echo "Network bind: always 127.0.0.1, optional extras via MCP_HUB_EXTRA_BIND_HOSTS in $DEFAULT_LOCAL_ENV_FILE"
  echo ""
  echo "  build    Build Docker image"
  echo "  test     Run tests in Docker"
  echo "  start    Start MCP server daemon on port $PORT"
  echo "  stop     Stop running container"
  echo "  restart  Restart the server"
  echo "  status   Show container status and health"
  echo "  smoke    MCP handshake + registration/authenticated-call smoke test"
  echo "  logs     Show container logs (follow with -f)"
  echo "  db       Open SQLite shell to inspect the database"
  echo "  clean    Remove container, image, and database"
  exit 1
}

cmd_build() {
  echo "Building $IMAGE..."
  docker build -t "$IMAGE" "$ROOT_DIR"
  echo "Done. Image: $IMAGE"
}

cmd_test() {
  echo "Building dev image and running tests..."
  docker build -f "$ROOT_DIR/Dockerfile.dev" -t "${IMAGE}-dev" "$ROOT_DIR"
  docker run --rm "${IMAGE}-dev" npx vitest run
}

effective_auth_mode() {
  local configured
  configured="$(trim_ws "$(printf '%s' "${MCP_HUB_AUTH_MODE:-}" | tr '[:upper:]' '[:lower:]')")"
  if [ -n "$configured" ]; then
    printf '%s' "$configured"
    return
  fi
  case "$(trim_ws "$(printf '%s' "${MCP_HUB_REQUIRE_AUTH:-}" | tr '[:upper:]' '[:lower:]')")" in
    true) printf 'enforce' ;;
    *) printf 'observe' ;;
  esac
}

validate_start_config() {
  local auth_mode
  auth_mode="$(effective_auth_mode)"
  case "$auth_mode" in
    observe|warn|enforce) ;;
    *)
      echo "Invalid MCP_HUB_AUTH_MODE=$auth_mode (expected observe, warn, or enforce)." >&2
      return 1
      ;;
  esac
  if [ "$auth_mode" = "enforce" ] && [ -z "$(trim_ws "${MCP_HUB_REGISTER_TOKEN:-}")" ]; then
    echo "Refusing to start auth_mode=enforce with open agent enrollment." >&2
    echo "Set MCP_HUB_REGISTER_TOKEN in the protected local env overlay (for example: openssl rand -hex 32)." >&2
    return 1
  fi
}

cmd_start() {
  validate_start_config
  if docker ps -q --filter name="^${CONTAINER}$" | grep -q .; then
    echo "Already running. Use '$0 restart' to restart."
    cmd_status
    return
  fi

  # Remove stopped container if exists
  docker rm "$CONTAINER" 2>/dev/null || true

  mkdir -p "$DB_DIR"
  chmod 700 "$DB_DIR"
  echo "Starting MCP Agent Hub on port $PORT..."
  echo "Publishing:"
  for bind_host in "${PUBLISH_BIND_HOSTS[@]}"; do
    echo "  - $bind_host:$PORT -> container:3000"
  done
  if [ "${#ENV_SOURCES[@]}" -gt 0 ]; then
    echo "Using env config:"
    for source in "${ENV_SOURCES[@]}"; do
      echo "  - $source"
    done
  fi

  local env_args=(
    -e "MCP_HUB_DB=/data/hub.db"
  )
  local publish_args=()
  for bind_host in "${PUBLISH_BIND_HOSTS[@]}"; do
    publish_args+=(-p "$bind_host:$PORT:3000")
  done
  local public_base_url="${MCP_HUB_PUBLIC_BASE_URL:-http://127.0.0.1:$PORT}"
  env_args+=(-e "MCP_HUB_PUBLIC_BASE_URL=${public_base_url}")
  for env_name in "${FORWARDED_ENV_VARS[@]}"; do
    local env_value="${!env_name:-}"
    if [ -n "$env_value" ]; then
      env_args+=(-e "${env_name}=${env_value}")
    fi
  done

  docker run -d \
    --name "$CONTAINER" \
    --restart unless-stopped \
    --user "$(id -u):$(id -g)" \
    "${publish_args[@]}" \
    -v "$DB_DIR:/data" \
    "${env_args[@]}" \
    "$IMAGE"

  echo "Server: http://127.0.0.1:$PORT/mcp"
  echo "Health: http://127.0.0.1:$PORT/health"
  echo "DB:     $DB_DIR/hub.db"
}

cmd_stop() {
  if docker ps -q --filter name="^${CONTAINER}$" | grep -q .; then
    echo "Stopping $CONTAINER..."
    docker stop "$CONTAINER"
    docker rm "$CONTAINER" 2>/dev/null || true
  else
    echo "Container $CONTAINER is not running."
  fi
}

cmd_restart() {
  # Validate before stopping a healthy container so a bad auth configuration cannot cause downtime.
  validate_start_config
  cmd_stop
  cmd_start
}

cmd_status() {
  if [ "${#ENV_SOURCES[@]}" -gt 0 ]; then
    echo "Env config:"
    for source in "${ENV_SOURCES[@]}"; do
      echo "  - $source"
    done
  else
    echo "Env config: none"
  fi
  echo ""
  if docker ps -q --filter name="^${CONTAINER}$" | grep -q .; then
    docker ps --filter name="^${CONTAINER}$" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    echo ""
    curl -s "http://127.0.0.1:$PORT/health" 2>/dev/null && echo "" || echo "Health check failed"
  else
    echo "Container $CONTAINER is not running."
  fi
  echo ""
  if [ -f "$DB_DIR/hub.db" ]; then
    echo "Database: $DB_DIR/hub.db ($(du -h "$DB_DIR/hub.db" | cut -f1))"
  else
    echo "Database: not created yet"
  fi
}

cmd_smoke() {
  local endpoint="http://127.0.0.1:$PORT/mcp"
  local health_url="http://127.0.0.1:$PORT/health"
  local init_payload='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"hub-smoke","version":"1.0.0"}}}'
  local initialized_payload='{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  local tools_payload='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

  echo "Running MCP smoke test against $endpoint..."

  local health_response
  health_response=$(curl -fsS "$health_url") || {
    echo "Smoke test failed: health endpoint could not be reached."
    return 1
  }
  if printf '%s' "$health_response" | grep -q '"auth_mode":"enforce"' \
    && printf '%s' "$health_response" | grep -q '"register_auth_mode":"open_enrollment"'; then
    echo "Smoke test failed: auth_mode=enforce is running with open agent enrollment." >&2
    return 1
  fi

  local init_response
  init_response=$(curl -i -sS -X POST "$endpoint" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    --data "$init_payload") || {
    echo "Smoke test failed: initialize request could not reach server."
    return 1
  }

  local session_id
  session_id=$(printf '%s\n' "$init_response" | awk '/^mcp-session-id:/ {print $2}' | tr -d '\r')
  if [ -z "$session_id" ]; then
    echo "Smoke test failed: initialize response did not include mcp-session-id."
    printf '%s\n' "$init_response" | sed -n '1,30p'
    return 1
  fi

  close_smoke_session() {
    curl -sS -X DELETE "$endpoint" -H "mcp-session-id: $session_id" >/dev/null || true
  }

  curl -sS -X POST "$endpoint" \
    -H "mcp-session-id: $session_id" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    --data "$initialized_payload" >/dev/null || {
    echo "Smoke test failed: notifications/initialized request failed."
    close_smoke_session
    return 1
  }

  local tools_response
  tools_response=$(curl -sS -X POST "$endpoint" \
    -H "mcp-session-id: $session_id" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    --data "$tools_payload") || {
    echo "Smoke test failed: tools/list request failed."
    close_smoke_session
    return 1
  }

  local tools_data
  tools_data=$(printf '%s\n' "$tools_response" | sed -n 's/^data: //p' | tail -n 1)
  if [ -z "$tools_data" ]; then
    # JSON response mode returns plain JSON body without SSE "data:" lines.
    if printf '%s\n' "$tools_response" | grep -q '"jsonrpc":"2.0"'; then
      tools_data="$tools_response"
    else
      echo "Smoke test failed: tools/list response had no MCP data payload."
      printf '%s\n' "$tools_response" | sed -n '1,30p'
      close_smoke_session
      return 1
    fi
  fi

  local tool_count
  tool_count=$(printf '%s\n' "$tools_data" | grep -o '"name":"' | wc -l | tr -d ' ')
  if [ "$tool_count" -lt 10 ]; then
    echo "Smoke test failed: expected >=10 tools, got $tool_count."
    close_smoke_session
    return 1
  fi

  local smoke_agent_id="hub-smoke-$(date +%s)-$$-$RANDOM"
  local smoke_auth_token
  smoke_auth_token=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  if [ "${#smoke_auth_token}" -lt 32 ]; then
    echo "Smoke test failed: could not generate a client auth credential." >&2
    close_smoke_session
    return 1
  fi

  json_escape() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    value="${value//$'\n'/\\n}"
    value="${value//$'\r'/\\r}"
    value="${value//$'\t'/\\t}"
    printf '%s' "$value"
  }

  local register_token_field=''
  if [ -n "${MCP_HUB_REGISTER_TOKEN:-}" ]; then
    register_token_field=",\"register_token\":\"$(json_escape "$MCP_HUB_REGISTER_TOKEN")\""
  fi
  local register_payload
  register_payload="{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"register_agent\",\"arguments\":{\"id\":\"$smoke_agent_id\",\"name\":\"Hub Smoke\",\"type\":\"smoke\",\"lifecycle\":\"ephemeral\",\"onboarding_mode\":\"none\",\"auth_token\":\"$smoke_auth_token\"$register_token_field}}}"
  local register_response
  register_response=$(printf '%s' "$register_payload" | curl -sS -X POST "$endpoint" \
    -H "mcp-session-id: $session_id" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    --data-binary @-) || {
    echo "Smoke test failed: register_agent request failed." >&2
    close_smoke_session
    return 1
  }
  if ! printf '%s' "$register_response" | grep -q '\\"success\\":true'; then
    echo "Smoke test failed: register_agent did not succeed (check MCP_HUB_REGISTER_TOKEN)." >&2
    close_smoke_session
    return 1
  fi

  local authenticated_payload
  authenticated_payload="{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"list_agents\",\"arguments\":{\"agent_id\":\"$smoke_agent_id\",\"auth_token\":\"$smoke_auth_token\",\"response_mode\":\"summary\"}}}"
  local authenticated_response
  authenticated_response=$(printf '%s' "$authenticated_payload" | curl -sS -X POST "$endpoint" \
    -H "mcp-session-id: $session_id" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    --data-binary @-) || {
    echo "Smoke test failed: authenticated list_agents request failed." >&2
    close_smoke_session
    return 1
  }
  if ! printf '%s' "$authenticated_response" | grep -q '\\"summary\\":{'; then
    echo "Smoke test failed: authenticated list_agents did not return its summary contract." >&2
    printf '%s\n' "$authenticated_response" | sed -n '1,10p' >&2
    close_smoke_session
    return 1
  fi

  close_smoke_session
  echo "Smoke test passed: session=$session_id tools=$tool_count auth=verified"
}

cmd_logs() {
  if [ "${2:-}" = "-f" ]; then
    docker logs -f "$CONTAINER" 2>&1
  else
    docker logs "$CONTAINER" 2>&1 || echo "No logs (container not running)."
  fi
}

cmd_db() {
  if [ ! -f "$DB_DIR/hub.db" ]; then
    echo "Database not found at $DB_DIR/hub.db"
    exit 1
  fi
  docker run --rm -it \
    -v "$DB_DIR:/data:ro" \
    node:20-alpine \
    sh -c "apk add --quiet sqlite && exec sqlite3 -readonly /data/hub.db"
}

cmd_clean() {
  echo "Stopping container..."
  docker stop "$CONTAINER" 2>/dev/null || true
  docker rm "$CONTAINER" 2>/dev/null || true
  echo "Removing images..."
  docker rmi "$IMAGE" "${IMAGE}-dev" 2>/dev/null || true
  echo "Remove database at $DB_DIR? [y/N]"
  read -r answer
  if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
    rm -rf "$DB_DIR"
    echo "Database removed."
  fi
  echo "Done."
}

case "${1:-}" in
  build)   cmd_build ;;
  test)    cmd_test ;;
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  smoke)   cmd_smoke ;;
  logs)    cmd_logs "$@" ;;
  db)      cmd_db ;;
  clean)   cmd_clean ;;
  *)       usage ;;
esac
