import { describe, expect, it } from 'vitest';
import { getAvailableReasoningLevels, isReasoningVisible, resolveCurrentReasoningLevel } from './reasoningUtils';

describe('Droid reasoning levels', () => {
  it('limits levels to the model\'s supported efforts in canonical order', () => {
    const levels = getAvailableReasoningLevels('droid', 'gpt-6-luna', {
      supportedEfforts: ['high', 'minimal', 'low', 'max'],
    });
    expect(levels.map((level) => level.id)).toEqual(['minimal', 'low', 'high', 'max']);
  });

  it('hides the selector when a model has a single or unknown effort set', () => {
    expect(isReasoningVisible('droid', 'm', { supportedEfforts: ['none'] })).toBe(false);
    expect(isReasoningVisible('droid', 'm', undefined)).toBe(false);
    expect(isReasoningVisible('droid', 'm', { supportedEfforts: ['off', 'low'] })).toBe(true);
  });

  it('resets unsupported efforts to the model default', () => {
    const levels = getAvailableReasoningLevels('droid', 'm', { supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
    expect(resolveCurrentReasoningLevel('none', levels, 'medium')?.id).toBe('medium');
    expect(resolveCurrentReasoningLevel('high', levels, 'medium')?.id).toBe('high');
  });

  it('keeps Droid-only levels out of other providers', () => {
    const ids = getAvailableReasoningLevels('codex', 'gpt-5.6-sol').map((level) => level.id);
    expect(ids).not.toContain('none');
    expect(ids).not.toContain('minimal');
  });
});
