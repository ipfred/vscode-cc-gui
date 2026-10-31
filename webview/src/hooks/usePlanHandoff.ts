import { useCallback, useEffect, useRef, useState } from 'react';
import { setDroidSpecMode } from './providers/droidSpecMode';

/** How long to wait for the old turn to end on its own before forcing the switch. */
const TURN_END_GRACE_MS = 3000;
/** Upper bound on waiting for the new session to finish opening. */
const SESSION_READY_TIMEOUT_MS = 5000;
const SESSION_POLL_MS = 100;

export interface UsePlanHandoffOptions {
  loading: boolean;
  forceCreateNewSession: () => void;
  executeMessage: (content: string) => void;
  /** Applies the autonomy level picked in the plan dialog to the toolbar and CLI. */
  applyMode: (mode: string) => void;
}

export function buildPlanHandoffPrompt(plan: string): string {
  return `Implement the following approved spec. Do not re-plan; start executing it.\n\n${plan.trim()}`;
}

/**
 * "New chat" approval: the old turn is declined, then the approved plan is sent
 * as the first message of a fresh session. Waits for the old turn to wind down
 * so its late events do not land in the new conversation.
 */
export function usePlanHandoff({
  loading,
  forceCreateNewSession,
  executeMessage,
  applyMode,
}: UsePlanHandoffOptions) {
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const startedRef = useRef(false);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const latest = useRef({ forceCreateNewSession, executeMessage });

  useEffect(() => {
    latest.current = { forceCreateNewSession, executeMessage };
  });

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const begin = useCallback((prompt: string) => {
    if (startedRef.current) return;
    startedRef.current = true;
    latest.current.forceCreateNewSession();
    const openedAt = Date.now();
    const schedule = () => {
      const timer = setTimeout(() => {
        timersRef.current.delete(timer);
        if (window.__sessionTransitioning && Date.now() - openedAt < SESSION_READY_TIMEOUT_MS) {
          schedule();
          return;
        }
        setDroidSpecMode(false);
        startedRef.current = false;
        setPendingPrompt(null);
        latest.current.executeMessage(prompt);
      }, SESSION_POLL_MS);
      timersRef.current.add(timer);
    };
    schedule();
  }, []);

  useEffect(() => {
    if (pendingPrompt === null || startedRef.current) return;
    if (!loading) {
      begin(pendingPrompt);
      return;
    }
    const timer = setTimeout(() => begin(pendingPrompt), TURN_END_GRACE_MS);
    return () => clearTimeout(timer);
  }, [pendingPrompt, loading, begin]);

  const startPlanHandoff = useCallback((plan: string, targetMode: string) => {
    if (!plan.trim()) return;
    applyMode(targetMode);
    setPendingPrompt(buildPlanHandoffPrompt(plan));
  }, [applyMode]);

  return { startPlanHandoff };
}
