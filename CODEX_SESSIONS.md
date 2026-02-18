# Codex Sessions: MCP Agent Hub

This guide describes how to use Codex with a local `agent-hub` and a shared DB together with Claude.

## 1) Short Checklist For The Current Codex Session

1. Ensure the hub is running:

```bash
cd <repo-root>
./hub.sh status
./hub.sh smoke
```

2. Verify Codex can see MCP config:

```bash
codex mcp list --json
codex mcp get agent-hub --json
```

3. If `agent-hub` is missing, add it to Codex globally:

```bash
MCP_HUB_DATA="${MCP_HUB_DATA:-$HOME/.mcp-hub}"
codex mcp add agent-hub -- \
  docker run --rm -i \
  -v "$MCP_HUB_DATA:/data" \
  -e MCP_HUB_DB=/data/hub.db \
  mcp-agent-hub
```

4. Restart your Codex session after MCP config changes.

5. Verify MCP handshake (quick smoke test):

```bash
./hub.sh smoke
```

## 2) Another Codex Session, Another Directory

If `agent-hub` was added via `codex mcp add`, it is available in any new session:

```bash
cd /path/to/another/project
codex
```

Important: all clients must use the same DB path (for example `~/.mcp-hub/hub.db`).

## 3) One-Off Run Without Global Config (single session only)

You can pass MCP config directly in startup command:

```bash
MCP_HUB_DATA="${MCP_HUB_DATA:-$HOME/.mcp-hub}"
cd /path/to/another/project
codex \
  -c 'mcp_servers.agent-hub.command="docker"' \
  -c "mcp_servers.agent-hub.args=[\"run\",\"--rm\",\"-i\",\"-v\",\"${MCP_HUB_DATA}:/data\",\"-e\",\"MCP_HUB_DB=/data/hub.db\",\"mcp-agent-hub\"]"
```

Pre-launch verification:

```bash
MCP_HUB_DATA="${MCP_HUB_DATA:-$HOME/.mcp-hub}"
codex mcp list --json \
  -c 'mcp_servers.agent-hub.command="docker"' \
  -c "mcp_servers.agent-hub.args=[\"run\",\"--rm\",\"-i\",\"-v\",\"${MCP_HUB_DATA}:/data\",\"-e\",\"MCP_HUB_DB=/data/hub.db\",\"mcp-agent-hub\"]"
```

## 4) Working Together With Claude

1. Claude: `~/.claude/.mcp.json` points to the same `agent-hub`.
2. Codex: `codex mcp list` shows the same server.
3. Both clients use one shared DB (for example `~/.mcp-hub/hub.db`), so they see the same tasks/messages/context.

## 5) If MCP Is Unavailable In Codex

1. Check server status:

```bash
cd <repo-root>
./hub.sh status
./hub.sh smoke
```

2. If you see an error like `error decoding response body, when send initialize request`, rebuild and restart:

```bash
./hub.sh build
./hub.sh restart
./hub.sh smoke
```

3. Re-check Codex config:

```bash
codex mcp list --json
codex mcp get agent-hub --json
```
