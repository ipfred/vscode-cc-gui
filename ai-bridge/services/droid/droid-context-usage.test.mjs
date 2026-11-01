import test from 'node:test';
import assert from 'node:assert/strict';
import { contextStatsToPayload, createContextUsageReporter } from './droid-context-usage.js';

function fakeSession(initial) {
  const handlers = new Map();
  let stats = initial;
  let calls = 0;
  return {
    session: {
      async getContextStats() {
        calls += 1;
        if (stats instanceof Error) throw stats;
        return stats;
      },
      onNotification(callback, filter) {
        handlers.set(filter.type, callback);
        return () => handlers.delete(filter.type);
      },
    },
    setStats(next) { stats = next; },
    fire(type) { handlers.get(type)?.({}); },
    subscribed: () => [...handlers.keys()].sort(),
    calls: () => calls,
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('stats become a payload only when used and limit are usable', () => {
  assert.deepEqual(contextStatsToPayload({ used: 51234.4, limit: 200000, accuracy: 'exact' }), { used: 51234, limit: 200000, accuracy: 'exact' });
  assert.deepEqual(contextStatsToPayload({ used: 0, limit: 1000000 }), { used: 0, limit: 1000000 });
  assert.equal(contextStatsToPayload({ used: 5, limit: 0 }), null);
  assert.equal(contextStatsToPayload({ used: -1, limit: 10 }), null);
  assert.equal(contextStatsToPayload(null), null);
});

test('flush reports the current context stats', async () => {
  const fake = fakeSession({ used: 147964, limit: 1000000, accuracy: 'exact' });
  const lines = [];
  const reporter = createContextUsageReporter(fake.session, (l) => lines.push(l));
  await reporter.flush();
  reporter.stop();
  assert.deepEqual(lines, ['[CONTEXT_USAGE] {"used":147964,"limit":1000000,"accuracy":"exact"}']);
});

test('token usage changes re-read the stats, throttled and without repeats', async () => {
  const fake = fakeSession({ used: 100, limit: 200000 });
  const lines = [];
  const reporter = createContextUsageReporter(fake.session, (l) => lines.push(l), { throttleMs: 10 });
  assert.deepEqual(fake.subscribed(), ['session_compacted', 'session_token_usage_changed']);

  fake.fire('session_token_usage_changed');
  fake.fire('session_token_usage_changed');
  fake.fire('session_token_usage_changed');
  await wait(40);
  assert.equal(fake.calls(), 1);
  assert.equal(lines.length, 1);

  fake.fire('session_token_usage_changed');
  await wait(40);
  assert.equal(lines.length, 1, 'unchanged numbers are not re-sent');

  fake.setStats({ used: 5000, limit: 200000 });
  fake.fire('session_compacted');
  await wait(40);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes('"used":5000'));
  reporter.stop();
});

test('stop unsubscribes and silences pending reads', async () => {
  const fake = fakeSession({ used: 1, limit: 10 });
  const lines = [];
  const reporter = createContextUsageReporter(fake.session, (l) => lines.push(l), { throttleMs: 10 });
  fake.fire('session_token_usage_changed');
  reporter.stop();
  await wait(30);
  assert.deepEqual(fake.subscribed(), []);
  assert.equal(lines.length, 0);
});

test('a failing stats read is swallowed', async () => {
  const fake = fakeSession(new Error('boom'));
  const lines = [];
  const reporter = createContextUsageReporter(fake.session, (l) => lines.push(l));
  await reporter.flush();
  reporter.stop();
  assert.deepEqual(lines, []);
});
