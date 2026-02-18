# MCP Agent Hub

A network MCP server for coordinating multiple AI agents through a shared SQLite database. It runs as a Docker daemon, and all agents connect over HTTP.

## Quick Start

```bash
./hub.sh build       # Build Docker image
./hub.sh start       # Start daemon on port 3000
./hub.sh status      # Check that it is running
./hub.sh smoke       # Verify MCP handshake (initialize + tools/list)
```

## Management

```bash
./hub.sh build    # Build Docker image
./hub.sh test     # Run tests
./hub.sh start    # Start server daemon
./hub.sh stop     # Stop
./hub.sh restart  # Restart
./hub.sh status   # Status + health check
./hub.sh smoke    # MCP smoke test (initialize + tools/list)
./hub.sh logs     # Logs (use logs -f to follow)
./hub.sh db       # SQLite shell for DB inspection
./hub.sh clean    # Remove everything
```

## KPI Round (8-12 workers)

For a comparative baseline vs hash/blob mode run:

```bash
./scripts/kpi-round.sh                # default: 10 workers
WORKERS=12 ./scripts/kpi-round.sh     # upper load boundary
USE_AUTH_TOKEN=true WORKERS=12 ./scripts/kpi-round.sh   # for auth_mode=enforce
```

Report is saved to `/tmp/exp5/exp5-kpi.json` (or `$OUT_DIR/exp5-kpi.json`).
The report also includes transport fields (`transport_wait_*`, `transport_polling_calls`) and their baseline vs optimized deltas.
The script registers orchestrator/workers with `onboarding_mode=none` to avoid unnecessary onboarding token overhead during benchmarks.

## Smart Swarm Round (real Claude/Codex workers)

To run real CLI workers instead of synthetic calls:

```bash
./scripts/smart-swarm-round.sh
WORKERS=12 WORKER_BACKEND=mixed ./scripts/smart-swarm-round.sh
WORKERS=10 WORKER_BACKEND=claude ./scripts/smart-swarm-round.sh
USE_AUTH_TOKEN=true WORKERS=12 WORKER_BACKEND=mixed ./scripts/smart-swarm-round.sh
```

The worker contract in this round uses `register_agent(onboarding_mode=none)` without `get_onboarding` to reduce service token overhead and keep useful traffic in the experiment.

Key variables:

```bash
ENDPOINT=http://localhost:3000/mcp
WORKERS=8
WORKER_BACKEND=mixed      # claude | codex | mixed
USE_AUTH_TOKEN=auto       # auto | true | false
ENABLE_NAMESPACE=auto     # auto | true | false
WORKER_TIMEOUT_SEC=900
OUT_DIR=/tmp/smart-swarm
SNAPSHOT_RESPONSE_MODE=auto  # auto | tiny | nano (auto => nano when server supports it)
ALLOW_BACKEND_FALLBACK=1  # 1 = fallback to another backend on worker runtime failure
SKIP_CLI_PREFLIGHT=0      # 1 = skip CLI mcp list preflight check
FORCE_WORKER_ENDPOINT_CONFIG=1  # 1 = force worker CLI to use ENDPOINT
```

The script:

- registers orchestrator;
- creates one task per worker;
- starts real workers in parallel via `claude`/`codex`;
- captures snapshot (`list_tasks`/`read_messages`/`get_context`) in `nano` when supported (or `tiny` fallback);
- can automatically restart a failed `claude` worker on `codex` when `ALLOW_BACKEND_FALLBACK=1` (`exit!=0` or empty output);
- collects KPI (done-rate, latency, message/context chars, token proxy);
- writes report to `$OUT_DIR/smart-swarm-<experiment>.json` (including `backend_health`, `backend_runtime_health`, `fallback_used`, `snapshots.*_bytes`, and `snapshots.total_tokens_est`).

## Wait Mode A/B (tiny vs micro vs nano)

To measure transport payload savings in `wait_for_updates`:

