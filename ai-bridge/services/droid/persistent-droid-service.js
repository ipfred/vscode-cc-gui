/**
 * Persistent Droid runtime service (daemon mode).
 *
 * One warm `DroidSession` (one `droid exec --input-format stream-jsonrpc`
 * child, spawned by @factory/droid-sdk) per CC GUI session. Turns stream via
 * `session.stream(prompt, {includePartialMessages: true})`; tool approvals,
 * Spec-plan approval and AskUser go through the plugin's permission IPC.
 *
 * Markers go to console.log so the daemon wraps each line into the
 * per-request NDJSON envelope.
 */

import { getRequestId, requestContext } from '../../utils/request-context.js';
import {
  requestAskUserQuestionAnswers,
  requestPermissionFromJava,
  requestPlanApproval,
} from '../../permission-ipc.js';
import { createDroidTransport, readDefaultDroidModelId } from './droid-runtime.js';
import { DroidEventNormalizer, tokenUsageToSnake } from './droid-event-normalizer.js';
import { permissionModeToDroid, settingsToUiPayload } from './droid-modes.js';
import { resolveDroidPermission, toAskUserResult, toDialogQuestions } from './droid-permissions.js';
import { findCachedModel, formatMultiplier, getRawCatalog, mapModelCatalog, resolveReasoningEffort } from './models-service.js';
import { deleteSession as deleteSessionFiles, listUserPrompts } from './history-service.js';
import { buildDroidCommandList } from './commands-service.js';

const MAX_LIVE_RUNTIMES = 6;
const MAX_WARM_RUNTIMES = 3;

// =============================================================================
// State
// =============================================================================

/** sessionId -> runtime {session, cwd, execPath, activeTurn, lastUsedAt, sessionUsage, pendingSettings} */
const runtimes = new Map();
/** runtimeSessionEpoch (webview tab) -> Promise<runtime> created by preconnect, not yet bound to a turn. */
const warmRuntimes = new Map();
/** daemon request id -> turn {requestId, runtime, interrupted} */
const activeTurns = new Map();

// =============================================================================
// Runtime lifecycle
// =============================================================================

function cwdOf(params) {
  const cwd = typeof params?.cwd === 'string' ? params.cwd.trim() : '';
  return cwd || process.cwd();
}

function normalizedModel(model) {
  const id = typeof model === 'string' ? model.trim() : '';
  return id && id !== 'default' ? id : '';
}

/**
 * Run a permission/ask-user callback inside the owning turn's request context
 * so the permission IPC routes the dialog to the webview that started the turn
 * (the SDK invokes handlers from the transport's stdout listener, whose async
 * context belongs to whichever request spawned the process).
 */
function withTurnContext(runtime, fn) {
  const requestId = runtime.activeTurn?.requestId;
  if (!requestId) return fn(null);
  return requestContext.run({ id: requestId, doneSent: true }, () => fn(requestId));
}

function buildHandlers(runtime) {
  return {
    permissionHandler: (params) => withTurnContext(runtime, (requestId) => resolveDroidPermission(params, {
      requestPermission: (toolName, input) => requestPermissionFromJava(toolName, {
        ...input,
        ...(requestId ? { __bridgeRequestId: requestId } : {}),
      }),
      requestPlanApproval,
    })),
    askUserHandler: (params) => withTurnContext(runtime, async () => {
      const questions = Array.isArray(params?.questions) ? params.questions : [];
      const answers = await requestAskUserQuestionAnswers({ questions: toDialogQuestions(questions) });
      return toAskUserResult(questions, answers);
    }),
  };
}

