/**
 * Droid session history read straight from the CLI's session store.
 *
 * Layout (same as the CLI / SDK listSessions):
 *   ~/.factory/sessions/<cwd-slug>/<sessionId>.jsonl          session transcript
 *   ~/.factory/sessions/<cwd-slug>/<sessionId>.settings.json  model / mode / usage
 * Line 1 is a `session_start` record; transcript entries are `message` lines
 * holding Anthropic-style content blocks with Droid tool names.
 *
 * No SDK or CLI process is needed, so history works even before the SDK is
 * installed.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mapDroidToolUse, stringifyDroidToolResult } from './droid-tool-mapping.js';

const SESSION_EXT = '.jsonl';
const SETTINGS_SUFFIX = '.settings.json';
const SYSTEM_REMINDER_PREFIX = '<system-reminder>';

export function getDroidSessionsDir() {
  return join(homedir(), '.factory', 'sessions');
}

/** Mirror of the CLI's sanitizePathToDirectoryName. */
export function sessionDirSlug(cwd, platform = process.platform) {
  let canonical = resolve(cwd);
  try {
    canonical = realpathSync(canonical);
  } catch {
    // keep the resolved path
  }
  const normalized = canonical.replace(/[\\/]+$/, '');
  if (platform === 'win32') {
    return `-${normalized.replace(/^([A-Z]):/i, '$1').replace(/[\\/]+/g, '-')}`;
  }
  return `-${normalized.replace(/^\/+/, '').replace(/\/+/g, '-')}`;
}

function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readLines(file) {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim());
  } catch {
    return [];
  }
}

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Locate `<sessionId>.jsonl`: the cwd's slug dir first, then every project dir. */
export function findSessionFile(sessionId, cwd, sessionsDir = getDroidSessionsDir()) {
  if (!sessionId || /[\\/]/.test(sessionId)) return null;
  const fileName = `${sessionId}${SESSION_EXT}`;
  if (cwd) {
    const direct = join(sessionsDir, sessionDirSlug(cwd), fileName);
    if (existsSync(direct)) return direct;
  }
  let entries = [];
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const legacy = join(sessionsDir, fileName);
  if (existsSync(legacy)) return legacy;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(sessionsDir, entry.name, fileName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function isVisibleUserText(text) {
  return typeof text === 'string' && text.trim() && !text.trimStart().startsWith(SYSTEM_REMINDER_PREFIX);
}

/** Map one transcript `message` record's content into Claude-shaped blocks. */
export function mapContentBlocks(role, content) {
  const blocks = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text':
        if (role === 'assistant' ? Boolean(block.text) : isVisibleUserText(block.text)) {
          blocks.push({ type: 'text', text: String(block.text) });
        }
        break;
      case 'thinking':
        if (typeof block.thinking === 'string' && block.thinking) {
          blocks.push({ type: 'thinking', thinking: block.thinking });
        }
        break;
      case 'image':
        if (block.source) blocks.push({ type: 'image', source: block.source });
        break;
      case 'tool_use': {
        const mapped = mapDroidToolUse(block.name, block.input);
        blocks.push({ type: 'tool_use', id: block.id, name: mapped.name, input: mapped.input });
        break;
      }
      case 'tool_result':
        blocks.push({
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: stringifyDroidToolResult(block.content, block.model_content),
          is_error: block.is_error === true,
        });
        break;
      default:
        break;
    }
  }
  return blocks;
}

/**
 * Parse a session transcript into the webview's Claude-shaped message list.
 * @param {string[]} lines raw jsonl lines
 */
export function parseSessionLines(lines) {
  const messages = [];
  for (const line of lines) {
    const record = safeJson(line);
    if (!record || record.type !== 'message' || !record.message) continue;
    const { role, content, visibility } = record.message;
    if (visibility === 'llm_only') continue;
    if (typeof record.id === 'string' && record.id.startsWith('context-')) continue;
    if (role !== 'user' && role !== 'assistant') continue;
    const blocks = mapContentBlocks(role, content);
    if (blocks.length === 0) continue;
    const type = role === 'assistant' ? 'assistant' : 'user';
    const message = { role, content: blocks };
    if (role === 'assistant' && record.message.modelId) message.model = record.message.modelId;
    messages.push({
      type,
      uuid: record.id,
      timestamp: record.timestamp,
      message,
    });
  }
  return messages;
}

