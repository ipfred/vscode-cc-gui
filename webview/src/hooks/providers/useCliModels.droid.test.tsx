// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCachedCliModels, normalizeModels, useCliModels } from './useCliModels';
import { DROID_MODELS } from '../../components/ChatInputBox/types';

const sendBridgeEventMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/bridge', () => ({
  sendBridgeEvent: (...args: unknown[]) => sendBridgeEventMock(...args),
}));

const OPUS = {
  id: 'claude-opus-5-5',
  label: 'Opus 5.5',
  description: '1.6× Factory token rate · reasoning low–max',
  multiplier: 1.6,
  group: 'Anthropic',
  disabled: false,
  disabledReason: null,
  supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultReasoningEffort: 'medium',
  noImageSupport: false,
  isCustom: false,
};

describe('useCliModels (droid)', () => {
  beforeEach(() => {
    sendBridgeEventMock.mockClear();
  });

  it('preserves Droid catalog metadata when normalizing', () => {
    expect(normalizeModels([OPUS])).toEqual([OPUS]);
    expect(normalizeModels([{ id: 'byok', label: 'BYOK', multiplier: null, isCustom: true, group: 'BYOK' }]))
      .toEqual([{ id: 'byok', label: 'BYOK', description: undefined, multiplier: null, isCustom: true, group: 'BYOK' }]);
  });

  it('starts with the placeholder list and stores the live catalog + default model', () => {
    const { result } = renderHook(() => useCliModels('droid'));
    expect(sendBridgeEventMock).toHaveBeenCalledWith('get_cli_models', 'droid');
    expect(result.current.cliModels).toEqual(DROID_MODELS);

    act(() => {
      window.setCliModels?.(JSON.stringify({ success: true, provider: 'droid', defaultModel: 'claude-opus-5-5', models: [OPUS] }));
    });
    expect(result.current.cliModels).toEqual([OPUS]);
    expect(result.current.cliDefaultModel).toBe('claude-opus-5-5');
    expect(getCachedCliModels('droid')).toEqual([OPUS]);
  });

  it('throttles dropdown-open refreshes but allows manual ones', () => {
    const { result } = renderHook(() => useCliModels('droid'));
    sendBridgeEventMock.mockClear();
    act(() => {
      result.current.refreshCliModelsThrottled('droid');
    });
    // The mount fetch just went out, so the throttled refresh is skipped.
    expect(sendBridgeEventMock).not.toHaveBeenCalled();
    act(() => {
      result.current.refreshCliModels('droid');
    });
    expect(sendBridgeEventMock).toHaveBeenCalledWith('get_cli_models', 'droid:refresh');
  });

  it('does not re-fetch the catalog when Droid becomes the active provider again', () => {
    const { rerender } = renderHook(({ provider }) => useCliModels(provider), { initialProps: { provider: 'droid' } });
    act(() => {
      window.setCliModels?.(JSON.stringify({ success: true, provider: 'droid', models: [OPUS] }));
    });
    rerender({ provider: 'kimi' });
    sendBridgeEventMock.mockClear();
    rerender({ provider: 'droid' });
    expect(sendBridgeEventMock).not.toHaveBeenCalledWith('get_cli_models', 'droid:refresh');
  });
});
