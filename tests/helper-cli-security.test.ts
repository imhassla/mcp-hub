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

    expect(wakeHydrate).toContain('Usage: hub-wake-hydrate.mjs --agent-id ID [options]');
    expect(eventsClient).toContain('Usage: hub-events-client.mjs --agent-id ID [options]');
    expect(wakeHydrate).not.toContain('Usage: hub-wake-hydrate.mjs --agent-id ID --token');
    expect(eventsClient).not.toContain('Usage: hub-events-client.mjs --agent-id ID --auth-token');

    for (const source of [wakeHydrate, eventsClient]) {
      expect(source).toContain('HUB_AUTH_TOKEN');
      expect(source).toContain('--token-file PATH');
      expect(source).toContain('ps/process listings');
    }
  });
});