```bash
ENDPOINT=http://localhost:3300/mcp ROUNDS=12 WAIT_MODES=default,tiny,micro,nano ./scripts/wait-mode-ab.sh
```

Output:
- JSON report with `avg_bytes` and `avg_ms` for selected modes (`WAIT_MODES`, default `tiny,micro,nano`);
- supports `default` mode (without `response_mode`) to validate server defaults;
- deltas `default_vs_tiny`, `default_vs_nano`, `micro_vs_tiny`, `nano_vs_tiny`, `nano_vs_micro` for direct transport comparison;
- scenario listens only to `messages` stream (`wait_for_updates.streams=["messages"]`);
- default file: `/tmp/wait-mode-ab-<ts>.json` (or `$OUT_FILE`).

## Repo-isolated Workflow (workers without repository access)

If workers must not change project files:
- workers send only structured handoff via MCP (`intent`, `evidence`, `patch_plan`, `verification_plan`, `risk_notes`);
- use `send_blob_message` / `share_blob_context` with `compression_mode=lossless_auto` for large payloads;
- only orchestrator/reviewer applies code changes to the repository;
- workers do not create local project files (except temporary files in `/tmp`).

Prerequisites:

- `claude` and/or `codex` CLI are installed and authenticated;
- `agent-hub` is visible in `claude mcp list` / `codex mcp list`;
- hub is reachable via `ENDPOINT`.
- Claude workers use `MCP_CONFIG_FILE` (default `.mcp.json`; start from `.mcp.example.json` in this repo);
- Codex workers use the active configuration from `codex mcp list`.

Ready-to-use template for an empty isolated directory:

- `templates/CLAUDE.isolated-swarm.md`

Quick usage:

```bash
mkdir -p /tmp/isolated-swarm-worker && cd /tmp/isolated-swarm-worker
cp /path/to/mcp-local/templates/CLAUDE.isolated-swarm.md ./CLAUDE.md
claude
```

## Observer Mode (live metrics)

For continuous read-only monitoring of a live hub:

```bash
./scripts/observe-hub.sh
INTERVAL_SEC=10 SAMPLES=12 TAG=peak-window ./scripts/observe-hub.sh
```

The script reads metrics from the `mcp-hub` container SQLite DB and stores:

- raw JSONL: `/tmp/hub-observer/<tag>.jsonl`
- summary JSON: `/tmp/hub-observer/<tag>.summary.json`

Main summary fields: online agents, task backlog, active claims, activity/message intensity, top actions over 5 minutes, namespace distribution, and trend over the observation window.

## Summary Report for N Hours

For a retrospective pool report (read-only from SQLite, JSON + Markdown):

```bash
./scripts/pool-report.sh --hours 12
./scripts/pool-report.sh --hours 24 --out-dir /tmp/hub-reports --tag day-1
./scripts/pool-report.sh --hours 6 --db "$HOME/.mcp-hub/hub.db"
```

Output:

- JSON: `/tmp/hub-reports/<tag>.json`
- MD: `/tmp/hub-reports/<tag>.md`

The report includes: task/claim throughput, auth coverage (`valid/missing/invalid`), top actions/agents, failure reasons, hourly trends, and namespace throughput for the selected window.

Override port or DB path:

```bash
MCP_HUB_PORT=8080 MCP_HUB_DATA=/path/to/dir ./hub.sh start
```

Key protocol modes:

