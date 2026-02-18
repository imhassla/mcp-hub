#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${CONTAINER:-mcp-hub}"
INTERVAL_SEC="${INTERVAL_SEC:-30}"
SAMPLES="${SAMPLES:-20}"
OUT_DIR="${OUT_DIR:-/tmp/hub-observer}"
TAG="${TAG:-obs-$(date +%s)}"

mkdir -p "$OUT_DIR"

RAW_FILE="$OUT_DIR/${TAG}.jsonl"
SUMMARY_FILE="$OUT_DIR/${TAG}.summary.json"

# Always start a fresh observation window for a given TAG.
# Previous behavior appended to existing files, which could silently skew summaries.
: > "$RAW_FILE"

require_cmd() {
  local bin="$1"
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "Missing required command: $bin" >&2
    exit 1
  fi
}

require_cmd docker
require_cmd jq

sample_once() {
  docker exec "$CONTAINER" node -e '
    const Database = require("better-sqlite3");
    const db = new Database("/data/hub.db", { readonly: true });
    const now = Date.now();
    const one = (sql, ...p) => db.prepare(sql).get(...p);
    const topActions = db.prepare(
      "SELECT action, count(*) c FROM activity_log WHERE created_at >= ? GROUP BY action ORDER BY c DESC LIMIT 5"
    ).all(now - 5 * 60 * 1000);
    const byNamespace = db.prepare(
      "SELECT namespace, count(*) c, sum(CASE WHEN status = ? THEN 1 ELSE 0 END) pending, sum(CASE WHEN status = ? THEN 1 ELSE 0 END) in_progress FROM tasks GROUP BY namespace ORDER BY c DESC LIMIT 8"
    ).all("pending", "in_progress").map((r) => ({
      ns: (r.namespace && String(r.namespace).trim().length > 0) ? r.namespace : "default",
      c: r.c,
      pending: r.pending,
      in_progress: r.in_progress,
    }));

    const out = {
      ts: now,
      iso: new Date(now).toISOString(),
      agents_total: one("SELECT count(*) c FROM agents").c,
      agents_online_5m: one("SELECT count(*) c FROM agents WHERE last_seen >= ?", now - 5 * 60 * 1000).c,
      tasks_total: one("SELECT count(*) c FROM tasks").c,
      tasks_pending: one("SELECT count(*) c FROM tasks WHERE status = ?", "pending").c,
      tasks_in_progress: one("SELECT count(*) c FROM tasks WHERE status = ?", "in_progress").c,
      tasks_done: one("SELECT count(*) c FROM tasks WHERE status = ?", "done").c,
      claims_active: one("SELECT count(*) c FROM task_claims WHERE lease_expires_at > ?", now).c,
      messages_total: one("SELECT count(*) c FROM messages").c,
      messages_1m: one("SELECT count(*) c FROM messages WHERE created_at >= ?", now - 60 * 1000).c,
      activity_total: one("SELECT count(*) c FROM activity_log").c,
      activity_1m: one("SELECT count(*) c FROM activity_log WHERE created_at >= ?", now - 60 * 1000).c,
      protocol_blobs_total: one("SELECT count(*) c FROM protocol_blobs").c,
      top_actions_5m: topActions,
      by_namespace: byNamespace,
    };

    console.log(JSON.stringify(out));
  '
}

for i in $(seq 1 "$SAMPLES"); do
  row="$(sample_once)"
  printf '%s\n' "$row" | tee -a "$RAW_FILE" >/dev/null
  echo "sample $i/$SAMPLES collected"
  if [ "$i" -lt "$SAMPLES" ]; then
    sleep "$INTERVAL_SEC"
  fi
done

jq -s --arg tag "$TAG" --arg container "$CONTAINER" --argjson interval "$INTERVAL_SEC" '
  def avg(path): (map(path) | add / (length | if . == 0 then 1 else . end));
  {
    tag: $tag,
    container: $container,
    samples: length,
    interval_sec: $interval,
    window_sec: ((length - 1) * $interval),
    first_ts: (.[0].iso // null),
    last_ts: (.[-1].iso // null),
    snapshot: (.[-1] // {}),
    trend: {
      activity_1m_avg: (avg(.activity_1m) | floor),
      messages_1m_avg: (avg(.messages_1m) | floor),
      tasks_pending_min: (map(.tasks_pending) | min),
      tasks_pending_max: (map(.tasks_pending) | max),
      tasks_in_progress_min: (map(.tasks_in_progress) | min),
      tasks_in_progress_max: (map(.tasks_in_progress) | max),
      claims_active_min: (map(.claims_active) | min),
      claims_active_max: (map(.claims_active) | max),
      done_delta: ((.[-1].tasks_done // 0) - (.[0].tasks_done // 0)),
      messages_delta: ((.[-1].messages_total // 0) - (.[0].messages_total // 0)),
      activity_delta: ((.[-1].activity_total // 0) - (.[0].activity_total // 0))
    }
  }
' "$RAW_FILE" > "$SUMMARY_FILE"

echo "Observation complete."
echo "Raw:     $RAW_FILE"
echo "Summary: $SUMMARY_FILE"
jq '.' "$SUMMARY_FILE"
