#!/usr/bin/env bash
set -euo pipefail

HOURS="${HOURS:-12}"
DB_PATH="${DB_PATH:-${MCP_HUB_DB:-${MCP_HUB_DATA:-$HOME/.mcp-hub}/hub.db}}"
OUT_DIR="${OUT_DIR:-/tmp/hub-reports}"
TAG="${TAG:-pool-report-$(date +%Y%m%d-%H%M%S)}"
HEALTH_ENDPOINT="${HEALTH_ENDPOINT:-http://localhost:${MCP_HUB_PORT:-3000}/health}"

usage() {
  cat <<'USAGE'
Usage: scripts/pool-report.sh [options]

Builds a pool performance report for the last N hours from MCP hub SQLite.

Options:
  --hours N             Lookback window in hours (default: 12)
  --db PATH             SQLite DB path (default: $MCP_HUB_DB or $MCP_HUB_DATA/hub.db or ~/.mcp-hub/hub.db)
  --out-dir DIR         Output directory (default: /tmp/hub-reports)
  --tag NAME            Output tag/prefix (default: pool-report-YYYYmmdd-HHMMSS)
  --health-endpoint URL Optional health endpoint (default: http://localhost:$MCP_HUB_PORT/health)
  -h, --help            Show this help

Examples:
  scripts/pool-report.sh --hours 12
  scripts/pool-report.sh --hours 24 --db ~/.mcp-hub/hub.db --out-dir /tmp/reports --tag day1
USAGE
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --hours)
      HOURS="${2:-}"
      shift 2
      ;;
    --db)
      DB_PATH="${2:-}"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --tag)
      TAG="${2:-}"
      shift 2
      ;;
    --health-endpoint)
      HEALTH_ENDPOINT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! [[ "$HOURS" =~ ^[0-9]+$ ]] || [ "$HOURS" -le 0 ]; then
  echo "--hours must be a positive integer, got: $HOURS" >&2
  exit 1
fi

require_cmd sqlite3
require_cmd jq

if [ ! -f "$DB_PATH" ]; then
  echo "Database file not found: $DB_PATH" >&2
  exit 1
fi

NOW_MS="$(( $(date +%s) * 1000 ))"
FROM_MS="$(( NOW_MS - HOURS * 3600 * 1000 ))"
GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

run_sql() {
  local sql="$1"
  sqlite3 "$DB_PATH" "$sql"
}

