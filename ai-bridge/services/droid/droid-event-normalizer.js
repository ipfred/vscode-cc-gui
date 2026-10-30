/**
 * Droid SDK stream events → CC GUI marker vocabulary.
 *
 * Consumes `session.stream(prompt, {includePartialMessages: true})` events and
 * emits the markers the extension bridge parses:
 *   [MESSAGE_START] [STREAM_START] [MODEL] [CONTENT_DELTA] [THINKING_DELTA]
 *   [BLOCK_RESET] [MESSAGE] (Claude-shaped tool_use / tool_result) [USAGE]
 *   [DROID_SETTINGS] [STREAM_END] [MESSAGE_END] [SEND_ERROR]
 */

import { mapDroidToolUse, stringifyDroidToolResult } from './droid-tool-mapping.js';
import { settingsToUiPayload } from './droid-modes.js';

export function tokenUsageToSnake(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const out = {
    input_tokens: Number(usage.inputTokens) || 0,
    output_tokens: Number(usage.outputTokens) || 0,
    cache_read_input_tokens: Number(usage.cacheReadTokens) || 0,
    cache_creation_input_tokens: Number(usage.cacheCreationTokens) || 0,
  };
  if (typeof usage.thinkingTokens === 'number') out.thinking_tokens = usage.thinkingTokens;
  if (typeof usage.factoryCredits === 'number') out.factory_credits = usage.factoryCredits;
  return out;
}

export class DroidEventNormalizer {
  /**
   * @param {(line: string) => void} emit stdout marker sink
   * @param {{sessionId?: string, modelId?: string}} [context]
   */
  constructor(emit, context = {}) {
    this.emit = emit;
    this.sessionId = context.sessionId || '';
    this.modelId = context.modelId || '';
    this.turnOpen = false;
    this.toolUses = new Map(); // toolUseId -> {name, emittedResult}
    this.deltaMessageIds = new Set();
    this.lastError = null;
    this.lastSettings = null;
  }

  begin() {
    if (this.turnOpen) return;
    this.turnOpen = true;
    this.emit('[MESSAGE_START]');
    this.emit('[STREAM_START]');
    if (this.modelId) this.emit(`[MODEL] ${this.modelId}`);
  }

  /**
   * @param {object} event one DroidStreamEvent
   * @returns {null | {status: 'success'|'interrupted'|'error', error?: string, usage?: object}}
   */
  handle(event) {
    if (!event || typeof event !== 'object') return null;
    switch (event.type) {
      case 'assistant_text_delta':
        if (event.messageId) this.deltaMessageIds.add(event.messageId);
        if (event.text) this.emit(`[CONTENT_DELTA] ${JSON.stringify(String(event.text))}`);
        return null;
      case 'thinking_text_delta':
        if (event.messageId) this.deltaMessageIds.add(event.messageId);
        if (event.text) this.emit(`[THINKING_DELTA] ${JSON.stringify(String(event.text))}`);
        return null;
      case 'thinking_text_complete':
        this.emit('[BLOCK_RESET]');
        return null;
      case 'assistant':
        this.#handleAssistantSnapshot(event);
        return null;
      case 'tool_call':
        this.#emitToolUse(event.toolUseId, event.name, event.input);
        return null;
      case 'tool_result':
        this.#emitToolResult(event.toolUseId, event.content, event.isError);
        return null;
      case 'settings_updated':
        this.emitSettings(event.settings);
        return null;
      case 'session_title_updated':
        if (this.sessionId && event.title) {
          this.emit(JSON.stringify({ type: 'daemon', event: 'title_generated', sessionId: this.sessionId, title: String(event.title) }));
        }
        return null;
      case 'error':
        this.lastError = event.message || 'Droid error';
        return null;
      case 'result':
        return this.#finish(event);
      default:
        return null;
    }
  }

  /** Emit a settings snapshot (deduplicated) for the webview's selectors. */
  emitSettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    const payload = settingsToUiPayload(settings);
    const key = JSON.stringify(payload);
    if (key === this.lastSettings) return;
    this.lastSettings = key;
    if (payload.modelId) this.modelId = payload.modelId;
    this.emit(`[DROID_SETTINGS] ${key}`);
  }

  /** Close the turn without an error (user interrupt, command output). */
  close(success) {
    this.#settleOpenTools(success);
    this.#closeStream();
  }

  /** Close the turn when the stream threw instead of yielding a result. */
  fail(message) {
    this.#settleOpenTools(false);
    this.emit(`[SEND_ERROR] ${JSON.stringify({ success: false, error: message || 'Droid turn failed' })}`);
    this.#closeStream();
  }

  #handleAssistantSnapshot(event) {
    const messageId = event.message?.id;
    if (messageId && this.deltaMessageIds.has(messageId)) return;
    // Snapshot without streamed deltas (non-partial providers): surface the text once.
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const block of content) {
      if (block?.type === 'text' && block.text) {
        this.emit(`[CONTENT_DELTA] ${JSON.stringify(String(block.text))}`);
      }
    }
  }

  #emitToolUse(toolUseId, name, input) {
    if (!toolUseId || this.toolUses.has(toolUseId)) return;
    const mapped = mapDroidToolUse(name, input);
    this.toolUses.set(toolUseId, { name: mapped.name, emittedResult: false });
    this.emit(`[MESSAGE] ${JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        ...(this.modelId ? { model: this.modelId } : {}),
        content: [{ type: 'tool_use', id: toolUseId, name: mapped.name, input: mapped.input }],
      },
    })}`);
    this.emit('[BLOCK_RESET]');
  }

  #emitToolResult(toolUseId, content, isError) {
    if (!toolUseId) return;
    const tool = this.toolUses.get(toolUseId);
    if (tool?.emittedResult) return;
    if (tool) tool.emittedResult = true;
    this.emit(`[MESSAGE] ${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: stringifyDroidToolResult(content),
          is_error: !!isError,
        }],
      },
    })}`);
  }

  #settleOpenTools(success) {
    for (const [id, tool] of this.toolUses) {
      if (!tool.emittedResult) {
        this.#emitToolResult(id, success ? 'ok' : 'cancelled', !success);
      }
    }
  }

  #finish(result) {
    const usage = tokenUsageToSnake(result.tokenUsage);
    if (usage) this.emit(`[USAGE] ${JSON.stringify(usage)}`);

    if (result.success) {
      this.#settleOpenTools(true);
      this.#closeStream();
      return { status: 'success', usage };
    }
    if (result.interrupted) {
      this.#settleOpenTools(false);
      this.#closeStream();
      return { status: 'interrupted', usage };
    }
    const message = result.error?.message || this.lastError || `Droid turn ended: ${result.subtype || 'error'}`;
    this.fail(message);
    return { status: 'error', error: message, usage };
  }

  #closeStream() {
    if (!this.turnOpen) return;
    this.turnOpen = false;
    this.emit('[STREAM_END]');
    this.emit('[MESSAGE_END]');
  }
}
