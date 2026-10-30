import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DroidSdkCard from './DroidSdkCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'version' in options ? `${key}:${String(options.version)}` : key,
  }),
}));

const statusPayload = (droid: Record<string, unknown> | undefined) => JSON.stringify({
  'claude-sdk': { id: 'claude-sdk', name: 'Claude Code SDK', status: 'installed' },
  ...(droid ? { 'droid-sdk': droid } : {}),
});

describe('DroidSdkCard', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
    window.updateDependencyStatus = undefined;
    window.dependencyInstallResult = undefined;
  });

  afterEach(cleanup);

  it('requests dependency status and shows the installed version', () => {
    const chained = vi.fn();
    window.updateDependencyStatus = chained;
    render(<DroidSdkCard />);
    expect(window.sendToJava).toHaveBeenCalledWith('get_dependency_status:');

    act(() => {
      window.updateDependencyStatus?.(statusPayload({
        id: 'droid-sdk',
        name: 'Droid SDK',
        status: 'installed',
        installedVersion: '0.10.2',
        meetsMinimumVersion: true,
        minimumVersion: '0.10.0',
        installPath: '/deps/droid-sdk',
      }));
    });

    expect(screen.getByTestId('droid-sdk-version').textContent).toBe('v0.10.2');
    expect(screen.queryByTestId('droid-sdk-install')).toBeNull();
    // Earlier handlers (App / DependencySection) keep receiving the payload.
    expect(chained).toHaveBeenCalledTimes(1);
  });

  it('offers an install button that sends install_dependency for droid-sdk', () => {
    render(<DroidSdkCard />);
    act(() => {
      window.updateDependencyStatus?.(statusPayload({ id: 'droid-sdk', name: 'Droid SDK', status: 'not_installed' }));
    });

    fireEvent.click(screen.getByTestId('droid-sdk-install'));
    expect(window.sendToJava).toHaveBeenCalledWith('install_dependency:{"id":"droid-sdk"}');
    expect(screen.getByTestId('droid-sdk-install').textContent).toContain('settings.cli.droidSdk.installing');

    act(() => {
      window.dependencyInstallResult?.(JSON.stringify({ success: true, sdkId: 'droid-sdk', installedVersion: '0.10.2' }));
    });
    expect(screen.getByTestId('droid-sdk-install').textContent).toContain('settings.cli.droidSdk.install');
  });
});