```bash
MCP_HUB_AUTH_MODE=observe|warn|enforce
MCP_HUB_NAMESPACE_GOVERNANCE=off|warn|require
MCP_HUB_EXTRA_BIND_HOSTS=100.107.1.68[,192.168.1.50]
MCP_HUB_SESSION_IDLE_TIMEOUT_MS=21600000 # <=0 disables idle session eviction (sessions live until DELETE /mcp or server restart)
MCP_HUB_SESSION_GC_INTERVAL_MS=60000
MCP_HUB_UNKNOWN_SESSION_POLICY=error|stateless_fallback
MCP_HUB_AGENT_OFFLINE_AFTER_MS=1800000
MCP_HUB_AGENT_RETENTION_MS=604800000
MCP_HUB_AUTO_PACK_MIN_PAYLOAD_CHARS=2048
MCP_HUB_AUTO_PACK_MIN_GAIN_PCT=3
MCP_HUB_LOSSLESS_AUTO_MIN_PAYLOAD_CHARS=1024
MCP_HUB_LOSSLESS_AUTO_MIN_GAIN_PCT=3
MCP_HUB_WAIT_MAX_MS=25000
MCP_HUB_WAIT_DEFAULT_MS=10000
MCP_HUB_WAIT_RETRY_FACTOR=1.5
MCP_HUB_WAIT_RETRY_CAP_MS=10000
MCP_HUB_WAIT_RETRY_JITTER_PCT=0.2
MCP_HUB_MAX_CONSENSUS_VOTES=1000
MCP_HUB_CONSENSUS_QUALITY_WEIGHTING=on|off
MCP_HUB_DONE_EVIDENCE_MIN_REFS=1
MCP_HUB_MAX_EVIDENCE_REFS_PER_CALL=16
MCP_HUB_MAX_EVIDENCE_REF_CHARS=256
MCP_HUB_ARTIFACT_MAX_BYTES=52428800
MCP_HUB_ARTIFACT_TICKET_TTL_SEC=300
MCP_HUB_ARTIFACT_UPLOAD_TTL_SEC=300
MCP_HUB_ARTIFACT_DOWNLOAD_TTL_SEC=180
MCP_HUB_ARTIFACT_RETENTION_SEC=86400
MCP_HUB_WAIT_DEFAULT_RESPONSE_MODE=compact|tiny|micro|nano|full
MCP_HUB_WAIT_DEFAULT_TIMEOUT_RESPONSE=default|minimal
MCP_HUB_WAIT_LOG_HITS=true|false
MCP_HUB_WAIT_LOG_TIMEOUTS=true|false
MCP_HUB_DEFAULT_ONBOARDING_MODE=full|compact|none
MCP_HUB_EPHEMERAL_DEFAULT_ONBOARDING_MODE=compact|full|none
MCP_HUB_REREGISTER_ONBOARDING_MODE=none|compact|full
MCP_HUB_PUBLIC_BASE_URL=http://localhost:3000
```

The persistent production profile is stored in the repository:

- `deploy/hub.production.env` (with comments and optimized defaults)
- `deploy/hub.local.env` (optional local overlay, gitignored)

Port `127.0.0.1` is always published. To add external interfaces, define `MCP_HUB_EXTRA_BIND_HOSTS` in `deploy/hub.local.env`.

Example local overlay:

```bash
cp deploy/hub.local.env.example deploy/hub.local.env
# then edit deploy/hub.local.env and set:
# MCP_HUB_EXTRA_BIND_HOSTS=100.107.1.68
```

`./hub.sh` picks it up automatically (if the file exists). Priority:

1. environment variables passed in command (`MCP_HUB_* ./hub.sh start`)
2. `MCP_HUB_LOCAL_ENV_FILE=/path/to/local.env` (or default `deploy/hub.local.env`)
3. `MCP_HUB_ENV_FILE=/path/to/file.env`
4. `deploy/hub.production.env` (auto-default)

Apply profile changes:

```bash
./hub.sh restart
./hub.sh status
```

Canary flow without stopping the working container:

```bash
MCP_HUB_CONTAINER=mcp-hub-canary \
MCP_HUB_PORT=3300 \
MCP_HUB_DATA="$HOME/.mcp-hub-canary" \
MCP_HUB_AUTH_MODE=warn \
MCP_HUB_NAMESPACE_GOVERNANCE=require \
./hub.sh start
```

