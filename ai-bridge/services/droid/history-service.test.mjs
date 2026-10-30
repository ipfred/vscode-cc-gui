import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteSession,
  findSessionFile,
  getSessionMessages,
  listSessions,
  listUserPrompts,
  parseSessionLines,
  sessionDirSlug,
} from './history-service.js';

const CWD = '/Users/dev/project';

function line(obj) {
  return JSON.stringify(obj);
}

const TRANSCRIPT = [
  line({ type: 'session_start', id: 's1', title: 'Fix the bug', cwd: CWD }),
  line({ type: 'message', id: 'm1', timestamp: '2026-01-01T10:00:00.000Z', message: { role: 'user', content: [
    { type: 'text', text: '<system-reminder>hidden context</system-reminder>' },
    { type: 'text', text: 'Please fix a.txt' },
  ] } }),
  line({ type: 'message', id: 'context-1', message: { role: 'user', content: [{ type: 'text', text: 'injected' }] } }),
  line({ type: 'message', id: 'm2', message: { role: 'user', visibility: 'llm_only', content: [{ type: 'text', text: 'llm only' }] } }),
  line({ type: 'message', id: 'm3', timestamp: '2026-01-01T10:00:05.000Z', message: { role: 'assistant', modelId: 'claude-opus-5-5', content: [
    { type: 'thinking', thinking: 'Look at the file' },
    { type: 'text', text: 'Editing now.' },
    { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/p/a.txt', old_str: 'a', new_str: 'b' } },
    { type: 'tool_use', id: 't2', name: 'Execute', input: { command: 'ls', summary: 'List files', riskLevel: 'low' } },
  ] } }),
  line({ type: 'message', id: 'm4', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't1', content: '{"success":true,"file_path":"/p/a.txt","linesAdded":1,"linesRemoved":1}' },
    { type: 'tool_result', tool_use_id: 't2', content: 'a.txt', is_error: false },
  ] } }),
  'not json',
  line({ type: 'message', id: 'm5', message: { role: 'user', content: [{ type: 'text', text: 'Now add tests' }] } }),
];

test('session dir slug mirrors the CLI layout', () => {
  assert.equal(sessionDirSlug('/Users/dev/project', 'darwin'), '-Users-dev-project');
  assert.equal(sessionDirSlug('/Users/dev/project/', 'darwin'), '-Users-dev-project');
});

test('transcript parsing hides system context and maps Droid tools', () => {
  const messages = parseSessionLines(TRANSCRIPT.slice(1));
  assert.deepEqual(messages.map((m) => m.uuid), ['m1', 'm3', 'm4', 'm5']);

  const [first, assistant, results] = messages;
  assert.deepEqual(first.message.content, [{ type: 'text', text: 'Please fix a.txt' }]);

  assert.equal(assistant.type, 'assistant');
  assert.equal(assistant.message.model, 'claude-opus-5-5');
  const [thinking, text, edit, bash] = assistant.message.content;
  assert.deepEqual(thinking, { type: 'thinking', thinking: 'Look at the file' });
  assert.equal(text.text, 'Editing now.');
  assert.deepEqual(edit, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/p/a.txt', old_string: 'a', new_string: 'b' } });
  assert.equal(bash.name, 'Bash');
  assert.equal(bash.input.command, 'ls');
  assert.equal(bash.input.description, 'List files');

  assert.equal(results.message.content[0].content, 'Updated /p/a.txt (+1 -1)');
  assert.equal(results.message.content[1].content, 'a.txt');
});

function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'droid-history-'));
  try {
    const projectDir = join(root, sessionDirSlug(CWD));
    mkdirSync(projectDir, { recursive: true });
    return fn(root, projectDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('listSessions summarizes transcripts and skips archived or empty ones', () => {
  withStore((root, dir) => {
    writeFileSync(join(dir, 's1.jsonl'), TRANSCRIPT.join('\n'));
    writeFileSync(join(dir, 's1.settings.json'), JSON.stringify({ model: 'claude-opus-5-5' }));
    writeFileSync(join(dir, 's2.jsonl'), [TRANSCRIPT[0], TRANSCRIPT[1]].join('\n'));
    writeFileSync(join(dir, 's2.settings.json'), JSON.stringify({ archivedAt: 1 }));
    writeFileSync(join(dir, 's3.jsonl'), TRANSCRIPT[0]);

    const result = listSessions(CWD, root);
    assert.equal(result.success, true);
    assert.equal(result.sessionCount, 1);
    const [session] = result.sessions;
    assert.equal(session.sessionId, 's1');
    assert.equal(session.title, 'Fix the bug');
    assert.equal(session.messageCount, 4);
    assert.equal(session.model, 'claude-opus-5-5');
    assert.equal(session.provider, 'droid');
  });
});

test('session lookup, rewind prompts and delete work across project dirs', () => {
  withStore((root, dir) => {
    writeFileSync(join(dir, 's1.jsonl'), TRANSCRIPT.join('\n'));
    writeFileSync(join(dir, 's1.settings.json'), '{}');

    assert.equal(findSessionFile('s1', '/elsewhere', root), join(dir, 's1.jsonl'));
    assert.equal(findSessionFile('../s1', CWD, root), null);
    assert.equal(getSessionMessages('s1', CWD, root).length, 4);

    const prompts = listUserPrompts('s1', CWD, root);
    assert.deepEqual(prompts.map((p) => [p.messageId, p.text]), [['m1', 'Please fix a.txt'], ['m5', 'Now add tests']]);

    assert.deepEqual(deleteSession('s1', CWD, root), { success: true });
    assert.equal(existsSync(join(dir, 's1.jsonl')), false);
    assert.equal(existsSync(join(dir, 's1.settings.json')), false);
    assert.equal(deleteSession('s1', CWD, root).success, false);
  });
});