SUMMARY_SQL=$(cat <<SQL
WITH w AS (SELECT $FROM_MS AS from_ms, $NOW_MS AS now_ms)
SELECT json_object(
  'window', json_object(
    'hours', $HOURS,
    'from_ms', from_ms,
    'to_ms', now_ms,
    'from_local', datetime(from_ms/1000, 'unixepoch', 'localtime'),
    'to_local', datetime(now_ms/1000, 'unixepoch', 'localtime')
  ),
  'current', json_object(
    'agents_total', (SELECT COUNT(*) FROM agents),
    'agents_online', (SELECT COUNT(*) FROM agents WHERE status = 'online'),
    'agents_offline', (SELECT COUNT(*) FROM agents WHERE status = 'offline'),
    'tasks_open', (SELECT COUNT(*) FROM tasks WHERE status IN ('pending','in_progress','blocked')),
    'tasks_pending', (SELECT COUNT(*) FROM tasks WHERE status = 'pending'),
    'tasks_in_progress', (SELECT COUNT(*) FROM tasks WHERE status = 'in_progress'),
    'tasks_blocked', (SELECT COUNT(*) FROM tasks WHERE status = 'blocked'),
    'claims_active', (SELECT COUNT(*) FROM task_claims),
    'messages_total', (SELECT COUNT(*) FROM messages),
    'context_keys_total', (SELECT COUNT(*) FROM context),
    'slo_open', (SELECT COUNT(*) FROM slo_alerts WHERE resolved_at IS NULL)
  ),
  'window_counters', json_object(
    'activity_events', (SELECT COUNT(*) FROM activity_log WHERE created_at >= from_ms),
    'activity_failed', (SELECT COUNT(*) FROM activity_log WHERE created_at >= from_ms AND action LIKE '%failed%'),
    'tasks_created', (SELECT COUNT(*) FROM tasks WHERE created_at >= from_ms),
    'tasks_updated', (SELECT COUNT(*) FROM tasks WHERE updated_at >= from_ms),
    'status_done', (SELECT COUNT(*) FROM task_status_history WHERE created_at >= from_ms AND to_status = 'done'),
    'status_pending', (SELECT COUNT(*) FROM task_status_history WHERE created_at >= from_ms AND to_status = 'pending'),
    'messages_sent', (SELECT COUNT(*) FROM messages WHERE created_at >= from_ms),
    'context_rows_updated', (SELECT COUNT(*) FROM context WHERE updated_at >= from_ms),
    'slo_triggered', (SELECT COUNT(*) FROM slo_alerts WHERE created_at >= from_ms),
    'slo_resolved', (SELECT COUNT(*) FROM slo_alerts WHERE resolved_at IS NOT NULL AND resolved_at >= from_ms)
  ),
  'auth', json_object(
    'valid', (SELECT COUNT(*) FROM auth_events WHERE created_at >= from_ms AND status = 'valid'),
    'missing', (SELECT COUNT(*) FROM auth_events WHERE created_at >= from_ms AND status = 'missing'),
    'invalid', (SELECT COUNT(*) FROM auth_events WHERE created_at >= from_ms AND status = 'invalid'),
    'skipped', (SELECT COUNT(*) FROM auth_events WHERE created_at >= from_ms AND status = 'skipped'),
    'coverage_pct', (
      WITH t AS (
        SELECT status, COUNT(*) AS c
        FROM auth_events
        WHERE created_at >= from_ms
        GROUP BY status
      )
      SELECT ROUND(
        CASE
          WHEN (SELECT COALESCE(SUM(c),0) FROM t WHERE status IN ('valid','missing','invalid')) = 0 THEN 100.0
          ELSE 100.0 * (SELECT COALESCE(SUM(c),0) FROM t WHERE status = 'valid')
            / (SELECT COALESCE(SUM(c),0) FROM t WHERE status IN ('valid','missing','invalid'))
        END, 2
      )
    )
  ),
  'claims', json_object(
    'claim_ok', (SELECT COUNT(*) FROM activity_log WHERE created_at >= from_ms AND action = 'claim_task'),
    'claim_failed', (SELECT COUNT(*) FROM activity_log WHERE created_at >= from_ms AND action = 'claim_task_failed'),
    'release_ok', (SELECT COUNT(*) FROM activity_log WHERE created_at >= from_ms AND action = 'release_task_claim'),
    'release_failed', (SELECT COUNT(*) FROM activity_log WHERE created_at >= from_ms AND action = 'release_task_claim_failed'),
    'done_gate_failed', (SELECT COUNT(*) FROM activity_log WHERE created_at >= from_ms AND action = 'release_task_claim_done_gate_failed'),
    'renew_ok', (SELECT COUNT(*) FROM activity_log WHERE created_at >= from_ms AND action = 'renew_task_claim')
  )
)
FROM w;
SQL
)

TOP_ACTIONS_SQL=$(cat <<SQL
WITH w AS (SELECT $FROM_MS AS from_ms)
SELECT COALESCE(
  json_group_array(json_object('action', action, 'count', cnt)),
  '[]'
)
FROM (
  SELECT action, COUNT(*) AS cnt
  FROM activity_log, w
  WHERE created_at >= w.from_ms
  GROUP BY action
  ORDER BY cnt DESC
  LIMIT 20
);
SQL
)

AUTH_GAPS_SQL=$(cat <<SQL
WITH w AS (SELECT $FROM_MS AS from_ms)
SELECT COALESCE(
  json_group_array(
    json_object(
      'tool', tool_name,
      'valid', valid,
      'missing', missing,
      'invalid', invalid
    )
  ),
  '[]'
)
FROM (
  SELECT
    tool_name,
    SUM(CASE WHEN status = 'valid' THEN 1 ELSE 0 END) AS valid,
    SUM(CASE WHEN status = 'missing' THEN 1 ELSE 0 END) AS missing,
    SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) AS invalid
  FROM auth_events, w
  WHERE created_at >= w.from_ms
  GROUP BY tool_name
  HAVING missing > 0 OR invalid > 0
  ORDER BY (missing + invalid) DESC, tool_name
  LIMIT 20
);
SQL
)

