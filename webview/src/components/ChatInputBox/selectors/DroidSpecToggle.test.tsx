import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DroidSpecToggle } from './DroidSpecToggle';
import { getDroidSpecMode, setDroidSpecMode } from '../../../hooks/providers/droidSpecMode';

const sendBridgeEventMock = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/bridge', () => ({ sendBridgeEvent: sendBridgeEventMock }));

afterEach(() => {
  act(() => setDroidSpecMode(false));
  sendBridgeEventMock.mockClear();
});

describe('DroidSpecToggle', () => {
  it('toggles Spec while keeping the chosen autonomy level', () => {
    render(<DroidSpecToggle permissionMode="auto" />);
    const button = screen.getByTestId('droid-spec-toggle');
    expect(button.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(button);
    expect(getDroidSpecMode()).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(sendBridgeEventMock).toHaveBeenLastCalledWith('set_mode', JSON.stringify({ mode: 'auto', spec: true }));

    fireEvent.click(button);
    expect(getDroidSpecMode()).toBe(false);
    expect(sendBridgeEventMock).toHaveBeenLastCalledWith('set_mode', JSON.stringify({ mode: 'auto', spec: false }));
  });

  it('falls back to Auto Off when the stored mode is not an autonomy level', () => {
    render(<DroidSpecToggle permissionMode="plan" />);
    fireEvent.click(screen.getByTestId('droid-spec-toggle'));
    expect(sendBridgeEventMock).toHaveBeenLastCalledWith('set_mode', JSON.stringify({ mode: 'default', spec: true }));
  });
});
