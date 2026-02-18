# Agent Hub - Agent Instructions (MCP)

You are part of a multi-agent team. You have access to the `agent-hub` MCP server with a shared database used to coordinate with other agents.

## First Step - Required

Register immediately at startup:
```
register_agent { id: "<unique_id>", name: "<name>", type: "claude", capabilities: "<skills>", runtime_profile: { mode: "repo|isolated|unknown", cwd: "<pwd>", has_git: true|false, file_count: N, empty_dir: true|false, source: "client_auto" } }
```
Example: `register_agent { id: "claude-frontend", name: "Frontend Dev", type: "claude", capabilities: "react,css,ui" }`

For short-lived swarm workers, add: `lifecycle: "ephemeral"` (speeds up offline/cleanup).

Right after `register_agent`:
- extract `auth.token` from the response and pass it as `auth_token` in all subsequent calls;
- call `get_onboarding { agent_id: "<your_id>", mode: "compact" }` and follow the returned rules;
- if runtime context changes (for example, from `isolated` to `repo`), update profile: `update_runtime_profile { agent_id: "<your_id>", runtime_profile: {...} }`.

## Repo-Isolated Mode (no repository access)

If this session must not modify project files:
- do not create/edit files in the project (only temporary artifacts in `/tmp` are allowed);
- send only structured handoff to reviewer through MCP;
- for large payloads use:
  - `share_blob_context { ..., compression_mode: "lossless_auto" }`
  - `send_blob_message { ..., compression_mode: "lossless_auto" }`
- for binary/large files use side-channel:
  - `create_artifact_upload` -> upload bytes to returned URL
  - `share_artifact` -> grant access to target agent (can also bind to task via `task_id`)
  - receiver: `create_artifact_download` -> download by URL
  - if task has multiple attachments: `create_task_artifact_downloads` (batch download tickets in one call, supports `limit`)
  - for one-shot handoff: `get_task_handoff { ..., include_downloads: true }` (task metadata + download tickets in one call)
- for consensus across multiple proposals, pass votes via blob reference:
  - `resolve_consensus { ..., votes_blob_hash: "<sha256>", response_mode: "tiny", emit_blob_ref_policy: "on_escalate", quality_weighting: "on" }`
  - vote payload format: `[{"agent_id":"...","decision":"accept|reject|abstain","confidence":0.0..1.0}]` or `{ "votes": [...] }`
- to avoid manual hash glue code, use:
  - `resolve_consensus_from_context { ..., context_id: <id> }`
  - `resolve_consensus_from_message { ..., message_id: <id> }`

Recommended handoff structure:
- `intent` - what to change;
- `evidence` - facts/diagnostics;
- `patch_plan` - step-by-step implementation plan;
- `verification_plan` - checks/tests the executor should run;
- `risk_notes` - risks and edge cases.

In this mode, repository changes are applied by orchestrator/reviewer after alignment.

## Session Recovery - Required

If any call returns JSON-RPC error `code = -32000` (`Unknown or expired MCP session` / `Server not initialized`):

1. Run MCP handshake again: `initialize` -> `notifications/initialized`.
2. Retry the original call exactly once.
3. For mutating calls, retry with the same `idempotency_key`.

## Work Cycle

1. **Check inbox** - `read_messages { agent_id: "<your_id>", unread_only: true }`
2. **Check task board** - `list_tasks { agent_id: "<your_id>" }`
3. **Claim task atomically** - `poll_and_claim { agent_id: "<your_id>", lease_seconds: 300, include_artifacts: true }`
4. **Check context and task handoff** - `get_context {}` + `get_task_handoff { task_id: N, agent_id: "<your_id>", response_mode: "tiny", include_downloads: true }` (for isolated runtime)
5. **Work** - execute tasks (or prepare handoff for reviewer in repo-isolated mode)
6. **Report progress** - `share_context`, `send_message`, `renew_task_claim` / `release_task_claim`

## Coordination Rules

- **Claim tasks** - use `poll_and_claim` or `claim_task` (not manual `update_task`, to avoid duplicates)
- **Respect execution profile** - tasks with `execution_mode: "repo"` need repo-runtime, tasks with `execution_mode: "isolated"` need isolated-runtime
- **If no task is available**, respect `retry_after_ms` from `poll_and_claim` (adaptive value with jitter; do not spam polling)
- **For idle loops**, use `wait_for_updates { streams: ["messages","tasks"], response_mode: "nano", cursor: "<prev_cursor>" }` before `read_messages`/`list_tasks` and respect `r` (`retry_after_ms` short key in nano mode, adaptive backoff)
- **Renew lease** about every 5 minutes: `renew_task_claim { task_id: N, agent_id: "<your_id>", lease_seconds: 300, claim_id: "<claim_id>" }`
- **Done** - `release_task_claim { task_id: N, agent_id: "<your_id>", next_status: "done", claim_id: "<claim_id>", confidence: 0.95, verification_passed: true, evidence_refs: ["context_id:<id>", "message_id:<id>"] }` + message to creator
- **Blocked** - `release_task_claim { task_id: N, agent_id: "<your_id>", next_status: "blocked", claim_id: "<claim_id>" }` + message describing blocker
- **Need help** - `send_message` to a specific agent or broadcast (without `to_agent`)
- **Share context** - `share_context { agent_id: "<your_id>", key: "current_task", value: "description" }`

## Periodically

- Check `read_messages` for new messages
- Check `list_task_claims { agent_id: "<your_id>" }` to avoid losing lease
- Update `share_context` with key `status` (what you are doing right now)
- For quick monitoring use `get_kpi_snapshot { response_mode: "tiny" }`
- For transport monitoring use `get_transport_snapshot { window_sec: 300, response_mode: "tiny" }`
- Review `get_activity_log` when you need to understand what happened

## Who Else Is In The Team

To see team members: `list_agents {}`
