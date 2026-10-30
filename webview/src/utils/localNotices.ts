import { useSyncExternalStore } from 'react';
import type { ClaudeMessage } from '../types';
import { getMessageTimestampMs } from '../hooks/windowCallbacks/messageSync';

/**
 * Neutral inline chat notices (e.g. "Model switched to …") that exist only in
 * the webview. They live outside the message list on purpose: backend
 * `updateMessages` snapshots replace the whole list, and message indices feed
 * streaming / tool-result lookups, so notices are interleaved at render time
 * by timestamp instead.
 */
export interface LocalNotice {
  id: string;
  text: string;
  /** Epoch milliseconds when the notice was created. */
  createdAt: number;
}

let notices: LocalNotice[] = [];
const listeners = new Set<() => void>();
let counter = 0;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function addLocalNotice(text: string, createdAt: number = Date.now()): LocalNotice {
  counter += 1;
  const notice: LocalNotice = { id: `local-notice-${createdAt}-${counter}`, text, createdAt };
  notices = [...notices, notice];
  emit();
  return notice;
}

export function clearLocalNotices(): void {
  if (notices.length === 0) return;
  notices = [];
  emit();
}

export function getLocalNotices(): LocalNotice[] {
  return notices;
}

export function useLocalNotices(): LocalNotice[] {
  return useSyncExternalStore(subscribe, getLocalNotices);
}

/**
 * Groups notices by the message index they should render before
 * (`messages.length` = after the last message). A notice goes after the last
 * message whose timestamp is not later than the notice; messages without a
 * timestamp inherit the previous message's time.
 */
export function placeLocalNotices(
  messages: ClaudeMessage[],
  pending: LocalNotice[],
): Map<number, LocalNotice[]> {
  const placement = new Map<number, LocalNotice[]>();
  if (pending.length === 0) return placement;

  const times: number[] = [];
  let carried = Number.NEGATIVE_INFINITY;
  for (const message of messages) {
    const ts = getMessageTimestampMs(message);
    if (ts !== undefined && Number.isFinite(ts)) carried = Math.max(carried, ts);
    times.push(carried);
  }

  for (const notice of pending) {
    let index = 0;
    while (index < times.length && times[index] <= notice.createdAt) index += 1;
    const bucket = placement.get(index);
    if (bucket) bucket.push(notice);
    else placement.set(index, [notice]);
  }
  return placement;
}