## Claude Code Connection

Global config (works from any directory) in `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "agent-hub": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

For one project, place the same format in `.mcp.json` at project root.
This repository provides a starter template in `.mcp.example.json`.

## Claude Desktop Connection

File: `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agent-hub": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## Codex Connection

Codex supports MCP servers. Use `codex-config.json` or CLI:

```bash
codex --mcp-server "http://localhost:3000/mcp"
```

## Network Connection (other machines)

If an extra bind is configured (for example `MCP_HUB_EXTRA_BIND_HOSTS=100.107.1.68`), remote clients can use that IP/hostname instead of `localhost`:

```json
{
  "mcpServers": {
    "agent-hub": {
      "url": "http://192.168.1.100:3000/mcp"
    }
  }
}
```

## Architecture

One Docker daemon server, all agents connect via HTTP (Streamable HTTP transport).

```
┌─────────────┐              ┌────────────────────────┐
│ Claude Code ├─── HTTP ────►│                        │
└─────────────┘              │                        │
                             │   MCP Agent Hub        │
┌─────────────┐              │   :3000                │  ┌──────────┐
│ Claude Desk ├─── HTTP ────►│                        ├─►│ SQLite   │
└─────────────┘              │   Docker container     │  │ hub.db   │
                             │                        │  └──────────┘
┌─────────────┐              │                        │
│ Codex/Other ├─── HTTP ────►│                        │
└─────────────┘              └────────────────────────┘
```

## Available Tools (46)

