import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function readScript(name: string): Promise<string> {
  return readFile(new URL(`../scripts/${name}`, import.meta.url), 'utf8');
}

describe('helper CLI auth-token exposure hardening', () => {
  it('hub-wake-hydrate spawns hub-events-client without argv auth tokens', async () => {
    const source = await readScript('hub-wake-hydrate.mjs');
    const childArgs = source.match(/const childArgs = \[[\s\S]*?\n  \];/)?.[0] ?? '';
    const spawnOptions = source.match(/spawn\(process\.execPath, childArgs, \{[\s\S]*?\n  \}\);/)?.[0] ?? '';

    expect(childArgs).not.toMatch(/['"]--(?:auth-)?token['"]/);
    expect(spawnOptions).toContain('AUTH_TOKEN: opts.token');
  });

  it('standalone helper help prefers env or token-file auth over argv token flags', async () => {
    const wakeHydrate = await readScript('hub-wake-hydrate.mjs');
    const eventsClient = await readScript('hub-events-client.mjs');
    const claim = await readScript('hub-claim.mjs');
    const findings = await readScript('hub-findings.mjs');

    expect(wakeHydrate).toContain('Usage: hub-wake-hydrate.mjs --agent-id ID [options]');
    expect(eventsClient).toContain('Usage: hub-events-client.mjs --agent-id ID [options]');
    expect(wakeHydrate).not.toContain('Usage: hub-wake-hydrate.mjs --agent-id ID --token');
    expect(eventsClient).not.toContain('Usage: hub-events-client.mjs --agent-id ID --auth-token');

    for (const source of [wakeHydrate, eventsClient, claim, findings]) {
      expect(source).toContain('HUB_AUTH_TOKEN');
      expect(source).toContain('--token-file PATH');
      expect(source).toContain('ps/process listings');
    }
  });

  it('bridge fallback uses a protected token file instead of passing agent credentials on argv', async () => {
    const runner = await readScript('bridge-agent-runner.mjs');
    const claim = await readScript('hub-claim.mjs');
    const smartSwarm = await readFile(new URL('../scripts/smart-swarm-round.sh', import.meta.url), 'utf8');
    const hubLauncher = await readFile(new URL('../hub', import.meta.url), 'utf8');

    expect(runner).toContain("agentAuthToken: process.env.BRIDGE_AGENT_AUTH_TOKEN || ''");
    expect(runner).toContain("else if (arg === '--agent-token-file')");
    expect(runner).not.toContain("else if (arg === '--agent-auth-token')");
    expect(smartSwarm).toContain('--agent-token-file "$OUT_DIR/bridge-tokens/${worker_id}.token"');
    expect(smartSwarm).not.toMatch(/--agent-auth-token|--auth-token/);
    expect(runner).toContain('Task completion contract (required)');
    expect(runner).toContain('verification_passed (boolean)');
    expect(claim).toContain("else if (a === '--verified-by')");
    expect(claim).toContain('verified_by: opts.verifiedBy || undefined');
    expect(claim).toContain("else if (a === '--preserve-assignment')");
    expect(runner).toContain('preserve_assignment: true');
    expect(smartSwarm).toContain('ORCHESTRATOR_TOKEN_FILE=');
    expect(smartSwarm).toContain('auth_token:env.AGENT_AUTH_TOKEN');
    expect(smartSwarm).not.toContain('--arg auth "$ORCHESTRATOR_AUTH_TOKEN"');
    expect(smartSwarm).toContain('export BRIDGE_REGISTER_TOKEN="$REGISTER_TOKEN"');
    expect(smartSwarm).toContain(') <"$prompt_file" >"$log_file" 2>&1');
    expect(smartSwarm).not.toContain('--prompt "$prompt"');
    expect(hubLauncher).toContain('printf \'%s\' "$PROMPT" |');
    expect(hubLauncher).not.toContain('--prompt "$PROMPT"');
  });

  it('scrubs hub credentials before spawning model backends', async () => {
    const runner = await readScript('bridge-agent-runner.mjs');
    const runtime = await readFile(new URL('../scripts/lib/bridge-runtime.mjs', import.meta.url), 'utf8');
    for (const key of [
      'HUB_AUTH_TOKEN',
      'AUTH_TOKEN',
      'HUB_AUTH_TOKEN_FILE',
      'AUTH_TOKEN_FILE',
      'HUB_REGISTER_TOKEN',
      'MCP_HUB_REGISTER_TOKEN',
      'BRIDGE_REGISTER_TOKEN',
      'HUB_AGENT_TOKEN_FILE',
      'BRIDGE_AGENT_TOKEN_FILE',
      'BRIDGE_AGENT_AUTH_TOKEN',
      'AGENT_AUTH_TOKEN',
      'REGISTER_TOKEN',
      'MCP_AUTH_TOKEN',
    ]) {
      expect(runtime).toContain(`'${key}'`);
    }
    expect(runner).toContain('sanitizeBackendEnv(process.env, extra)');
    expect(runner).toContain("args.push('-')");
    expect(runner).toContain('input: prompt');
    expect(runner).not.toContain('args.push(prompt)');
    expect(runner).not.toContain('BRIDGE_PROMPT: prompt');
    expect(runner).toContain('process.umask(0o077)');
    expect(runner).toContain("await fs.chmod(opts.outDir, 0o700)");
    expect(runtime).toContain("fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\\n`, { mode: 0o600 })");
    expect(runtime).toContain('await fs.chmod(filePath, 0o600)');
    expect(runner.match(/writePrivateJson\(reportPath,/g)).toHaveLength(3);
    expect(runner).toContain('--register-token exposes the registration secret in ps/process listings');
  });

  it('keeps private thread results out of shared bridge channels', async () => {
    const runner = await readScript('bridge-agent-runner.mjs');

    expect(runner).toContain('threadPublication.allow_shared_publication && opts.rememberKey');
    expect(runner).toContain("visibility: threadPublication.is_private ? 'private' : 'public'");
    expect(runner).toContain('share_with_agents: threadPublication.private_peer ? [threadPublication.private_peer] : undefined');
    expect(runner).toContain('if (threadPublication.allow_shared_publication)');
    expect(runner).toContain('const shouldPublishMessage = threadPublication.allow_shared_publication');
    expect(runner).toContain('state.allowSharedPublication === false');
  });

  it('forwards registration and event security limits into the container', async () => {
    const hubScript = await readFile(new URL('../hub.sh', import.meta.url), 'utf8');
    for (const key of [
      'MCP_HUB_REGISTER_TOKEN',
      'MCP_HUB_ALLOW_LEGACY_AGENT_CLAIM',
      'MCP_HUB_REGISTER_RATE_LIMIT_RPS',
      'MCP_HUB_MAX_SESSIONS',
      'MCP_HUB_MAX_SESSIONS_PER_SOURCE',
      'MCP_HUB_SESSION_PROVISIONAL_TTL_MS',
      'MCP_HUB_SESSION_INITIALIZE_RPS',
      'MCP_HUB_RATE_LIMIT_BUCKET_IDLE_TTL_MS',
      'MCP_HUB_EVENT_STREAM_MAX_CONNECTIONS',
      'MCP_HUB_EVENT_STREAM_MAX_PER_AGENT',
      'MCP_HUB_EVENT_STREAM_MAX_BUFFER_BYTES',
      'MCP_HUB_EVENT_STREAM_DRAIN_TIMEOUT_MS',
    ]) {
      expect(hubScript).toContain(key);
    }
    expect(hubScript).toContain('chmod 700 "$DB_DIR"');
    expect(hubScript).toContain('Refusing to start auth_mode=enforce with open agent enrollment.');
    expect(hubScript).toContain('\\"name\\":\\"register_agent\\"');
    expect(hubScript).toContain('\\"name\\":\\"list_agents\\"');
    expect(hubScript).toContain('auth=verified');

    const server = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(server).toContain('process.umask(0o077)');
    expect(server).toContain('mode: 0o700');
    expect(server).toContain('fs.chmodSync(ARTIFACTS_DIR, 0o700)');
  });

  it('rejects wildcard extra binds and scopes findings publication to its thread', async () => {
    const hubScript = await readFile(new URL('../hub.sh', import.meta.url), 'utf8');
    const findings = await readScript('hub-findings.mjs');

    expect(hubScript).toContain('[ "$host" = "0.0.0.0" ]');
    expect(hubScript).toContain('[ "$host" = "::" ]');
    expect(hubScript).toContain('[ "$host" = "[::]" ]');
    expect(hubScript).toContain('http://127.0.0.1:$PORT/mcp');
    expect(hubScript).not.toContain('local endpoint="http://localhost:$PORT/mcp"');
    expect(hubScript).toContain(String.raw`grep -q '\\"summary\\":{'`);
    expect(findings).toContain("createHash('sha256').update(opts.threadId)");
    expect(findings).toContain('idempotency_key: `findings:${threadScope}:${blobHash}`');
    expect(findings).not.toContain('idempotency_key: `${opts.agentId}:findings:${blobHash}`');
  });

  it('keeps operational helpers read-only, cwd-independent, and session-bounded', async () => {
    const hubScript = await readFile(new URL('../hub.sh', import.meta.url), 'utf8');
    const waitMode = await readScript('wait-mode-ab.sh');
    const claim = await readScript('hub-claim.mjs');
    const findings = await readScript('hub-findings.mjs');

    expect(hubScript).toContain('docker build -t "$IMAGE" "$ROOT_DIR"');
    expect(hubScript).toContain('docker build -f "$ROOT_DIR/Dockerfile.dev" -t "${IMAGE}-dev" "$ROOT_DIR"');
    expect(hubScript).toContain('-v "$DB_DIR:/data:ro"');
    expect(hubScript).toContain('sqlite3 -readonly /data/hub.db');
    expect(hubScript).toContain("stat -f '%Lp' \"$file\"");
    expect(hubScript).toContain("stat -c '%a' \"$file\"");
    expect(hubScript).toContain('(8#$mode & 8#077)');
    expect(hubScript).toContain('Local environment file must not be accessible by group or others');
    const startFunction = hubScript.slice(hubScript.indexOf('cmd_start() {'), hubScript.indexOf('cmd_stop() {'));
    expect(startFunction.match(/\bcmd_status\b/g)).toHaveLength(1);

    expect(waitMode).toContain('ENDPOINT="${ENDPOINT:-http://127.0.0.1:3300/mcp}"');
    expect(waitMode).toContain('trap cleanup EXIT');
    expect(waitMode).toContain('close_mcp_session "$previous_sid"');
    expect(waitMode).toContain('close_mcp_session "$session_id"');

    expect(claim).not.toContain('--token TOK');
    expect(findings).not.toContain('--token TOK');
    expect(claim).toContain('--token-file /secure/hub.token');
    expect(findings).toContain('--token-file /secure/hub.token');
  });

  it('benchmark registration gates use env secrets and stream JSON bodies to curl stdin', async () => {
    const names = ['smart-swarm-round.sh', 'kpi-round.sh', 'wait-mode-ab.sh', 'consensus-ab-round.sh'];
    for (const name of names) {
      const source = await readFile(new URL(`../scripts/${name}`, import.meta.url), 'utf8');
      expect(source).toContain('HUB_REGISTER_TOKEN');
      expect(source).toContain('MCP_HUB_REGISTER_TOKEN');
      expect(source).toContain('register_token:env.REGISTER_TOKEN');
      expect(source).not.toMatch(/--arg\s+rt\s+["']?\$REGISTER_TOKEN/);
      expect(source).toContain('--data-binary @-');
      expect(source).not.toContain('--data "$payload"');
      expect(source).not.toContain('-d "$payload"');
      expect(source).not.toMatch(/--arg\s+token\s+"\$auth_token"|--arg\s+token\s+"\$token"/);
      if (name !== 'wait-mode-ab.sh') {
        expect(source).toContain('payload_is_replay_safe()');
        expect(source).toContain('local max_attempts=1');
        expect(source).toContain('$name != "read_messages" or $args.mark_read == false');
        expect(source).toContain('$name != "read_filter_feed" or $args.advance_cursor != true');
        expect(source).toContain('$name != "fetch_hub_refs" or $args.mark_messages_read != true');
        expect(source).toContain('$name != "get_task_handoff" or $args.include_downloads != true');
        expect(source).toContain('"send_message", "share_artifact"');
      }
    }
  });

  it('consensus benchmark owns a unique authenticated identity for the complete run', async () => {
    const source = await readScript('consensus-ab-round.sh');

    expect(source).toContain('AGENT_ID="${AGENT_ID:-consensus-ab-orchestrator-${RUN_TAG}}"');
    expect(source).toContain("require('node:crypto').randomBytes(32)");
    expect(source).toContain('auth_token:env.INITIAL_AUTH_TOKEN');
    expect(source).toContain("jq -r '.auth.token // empty'");
    expect(source).toContain('register_agent did not return auth token');
    expect(source.match(/auth_token:env\.AGENT_AUTH_TOKEN/g)).toHaveLength(4);
    expect(source).not.toContain('--arg auth "$AGENT_AUTH_TOKEN"');
  });

  it('authenticates artifact uploads before raw buffering and disables download caching', async () => {
    const server = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(server).toContain("app.post('/artifacts/upload/:artifactId', artifactUploadTicketGuard, artifactUploadBodyParser");
    expect(server).toContain('reserveArtifactUploadTicket');
    expect(server).toContain('releaseArtifactUploadReservation');
    expect(server).toContain("res.setHeader('Cache-Control', 'private, no-store, max-age=0')");
    expect(server).toContain("res.setHeader('Surrogate-Control', 'no-store')");
    expect(server).toContain("res.setHeader('Vary', 'X-Artifact-Token')");
    expect(server).toContain("preserve_assignment: z.boolean().optional()");

    const uploadRoute = server.indexOf("app.post('/artifacts/upload/:artifactId'");
    const reservationCommit = server.indexOf('commitArtifactUploadReservation(reservation)', uploadRoute);
    const artifactWrite = server.indexOf('await fsp.writeFile(artifactPath, body)', uploadRoute);
    const artifactFinalize = server.indexOf('finalizeArtifactUpload({', uploadRoute);
    expect(reservationCommit).toBeGreaterThan(uploadRoute);
    expect(reservationCommit).toBeLessThan(artifactWrite);
    expect(reservationCommit).toBeLessThan(artifactFinalize);
  });
});
