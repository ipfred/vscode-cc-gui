/**
 * CC GUI permission mode ↔ Droid interaction mode + autonomy level.
 *
 * The four webview mode ids map to Auto Off / Low / Medium / High. Spec is an
 * independent interaction-mode flag that combines with any of them; the legacy
 * `plan` id still means "enter Spec, keep the current autonomy level".
 */

const MODE_TO_DROID = {
  plan: { interactionMode: 'spec', autonomyLevel: null },
  default: { interactionMode: 'auto', autonomyLevel: 'off' },
  acceptEdits: { interactionMode: 'auto', autonomyLevel: 'low' },
  auto: { interactionMode: 'auto', autonomyLevel: 'medium' },
  bypassPermissions: { interactionMode: 'auto', autonomyLevel: 'high' },
};

const AUTONOMY_TO_MODE = {
  off: 'default',
  low: 'acceptEdits',
  medium: 'auto',
  high: 'bypassPermissions',
};

/**
 * @param {string} permissionMode CC GUI mode id
 * @returns {{interactionMode: 'auto'|'spec', autonomyLevel: 'off'|'low'|'medium'|'high'|null}}
 */
export function permissionModeToDroid(permissionMode) {
  const key = String(permissionMode || '').trim();
  if (key === 'autoEdit') return MODE_TO_DROID.acceptEdits;
  if (key === 'yolo') return MODE_TO_DROID.bypassPermissions;
  return MODE_TO_DROID[key] || MODE_TO_DROID.default;
}

/**
 * Droid session settings → CC GUI mode id. Spec is a separate axis
 * (`interactionMode`), so this only reflects the autonomy level.
 */
export function droidToPermissionMode(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  return AUTONOMY_TO_MODE[s.autonomyLevel] || 'default';
}

/** Payload pushed to the webview on every settings change. */
export function settingsToUiPayload(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  return {
    modelId: typeof s.modelId === 'string' ? s.modelId : '',
    reasoningEffort: typeof s.reasoningEffort === 'string' ? s.reasoningEffort : '',
    interactionMode: s.interactionMode === 'spec' ? 'spec' : 'auto',
    autonomyLevel: typeof s.autonomyLevel === 'string' ? s.autonomyLevel : 'off',
    permissionMode: droidToPermissionMode(s),
  };
}

/** Spec-plan approval target mode → the matching ExitSpecMode outcomes, best first. */
export function planApprovalOutcomes(targetMode) {
  switch (targetMode) {
    case 'acceptEdits':
      return ['proceed_auto_run_low', 'proceed_once'];
    case 'auto':
      return ['proceed_auto_run_medium', 'proceed_once'];
    case 'bypassPermissions':
      return ['proceed_auto_run_high', 'proceed_once'];
    default:
      return ['proceed_once', 'proceed_auto_run_low'];
  }
}