| Tool | Description |
|------|-------------|
| `register_agent` | Register an agent (call first; use `lifecycle: "ephemeral"` for short-lived workers; provide `runtime_profile` for accurate task routing) |
| `update_runtime_profile` | Update registered agent `runtime_profile` (useful when working directory/mode changes after start) |
| `list_agents` | List all agents and statuses (`response_mode`: `full`/`compact`/`summary`) |
| `get_onboarding` | Get onboarding with protocol capabilities and rules |
| `send_message` | Send a message to one agent or broadcast, supports `trace_id`/`span_id` |
| `send_blob_message` | Send message as hash-reference to deduplicated blob (single call, default `compression_mode=lossless_auto`; supports `trace_id`/`span_id`) |
| `read_messages` | Read inbox messages (`response_mode`: `full`/`compact`/`tiny`/`nano`; `full` is forbidden when `polling=true`) |
| `create_task` | Create task on shared board (`execution_mode`: `any`/`repo`/`isolated`, `consistency_mode`: `auto`/`cheap`/`strict`, supports `trace_id`/`span_id`) |
| `update_task` | Update task (status, assignment, `execution_mode`, `consistency_mode`, done-gate with `confidence`/`verification_passed`/`evidence_refs`, supports `trace_id`/`span_id`) |
| `list_tasks` | View task board (`response_mode`: `full`/`compact`/`tiny`/`nano`; `full` is forbidden when `polling=true`) |
| `poll_and_claim` | Atomically claim next available task by priority (`include_artifacts` option for tiny attachment refs) |
| `claim_task` | Claim a specific task in lease mode (anti-duplicate; `include_artifacts` option) |
| `renew_task_claim` | Renew task lease |
| `release_task_claim` | Release lease and set final status (`done` requires `confidence`/`verification_passed`/`evidence_refs`; optional `consistency_mode`) |
| `list_task_claims` | List active leased tasks and expiration times |
| `attach_task_artifact` | Attach artifact to task and auto-share to current assignee (for repo-isolated handoff) |
| `list_task_artifacts` | List artifacts attached to a task (`full`/`compact`/`tiny`, supports `limit/offset`) |
| `get_task_handoff` | Get consolidated task handoff packet (deps + evidence refs + artifact hints), optionally with download tickets (`include_downloads`) |
| `share_context` | Share context (key-value), supports `trace_id`/`span_id` |
| `share_blob_context` | Share context as hash-reference to deduplicated blob (single call, default `compression_mode=lossless_auto`; supports `trace_id`/`span_id`) |
| `get_context` | Get context from other agents (`response_mode`: `full`/`compact`/`tiny`/`nano`/`summary`, `updated_after` for delta; `full` forbidden when `polling=true`) |
| `resolve_consensus` | Resolve multi-agent disagreement: inline votes or `votes_blob_hash`/`votes_blob_ref`, quality weighting (`quality_weighting: on/off`), `response_mode: full/compact/tiny`, `emit_blob_ref_policy` (`never/always/on_escalate/on_conflict`) |
| `resolve_consensus_from_context` | Resolve consensus directly from `context` (`context_id` or `context_agent_id+context_key`) without manual hash extraction |
| `resolve_consensus_from_message` | Resolve consensus directly from `message` (`message_id`) without manual hash glue code |
| `list_consensus_decisions` | View persisted consensus decisions (`response_mode`: `full`/`compact`/`tiny`) |
| `pack_protocol_message` | Pack payload into CAEP-v1 packet with adaptive lossless policy (`mode:auto` enables dictionary only with enough size/gain) |
| `unpack_protocol_message` | Unpack CAEP-v1 packet and validate hash |
| `hash_payload` | Compute deterministic payload hash for references/dedup |
| `store_protocol_blob` | Store payload as deduplicated blob by hash |
| `get_protocol_blob` | Get payload blob by hash |
| `list_protocol_blobs` | List recent blobs and access counters |
| `create_artifact_upload` | Create upload ticket + URL for binary side-channel transfer (without MCP payload tokens) |
| `create_artifact_download` | Create download ticket + URL for shared artifact download |
| `create_task_artifact_downloads` | Create batch download tickets for task-bound artifacts (single call, supports `limit`) |
| `share_artifact` | Grant artifact access to specific agent, optionally bind to task (`task_id`) and notify |
| `list_artifacts` | List artifacts visible to agent (`full`/`compact`/`tiny`) |
| `get_activity_log` | Agent activity log (`response_mode`: `full`/`compact`/`summary`) |
| `get_kpi_snapshot` | Built-in KPI aggregates over 1m/5m/30m (`response_mode: "tiny"` for minimum payload; includes `collective_accuracy`, `execution_backlog`, profile mismatch, artifact activity, task-artifact handoff usage, and transport metrics `wait_hits/timeouts/retry_after`) |
| `get_transport_snapshot` | Lightweight wait/poll transport efficiency snapshot for a window (`window_sec`), modes `tiny`/`full` |
| `wait_for_updates` | Long-poll for updates (`streams` to filter channels, `cursor` for compact delta mode; `response_mode: "nano"` for shortest machine format `c/s/u/r`; `response_mode: "micro"` for compact-compatible mode; `timeout_response: "minimal"` returns only changed flag on timeout; normal timeout returns `retry_after_ms` or `r` in nano mode with adaptive backoff+jitter, can disable via `adaptive_retry:false`) |
| `read_snapshot` | Batch read for polling loops: one call returns `messages+tasks+context` with a single cursor (`compact`/`tiny`/`nano`) |
| `evaluate_slo_alerts` | Recalculate SLO alerts (pending age / claim churn / stale in_progress) |
| `list_slo_alerts` | List open/closed SLO alerts |
| `get_auth_coverage` | Auth-token usage coverage by time window and tools |

`nano` mode for read tools (lossless, short keys only):
- `read_messages`: `{ m, h, n }` + `m[]` items with keys `i/f/t/u/r/c/d` (+`x/y` for trace/span, `b/z` for blob-ref)
- `list_tasks`: `{ t, h, n }` + `t[]` items with keys `i/s/a/p/n/e/cm/u/tc/t/dc` (+`x/y` for trace/span)
- `get_context`: `{ c }` + `c[]` items with keys `i/a/k/u/c/d` (+`x/y` for trace/span, `b/r` for blob-ref)
- `read_snapshot`: `{ s, h, ch, n, u }`, where `s={m,t,c}` is batch data and `u` is the unified cursor

