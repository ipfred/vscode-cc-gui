import test from 'node:test';
import assert from 'node:assert/strict';
import { DroidEventNormalizer } from './droid-event-normalizer.js';

function collect(context = { sessionId: 's1', modelId: 'claude-opus-5-5' }) {
  const lines = [];
  const normalizer = new DroidEventNormalizer((line) => lines.push(line), context);
  normalizer.begin();
  return { lines, normalizer };
}

const messages = (lines) => lines
  .filter((l) => l.startsWith('[MESSAGE] '))
  .map((l) => JSON.parse(l.slice('[MESSAGE] '.length)));

const success = (tokenUsage = null) => ({ type: 'result', subtype: 'success', success: true, interrupted: false, tokenUsage, error: null });

test('streams text and thinking deltas inside one turn', () => {
  const { lines, normalizer } = collect();
  normalizer.handle({ type: 'thinking_text_delta', messageId: 'm1', blockIndex: 0, text: 'plan ' });
  normalizer.handle({ type: 'thinking_text_complete', messageId: 'm1', blockIndex: 0 });
  normalizer.handle({ type: 'assistant_text_delta', messageId: 'm1', blockIndex: 1, text: 'Hello' });
  normalizer.handle({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hello' }] }, text: 'Hello' });
  const outcome = normalizer.handle(success());

  assert.equal(outcome.status, 'success');
  assert.deepEqual(lines.slice(0, 3), ['[MESSAGE_START]', '[STREAM_START]', '[MODEL] claude-opus-5-5']);
  assert.ok(lines.includes('[THINKING_DELTA] "plan "'));
  assert.ok(lines.includes('[BLOCK_RESET]'));
  // The snapshot for an already-streamed message must not duplicate the text.
  assert.equal(lines.filter((l) => l === '[CONTENT_DELTA] "Hello"').length, 1);
  assert.deepEqual(lines.slice(-2), ['[STREAM_END]', '[MESSAGE_END]']);
});

test('assistant snapshot without deltas surfaces its text once', () => {
  const { lines, normalizer } = collect();
  normalizer.handle({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'red' }] }, text: 'red' });
  assert.ok(lines.includes('[CONTENT_DELTA] "red"'));
});

