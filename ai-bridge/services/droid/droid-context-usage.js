/**
 * Live context-window usage for a Droid session.
 *
 * The turn's final `tokenUsage` is a sum over every model call in the turn and
 * leaves out cache reads, so it cannot show how full the context is. The CLI
 * itself asks the session for its context stats; this does the same, and
 * re-asks whenever the session reports a token-usage change so the number
 * moves while the turn is still running.
 */

const TRIGGER_NOTIFICATIONS = ['session_token_usage_changed', 'session_compacted'];
const DEFAULT_THROTTLE_MS = 400;

/** `getContextStats()` result → the payload sent to the extension, or null when unusable. */
export function contextStatsToPayload(stats) {
  const used = Number(stats?.used);
  const limit = Number(stats?.limit);
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(limit) || limit <= 0) return null;
  return {
    used: Math.round(used),
    limit: Math.round(limit),
    ...(typeof stats.accuracy === 'string' ? { accuracy: stats.accuracy } : {}),
  };
}

/**
 * @param {object} session DroidSession (getContextStats, onNotification)
 * @param {(line: string) => void} emit
 * @param {{throttleMs?: number}} [options]
 */
export function createContextUsageReporter(session, emit, options = {}) {
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
  let timer = null;
  let running = null;
  let rerun = false;
  let stopped = false;
  let lastLine = '';
  const unsubscribers = [];

  const report = async () => {
    try {
      const payload = contextStatsToPayload(await session.getContextStats());
      if (!payload || stopped) return;
      const line = `[CONTEXT_USAGE] ${JSON.stringify(payload)}`;
      if (line === lastLine) return;
      lastLine = line;
      emit(line);
    } catch (err) {
      console.error(`[DROID] getContextStats failed: ${err?.message || err}`);
    }
  };

  const run = () => {
    if (running) {
      rerun = true;
      return running;
    }
    running = report().finally(() => {
      running = null;
      if (rerun && !stopped) {
        rerun = false;
        schedule();
      }
    });
    return running;
  };

  function schedule() {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, throttleMs);
  }

  for (const type of TRIGGER_NOTIFICATIONS) {
    try {
      unsubscribers.push(session.onNotification(() => schedule(), { type }));
    } catch (err) {
      console.error(`[DROID] ${type} subscription failed: ${err?.message || err}`);
    }
  }

  return {
    /** Report right away (turn start / end). */
    async flush() {
      // An in-flight read may predate the latest change, so wait it out and read again.
      if (running) await running;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      rerun = false;
      await run();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      for (const off of unsubscribers) {
        try { off(); } catch { /* ignore */ }
      }
    },
  };
}
