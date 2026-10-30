import { useEffect, useMemo } from 'react';
import {
  DROID_REASONING_LEVELS,
  EFFORT_SUPPORTED_CLAUDE_MODELS,
  MAX_EFFORT_CLAUDE_MODELS,
  REASONING_LEVELS,
  XHIGH_EFFORT_CLAUDE_MODELS,
  codexModelSupportsMaxEffort,
  type ReasoningEffort,
  type ReasoningInfo,
} from './types';

/**
 * Droid-only inputs: the selected catalog entry's effort set and default.
 * Ignored for every other provider.
 */
export interface DroidReasoningOptions {
  supportedEfforts?: string[];
  defaultEffort?: string;
}

export function isReasoningVisible(
  currentProvider?: string,
  selectedModel?: string,
  droid?: DroidReasoningOptions,
): boolean {
  if (currentProvider === 'droid') {
    // A single-value set (e.g. only "none") leaves nothing to choose.
    return getAvailableReasoningLevels(currentProvider, selectedModel, droid).length > 1;
  }
  return currentProvider !== 'claude' || !selectedModel || EFFORT_SUPPORTED_CLAUDE_MODELS.has(selectedModel);
}

export function getAvailableReasoningLevels(
  currentProvider?: string,
  selectedModel?: string,
  droid?: DroidReasoningOptions,
): ReasoningInfo[] {
  if (currentProvider === 'droid') {
    const supported = droid?.supportedEfforts;
    if (!supported || supported.length === 0) return [];
    return DROID_REASONING_LEVELS.filter((level) => supported.includes(level.id));
  }
  return REASONING_LEVELS.filter((level) => {
    if (currentProvider === 'grok') {
      return level.id === 'low' || level.id === 'medium' || level.id === 'high';
    }
    if (currentProvider === 'codex') {
      return level.id !== 'max' || (selectedModel !== undefined && codexModelSupportsMaxEffort(selectedModel));
    }
    if (currentProvider !== 'claude') {
      return level.id !== 'max';
    }
    if (!selectedModel) {
      return true;
    }
    if (level.id === 'xhigh') {
      return XHIGH_EFFORT_CLAUDE_MODELS.has(selectedModel);
    }
    if (level.id === 'max') {
      return MAX_EFFORT_CLAUDE_MODELS.has(selectedModel);
    }
    return true;
  });
}

export function resolveCurrentReasoningLevel(
  value: ReasoningEffort,
  availableLevels: ReasoningInfo[],
  defaultEffort?: string,
): ReasoningInfo | undefined {
  return availableLevels.find((level) => level.id === value)
    || (defaultEffort ? availableLevels.find((level) => level.id === defaultEffort) : undefined)
    || availableLevels[availableLevels.length - 2]
    || availableLevels[0];
}

export function useReasoningEffortGuard(
  value: ReasoningEffort,
  onChange: (effort: ReasoningEffort) => void,
  selectedModel?: string,
  currentProvider?: string,
  droid?: DroidReasoningOptions,
): {
  isVisible: boolean;
  availableLevels: ReasoningInfo[];
  currentLevel: ReasoningInfo | undefined;
} {
  const supportedKey = droid?.supportedEfforts?.join(',') ?? '';
  const availableLevels = useMemo(
    () => getAvailableReasoningLevels(currentProvider, selectedModel, droid),
    // supportedKey stands in for the array identity, which changes on every catalog refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentProvider, selectedModel, supportedKey],
  );
  const isVisible = currentProvider === 'droid'
    ? availableLevels.length > 1
    : isReasoningVisible(currentProvider, selectedModel);
  const currentLevel = resolveCurrentReasoningLevel(value, availableLevels, droid?.defaultEffort);

  useEffect(() => {
    if (!isVisible || availableLevels.some((level) => level.id === value)) {
      return;
    }
    if (currentLevel) {
      onChange(currentLevel.id);
    }
  }, [availableLevels, currentLevel, isVisible, onChange, value]);

  return { isVisible, availableLevels, currentLevel };
}
