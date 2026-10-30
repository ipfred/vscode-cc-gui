// Real end-to-end smoke test against the local Droid CLI via @factory/droid-sdk.
//
// Requires a logged-in `droid` CLI and the SDK installed where the extension
// installs it (~/.codemoss/dependencies/droid-sdk). Runs in a throwaway
// workspace and answers permission prompts automatically.
//
// Usage: node scripts/droid-smoke.mjs [--keep]   (--keep leaves sessions in history)
import { mkdtempSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const keep = process.argv.includes('--keep');
const STEP_TIMEOUT_MS = 240_000;

// permission-ipc reads its directory at import time.
const permissionDir = mkdtempSync(join(tmpdir(), 'droid-smoke-perm-'));
process.env.CLAUDE_PERMISSION_DIR = permissionDir;
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'droid-smoke-ws-')));
writeFileSync(join(workspace, 'notes.txt'), 'The secret word is PAPAYA.\n');

const service = await import('../services/droid/persistent-droid-service.js');
const models = await import('../services/droid/models-service.js');
const history = await import('../services/droid/history-service.js');

const origLog = console.log.bind(console);
let captured = [];
console.log = (...args) => { captured.push(args.join(' ')); };
const report = (...args) => origLog('[SMOKE]', ...args);

const permissionRequests = [];
const responder = setInterval(() => {
  let files = [];
  try { files = readdirSync(permissionDir); } catch { return; }
  for (const file of files) {
    const match = /^request-(.+)-([0-9a-f-]{36})\.json$/.exec(file);
    if (!match) continue;
    const requestFile = join(permissionDir, file);
    try {
      const request = JSON.parse(readFileSync(requestFile, 'utf8'));
      permissionRequests.push(request.toolName);
      rmSync(requestFile, { force: true });
      writeFileSync(join(permissionDir, `response-${match[1]}-${match[2]}.json`), JSON.stringify({ allow: true }));
    } catch {
      // partially written; retry next tick
    }
  }
}, 50);

const markers = (prefix) => captured.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length).trim());
const content = () => markers('[CONTENT_DELTA]').map((t) => JSON.parse(t)).join('');
const lastSessionId = () => markers('[SESSION_ID]').pop();
const lastSettings = () => {
  const raw = markers('[DROID_SETTINGS]').pop();
  return raw ? JSON.parse(raw) : null;
};
function histogram() {
  const kinds = {};
  for (const line of captured) {
    const m = /^\[([A-Z_]+)\]/.exec(line);
    const kind = m ? m[1] : (line.startsWith('{') ? 'JSON' : 'OTHER');
    kinds[kind] = (kinds[kind] || 0) + 1;
  }
  return kinds;
}

const results = [];
async function step(name, fn) {
  captured = [];
  const started = Date.now();
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        void service.abortCurrentTurn();
        reject(new Error(`timed out after ${STEP_TIMEOUT_MS / 1000}s`));
      }, STEP_TIMEOUT_MS);
    });
    const detail = await Promise.race([fn(), timeout]);
    results.push({ name, ok: true });
    report(`PASS ${name} (${Date.now() - started}ms)${detail ? ` - ${detail}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false });
    report(`FAIL ${name} (${Date.now() - started}ms) - ${err?.message || err}`);
    report('  markers:', JSON.stringify(histogram()));
    const errors = markers('[SEND_ERROR]');
    if (errors.length) report('  errors:', errors.join(' | '));
  } finally {
    clearTimeout(timer);
  }
}
function check(condition, message) {
  if (!condition) throw new Error(message);
}

const base = { cwd: workspace, permissionMode: 'default', reasoningEffort: '' };
const sessionIds = new Set();
let sessionId = '';
let catalog = [];
let currentModel = '';

await step('list models (with multipliers)', async () => {
  const payload = await models.listModels({ cwd: workspace, force: true });
  check(payload.success, payload.error || 'listModels failed');
  catalog = payload.models;
  check(catalog.length > 0, 'empty catalog');
  const groups = [...new Set(catalog.map((m) => m.group))];
  const priced = catalog.filter((m) => m.multiplier != null);
  check(priced.length > 0, 'no model carries a multiplier');
  const sample = priced.slice(0, 3).map((m) => `${m.shortLabel} · ${models.formatMultiplier(m.multiplier)}`).join(', ');
  return `${catalog.length} models, ${catalog.filter((m) => m.disabled).length} disabled, groups=${groups.join('/')}, default=${payload.defaultModel}; ${sample}`;
});