async function openRuntime(params, sessionId = '') {
  const cwd = cwdOf(params);
  const { sdk, transport, execPath } = await createDroidTransport({ cwd, execPath: params.execPath });
  const runtime = {
    session: null,
    cwd,
    execPath,
    activeTurn: null,
    lastUsedAt: Date.now(),
    sessionUsage: null,
    pendingSettings: null,
  };
  const handlers = buildHandlers(runtime);
  try {
    if (sessionId) {
      runtime.session = await sdk.resumeSession(sessionId, { transport, ...handlers });
    } else {
      const mode = permissionModeToDroid(params.permissionMode);
      const modelId = normalizedModel(params.model);
      const createOptions = {
        transport,
        cwd,
        interactionMode: mode.interactionMode,
        autonomyLevel: mode.autonomyLevel || 'off',
        ...handlers,
      };
      if (modelId) createOptions.modelId = modelId;
      const effort = modelId ? resolveReasoningEffort(findCachedModel(modelId), params.reasoningEffort) : undefined;
      if (effort) createOptions.reasoningEffort = effort;
      runtime.session = await sdk.createSession(createOptions);
    }
  } catch (err) {
    try { await transport.close(); } catch { /* already closed */ }
    throw err;
  }
  return runtime;
}

async function closeRuntime(runtime, { discardEmpty = false } = {}) {
  if (!runtime?.session) return;
  const { session, cwd } = runtime;
  try {
    await session.close();
  } catch (err) {
    console.error(`[DROID] session close failed: ${err.message}`);
  }
  if (discardEmpty) {
    // Warm sessions never received a message; drop their empty transcript.
    deleteSessionFiles(session.id, cwd);
  }
}

function registerRuntime(runtime) {
  runtimes.set(runtime.session.id, runtime);
  if (runtimes.size <= MAX_LIVE_RUNTIMES) return;
  const idle = [...runtimes.values()]
    .filter((r) => !r.activeTurn && r !== runtime)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  const evict = idle[0];
  if (evict) {
    runtimes.delete(evict.session.id);
    void closeRuntime(evict);
  }
}

/** Re-key a runtime after compact / fork / rewind moved it to a successor session. */
function rebindRuntime(runtime, nextSession) {
  const oldId = runtime.session?.id;
  if (oldId) runtimes.delete(oldId);
  runtime.session = nextSession;
  runtime.sessionUsage = null;
  registerRuntime(runtime);
}

async function takeWarmRuntime(params) {
  const epoch = String(params.runtimeSessionEpoch || '').trim();
  if (!epoch || !warmRuntimes.has(epoch)) return null;
  const pending = warmRuntimes.get(epoch);
  warmRuntimes.delete(epoch);
  try {
    const runtime = await pending;
    if (runtime.cwd !== cwdOf(params)) {
      void closeRuntime(runtime, { discardEmpty: true });
      return null;
    }
    return runtime;
  } catch {
    return null;
  }
}

/**
 * Runtime for this request: the live one for params.sessionId, a resumed one,
 * a preconnected warm one, or a freshly created session.
 */
async function acquireRuntime(params) {
  const sessionId = String(params.sessionId || '').trim();
  if (sessionId) {
    const live = runtimes.get(sessionId);
    if (live) return live;
    const resumed = await openRuntime(params, sessionId);
    registerRuntime(resumed);
    return resumed;
  }
  const warm = await takeWarmRuntime(params);
  const runtime = warm || await openRuntime(params);
  registerRuntime(runtime);
  return runtime;
}

// =============================================================================
// Settings (model / reasoning / mode)
// =============================================================================

/**
 * Bring the live session in line with the requested model / reasoning / mode.
 * Takes effect on the next LLM call; no runtime restart.
 */