For polling loops, pass `polling:true` to `read_messages`/`list_tasks`/`get_context`; when `polling:true`, the server forbids `response_mode:"full"` and returns `FULL_MODE_FORBIDDEN_IN_POLLING`.

Best practice for repo-isolated workers: workers send only structured proposals/votes via blob/hash-reference, reviewer calls `resolve_consensus`, and repository changes are applied by orchestrator/reviewer.

## Running Agents from Different Directories

With global config (`~/.claude/.mcp.json`), each agent can work in a separate project:

```bash
# Terminal 1 - frontend agent
cd ~/projects/frontend
claude -p "$(cat ~/mcp-local/AGENT_PROMPT.md)

You are claude-frontend. Your responsibility area: React UI.
Register and check the task board."

# Terminal 2 - backend agent
cd ~/projects/backend
claude -p "$(cat ~/mcp-local/AGENT_PROMPT.md)

You are claude-backend. Your responsibility area: API and database.
Register and check the task board."
```

## Role Launcher `/hub`

Unified role launcher for `codex` and `claude` with runtime-profile auto-detection (repo/isolated):

```bash
./hub --role orchestrator --backend codex --endpoint http://localhost:3000/mcp
./hub --role reviewer --backend claude --endpoint http://localhost:3000/mcp
./hub --role assistant --backend codex --namespace EXP-123
./hub --role orchestrator --backend codex --runtime-mode repo
./hub --role assistant --backend claude --runtime-mode isolated
./hub --role assistant --backend codex --lifecycle ephemeral
```

What launcher does:
- detects `runtime_profile` (`mode`, `cwd`, `has_git`, `file_count`, `empty_dir`);
- supports forced mode via `--runtime-mode repo|isolated|unknown` (or shortcuts `--repo-runtime` / `--isolated-runtime`);
- registers `orchestrator/reviewer/assistant` roles as `lifecycle: "persistent"` by default (set `--lifecycle ephemeral` for short-lived workers);
- injects profile into `register_agent` contract;
- loads system onboarding + role prompt;
- starts selected CLI with `agent-hub` connected.

Role skill cheatsheets:
- `skills/codex-hub.md`
- `skills/claude-hub.md`

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | MCP Streamable HTTP (primary) |
| `/mcp` | GET | SSE stream for notifications |
| `/mcp` | DELETE | Close session |
| `/events` | GET | SSE-only push channel for high-load polling replacement (`agent_id`, `auth_token`, `streams`, `cursor`, `response_mode`) |
| `/artifacts/upload/:artifactId` | POST | Side-channel upload binary artifact (ticket/token required) |
| `/artifacts/download/:artifactId` | GET | Side-channel download binary artifact (ticket/token required) |
| `/health` | GET | Health check (`auth_mode`, namespace quota mode, SSE settings, session counters) |

## Handshake Diagnostics

If you see an error in Codex/Claude like:

`error decoding response body, when send initialize request`

check server status:

```bash
./hub.sh status
./hub.sh smoke
```

If `smoke` fails, in most cases an outdated container is running. Fix:

```bash
./hub.sh build
./hub.sh restart
./hub.sh smoke
```

### Client Auto-Recovery for `-32000`

After container restart, previous `mcp-session-id` values become invalid.
Server returns JSON-RPC error `code: -32000` with `error.data.reinitialize_required=true`.

Recommended client algorithm:

1. Catch `error.code == -32000`.
2. Re-run handshake: `initialize` -> `notifications/initialized`.
3. Retry the original request exactly once.
4. For mutating tools, retry with the same `idempotency_key`.

Server also adds:

- `error.data.reason` (`unknown_or_expired_session` / `server_not_initialized`)
- `error.data.recovery_sequence`
- HTTP header `x-mcp-reinit-required: 1`

