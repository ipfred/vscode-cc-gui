import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { InstallResult, SdkStatus } from '../../../types/dependency';
import styles from './style.module.less';

/**
 * Droid SDK status card (Settings → CLI, under the Droid row).
 *
 * The Droid provider needs both the `droid` binary (detected by the CLI row)
 * and @factory/droid-sdk, which is managed like the Claude/Codex SDKs:
 *   sendToJava('get_dependency_status:')                → window.updateDependencyStatus(json)
 *   sendToJava('install_dependency:{"id":"droid-sdk"}') → dependencyInstallProgress / dependencyInstallResult
 * Callbacks are chained so App / DependencySection keep receiving them.
 */

const DROID_SDK_ID = 'droid-sdk';
const DROID_SDK_MIN_VERSION = '0.10.0';

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
};

interface DroidSdkCardProps {
  addToast?: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
}

const parseDroidSdkStatus = (json: string): SdkStatus | null | undefined => {
  try {
    const parsed = JSON.parse(json) as Record<string, SdkStatus | undefined>;
    if (!parsed || typeof parsed !== 'object') return undefined;
    return parsed[DROID_SDK_ID] ?? null;
  } catch {
    return undefined;
  }
};

const DroidSdkCard = ({ addToast }: DroidSdkCardProps) => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SdkStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [lastLog, setLastLog] = useState('');
  const addToastRef = useRef(addToast);
  const tRef = useRef(t);
  useEffect(() => {
    addToastRef.current = addToast;
    tRef.current = t;
  }, [addToast, t]);

  useEffect(() => {
    const previousStatus = window.updateDependencyStatus;
    const previousProgress = window.dependencyInstallProgress;
    const previousResult = window.dependencyInstallResult;

    const statusHandler = (json: string) => {
      const next = parseDroidSdkStatus(json);
      if (next !== undefined) {
        setStatus(next);
        setLoaded(true);
      }
      if (previousStatus && previousStatus !== statusHandler) previousStatus(json);
    };
    const progressHandler = (json: string) => {
      try {
        const progress = JSON.parse(json) as { sdkId?: string; log?: string };
        if (progress.sdkId === DROID_SDK_ID && typeof progress.log === 'string') {
          setLastLog(progress.log.trim().split('\n').pop() ?? '');
        }
      } catch {
        // ignore malformed progress lines
      }
      if (previousProgress && previousProgress !== progressHandler) previousProgress(json);
    };
    const resultHandler = (json: string) => {
      try {
        const result = JSON.parse(json) as InstallResult;
        if (result.sdkId === DROID_SDK_ID) {
          setInstalling(false);
          setLastLog('');
          if (result.success) {
            addToastRef.current?.(tRef.current('settings.cli.droidSdk.installSuccess'), 'success');
            sendToJava('get_dependency_status:');
          } else if (result.error === 'node_not_configured') {
            addToastRef.current?.(tRef.current('settings.dependency.nodeNotConfigured'), 'warning');
          } else {
            addToastRef.current?.(
              tRef.current('settings.cli.droidSdk.installFailed', { error: result.error ?? '' }),
              'error',
            );
          }
        }
      } catch {
        setInstalling(false);
      }
      if (previousResult && previousResult !== resultHandler) previousResult(json);
    };

    window.updateDependencyStatus = statusHandler;
    window.dependencyInstallProgress = progressHandler;
    window.dependencyInstallResult = resultHandler;
    sendToJava('get_dependency_status:');

    return () => {
      if (window.updateDependencyStatus === statusHandler) window.updateDependencyStatus = previousStatus;
      if (window.dependencyInstallProgress === progressHandler) window.dependencyInstallProgress = previousProgress;
      if (window.dependencyInstallResult === resultHandler) window.dependencyInstallResult = previousResult;
    };
  }, []);

  const handleInstall = useCallback(() => {
    setInstalling(true);
    setLastLog('');
    sendToJava(`install_dependency:${JSON.stringify({ id: DROID_SDK_ID })}`);
  }, []);

  const installed = status?.status === 'installed';
  const belowMinimum = installed && status?.meetsMinimumVersion === false;
  const minimumVersion = status?.minimumVersion || DROID_SDK_MIN_VERSION;

  let meta: string;
  if (installing) {
    meta = lastLog || t('settings.cli.droidSdk.installing');
  } else if (!loaded) {
    meta = t('settings.cli.droidSdk.checking');
  } else if (belowMinimum) {
    meta = t('settings.cli.droidSdk.belowMinimum', { version: minimumVersion });
  } else if (installed) {
    meta = status?.installPath || t('settings.cli.droidSdk.hint', { version: minimumVersion });
  } else {
    meta = t('settings.cli.droidSdk.hint', { version: minimumVersion });
  }

  const badgeClass = installed && !belowMinimum ? styles.ok : loaded ? styles.missing : '';
  const badgeText = !loaded
    ? t('settings.cli.droidSdk.checking')
    : installed
      ? t('settings.cli.status.installed')
      : t('settings.cli.status.notInstalled');

  return (
    <div className={`${styles.cliCard} ${styles.dshCard}`} data-testid="droid-sdk-card">
      <div className={styles.cliMain} title={meta}>
        <div className={styles.cliIcon}>
          <span className="codicon codicon-package" aria-hidden="true" />
        </div>
        <span className={styles.cliName}>{t('settings.cli.droidSdk.title')}</span>
        {installed && status?.installedVersion && (
          <span className={styles.versionBadge} data-testid="droid-sdk-version">v{status.installedVersion}</span>
        )}
        <span className={styles.cliMeta}>{meta}</span>
      </div>

      <div className={styles.cliActions}>
        <span className={`${styles.statusBadge} ${badgeClass}`}>
          {installed && !belowMinimum && <span className="codicon codicon-check" aria-hidden="true" />}
          {badgeText}
        </span>
        {loaded && (!installed || belowMinimum) && (
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={handleInstall}
            disabled={installing}
            data-testid="droid-sdk-install"
          >
            <span
              className={`codicon ${installing ? 'codicon-loading codicon-modifier-spin' : 'codicon-cloud-download'}`}
              aria-hidden="true"
            />
            {installing
              ? t('settings.cli.droidSdk.installing')
              : belowMinimum
                ? t('settings.cli.droidSdk.update')
                : t('settings.cli.droidSdk.install')}
          </button>
        )}
      </div>
    </div>
  );
};

export default DroidSdkCard;