async function applySettings(runtime, { model, reasoningEffort, permissionMode } = {}) {
  const { session } = runtime;
  const current = session.settings || {};
  const update = {};

  const modelId = normalizedModel(model);
  const targetModel = modelId || current.modelId;
  if (modelId && modelId !== current.modelId) update.modelId = modelId;

  if (reasoningEffort !== undefined || update.modelId) {
    const catalogModel = findCachedModel(targetModel);
    const effort = catalogModel
      ? resolveReasoningEffort(catalogModel, reasoningEffort || current.reasoningEffort)
      : (String(reasoningEffort || '').trim().toLowerCase() || undefined);
    if (effort && effort !== current.reasoningEffort) update.reasoningEffort = effort;
  }

  let enterSpec = false;
  if (permissionMode !== undefined) {
    const mode = permissionModeToDroid(permissionMode);
    if (mode.interactionMode === 'spec') {
      enterSpec = current.interactionMode !== 'spec';
    } else {
      if (current.interactionMode === 'spec') update.interactionMode = 'auto';
      if (mode.autonomyLevel && mode.autonomyLevel !== current.autonomyLevel) update.autonomyLevel = mode.autonomyLevel;
    }
  }

  if (Object.keys(update).length > 0) {
    try {
      await session.updateSettings(update);
    } catch (err) {
      if (!update.reasoningEffort) throw err;
      // Reasoning levels are model-specific; retry without it so the model switch lands.
      console.error(`[DROID] updateSettings rejected reasoningEffort=${update.reasoningEffort}: ${err.message}`);
      const { reasoningEffort: _dropped, ...rest } = update;
      if (Object.keys(rest).length > 0) await session.updateSettings(rest);
    }
  }
  if (enterSpec) await session.enterSpecMode();
  return session.settings;
}

function emitSettings(settings) {
  console.log(`[DROID_SETTINGS] ${JSON.stringify(settingsToUiPayload(settings))}`);
}

// =============================================================================
// Turns
// =============================================================================

function mapImages(attachments) {
  if (!Array.isArray(attachments)) return undefined;
  const images = [];
  for (const att of attachments) {
    if (!att || typeof att.data !== 'string' || !att.data) continue;
    const mediaType = typeof att.mediaType === 'string' ? att.mediaType : 'image/png';
    if (!mediaType.startsWith('image/')) continue;
    images.push({ type: 'base64', data: att.data, mediaType });
  }
  return images.length > 0 ? images : undefined;
}

function addUsage(total, turn) {
  if (!turn) return total;
  const next = { ...(total || {}) };
  for (const [key, value] of Object.entries(turn)) {
    if (typeof value === 'number') next[key] = (next[key] || 0) + value;
  }
  return next;
}

/**
 * Send one prompt on the session's warm runtime, streaming markers to stdout.
 */
