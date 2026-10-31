import type { ModelInfo, PermissionMode } from '../../components/ChatInputBox/types';
import { isDroidPermissionMode } from '../../components/ChatInputBox/types';

/**
 * Headless CLI providers that share Grok-style marker streaming. Droid does use
 * an npm SDK (@factory/droid-sdk), but the backend reports SDK_NOT_INSTALLED
 * itself, so the webview does not gate sends on SDK status for it either.
 */
export const CLI_ONLY_PROVIDERS = new Set(['grok', 'kimi', 'opencode', 'pi', 'omp', 'dsh', 'minimax', 'zcode', 'droid']);

export function isCliOnlyProvider(providerId: string | null | undefined): boolean {
  return !!providerId && CLI_ONLY_PROVIDERS.has(providerId);
}

/**
 * Static OMP model roles — used only to reconcile snapshots persisted before
 * roles became dynamic. The live role list comes from useOmpRoles() (dynamic
 * listModels roles, falling back to these same three when unloaded).
 */
export const OMP_ROLE_MODEL_IDS: ReadonlySet<string> = new Set(['smol', 'slow', 'plan']);

/**
 * Maps an omp model id to its mode: an id present in `roles` maps to the
 * same-named mode, everything else ('auto' or any catalog model) maps to
 * 'default'. Pass useOmpRoles() — it already falls back to the static
 * smol/slow/plan entries when no dynamic roles have loaded.
 */
export function ompModeForModelId(modelId: string, roles: ModelInfo[]): PermissionMode {
  return roles.some((role) => role.id === modelId) ? modelId : 'default';
}

/**
 * Plan mode and provider-native auto review are not exposed for headless CLI providers,
 * so they are coerced to default. The legacy autoEdit alias is migrated to acceptEdits
 * (or default for OMP), while OMP preserves model-role ids (default / smol / slow / plan).
 */
export function normalizeCliPermissionMode(mode: PermissionMode, provider?: string | null): PermissionMode {
  if (provider === 'droid') {
    // Droid exposes the four autonomy levels; Spec is a separate flag, so a
    // legacy `plan` value falls back to Auto Off.
    const canonical = mode === 'autoEdit' ? 'acceptEdits' : mode;
    return isDroidPermissionMode(canonical) ? canonical : 'default';
  }
  if (provider === 'omp') {
    return mode === 'auto' || mode === 'autoEdit' ? 'default' : mode;
  }
  if (mode === 'autoEdit') {
    return 'acceptEdits';
  }
  return mode === 'plan' || mode === 'auto' ? 'default' : mode;
}
