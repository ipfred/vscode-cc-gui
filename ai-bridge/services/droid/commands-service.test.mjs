import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDroidCommandList } from './commands-service.js';

test('custom commands and invocable skills merge without duplicates', () => {
  const list = buildDroidCommandList({
    commands: [
      { name: 'verify', description: 'Run the checks\nsecond line' },
      { name: '/deploy', description: 'Ship it' },
      null,
      { name: '  ' },
    ],
    skills: [
      { name: 'review', description: 'Review code', enabled: true },
      { name: 'verify', description: 'duplicate of the command' },
      { name: 'hidden', description: 'disabled', enabled: false },
      { name: 'internal', description: 'not invocable', userInvocable: false },
    ],
  });
  assert.deepEqual(list, [
    { name: '/verify', description: 'Run the checks', source: 'droid-command' },
    { name: '/deploy', description: 'Ship it', source: 'droid-command' },
    { name: '/review', description: 'Review code', source: 'droid-skill' },
  ]);
});

test('missing sources produce an empty list', () => {
  assert.deepEqual(buildDroidCommandList(), []);
  assert.deepEqual(buildDroidCommandList({ commands: 'bad', skills: null }), []);
});
