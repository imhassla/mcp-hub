#!/usr/bin/env node

import { createApiKey, listApiKeys, parseExpiration, revokeApiKey } from '../apiKeys.js';
import { closeDb, getDb } from '../db.js';

function usage(exitCode = 0): never {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage:
  mcp-hub-api-key create NAME [--exp 30d]
  mcp-hub-api-key list [--all]
  mcp-hub-api-key revoke NAME
`);
  process.exit(exitCode);
}

function requireSecret(): string {
  const secret = process.env.MCP_HUB_API_JWT_SECRET || '';
  if (!secret.trim()) {
    throw new Error('MCP_HUB_API_JWT_SECRET is required');
  }
  return secret;
}

function parseCreateArgs(args: string[]): { name: string; exp?: string } {
  if (args.length < 1) usage(1);
  const name = args[0];
  let exp: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--exp') {
      index += 1;
      if (index >= args.length) throw new Error('--exp requires a value');
      exp = args[index];
    } else if (arg.startsWith('--exp=')) {
      exp = arg.slice('--exp='.length);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return { name, exp };
}

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') usage(0);
  getDb();

  if (command === 'create') {
    const parsed = parseCreateArgs(args);
    const expiresAt = parseExpiration(parsed.exp);
    const created = createApiKey(parsed.name, requireSecret(), { expiresAt });
    printJson({
      success: true,
      name: created.record.name,
      id: created.record.id,
      token_id: created.record.token_id,
      expires_at: created.record.expires_at,
      token: created.token,
    });
    return;
  }

  if (command === 'list') {
    let includeAll = false;
    for (const arg of args) {
      if (arg === '--all') {
        includeAll = true;
      } else {
        throw new Error(`unknown option: ${arg}`);
      }
    }
    printJson({
      success: true,
      keys: listApiKeys({ includeAll }).map((key) => ({
        id: key.id,
        name: key.name,
        token_id: key.token_id,
        created_at: key.created_at,
        expires_at: key.expires_at,
        revoked_at: key.revoked_at,
      })),
    });
    return;
  }

  if (command === 'revoke') {
    if (args.length !== 1) usage(1);
    const revoked = revokeApiKey(args[0]);
    printJson({ success: true, name: args[0], revoked });
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main()
  .catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });

