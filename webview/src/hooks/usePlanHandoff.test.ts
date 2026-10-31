import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlanHandoffPrompt, usePlanHandoff } from './usePlanHandoff';
import { getDroidSpecMode, setDroidSpecMode } from './providers/droidSpecMode';

describe('usePlanHandoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.__sessionTransitioning = false;
    setDroidSpecMode(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    window.__sessionTransitioning = false;
    setDroidSpecMode(false);
  });

  const setup = (loading: boolean) => {
    const forceCreateNewSession = vi.fn(() => {
      window.__sessionTransitioning = true;
    });
    const executeMessage = vi.fn();
    const applyMode = vi.fn();
    const hook = renderHook(
      ({ isLoading }) => usePlanHandoff({ loading: isLoading, forceCreateNewSession, executeMessage, applyMode }),
      { initialProps: { isLoading: loading } },
    );
    return { hook, forceCreateNewSession, executeMessage, applyMode };
  };

  it('opens a new session and sends the approved plan once the old turn is idle', () => {
    const { hook, forceCreateNewSession, executeMessage, applyMode } = setup(false);

    act(() => hook.result.current.startPlanHandoff('# Plan\n\nDo it', 'auto'));
    expect(applyMode).toHaveBeenCalledWith('auto');
    expect(forceCreateNewSession).toHaveBeenCalledTimes(1);
    expect(executeMessage).not.toHaveBeenCalled();

    // The new session is still opening: keep waiting.
    act(() => { vi.advanceTimersByTime(500); });
    expect(executeMessage).not.toHaveBeenCalled();

    window.__sessionTransitioning = false;
    act(() => { vi.advanceTimersByTime(200); });
    expect(executeMessage).toHaveBeenCalledTimes(1);
    expect(executeMessage).toHaveBeenCalledWith(buildPlanHandoffPrompt('# Plan\n\nDo it'));
    expect(getDroidSpecMode()).toBe(false);
  });

  it('waits for the old turn to end before switching', () => {
    const { hook, forceCreateNewSession, executeMessage } = setup(true);

    act(() => hook.result.current.startPlanHandoff('plan', 'default'));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(forceCreateNewSession).not.toHaveBeenCalled();

    hook.rerender({ isLoading: false });
    expect(forceCreateNewSession).toHaveBeenCalledTimes(1);

    window.__sessionTransitioning = false;
    act(() => { vi.advanceTimersByTime(200); });
    expect(executeMessage).toHaveBeenCalledTimes(1);
  });

  it('forces the switch when the old turn never ends', () => {
    const { hook, forceCreateNewSession } = setup(true);

    act(() => hook.result.current.startPlanHandoff('plan', 'default'));
    act(() => { vi.advanceTimersByTime(3100); });
    expect(forceCreateNewSession).toHaveBeenCalledTimes(1);
  });

  it('ignores an empty plan', () => {
    const { hook, forceCreateNewSession, applyMode } = setup(false);
    act(() => hook.result.current.startPlanHandoff('   ', 'default'));
    expect(applyMode).not.toHaveBeenCalled();
    expect(forceCreateNewSession).not.toHaveBeenCalled();
  });
});