function summarizeSession(file, sessionId) {
  const lines = readLines(file);
  if (lines.length === 0) return null;
  const start = safeJson(lines[0]);
  if (!start || start.type !== 'session_start') return null;

  const settingsFile = file.slice(0, -SESSION_EXT.length) + SETTINGS_SUFFIX;
  let settings = null;
  if (existsSync(settingsFile)) settings = safeJson(readFileSync(settingsFile, 'utf8'));
  if (settings?.archivedAt) return null;

  const messages = parseSessionLines(lines.slice(1));
  if (messages.length === 0) return null;

  let stats = null;
  try {
    stats = statSync(file);
  } catch {
    // ignore
  }
  const firstTimestamp = toMs(messages[0]?.timestamp) || (stats ? stats.birthtimeMs || stats.ctimeMs : 0);
  const lastTimestamp = (stats ? stats.mtimeMs : 0) || toMs(messages[messages.length - 1]?.timestamp);
  const firstUserText = messages
    .find((m) => m.type === 'user' && m.message.content.some((b) => b.type === 'text'))
    ?.message.content.find((b) => b.type === 'text')?.text;

  return {
    sessionId,
    title: start.title || (firstUserText ? firstUserText.slice(0, 80) : 'Untitled session'),
    messageCount: messages.length,
    lastTimestamp: Math.round(lastTimestamp),
    firstTimestamp: Math.round(firstTimestamp),
    cwd: start.cwd || '',
    fileSize: stats ? stats.size : 0,
    model: settings?.model || '',
    provider: 'droid',
  };
}

/** Sessions recorded for one working directory, newest first. */
export function listSessions(cwd, sessionsDir = getDroidSessionsDir()) {
  const dir = join(sessionsDir, sessionDirSlug(cwd || process.cwd()));
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(SESSION_EXT)) continue;
    const sessionId = entry.name.slice(0, -SESSION_EXT.length);
    const summary = summarizeSession(join(dir, entry.name), sessionId);
    if (summary) sessions.push(summary);
  }
  sessions.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  return {
    success: true,
    sessions,
    sessionCount: sessions.length,
    total: sessions.reduce((sum, s) => sum + s.messageCount, 0),
    provider: 'droid',
  };
}

export function getSessionMessages(sessionId, cwd, sessionsDir = getDroidSessionsDir()) {
  const file = findSessionFile(sessionId, cwd, sessionsDir);
  if (!file) return [];
  return parseSessionLines(readLines(file).slice(1));
}

/** Most recent user-visible prompts (for /rewind), newest last. */
export function listUserPrompts(sessionId, cwd, sessionsDir = getDroidSessionsDir()) {
  const file = findSessionFile(sessionId, cwd, sessionsDir);
  if (!file) return [];
  const prompts = [];
  for (const line of readLines(file).slice(1)) {
    const record = safeJson(line);
    if (!record || record.type !== 'message' || record.message?.role !== 'user') continue;
    if (record.message.visibility === 'llm_only' || String(record.id).startsWith('context-')) continue;
    const text = (Array.isArray(record.message.content) ? record.message.content : [])
      .filter((b) => b?.type === 'text' && isVisibleUserText(b.text))
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text) prompts.push({ messageId: record.id, text, timestamp: record.timestamp });
  }
  return prompts;
}

/** Delete the transcript and its settings sidecars. */
export function deleteSession(sessionId, cwd, sessionsDir = getDroidSessionsDir()) {
  const file = findSessionFile(sessionId, cwd, sessionsDir);
  if (!file) return { success: false, error: 'Session not found.' };
  const base = file.slice(0, -SESSION_EXT.length);
  for (const target of [file, `${base}${SETTINGS_SUFFIX}`, `${base}${SETTINGS_SUFFIX}.bak`]) {
    try {
      if (existsSync(target)) unlinkSync(target);
    } catch (err) {
      if (target === file) return { success: false, error: err.message };
    }
  }
  return { success: true };
}
