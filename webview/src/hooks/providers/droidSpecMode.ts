import { useSyncExternalStore } from 'react';

/**
 * Droid Spec mode, tracked apart from the autonomy level (the PermissionMode):
 * Spec combines with any of Auto Off / Low / Medium / High. Kept as a tiny
 * external store so the mode selector, the send path and the CLI settings sync
 * share one value without prop drilling.
 */
let specMode = false;
const listeners = new Set<() => void>();

export function getDroidSpecMode(): boolean {
  return specMode;
}

export function setDroidSpecMode(next: boolean): void {
  if (specMode === next) return;
  specMode = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDroidSpecMode(): boolean {
  return useSyncExternalStore(subscribe, getDroidSpecMode);
}