export async function sendMessagePersistent(params = {}) {
  const requestId = getRequestId();
  const message = String(params.message ?? params.text ?? params.prompt ?? '');

  let runtime;
  try {
    runtime = await acquireRuntime(params);
  } catch (err) {
    const error = err?.message || String(err);
    console.log(`[SEND_ERROR] ${JSON.stringify({ success: false, error })}`);
    const payload = { success: false, error };
    console.log(JSON.stringify(payload));
    return payload;
  }

  const { session } = runtime;
  const sessionId = session.id;
  runtime.lastUsedAt = Date.now();
  console.log(`[SESSION_ID] ${sessionId}`);

  if (runtime.activeTurn) {
    const error = 'Droid is still working on the previous message in this session.';
    console.log(`[SEND_ERROR] ${JSON.stringify({ success: false, error })}`);
    return { success: false, sessionId, error };
  }

  try {
    await applySettings(runtime, {
      model: params.model,
      reasoningEffort: params.reasoningEffort,
      permissionMode: params.permissionMode,
      ...(runtime.pendingSettings || {}),
    });
    runtime.pendingSettings = null;
  } catch (err) {
    console.error(`[DROID] applying settings failed: ${err.message}`);
  }

  const normalizer = new DroidEventNormalizer((line) => console.log(line), {
    sessionId,
    modelId: session.settings?.modelId,
  });
  normalizer.begin();
  normalizer.emitSettings(session.settings);

  const turn = { requestId, runtime, interrupted: false };
  runtime.activeTurn = turn;
  if (requestId) activeTurns.set(requestId, turn);

  // settings_updated arrives only as a session notification (e.g. the CLI
  // falling back to another model mid-turn), never as a stream event.
  let unsubscribeSettings = () => {};
  try {
    unsubscribeSettings = session.onNotification((notification) => {
      const update = notification?.params?.notification?.settings;
      if (update && typeof update === 'object') normalizer.emitSettings({ ...session.settings, ...update });
    }, { type: 'settings_updated' });
  } catch (err) {
    console.error(`[DROID] settings subscription failed: ${err.message}`);
  }

  let outcome = null;
  try {
    const images = mapImages(params.attachments);
    const stream = session.stream(message, { includePartialMessages: true, ...(images ? { images } : {}) });
    for await (const event of stream) {
      const settled = normalizer.handle(event);
      if (settled) outcome = settled;
    }
    if (!outcome) {
      if (turn.interrupted) normalizer.close(false);
      else normalizer.fail('Droid stream ended without a result');
      outcome = { status: turn.interrupted ? 'interrupted' : 'error' };
    }
  } catch (err) {
    if (turn.interrupted) {
      normalizer.close(false);
      outcome = { status: 'interrupted' };
    } else {
      const error = err?.message || String(err);
      normalizer.fail(error);
      outcome = { status: 'error', error };
    }
  } finally {
    unsubscribeSettings();
    runtime.activeTurn = null;
    runtime.lastUsedAt = Date.now();
    if (requestId) activeTurns.delete(requestId);
  }

  runtime.sessionUsage = addUsage(runtime.sessionUsage, outcome.usage);
  const success = outcome.status !== 'error';
  const payload = success
    ? { success: true, sessionId, result: outcome.status }
    : { success: false, sessionId, error: outcome.error || 'Droid turn failed' };
  console.log(JSON.stringify(payload));
  return payload;
}

/**
 * Interrupt in-flight turns. Scoped to the given daemon request ids
 * (multi-window stop); undefined interrupts every active turn.
 */
export async function abortCurrentTurn(targetRequestIds) {
  const targets = Array.isArray(targetRequestIds) ? targetRequestIds.map(String) : null;
  const pending = [];
  for (const [requestId, turn] of activeTurns) {
    if (targets && !targets.includes(requestId)) continue;
    turn.interrupted = true;
    pending.push(turn.runtime.session.interrupt().catch((err) => {
      console.error(`[DROID] interrupt failed: ${err.message}`);
    }));
  }
  await Promise.all(pending);
}

// =============================================================================
// Live settings
// =============================================================================

export async function setPermissionModePersistent(params = {}) {
  const sessionId = String(params.sessionId || '').trim();
  const permissionMode = params.permissionMode ?? params.mode;
  const runtime = sessionId ? runtimes.get(sessionId) : null;
  if (!runtime) return { applied: false };
  try {
    await applySettings(runtime, { permissionMode });
    return { applied: true };
  } catch (err) {
    runtime.pendingSettings = { ...(runtime.pendingSettings || {}), permissionMode };
    console.error(`[DROID] setPermissionMode failed: ${err.message}`);
    return { applied: false, error: err.message };
  }
}

export async function setModelPersistent(params = {}) {
  const sessionId = String(params.sessionId || '').trim();
  const runtime = sessionId ? runtimes.get(sessionId) : null;
  const requested = { model: params.model, reasoningEffort: params.reasoningEffort };
  if (!runtime) return { applied: false };
  if (runtime.activeTurn) {
    runtime.pendingSettings = { ...(runtime.pendingSettings || {}), ...requested };
    return { applied: false, deferred: true };
  }
  try {
    await getRawCatalog({ cwd: runtime.cwd, execPath: runtime.execPath }).catch(() => null);
    const settings = await applySettings(runtime, requested);
    emitSettings(settings);
    return { applied: true };
  } catch (err) {
    console.error(`[DROID] setModel failed: ${err.message}`);
    return { applied: false, error: err.message };
  }
}

// =============================================================================
// Lifecycle
// =============================================================================

