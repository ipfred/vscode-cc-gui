import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { sendBridgeEvent } from '../../../utils/bridge';
import { setDroidSpecMode, useDroidSpecMode } from '../../../hooks/providers/droidSpecMode';
import { isDroidPermissionMode } from '../types';
import type { PermissionMode } from '../types';

interface DroidSpecToggleProps {
  /** Current autonomy level; sent along so the backend keeps it unchanged. */
  permissionMode: PermissionMode;
}

/**
 * Droid Spec on/off. Spec is independent of the Auto Off / Low / Medium / High
 * level chosen in the mode selector, so the two can be combined.
 */
export const DroidSpecToggle = ({ permissionMode }: DroidSpecToggleProps) => {
  const { t } = useTranslation();
  const active = useDroidSpecMode();

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !active;
    setDroidSpecMode(next);
    const mode = isDroidPermissionMode(permissionMode) ? permissionMode : 'default';
    sendBridgeEvent('set_mode', JSON.stringify({ mode, spec: next }));
  }, [active, permissionMode]);

  const label = t('droidModes.spec.label', { defaultValue: 'Spec' });
  const description = t('droidModes.spec.description', {
    defaultValue: 'Plan first: Droid researches and writes a spec for your approval before editing files',
  });

  return (
    <button
      type="button"
      className={`selector-button droid-spec-toggle${active ? ' active' : ''}`}
      data-testid="droid-spec-toggle"
      aria-pressed={active}
      title={description}
      onClick={handleToggle}
    >
      <span className="codicon codicon-checklist" />
      <span className="selector-button-text">{label}</span>
    </button>
  );
};

export default DroidSpecToggle;