AUTH_BY_AGENT_SQL=$(cat <<SQL
WITH w AS (SELECT $FROM_MS AS from_ms)
SELECT COALESCE(
  json_group_array(
    json_object(
      'agent_id', agent_id,
      'valid', valid,
      'missing', missing,
      'invalid', invalid,
      'skipped', skipped
    )
  ),
  '[]'
)
FROM (
  SELECT
    COALESCE(agent_id, '<null>') AS agent_id,
    SUM(CASE WHEN status = 'valid' THEN 1 ELSE 0 END) AS valid,
    SUM(CASE WHEN status = 'missing' THEN 1 ELSE 0 END) AS missing,
    SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) AS invalid,
    SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
  FROM auth_events, w
  WHERE created_at >= w.from_ms
  GROUP BY COALESCE(agent_id, '<null>')
  ORDER BY missing DESC, invalid DESC, valid DESC
  LIMIT 20
);
SQL
)

FAIL_REASONS_SQL=$(cat <<SQL
WITH w AS (SELECT $FROM_MS AS from_ms)
SELECT COALESCE(
  json_group_array(json_object('reason', reason, 'count', cnt)),
  '[]'
)
FROM (
  SELECT
    CASE
      WHEN details LIKE '%PROFILE_MISMATCH%' THEN 'PROFILE_MISMATCH'
      WHEN details LIKE '%CLAIM_EXPIRED%' THEN 'CLAIM_EXPIRED'
      WHEN details LIKE '%TASK_ALREADY_DONE%' THEN 'TASK_ALREADY_DONE'
      WHEN details LIKE '%ALREADY_CLAIMED%' THEN 'ALREADY_CLAIMED'
      WHEN details LIKE '%evidence_refs required%' THEN 'MISSING_EVIDENCE_REFS'
      WHEN details LIKE '%Independent verifier%' THEN 'MISSING_VERIFIER'
      WHEN details LIKE '%confidence%' THEN 'LOW_CONFIDENCE'
      ELSE 'OTHER'
    END AS reason,
    COUNT(*) AS cnt
  FROM activity_log, w
  WHERE created_at >= w.from_ms
    AND action IN ('claim_task_failed','release_task_claim_failed','release_task_claim_done_gate_failed')
  GROUP BY reason
  ORDER BY cnt DESC
);
SQL
)

TOP_AGENTS_SQL=$(cat <<SQL
WITH w AS (SELECT $FROM_MS AS from_ms)
SELECT COALESCE(
  json_group_array(json_object('agent_id', agent_id, 'events', cnt)),
  '[]'
)
FROM (
  SELECT agent_id, COUNT(*) AS cnt
  FROM activity_log, w
  WHERE created_at >= w.from_ms
  GROUP BY agent_id
  ORDER BY cnt DESC
  LIMIT 20
);
SQL
)

HOURLY_ACTIVITY_SQL=$(cat <<SQL
WITH w AS (SELECT $FROM_MS AS from_ms)
SELECT COALESCE(
  json_group_array(
    json_object(
      'hour', hour,
      'activity_total', activity_total,
      'failed_events', failed_events
    )
  ),
  '[]'
)
FROM (
  SELECT
    strftime('%Y-%m-%d %H:00', created_at/1000, 'unixepoch', 'localtime') AS hour,
    COUNT(*) AS activity_total,
    SUM(CASE WHEN action LIKE '%failed%' THEN 1 ELSE 0 END) AS failed_events
  FROM activity_log, w
  WHERE created_at >= w.from_ms
  GROUP BY hour
  ORDER BY hour
);
SQL
)

HOURLY_AUTH_SQL=$(cat <<SQL
WITH w AS (SELECT $FROM_MS AS from_ms)
SELECT COALESCE(
  json_group_array(
    json_object(
      'hour', hour,
      'valid', valid,
      'missing', missing,
      'invalid', invalid
    )
  ),
  '[]'
)
FROM (
  SELECT
    strftime('%Y-%m-%d %H:00', created_at/1000, 'unixepoch', 'localtime') AS hour,
    SUM(CASE WHEN status = 'valid' THEN 1 ELSE 0 END) AS valid,
    SUM(CASE WHEN status = 'missing' THEN 1 ELSE 0 END) AS missing,
    SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) AS invalid
  FROM auth_events, w
  WHERE created_at >= w.from_ms
  GROUP BY hour
  ORDER BY hour
);
SQL
)