export async function preconnectPersistent(params = {}) {
  const sessionId = String(params.sessionId || '').trim();
  if (sessionId) {
    if (!runtimes.has(sessionId)) {
      registerRuntime(await openRuntime(params, sessionId));
    }
    return { preconnected: true, sessionId };
  }
  const epoch = String(params.runtimeSessionEpoch || '').trim();
  if (!epoch || warmRuntimes.has(epoch)) return { preconnected: warmRuntimes.has(epoch) };
  if (warmRuntimes.size >= MAX_WARM_RUNTIMES) {
    const [oldestEpoch, oldest] = warmRuntimes.entries().next().value;
    warmRuntimes.delete(oldestEpoch);
    oldest.then((r) => closeRuntime(r, { discardEmpty: true })).catch(() => {});
  }
  const pending = openRuntime(params);
  pending.catch((err) => {
    console.error(`[DROID] preconnect failed: ${err.message}`);
    if (warmRuntimes.get(epoch) === pending) warmRuntimes.delete(epoch);
  });
  warmRuntimes.set(epoch, pending);
  // Refresh the model catalog in the background so reasoning validation is ready.
  getRawCatalog({ cwd: cwdOf(params), execPath: params.execPath }).catch(() => {});
  return { preconnected: true };
}

export async function resetRuntimePersistent(params = {}) {
  const sessionId = String(params.sessionId || '').trim();
  if (sessionId) {
    const runtime = runtimes.get(sessionId);
    runtimes.delete(sessionId);
    if (runtime) await closeRuntime(runtime);
    return { reset: true };
  }
  await shutdownPersistentRuntimes();
  return { reset: true };
}

export async function shutdownPersistentRuntimes() {
  await abortCurrentTurn(undefined);
  const live = [...runtimes.values()];
  runtimes.clear();
  const warm = [...warmRuntimes.values()];
  warmRuntimes.clear();
  await Promise.all([
    ...live.map((r) => closeRuntime(r)),
    ...warm.map((p) => p.then((r) => closeRuntime(r, { discardEmpty: true })).catch(() => {})),
  ]);
}

export function getRuntimeSnapshot() {
  return { runtimeCount: runtimes.size, warmCount: warmRuntimes.size, activeTurnCount: activeTurns.size };
}

// =============================================================================
// Usage
// =============================================================================

export async function getContextUsagePersistent(params = {}) {
  const sessionId = String(params.sessionId || '').trim();
  const runtime = sessionId ? runtimes.get(sessionId) : null;
  let used = Number(params.usedTokens) || 0;
  let max = Number(params.maxTokens) || 0;
  let accuracy = 'unknown';
  if (runtime) {
    try {
      const stats = await runtime.session.getContextStats();
      if (Number.isFinite(stats?.used)) used = stats.used;
      if (Number.isFinite(stats?.limit) && stats.limit > 0) max = stats.limit;
      accuracy = stats?.accuracy || accuracy;
    } catch (err) {
      console.error(`[DROID] getContextStats failed: ${err.message}`);
    }
  }
  if (!Number.isFinite(max) || max <= 0) max = 200_000;
  if (!Number.isFinite(used) || used < 0) used = 0;
  if (used > max) used = max;
  const free = Math.max(0, max - used);
  const percentage = Math.round((1000 * used) / max) / 10;
  const payload = {
    success: true,
    totalTokens: used,
    maxTokens: max,
    rawMaxTokens: max,
    percentage,
    model: runtime?.session.settings?.modelId || params.model || '',
    isAutoCompactEnabled: runtime?.session.settings?.compactionThresholdCheckEnabled !== false,
    source: `droid-session${accuracy === 'estimated' ? '-estimated' : ''}`,
    categories: [
      { name: 'Conversation', tokens: used, color: 'claude' },
      { name: 'Free space', tokens: free, color: 'inactive' },
    ],
    gridRows: [[
      { color: 'claude', isFilled: used > 0, categoryName: 'Conversation', tokens: used, percentage, squareFullness: used > 0 ? 1 : 0 },
      {
        color: 'inactive', isFilled: false, categoryName: 'Free space', tokens: free,
        percentage: Math.round((1000 * free) / max) / 10, squareFullness: free > 0 ? Math.min(1, free / max) : 0,
      },
    ]],
    memoryFiles: [],
    mcpTools: [],
    agents: [],
  };
  console.log(JSON.stringify(payload));
  return payload;
}