await step('chat turn', async () => {
  const result = await service.sendMessagePersistent({ ...base, message: 'Reply with exactly the word PONG and nothing else.' });
  check(result.success, result.error || 'turn failed');
  sessionId = result.sessionId;
  sessionIds.add(sessionId);
  currentModel = lastSettings()?.modelId || '';
  check(/PONG/.test(content()), `unexpected reply: ${JSON.stringify(content())}`);
  check(markers('[USAGE]').length > 0, 'no usage marker');
  return `session=${sessionId} reply=${JSON.stringify(content().trim())}`;
});

await step('tool call with approval (Auto Off)', async () => {
  const before = permissionRequests.length;
  const result = await service.sendMessagePersistent({
    ...base,
    sessionId,
    message: 'Create a file named smoke.txt in the current directory containing exactly: hello droid. Then reply DONE.',
  });
  check(result.success, result.error || 'turn failed');
  const file = join(workspace, 'smoke.txt');
  check(existsSync(file), 'smoke.txt was not created');
  check(readFileSync(file, 'utf8').includes('hello droid'), 'smoke.txt has the wrong content');
  const toolMessages = markers('[MESSAGE]').filter((m) => m.includes('"tool_use"') || m.includes('"tool_result"'));
  check(toolMessages.length >= 2, 'no tool_use/tool_result markers');
  const asked = permissionRequests.slice(before);
  check(asked.length > 0, 'no permission prompt was raised');
  return `permission prompts: ${asked.join(', ')}`;
});

await step('live model switch', async () => {
  const current = currentModel;
  const target = catalog
    .filter((m) => !m.disabled && !m.isCustom && m.group !== 'Auto' && m.id !== current && m.multiplier != null)
    .sort((a, b) => a.multiplier - b.multiplier)[0];
  check(target, 'no alternative enabled model');
  const result = await service.setModelPersistent({ sessionId, model: target.id });
  check(result.applied, result.error || 'model switch not applied');
  const settings = lastSettings();
  check(settings?.modelId === target.id, `settings report ${settings?.modelId}`);
  const turn = await service.sendMessagePersistent({ ...base, sessionId, model: target.id, message: 'Reply with exactly OK.' });
  check(turn.success, turn.error || 'turn on the new model failed');
  return `${current || '?'} -> ${target.id} (${models.formatMultiplier(target.multiplier)})`;
});

await step('/compact', async () => {
  await service.runCommandPersistent({ command: 'compact', sessionId, cwd: workspace });
  const next = lastSessionId();
  check(next, 'no session id reported');
  check(/compacted/i.test(content()), `unexpected output: ${content()}`);
  const moved = next !== sessionId;
  sessionId = next;
  sessionIds.add(sessionId);
  return moved ? `continues in ${sessionId}` : `compacted in place: ${JSON.stringify(content().trim())}`;
});

await step('resume after runtime restart', async () => {
  await service.shutdownPersistentRuntimes();
  const result = await service.sendMessagePersistent({
    ...base,
    sessionId,
    message: 'Which file did you create earlier in this conversation? Reply with just the file name.',
  });
  check(result.success, result.error || 'resumed turn failed');
  check(result.sessionId === sessionId, `resumed into ${result.sessionId}`);
  check(/smoke\.txt/.test(content()), `reply lost context: ${JSON.stringify(content())}`);
  return JSON.stringify(content().trim());
});

await step('history', async () => {
  const listing = history.listSessions(workspace);
  const ids = listing.sessions.map((s) => s.sessionId);
  check(ids.includes(sessionId), 'current session missing from history');
  const messages = history.getSessionMessages(sessionId, workspace);
  check(messages.length > 0, 'history transcript is empty');
  return `${listing.sessionCount} sessions, ${messages.length} messages in current`;
});

await service.shutdownPersistentRuntimes();
clearInterval(responder);
if (!keep) {
  for (const id of sessionIds) history.deleteSession(id, workspace);
  rmSync(workspace, { recursive: true, force: true });
}
rmSync(permissionDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
report(`${results.length - failed.length}/${results.length} steps passed${keep ? `; workspace kept at ${workspace}` : ''}`);
process.exit(failed.length ? 1 : 0);
