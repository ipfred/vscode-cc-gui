import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { TFunction } from 'i18next';
import {
  isDroidPermissionMode,
  isDroidReasoningEffort,
} from '../../components/ChatInputBox/types';
import { droidModelRateLabel } from '../../components/ChatInputBox/droidModelUtils';
import type { ModelInfo, PermissionMode, ReasoningEffort } from '../../components/ChatInputBox/types';
import { addLocalNotice } from '../../utils/localNotices';
import { getCachedCliModels } from './useCliModels';

/** Payload of `window.onDroidSettingsUpdated` (Droid CLI `settings_updated`). */
export interface DroidSettingsPayload {
  modelId?: string;
  reasoningEffort?: string;
  interactionMode?: string;
  autonomyLevel?: string;
  permissionMode?: string;
}

const AUTONOMY_TO_MODE: Record<string, PermissionMode> = {
  off: 'default',
  low: 'acceptEdits',
  medium: 'auto',
  high: 'bypassPermissions',
};

/**
 * Resolves the webview mode id from a settings payload. `permissionMode` is
 * authoritative; interactionMode/autonomyLevel are a fallback for payloads
 * that only carry the CLI-native fields.
 */
export function resolveDroidPermissionMode(payload: DroidSettingsPayload): PermissionMode | null {
  if (isDroidPermissionMode(payload.permissionMode)) return payload.permissionMode;
  const interaction = payload.interactionMode?.toLowerCase();
  if (interaction === 'spec' || interaction === 'plan') return 'plan';
  const autonomy = payload.autonomyLevel?.toLowerCase();
  if (autonomy && AUTONOMY_TO_MODE[autonomy]) return AUTONOMY_TO_MODE[autonomy];
  return null;
}

export function buildDroidModelSwitchedNotice(modelId: string, models: ModelInfo[], t: TFunction): string {
  const model = models.find((entry) => entry.id === modelId);
  const label = model?.label || modelId;
  const rate = droidModelRateLabel(model, t);
  return rate
    ? t('droid.modelSwitched', { model: label, multiplier: rate, defaultValue: `Model switched to ${label} (${rate})` })
    : t('droid.modelSwitchedNoRate', { model: label, defaultValue: `Model switched to ${label}` });
}

export interface DroidSettingsHandlerDeps {
  t: TFunction;
  currentProviderRef: MutableRefObject<string>;
  /** Webview-selected Droid model; baseline before the CLI confirms one. */
  selectedDroidModelRef: MutableRefObject<string>;
  /** Last model id the CLI reported; shared across handler re-creations. */
  confirmedModelRef: MutableRefObject<string | null>;
  setSelectedDroidModel: (modelId: string) => void;
  setDroidReasoningEffort: (effort: ReasoningEffort) => void;
  setDroidPermissionMode: (mode: PermissionMode) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  getModels?: () => ModelInfo[];
}

/**
 * Builds the `window.onDroidSettingsUpdated` handler. It only mirrors CLI
 * state into React state — it never sends set_model / set_mode back, which
 * would loop with the extension re-emitting settings_updated.
 */
export function createDroidSettingsHandler(deps: DroidSettingsHandlerDeps) {
  return (input: string | DroidSettingsPayload) => {
    let payload: DroidSettingsPayload | null = null;
    if (typeof input === 'string') {
      try {
        payload = JSON.parse(input) as DroidSettingsPayload;
      } catch {
        return;
      }
    } else if (input && typeof input === 'object') {
      payload = input;
    }
    if (!payload || typeof payload !== 'object') return;

    const modelId = typeof payload.modelId === 'string' ? payload.modelId.trim() : '';
    if (modelId) {
      const baseline = deps.confirmedModelRef.current ?? deps.selectedDroidModelRef.current;
      deps.confirmedModelRef.current = modelId;
      deps.selectedDroidModelRef.current = modelId;
      deps.setSelectedDroidModel(modelId);
      // An empty baseline means "CLI default" — the first report just resolves
      // it, which is not a user-visible switch.
      if (baseline && baseline !== modelId) {
        const models = deps.getModels ? deps.getModels() : getCachedCliModels('droid');
        addLocalNotice(buildDroidModelSwitchedNotice(modelId, models, deps.t));
      }
    }

    if (isDroidReasoningEffort(payload.reasoningEffort)) {
      deps.setDroidReasoningEffort(payload.reasoningEffort);
    }

    const mode = resolveDroidPermissionMode(payload);
    if (mode) {
      deps.setDroidPermissionMode(mode);
      if (deps.currentProviderRef.current === 'droid') {
        deps.setPermissionMode(mode);
      }
    }
  };
}

export interface UseDroidSettingsSyncOptions {
  t: TFunction;
  currentProviderRef: MutableRefObject<string>;
  selectedDroidModel: string;
  setSelectedDroidModel: (modelId: string) => void;
  setDroidReasoningEffort: (effort: ReasoningEffort) => void;
  setDroidPermissionMode: (mode: PermissionMode) => void;
  setPermissionMode: (mode: PermissionMode) => void;
}

/** Registers `window.onDroidSettingsUpdated` for the lifetime of the caller. */
export function useDroidSettingsSync(options: UseDroidSettingsSyncOptions): void {
  const {
    t,
    currentProviderRef,
    selectedDroidModel,
    setSelectedDroidModel,
    setDroidReasoningEffort,
    setDroidPermissionMode,
    setPermissionMode,
  } = options;
  const selectedDroidModelRef = useRef(selectedDroidModel);
  selectedDroidModelRef.current = selectedDroidModel;
  const confirmedModelRef = useRef<string | null>(null);

  useEffect(() => {
    const handler = createDroidSettingsHandler({
      t,
      currentProviderRef,
      selectedDroidModelRef,
      confirmedModelRef,
      setSelectedDroidModel,
      setDroidReasoningEffort,
      setDroidPermissionMode,
      setPermissionMode,
    });
    window.onDroidSettingsUpdated = handler;

    const pending = window.__pendingDroidSettings;
    if (pending !== undefined) {
      window.__pendingDroidSettings = undefined;
      handler(pending);
    }

    return () => {
      if (window.onDroidSettingsUpdated === handler) {
        delete window.onDroidSettingsUpdated;
      }
    };
  }, [t, currentProviderRef, setSelectedDroidModel, setDroidReasoningEffort, setDroidPermissionMode, setPermissionMode]);
}