export async function getUsagePersistent(params = {}) {
  const sessionId = String(params.sessionId || '').trim();
  const usage = sessionId ? runtimes.get(sessionId)?.sessionUsage : null;
  const credits = usage?.factory_credits;
  const payload = {
    success: true,
    data: {
      unavailable: true,
      source: 'droid-session',
      tokenUsage: usage || null,
      factoryCredits: typeof credits === 'number' ? credits : null,
      message: typeof credits === 'number'
        ? `This session used ${credits.toLocaleString('en-US')} Factory credits. Plan usage is shown at app.factory.ai.`
        : 'Factory plan usage is shown at app.factory.ai.',
    },
  };
  console.log(JSON.stringify(payload));
  return payload;
}

// =============================================================================
// Slash commands
// =============================================================================

/**
 * Probe session for read-only listings when no runtime exists for this cwd.
 * Its empty transcript is deleted afterwards so it never shows up in history.
 */
async function withListingSession(params, fn) {
  const sessionId = String(params.sessionId || '').trim();
  const cwd = cwdOf(params);
  const live = (sessionId && runtimes.get(sessionId))
    || [...runtimes.values()].find((r) => r.cwd === cwd && !r.activeTurn);
  if (live) return fn(live.session);
  const probe = await openRuntime({ ...params, sessionId: '', permissionMode: 'default', model: '' });
  try {
    return await fn(probe.session);
  } finally {
    await closeRuntime(probe, { discardEmpty: true });
  }
}

export async function listCommandsPersistent(params = {}) {
  try {
    const result = await withListingSession(params, async (session) => {
      // DroidSession exposes listSkills; custom commands live on the client.
      const [commands, skills] = await Promise.all([
        session._client?.listCommands?.().then((r) => r?.result?.commands ?? r?.commands ?? []).catch(() => []) ?? [],
        session.listSkills().then((r) => r?.skills ?? []).catch(() => []),
      ]);
      return { commands, skills };
    });
    const list = buildDroidCommandList(result);
    console.log(`[DROID_COMMANDS] ${JSON.stringify(list)}`);
    return { success: true, commands: list };
  } catch (err) {
    console.error(`[DROID] listCommands failed: ${err.message}`);
    console.log(`[DROID_COMMANDS] ${JSON.stringify([])}`);
    return { success: false, error: err.message, commands: [] };
  }
}

function formatContextStats(stats, settings) {
  const used = Number(stats?.used) || 0;
  const limit = Number(stats?.limit) || 0;
  const pct = limit > 0 ? Math.round((1000 * used) / limit) / 10 : 0;
  const lines = [
    '**Context usage**',
    '',
    `- Model: \`${settings?.modelId || 'unknown'}\``,
    `- Used: ${used.toLocaleString('en-US')} tokens${limit ? ` of ${limit.toLocaleString('en-US')} (${pct}%)` : ''}`,
  ];
  if (Number.isFinite(stats?.remaining)) lines.push(`- Remaining: ${Number(stats.remaining).toLocaleString('en-US')} tokens`);
  if (stats?.accuracy) lines.push(`- Accuracy: ${stats.accuracy}`);
  return lines.join('\n');
}

