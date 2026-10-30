import test from 'node:test';
import assert from 'node:assert/strict';
import { mapDroidToolUse, parseDroidQuestionnaire, parseDroidTodos, stringifyDroidToolResult } from './droid-tool-mapping.js';

test('Droid tool names map to the Claude tool cards', () => {
  assert.deepEqual(mapDroidToolUse('Create', { file_path: '/a', content: 'x' }), { name: 'Write', input: { file_path: '/a', content: 'x' } });
  assert.deepEqual(mapDroidToolUse('Execute', { command: 'sleep 1', summary: 'Wait', timeout: 5, fireAndForget: true }), {
    name: 'Bash',
    input: { command: 'sleep 1', description: 'Wait', timeout: 5000, run_in_background: true },
  });
  assert.deepEqual(mapDroidToolUse('Edit', { file_path: '/a', old_str: 'x', new_str: 'y', change_all: true }), {
    name: 'Edit',
    input: { file_path: '/a', old_string: 'x', new_string: 'y', replace_all: true },
  });
  assert.deepEqual(mapDroidToolUse('Glob', { patterns: ['*.js', '*.ts'], folder: '/src' }), { name: 'Glob', input: { pattern: '*.js, *.ts', path: '/src' } });
  assert.equal(mapDroidToolUse('ExitSpecMode', { plan: 'Do it' }).name, 'ExitPlanMode');
  assert.deepEqual(mapDroidToolUse('mcp__server__tool', { a: 1 }), { name: 'mcp__server__tool', input: { a: 1 } });
});

test('TodoWrite text becomes a todo list', () => {
  assert.deepEqual(parseDroidTodos('1. [completed] Read a\n2. [in_progress] Edit b\n3. [cancelled] Skip c\nnoise'), [
    { content: 'Read a', status: 'completed', activeForm: 'Read a' },
    { content: 'Edit b', status: 'in_progress', activeForm: 'Edit b' },
    { content: 'Skip c', status: 'completed', activeForm: 'Skip c' },
  ]);
});

test('AskUser questionnaire becomes AskUserQuestion questions', () => {
  const questions = parseDroidQuestionnaire('1. [question] Pick colors (multi)\n[topic] Colors\n[option] Red\n[option] Blue\n2. [question] Size?\n[option] S');
  assert.deepEqual(questions, [
    { question: 'Pick colors', header: 'Colors', options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }], multiSelect: true },
    { question: 'Size?', header: '', options: [{ label: 'S', description: '' }], multiSelect: false },
  ]);
});

test('tool results flatten to display text', () => {
  assert.equal(stringifyDroidToolResult('{"success":false,"file_path":"/a","error":"No match"}'), 'No match');
  assert.equal(stringifyDroidToolResult([{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }]), 'one\ntwo');
  assert.equal(stringifyDroidToolResult('raw', 'model text'), 'model text');
  assert.equal(stringifyDroidToolResult(null), '');
});
