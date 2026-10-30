import { useCallback, useState } from 'react';
import { sendBridgeEvent } from '../../utils/bridge';
import { DROID_DEFAULT_MODEL_ID } from '../../components/ChatInputBox/types';
import type { PermissionMode, ReasoningEffort } from '../../components/ChatInputBox/types';
import { useCliProviderState } from './useCliProviderState';

/** Droid provider slice exposed through useModelProviderState. */
export interface UseDroidProviderReturn {
  selectedDroidModel: string;
  setSelectedDroidModel: (modelId: string) => void;
  droidPermissionMode: PermissionMode;
  setDroidPermissionMode: (mode: PermissionMode) => void;
  /** Kept apart from Codex's effort: Droid models expose their own effort sets. */
  droidReasoningEffort: ReasoningEffort;
  setDroidReasoningEffort: (effort: ReasoningEffort) => void;
  handleDroidReasoningChange: (effort: ReasoningEffort) => void;
}

/**
 * Factory Droid provider state. The model catalog, auth and BYOK config come
 * from the Droid CLI (via @factory/droid-sdk); the webview only remembers the
 * user's selection.
 */
export function useDroidProvider(): UseDroidProviderReturn {
  const state = useCliProviderState(DROID_DEFAULT_MODEL_ID);
  const [droidReasoningEffort, setDroidReasoningEffort] = useState<ReasoningEffort>('medium');

  const handleDroidReasoningChange = useCallback((effort: ReasoningEffort) => {
    setDroidReasoningEffort(effort);
    sendBridgeEvent('set_reasoning_effort', effort);
  }, []);

  return {
    selectedDroidModel: state.selectedModel,
    setSelectedDroidModel: state.setSelectedModel,
    droidPermissionMode: state.permissionMode,
    setDroidPermissionMode: state.setPermissionMode,
    droidReasoningEffort,
    setDroidReasoningEffort,
    handleDroidReasoningChange,
  };
}