function formatModelList(models, currentId) {
  const groups = new Map();
  for (const m of models) {
    if (!groups.has(m.group)) groups.set(m.group, []);
    groups.get(m.group).push(m);
  }
  const lines = ['**Available models** (use `/model <id>` to switch)', ''];
  for (const [group, list] of groups) {
    lines.push(`*${group}*`);
    for (const m of list) {
      const rate = m.isCustom ? 'BYOK' : (m.multiplier != null ? formatMultiplier(m.multiplier) : '');
      const flags = [m.id === currentId ? '← current' : '', m.disabled ? `disabled: ${m.disabledReason || 'unavailable'}` : '']
        .filter(Boolean).join(', ');
      lines.push(`- \`${m.id}\` ${m.label}${rate ? ` · ${rate}` : ''}${flags ? ` (${flags})` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

function formatMcpServers(result) {
  const servers = Array.isArray(result?.servers) ? result.servers : [];
  if (servers.length === 0) return 'No MCP servers are configured for Droid. Add them with `droid mcp add` or in ~/.factory/mcp.json.';
  const lines = ['**MCP servers**', ''];
  for (const s of servers) {
    const name = s.name || s.serverName || 'server';
    const status = s.status || (s.enabled === false ? 'disabled' : '');
    const tools = Array.isArray(s.tools) ? ` · ${s.tools.length} tools` : (typeof s.toolCount === 'number' ? ` · ${s.toolCount} tools` : '');
    lines.push(`- **${name}**${status ? ` — ${status}` : ''}${tools}`);
  }
  return lines.join('\n');
}

function formatSkills(result) {
  const skills = Array.isArray(result?.skills) ? result.skills : [];
  if (skills.length === 0) return 'No skills are installed for Droid.';
  const lines = ['**Skills** (invoke with `/<name>`)', ''];
  for (const s of skills) {
    const desc = String(s.description || '').split('\n')[0].slice(0, 140);
    lines.push(`- \`/${s.name}\`${s.enabled === false ? ' (disabled)' : ''}${desc ? ` — ${desc}` : ''}`);
  }
  return lines.join('\n');
}

/**
 * Plugin builtins that map to SDK calls instead of prompt text. Output streams
 * back as one assistant message so the chat UI renders it like a turn.
 */
export async function runCommandPersistent(params = {}) {
  const command = String(params.command || '').replace(/^\//, '').trim().toLowerCase();
  const args = String(params.args || '').trim();

  if (command === 'spec') {
    const runtime = await acquireRuntime(params);
    console.log(`[SESSION_ID] ${runtime.session.id}`);
    const settings = await applySettings(runtime, { permissionMode: 'plan' });
    emitSettings(settings);
    if (args) {
      return sendMessagePersistent({ ...params, sessionId: runtime.session.id, message: args, permissionMode: 'plan' });
    }
  }

  const normalizer = new DroidEventNormalizer((line) => console.log(line));
  normalizer.begin();
  const say = (text) => console.log(`[CONTENT_DELTA] ${JSON.stringify(text)}`);
  const sessionId = String(params.sessionId || '').trim();

  try {
    switch (command) {
      case 'spec':
        say('Spec mode is on. Describe what you want to build and Droid will plan it before making changes.');
        break;

      case 'compact': {
        if (!sessionId) { say('Nothing to compact yet.'); break; }
        const runtime = await acquireRuntime(params);
        const previousId = runtime.session.id;
        const { session: next, removedCount } = await runtime.session.compact(args ? { customInstructions: args } : {});
        rebindRuntime(runtime, next);
        console.log(`[SESSION_ID] ${next.id}`);
        say(next.id === previousId
          ? `Conversation compacted: ${removedCount} messages were summarized.`
          : `Conversation compacted: ${removedCount} messages were summarized. The conversation continues in a new session.`);
        break;
      }

      case 'context': {
        if (!sessionId) { say('No active Droid session yet. Send a message first.'); break; }
        const runtime = await acquireRuntime(params);
        const stats = await runtime.session.getContextStats();
        say(formatContextStats(stats, runtime.session.settings));
        break;
      }

      case 'model': {
        const raw = await getRawCatalog({ cwd: cwdOf(params), execPath: params.execPath });
        const { models } = mapModelCatalog(raw, readDefaultDroidModelId());
        if (!args) {
          const current = sessionId ? runtimes.get(sessionId)?.session.settings?.modelId : (normalizedModel(params.model) || readDefaultDroidModelId());
          say(formatModelList(models, current));
          break;
        }
        const target = models.find((m) => m.id === args || m.label.toLowerCase() === args.toLowerCase());
        if (!target) { say(`Unknown model \`${args}\`. Run \`/model\` to list available models.`); break; }
        if (target.disabled) { say(`${target.label} is not available: ${target.disabledReason || 'disabled'}.`); break; }
        const runtime = await acquireRuntime(params);
        console.log(`[SESSION_ID] ${runtime.session.id}`);
        const settings = await applySettings(runtime, { model: target.id, reasoningEffort: params.reasoningEffort });
        emitSettings(settings);
        say(`Model set to ${target.label}${target.isCustom ? ' (BYOK)' : (target.multiplier != null ? ` (${formatMultiplier(target.multiplier)})` : '')}.`);
        break;
      }

      case 'fork': {
        if (!sessionId) { say('Nothing to fork yet.'); break; }
        const runtime = await acquireRuntime(params);
        const next = await runtime.session.fork();
        rebindRuntime(runtime, next);
        console.log(`[SESSION_ID] ${next.id}`);
        say('Forked the conversation. New messages go to the fork; the original session is kept in history.');
        break;
      }

      case 'rewind': {
        if (!sessionId) { say('Nothing to rewind yet.'); break; }
        const runtime = await acquireRuntime(params);
        const prompts = listUserPrompts(runtime.session.id, runtime.cwd).reverse();
        const index = Number.parseInt(args, 10);
        if (!args || !Number.isFinite(index)) {
          if (prompts.length === 0) { say('There are no earlier messages to rewind to.'); break; }
          const lines = ['**Rewind to before one of these messages** (use `/rewind <n>`):', ''];
          prompts.slice(0, 15).forEach((p, i) => lines.push(`${i + 1}. ${p.text.replace(/\s+/g, ' ').slice(0, 100)}`));
          say(lines.join('\n'));
          break;
        }
        const target = prompts[index - 1];
        if (!target) { say(`No message #${index}. Run \`/rewind\` to list messages.`); break; }
        const info = await runtime.session.getRewindInfo({ messageId: target.messageId });
        const { session: next } = await runtime.session.rewind({
          messageId: target.messageId,
          filesToRestore: info.availableFiles || [],
          filesToDelete: info.createdFiles || [],
          forkTitle: `Rewind: ${target.text.slice(0, 40)}`,
        });
        rebindRuntime(runtime, next);
        console.log(`[SESSION_ID] ${next.id}`);
        console.log(`[DROID_RELOAD_SESSION] ${next.id}`);
        const restored = (info.availableFiles || []).length;
        const deleted = (info.createdFiles || []).length;
        say(`Rewound to before "${target.text.slice(0, 60)}". Restored ${restored} file(s), removed ${deleted} created file(s).`);
        break;
      }

      case 'mcp': {
        const result = await withListingSession(params, (session) => session.listMcpServers());
        say(formatMcpServers(result));
        break;
      }

      case 'skills': {
        const result = await withListingSession(params, (session) => session.listSkills());
        say(formatSkills(result));
        break;
      }

      default:
        say(`Unknown command /${command}.`);
    }
  } catch (err) {
    say(`/${command} failed: ${err?.message || err}`);
  }
  normalizer.close(true);
  return { success: true };
}

// =============================================================================
// Testing
// =============================================================================

export const __testing = {
  runtimes,
  warmRuntimes,
  activeTurns,
  applySettings,
  mapImages,
  addUsage,
  resetAll: () => {
    runtimes.clear();
    warmRuntimes.clear();
    activeTurns.clear();
  },
};

export { tokenUsageToSnake };
