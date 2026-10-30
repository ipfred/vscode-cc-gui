import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import type { ModelInfo } from '../../components/ChatInputBox/types';
import { clearLocalNotices, getLocalNotices } from '../../utils/localNotices';
import {
  buildDroidModelSwitchedNotice,
  createDroidSettingsHandler,
  resolveDroidPermissionMode,
} from './useDroidSettingsSync';

const t = ((key: string, options?: Record<string, unknown>) =>
  (options?.defaultValue as string | undefined) ?? key) as unknown as TFunction;

const MODELS: ModelInfo[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', group: 'Anthropic', multiplier: 1.6 },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', group: 'OpenAI', multiplier: 0.04 },
  { id: 'my-byok', label: 'My BYOK', group: 'BYOK', multiplier: null, isCustom: true },
];

function setup(selected = 'claude-opus-5-5', provider = 'droid') {
  const deps = {
    t,
    currentProviderRef: { current: provider },
    selectedDroidModelRef: { current: selected },
    confirmedModelRef: { current: null as string | null },
    setSelectedDroidModel: vi.fn(),
    setDroidReasoningEffort: vi.fn(),
    setDroidPermissionMode: vi.fn(),
    setPermissionMode: vi.fn(),
    getModels: () => MODELS,
  };
  return { deps, handler: createDroidSettingsHandler(deps) };
}

afterEach(() => {
  clearLocalNotices();
});

describe('createDroidSettingsHandler', () => {
  it('syncs model, effort and mode without a notice when the CLI confirms the selected model', () => {
    const { deps, handler } = setup();
    handler(JSON.stringify({
      modelId: 'claude-opus-5-5',
      reasoningEffort: 'high',
      permissionMode: 'acceptEdits',
    }));
    expect(deps.setSelectedDroidModel).toHaveBeenCalledWith('claude-opus-5-5');
    expect(deps.setDroidReasoningEffort).toHaveBeenCalledWith('high');
    expect(deps.setDroidPermissionMode).toHaveBeenCalledWith('acceptEdits');
    expect(deps.setPermissionMode).toHaveBeenCalledWith('acceptEdits');
    expect(getLocalNotices()).toHaveLength(0);
  });

  it('appends a model-switch notice with the rate when the model changes', () => {
    const { handler } = setup();
    handler({ modelId: 'claude-opus-5-5' });
    handler({ modelId: 'gpt-6-luna' });
    handler({ modelId: 'gpt-6-luna' });
    const notices = getLocalNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toBe('Model switched to GPT-6 Luna (0.04×)');
  });

  it('labels BYOK models and does not announce resolving the CLI default', () => {
    const { handler } = setup('');
    handler({ modelId: 'claude-opus-5-5' });
    expect(getLocalNotices()).toHaveLength(0);
    handler({ modelId: 'my-byok' });
    expect(getLocalNotices()[0].text).toBe('Model switched to My BYOK (BYOK)');
  });

  it('only mirrors the active permission mode while Droid is the current provider', () => {
    const { deps, handler } = setup('claude-opus-5-5', 'claude');
    handler({ interactionMode: 'spec', autonomyLevel: 'off' });
    expect(deps.setDroidPermissionMode).toHaveBeenCalledWith('plan');
    expect(deps.setPermissionMode).not.toHaveBeenCalled();
  });

  it('ignores malformed payloads and unknown efforts', () => {
    const { deps, handler } = setup();
    handler('{not json');
    handler({ reasoningEffort: 'turbo' });
    expect(deps.setDroidReasoningEffort).not.toHaveBeenCalled();
    expect(deps.setSelectedDroidModel).not.toHaveBeenCalled();
  });
});

describe('resolveDroidPermissionMode', () => {
  it('prefers permissionMode and falls back to interaction/autonomy fields', () => {
    expect(resolveDroidPermissionMode({ permissionMode: 'bypassPermissions', autonomyLevel: 'off' })).toBe('bypassPermissions');
    expect(resolveDroidPermissionMode({ interactionMode: 'auto', autonomyLevel: 'medium' })).toBe('auto');
    expect(resolveDroidPermissionMode({ interactionMode: 'auto', autonomyLevel: 'low' })).toBe('acceptEdits');
    expect(resolveDroidPermissionMode({ interactionMode: 'spec' })).toBe('plan');
    expect(resolveDroidPermissionMode({})).toBeNull();
  });
});

describe('buildDroidModelSwitchedNotice', () => {
  it('falls back to the raw id without a rate for unknown models', () => {
    expect(buildDroidModelSwitchedNotice('mystery', MODELS, t)).toBe('Model switched to mystery');
  });
});
