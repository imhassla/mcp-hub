import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function parseLooseJson(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const normalizeParsed = (parsed) => {
    if (typeof parsed === 'string') {
      const nested = parsed.trim();
      if (nested.startsWith('{') || nested.startsWith('[')) {
        return parseLooseJson(nested) ?? parsed;
      }
    }
    return parsed;
  };
  try {
    return normalizeParsed(JSON.parse(value));
  } catch {
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      try {
        return normalizeParsed(JSON.parse(fenced[1].trim()));
      } catch {
        return null;
      }
    }
    const start = value.indexOf('{');
    const end = value.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return normalizeParsed(JSON.parse(value.slice(start, end + 1)));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function assessTaskCompletion(output) {
  const parsed = parseLooseJson(output);
  const row = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  const nestedVerification = row?.verification && typeof row.verification === 'object'
    ? row.verification
    : null;
  const verificationChecks = Array.isArray(nestedVerification?.checks)
    ? nestedVerification.checks.filter((check) => {
      if (typeof check === 'string') return check.trim().length > 0;
      return check !== null && check !== undefined;
    })
    : [];
  const verificationPassed = row?.verification_passed === true || nestedVerification?.passed === true;
  const confidenceRaw = row?.confidence ?? nestedVerification?.confidence;
  const confidence = typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw)
    ? confidenceRaw
    : null;
  const confidenceValid = confidence !== null && confidence >= 0 && confidence <= 1;
  return {
    parsed,
    json_valid: parsed !== null,
    verification_passed: verificationPassed,
    verification_checks: verificationChecks,
    confidence: confidenceValid ? confidence : null,
    completion_ready: verificationPassed && confidenceValid && verificationChecks.length > 0,
  };
}

export function sanitizeBackendEnv(source = process.env, extra = {}) {
  const blockedEnvPatterns = [
    /^MCP_HUB_/,
    /^BRIDGE_/,
    /^WORKER_.*MCP_/,
    /^CODEX_.*MCP_/,
    /^(?:HUB|BRIDGE)_(?:AGENT_)?(?:(?:AUTH|REGISTER)_)?TOKEN(?:_FILE)?$/,
  ];
  const blockedKeys = new Set([
    'ENDPOINT',
    'MCP_ENDPOINT',
    'HUB_ENDPOINT',
    'MCP_CONFIG_FILE',
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
    'AGENT_TOKEN_FILE',
    'REGISTER_TOKEN',
    'REGISTRATION_TOKEN',
    'MCP_AUTH_TOKEN',
    'MCP_REGISTER_TOKEN',
  ]);
  const env = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (blockedKeys.has(key)) continue;
    if (blockedEnvPatterns.some((pattern) => pattern.test(key))) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

export function resolveThreadPublicationPolicy(threadResult, agentId) {
  const thread = threadResult?.thread && typeof threadResult.thread === 'object'
    ? threadResult.thread
    : null;
  const isPrivate = thread?.private === true;
  const privatePeer = isPrivate
    ? [thread.from_agent, thread.to_agent].find((id) => typeof id === 'string' && id.length > 0 && id !== agentId) || null
    : null;
  return {
    is_private: isPrivate,
    private_peer: privatePeer,
    allow_shared_publication: !isPrivate,
  };
}

export function runIdempotencyKey(runId, action, ...parts) {
  const canonicalPayload = JSON.stringify(
    [runId, action, ...parts].map((part) => String(part ?? '').trim()),
  );
  const digest = createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
  return `bridge-v1:${digest}`;
}

export function taskRequiresIndependentVerifier(taskLike) {
  const task = taskLike?.task && typeof taskLike.task === 'object' ? taskLike.task : taskLike;
  return task?.consistency_mode === 'strict';
}

export async function readAgentToken(explicitToken, tokenFile) {
  if (explicitToken) return String(explicitToken).trim();
  if (!tokenFile) return '';
  try {
    return (await fs.readFile(tokenFile, 'utf8')).trim();
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

export async function writeAgentToken(tokenFile, token) {
  if (!tokenFile || !token) return false;
  const resolved = path.resolve(tokenFile);
  const parent = path.dirname(resolved);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const existing = await readAgentToken('', resolved);
  if (existing) {
    if (existing !== String(token).trim()) throw new Error(`agent token file already contains a different credential: ${resolved}`);
    await fs.chmod(resolved, 0o600);
    return true;
  }
  const temporary = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${String(token).trim()}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, resolved);
    await fs.chmod(resolved, 0o600);
    return true;
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writePrivateJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}

export async function getOrCreateAgentToken(tokenFile, candidateToken) {
  if (!tokenFile) return String(candidateToken || '').trim();
  const resolved = path.resolve(tokenFile);
  const parent = path.dirname(resolved);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const existing = await readAgentToken('', resolved);
  if (existing) return existing;

  const candidate = String(candidateToken || '').trim();
  if (!candidate) throw new Error('candidate agent token is required');
  const temporary = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${candidate}\n`, { mode: 0o600, flag: 'wx' });
    try {
      // Publish a fully-written inode without overwriting a winner from another process.
      await fs.link(temporary, resolved);
      await fs.chmod(resolved, 0o600);
      return candidate;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const winner = await readAgentToken('', resolved);
      if (!winner) throw new Error(`agent token file race produced an empty credential: ${resolved}`);
      return winner;
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