NAMESPACE_SQL=$(cat <<SQL
WITH
  w AS (SELECT $FROM_MS AS from_ms),
  created AS (
    SELECT namespace, COUNT(*) AS created_hrs
    FROM tasks, w
    WHERE created_at >= w.from_ms
    GROUP BY namespace
  ),
  done AS (
    SELECT t.namespace AS namespace, COUNT(*) AS done_hrs
    FROM task_status_history h
    JOIN tasks t ON t.id = h.task_id, w
    WHERE h.created_at >= w.from_ms
      AND h.to_status = 'done'
    GROUP BY t.namespace
  ),
  pending_now AS (
    SELECT namespace, COUNT(*) AS pending_now
    FROM tasks
    WHERE status = 'pending'
    GROUP BY namespace
  )
SELECT COALESCE(
  json_group_array(
    json_object(
      'namespace', namespace,
      'created_window', created_hrs,
      'done_window', done_hrs,
      'pending_now', pending_now
    )
  ),
  '[]'
)
FROM (
  SELECT
    c.namespace AS namespace,
    c.created_hrs AS created_hrs,
    COALESCE(d.done_hrs, 0) AS done_hrs,
    COALESCE(p.pending_now, 0) AS pending_now
  FROM created c
  LEFT JOIN done d ON d.namespace = c.namespace
  LEFT JOIN pending_now p ON p.namespace = c.namespace
  ORDER BY c.created_hrs DESC
  LIMIT 20
);
SQL
)

SUMMARY_JSON="$(run_sql "$SUMMARY_SQL")"
TOP_ACTIONS_JSON="$(run_sql "$TOP_ACTIONS_SQL")"
AUTH_GAPS_JSON="$(run_sql "$AUTH_GAPS_SQL")"
AUTH_BY_AGENT_JSON="$(run_sql "$AUTH_BY_AGENT_SQL")"
FAIL_REASONS_JSON="$(run_sql "$FAIL_REASONS_SQL")"
TOP_AGENTS_JSON="$(run_sql "$TOP_AGENTS_SQL")"
HOURLY_ACTIVITY_JSON="$(run_sql "$HOURLY_ACTIVITY_SQL")"
HOURLY_AUTH_JSON="$(run_sql "$HOURLY_AUTH_SQL")"
NAMESPACE_JSON="$(run_sql "$NAMESPACE_SQL")"

if [ -z "$SUMMARY_JSON" ]; then
  echo "Failed to build summary from DB: $DB_PATH" >&2
  exit 1
fi

HEALTH_JSON='null'
if command -v curl >/dev/null 2>&1; then
  HEALTH_RAW="$(curl -fsS --max-time 2 "$HEALTH_ENDPOINT" 2>/dev/null || true)"
  if [ -n "$HEALTH_RAW" ] && printf '%s' "$HEALTH_RAW" | jq -e . >/dev/null 2>&1; then
    HEALTH_JSON="$HEALTH_RAW"
  fi
fi

if [ "$HEALTH_JSON" = 'null' ] && [ -x "./hub.sh" ]; then
  STATUS_RAW="$(./hub.sh status 2>/dev/null || true)"
  STATUS_JSON="$(printf '%s\n' "$STATUS_RAW" | awk '/^\{/{print; exit}')"
  if [ -n "$STATUS_JSON" ] && printf '%s' "$STATUS_JSON" | jq -e . >/dev/null 2>&1; then
    HEALTH_JSON="$STATUS_JSON"
  fi
fi

mkdir -p "$OUT_DIR"
JSON_FILE="$OUT_DIR/${TAG}.json"
MD_FILE="$OUT_DIR/${TAG}.md"

jq -n \
  --arg generated_at "$GENERATED_AT" \
  --arg db_path "$DB_PATH" \
  --arg health_endpoint "$HEALTH_ENDPOINT" \
  --argjson summary "$SUMMARY_JSON" \
  --argjson health "$HEALTH_JSON" \
  --argjson top_actions "$TOP_ACTIONS_JSON" \
  --argjson auth_gaps "$AUTH_GAPS_JSON" \
  --argjson auth_by_agent "$AUTH_BY_AGENT_JSON" \
  --argjson fail_reasons "$FAIL_REASONS_JSON" \
  --argjson top_agents "$TOP_AGENTS_JSON" \
  --argjson hourly_activity "$HOURLY_ACTIVITY_JSON" \
  --argjson hourly_auth "$HOURLY_AUTH_JSON" \
  --argjson namespace "$NAMESPACE_JSON" \
  '{
    generated_at: $generated_at,
    db_path: $db_path,
    health_endpoint: $health_endpoint,
    summary: $summary,
    health: $health,
    top_actions: $top_actions,
    auth_gaps_by_tool: $auth_gaps,
    auth_by_agent: $auth_by_agent,
    failure_reasons: $fail_reasons,
    top_agents_by_activity: $top_agents,
    hourly_activity: $hourly_activity,
    hourly_auth: $hourly_auth,
    namespace_throughput: $namespace
  }' > "$JSON_FILE"

