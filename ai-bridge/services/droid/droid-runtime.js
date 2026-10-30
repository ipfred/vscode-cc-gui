/**
 * Droid SDK runtime helpers shared by the persistent service and one-shot
 * channel commands.
 *
 * The SDK's default transport injects FACTORY_API_KEY and throws when it is
 * missing. Passing our own ProcessTransport skips that check, so the spawned
 * `droid exec --input-format stream-jsonrpc` authenticates with the CLI's own
 * login (keychain / ~/.factory auth) and bills the user's subscription.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadDroidSdk } from '../../utils/sdk-loader.js';
import { resolveDroidCliPath } from '../../utils/cli-path.js';

export function resolveDroidExecPath(explicit) {
  const candidate = typeof explicit === 'string' ? explicit.trim() : '';
  if (candidate && existsSync(candidate)) return candidate;
  return resolveDroidCliPath();
}

/**
 * Start a droid process transport rooted at `cwd`.
 * @returns {Promise<{sdk: object, transport: object, execPath: string}>}
 */
export async function createDroidTransport({ cwd, execPath } = {}) {
  const sdk = await loadDroidSdk();
  const resolvedExecPath = resolveDroidExecPath(execPath);
  const transport = new sdk.ProcessTransport({
    droidExecPath: resolvedExecPath,
    cwd: cwd || process.cwd(),
    env: { FACTORY_UPSTREAM_CLIENT_TYPE: 'sdk' },
  });
  await transport.connect();
  return { sdk, transport, execPath: resolvedExecPath };
}

/** Droid CLI user settings (~/.factory/settings.json); {} when unreadable. */
export function readDroidUserSettings() {
  try {
    const raw = readFileSync(join(homedir(), '.factory', 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** The model a fresh CLI session starts with. */
export function readDefaultDroidModelId() {
  const settings = readDroidUserSettings();
  const model = settings?.sessionDefaultSettings?.model ?? settings?.model;
  return typeof model === 'string' && model.trim() ? model.trim() : '';
}