test('tool calls map to Claude tool cards and results pair by id', () => {
  const { lines, normalizer } = collect();
  normalizer.handle({ type: 'tool_call', name: 'Execute', toolUseId: 't1', input: { command: 'ls', summary: 'List files', riskLevel: 'low' } });
  normalizer.handle({ type: 'tool_call', name: 'Edit', toolUseId: 't2', input: { file_path: '/a.txt', old_str: 'world', new_str: 'droid' } });
  normalizer.handle({ type: 'tool_call', name: 'Create', toolUseId: 't3', input: { file_path: '/b.txt', content: 'hi' } });
  normalizer.handle({ type: 'tool_call', name: 'TodoWrite', toolUseId: 't4', input: { todos: '1. [completed] Read\n2. [in_progress] Edit' } });
  normalizer.handle({ type: 'tool_call', name: 'Execute', toolUseId: 't1', input: { command: 'ls' } });
  normalizer.handle({ type: 'tool_result', toolUseId: 't1', toolName: 'Execute', content: 'a.txt\n', isError: false });
  normalizer.handle({
    type: 'tool_result', toolUseId: 't2', toolName: 'Edit', isError: false,
    content: '{"success":true,"file_path":"/a.txt","linesAdded":1,"linesRemoved":1}',
  });
  normalizer.handle(success());

  const msgs = messages(lines);
  const uses = msgs.filter((m) => m.type === 'assistant').map((m) => m.message.content[0]);
  assert.equal(uses.length, 4, 'duplicate tool_call for t1 is ignored');
  assert.deepEqual(uses[0], { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls', description: 'List files', riskLevel: 'low' } });
  assert.deepEqual(uses[1].input, { file_path: '/a.txt', old_string: 'world', new_string: 'droid' });
  assert.equal(uses[1].name, 'Edit');
  assert.equal(uses[2].name, 'Write');
  assert.deepEqual(uses[3].input.todos, [
    { content: 'Read', status: 'completed', activeForm: 'Read' },
    { content: 'Edit', status: 'in_progress', activeForm: 'Edit' },
  ]);

  const results = msgs.filter((m) => m.type === 'user').map((m) => m.message.content[0]);
  assert.equal(results.find((r) => r.tool_use_id === 't1').content, 'a.txt\n');
  assert.equal(results.find((r) => r.tool_use_id === 't2').content, 'Updated /a.txt (+1 -1)');
  // Calls without a terminal result are settled at end of turn.
  assert.equal(results.find((r) => r.tool_use_id === 't3').is_error, false);
  assert.equal(results.length, 4);
});

test('usage is emitted in snake_case including Factory credits', () => {
  const { lines, normalizer } = collect();
  normalizer.handle(success({ inputTokens: 432, outputTokens: 1388, cacheCreationTokens: 8704, cacheReadTokens: 147964, thinkingTokens: 245, factoryCredits: 1494 }));
  const usage = JSON.parse(lines.find((l) => l.startsWith('[USAGE] ')).slice('[USAGE] '.length));
  assert.deepEqual(usage, {
    input_tokens: 432,
    output_tokens: 1388,
    cache_read_input_tokens: 147964,
    cache_creation_input_tokens: 8704,
    thinking_tokens: 245,
    factory_credits: 1494,
  });
});

test('error results emit SEND_ERROR and close the stream', () => {
  const { lines, normalizer } = collect();
  normalizer.handle({ type: 'error', message: 'rate limited', errorType: 'api', timestamp: '' });
  const outcome = normalizer.handle({ type: 'result', subtype: 'error_during_execution', success: false, interrupted: false, tokenUsage: null, error: null });
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.error, 'rate limited');
  const err = lines.find((l) => l.startsWith('[SEND_ERROR] '));
  assert.deepEqual(JSON.parse(err.slice('[SEND_ERROR] '.length)), { success: false, error: 'rate limited' });
  assert.deepEqual(lines.slice(-2), ['[STREAM_END]', '[MESSAGE_END]']);
});

test('interrupted results close quietly and cancel open tools', () => {
  const { lines, normalizer } = collect();
  normalizer.handle({ type: 'tool_call', name: 'Execute', toolUseId: 't9', input: { command: 'sleep 100' } });
  const outcome = normalizer.handle({ type: 'result', subtype: 'interrupted', success: false, interrupted: true, tokenUsage: null, error: null });
  assert.equal(outcome.status, 'interrupted');
  assert.equal(lines.some((l) => l.startsWith('[SEND_ERROR]')), false);
  const result = messages(lines).find((m) => m.type === 'user').message.content[0];
  assert.equal(result.is_error, true);
  assert.equal(lines.at(-1), '[MESSAGE_END]');
});

test('settings updates are pushed once per distinct state and track the model', () => {
  const { lines, normalizer } = collect();
  const settings = { modelId: 'gpt-6-luna', reasoningEffort: 'low', interactionMode: 'auto', autonomyLevel: 'medium' };
  normalizer.handle({ type: 'settings_updated', settings });
  normalizer.handle({ type: 'settings_updated', settings: { ...settings } });
  const pushed = lines.filter((l) => l.startsWith('[DROID_SETTINGS] '));
  assert.equal(pushed.length, 1);
  assert.deepEqual(JSON.parse(pushed[0].slice('[DROID_SETTINGS] '.length)), {
    modelId: 'gpt-6-luna', reasoningEffort: 'low', interactionMode: 'auto', autonomyLevel: 'medium', permissionMode: 'auto',
  });
  normalizer.handle({ type: 'tool_call', name: 'Read', toolUseId: 'r1', input: { file_path: '/x' } });
  assert.equal(messages(lines)[0].message.model, 'gpt-6-luna');
});

test('session titles become daemon title events', () => {
  const { lines, normalizer } = collect();
  normalizer.handle({ type: 'session_title_updated', title: 'Fix the build' });
  assert.ok(lines.includes(JSON.stringify({ type: 'daemon', event: 'title_generated', sessionId: 's1', title: 'Fix the build' })));
});

test('fail() reports stream errors once', () => {
  const { lines, normalizer } = collect();
  normalizer.fail('process exited');
  assert.equal(lines.filter((l) => l.startsWith('[SEND_ERROR]')).length, 1);
  assert.equal(lines.filter((l) => l === '[STREAM_END]').length, 1);
});