jq -r '
  def pct(n): (if n == null then "n/a" else (n|tostring) + "%" end);
  "Pool Report",
  "",
  "- Generated at (UTC): \(.generated_at)",
  "- DB: `\(.db_path)`",
  "- Window: \(.summary.window.from_local) -> \(.summary.window.to_local) (\(.summary.window.hours)h)",
  (if .health == null then "- Health endpoint: unavailable (`\(.health_endpoint)`)" else "- Health auth_mode: \(.health.auth_mode), sessions: \(.health.sessions), namespace_quota_mode: \(.health.namespace_quota_mode), session_idle_timeout_ms: \(.health.session_idle_timeout_ms)" end),
  "",
  "**Current Snapshot**",
  "- Agents: total \(.summary.current.agents_total), online \(.summary.current.agents_online), offline \(.summary.current.agents_offline)",
  "- Tasks: open \(.summary.current.tasks_open), pending \(.summary.current.tasks_pending), in_progress \(.summary.current.tasks_in_progress), blocked \(.summary.current.tasks_blocked)",
  "- Active claims: \(.summary.current.claims_active)",
  "- Messages total: \(.summary.current.messages_total), context keys: \(.summary.current.context_keys_total)",
  "- Open SLO alerts: \(.summary.current.slo_open)",
  "",
  "**Window Counters**",
  "- Activity events: \(.summary.window_counters.activity_events) (failed: \(.summary.window_counters.activity_failed))",
  "- Tasks created: \(.summary.window_counters.tasks_created), status->done: \(.summary.window_counters.status_done), status->pending: \(.summary.window_counters.status_pending)",
  "- Messages sent: \(.summary.window_counters.messages_sent), context rows updated: \(.summary.window_counters.context_rows_updated)",
  "- SLO triggered: \(.summary.window_counters.slo_triggered), resolved: \(.summary.window_counters.slo_resolved)",
  "",
  "**Auth Coverage**",
  "- Valid: \(.summary.auth.valid), missing: \(.summary.auth.missing), invalid: \(.summary.auth.invalid), skipped: \(.summary.auth.skipped)",
  "- Coverage (valid / checked): \(pct(.summary.auth.coverage_pct))",
  "",
  "**Claims**",
  "- claim ok/failed: \(.summary.claims.claim_ok)/\(.summary.claims.claim_failed)",
  "- release ok/failed: \(.summary.claims.release_ok)/\(.summary.claims.release_failed)",
  "- release done-gate failed: \(.summary.claims.done_gate_failed), renew ok: \(.summary.claims.renew_ok)",
  "",
  "**Top Actions**",
  ((.top_actions // []) | .[0:12] | map("- " + .action + ": " + (.count|tostring))[]),
  "",
  "**Auth Gaps By Tool**",
  (if (.auth_gaps_by_tool // [] | length) == 0 then "- none" else (.auth_gaps_by_tool | map("- " + .tool + " (missing=" + (.missing|tostring) + ", invalid=" + (.invalid|tostring) + ", valid=" + (.valid|tostring) + ")")[]) end),
  "",
  "**Failure Reasons**",
  (if (.failure_reasons // [] | length) == 0 then "- none" else (.failure_reasons | map("- " + .reason + ": " + (.count|tostring))[]) end),
  "",
  "**Top Agents By Activity**",
  ((.top_agents_by_activity // []) | .[0:12] | map("- " + .agent_id + ": " + (.events|tostring))[]),
  "",
  "**Namespace Throughput**",
  (if (.namespace_throughput // [] | length) == 0 then "- none" else (.namespace_throughput | map("- " + .namespace + " (created=" + (.created_window|tostring) + ", done=" + (.done_window|tostring) + ", pending_now=" + (.pending_now|tostring) + ")")[]) end)
' "$JSON_FILE" > "$MD_FILE"

echo "Report generated:"
echo "  JSON: $JSON_FILE"
echo "  MD:   $MD_FILE"