Optionally, enable server-side auto-recovery mode:

```bash
MCP_HUB_UNKNOWN_SESSION_POLICY=stateless_fallback
```

In this mode, requests with expired `mcp-session-id` are handled via one-shot stateless transport without `-32000`, reducing client breaks during long rounds/after restarts.

For long-lived pools, you can fully disable idle expiration of transport sessions:

```bash
MCP_HUB_SESSION_IDLE_TIMEOUT_MS=0
```

Why not Redis for "live" MCP sessions:
- In the SDK, transport session keeps in-memory connection state and is not serializable.
- Redis is useful for metrics/queues/event-store, but transport itself does not resume from Redis after process restart.
- Practical reliability path: `MCP_HUB_SESSION_IDLE_TIMEOUT_MS=0` (or long timeout) + client auto-reinit + `stateless_fallback` for unknown session.

### Onboarding at Agent Startup

Minimal bootstrap contract:

1. `register_agent`
2. Save `auth.token` from response
3. Call all subsequent tools with `auth_token`
4. Call `get_onboarding { mode: "compact" }` once

Token optimization for mass re-registrations:
- on repeated `register_agent` (same `id`) server defaults to `onboarding_mode=none`;
- first `register_agent` remains detailed (`full` for persistent, `compact` for ephemeral);
- behavior is configurable via `MCP_HUB_DEFAULT_ONBOARDING_MODE`, `MCP_HUB_EPHEMERAL_DEFAULT_ONBOARDING_MODE`, `MCP_HUB_REREGISTER_ONBOARDING_MODE`.

For swarm workers use `register_agent { ..., lifecycle: "ephemeral" }`:
- faster offline marking,
- faster stale-agent cleanup,
- automatic task requeue from missing ephemeral workers during maintenance.

## Example Scenario

1. Claude agent registers: `register_agent { id: "claude-1", name: "Claude", type: "claude", runtime_profile: { mode: "repo", has_git: true, file_count: 120 } }`
2. Codex agent registers: `register_agent { id: "codex-1", name: "Codex", type: "codex", runtime_profile: { mode: "isolated", has_git: false, file_count: 0, empty_dir: true } }`
3. Claude creates task: `create_task { title: "Refactor auth", created_by: "claude-1", execution_mode: "repo" }`
4. Codex claims atomically: `poll_and_claim { agent_id: "codex-1", lease_seconds: 300 }`
5. During execution Codex renews lease: `renew_task_claim { task_id: 42, agent_id: "codex-1", lease_seconds: 300, claim_id: "<from claim response>" }`
6. Codex shares progress: `share_context { agent_id: "codex-1", key: "status", value: "refactoring auth.ts" }`
7. On completion Codex records result:
   `release_task_claim { task_id: 42, agent_id: "codex-1", next_status: "done", claim_id: "<from claim response>", confidence: 0.95, verification_passed: true, evidence_refs: ["context_id:123", "message_id:456"] }`

## Recommendations for Swarm Polling

- If `poll_and_claim` returns `task: null`, wait `retry_after_ms` before the next poll.
- Under burst load, this reduces empty polls and collisions between agents.
- In routing loop, replace three calls (`list_tasks` + `read_messages` + `get_context`) with one `read_snapshot` using a single `cursor`.
- For high-load modes, enable `/events` push channel (SSE) and process only `update` events instead of cyclic long-poll.
- For safe renew/release, pass `claim_id` from the claim response.
- `retry_after_ms` is adaptive to the number of active agents (profiles for ~5/10/20+ agents) and includes jitter.
- For large handoff payloads, use `send_blob_message`/`share_blob_context`; when reading, enable `resolve_blob_refs`.
- In production swarm rounds, set `namespace` on task-flow and enable namespace quotas (`MCP_HUB_NAMESPACE_QUOTA_MODE=warn|enforce`).
